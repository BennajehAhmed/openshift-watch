import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { namespaces } from './config.js';
import { logArgs, LOG_LIMITS } from './logs.js';
import { assertReadOnly, readResources, resourceName } from './commands.js';

const execute = promisify(execFile);
export const resources = ['pods', 'deployments.apps', 'statefulsets.apps', 'daemonsets.apps', 'replicasets.apps', 'replicationcontrollers', 'deploymentconfigs.apps.openshift.io'];

export class OcClient {
  constructor(config, runner = execute) { this.config = config; this.runner = runner; this.context = config.context; }
  async run(args, withContext = true, options = {}) {
    assertReadOnly(args);
    const full = [...(withContext && this.context ? [`--context=${this.context}`] : []), ...args];
    try {
      const { stdout } = await this.runner(this.config.ocBin, full, {
        shell: false, windowsHide: true, timeout: this.config.timeoutSeconds * 1000,
        maxBuffer: options.maxBuffer || 32 * 1024 * 1024, encoding: 'utf8', signal: options.signal
      });
      return stdout;
    } catch (error) {
      // Do not return stderr: plugins/proxies can include credentials or internal URLs.
      const stderr = String(error.stderr || '');
      if (error.name === 'AbortError') throw new Error('Read request cancelled.');
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Read output exceeded the buffer limit. Narrow the selection or inspect it in your terminal.');
      if (/previous terminated container|previous.*not found/i.test(stderr)) throw new Error('No previous container instance is available. Select current logs instead.');
      if (/waiting to start|ContainerCreating|PodInitializing/i.test(stderr)) throw new Error('Container has not started yet. Inspect pod events and try again after it starts.');
      if (error.code === 'ENOENT') throw new Error('oc was not found. Install the approved CLI or set OC_BIN to its absolute path.');
      if (error.killed || error.code === 'ETIMEDOUT') throw new Error('OpenShift request timed out. Check VPN/network and try again.');
      if (/Unauthorized|must be logged|expired|provide credentials/i.test(stderr)) throw new Error('OpenShift login expired or is missing. Run oc login in your terminal.');
      if (/Forbidden|cannot list|cannot get/i.test(stderr)) throw new Error(args[0] === 'logs' ? 'Logs require get access to pods/log in this project.' : 'Your OpenShift account cannot read this resource.');
      if (/doesn.t have a resource type|could not find the requested resource|no matches for kind/i.test(stderr)) {
        const unsupported = new Error('Resource type is unavailable in this cluster.'); unsupported.unsupported = true; throw unsupported;
      }
      if (/not found|NotFound/i.test(stderr)) throw new Error('Requested object no longer exists. Refresh project health.');
      throw new Error('oc request failed. Check your access, context, and network in the terminal.');
    }
  }
  async initialize() {
    if (!this.context) this.context = (await this.run(['config', 'current-context'], false)).trim();
    if (!this.context) throw new Error('No current OpenShift context. Run oc login first.');
  }
  async projects() {
    const result = JSON.parse(await this.run(['get', 'projects', '-o', 'json', `--request-timeout=${this.config.timeoutSeconds}s`]));
    return (result.items || []).map(p => ({ name: p.metadata.name, displayName: p.metadata.annotations?.['openshift.io/display-name'] || '' }));
  }
  async get(namespace, resource) {
    namespaces([namespace]);
    if (!resources.includes(resource)) throw new Error('Resource is not allowed.');
    const result = JSON.parse(await this.run(['get', resource, `--namespace=${namespace}`, '-o', 'json', `--request-timeout=${this.config.timeoutSeconds}s`]));
    if (!Array.isArray(result.items)) throw new Error('Unexpected OpenShift response.');
    return result.items;
  }
  async logs(options, signal) {
    return this.run(logArgs(options, false, this.config.timeoutSeconds), true, { maxBuffer: LOG_LIMITS.bytes + 65536, signal });
  }
  followLogs(options) {
    const args = logArgs(options, true); assertReadOnly(args);
    return spawn(this.config.ocBin, [...(this.context ? [`--context=${this.context}`] : []), ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  async readObject(namespace, resource, options = {}) {
    namespaces([namespace]); if (!readResources.has(resource) || resource === 'projects') throw new Error('Resource is not allowed.');
    const args = ['get', resource, ...(options.name ? [resourceName(options.name)] : []), `--namespace=${namespace}`, '-o', 'json', `--request-timeout=${this.config.timeoutSeconds}s`];
    if (options.uid) args.push(`--field-selector=involvedObject.uid=${options.uid}`);
    if (options.objectName) args.push(`--field-selector=involvedObject.name=${resourceName(options.objectName)}`);
    if (options.service) args.push(`--selector=kubernetes.io/service-name=${resourceName(options.service)}`);
    return JSON.parse(await this.run(args, true, { maxBuffer: 2 * 1024 * 1024, signal: options.signal }));
  }
  async describePod(namespace, pod, signal) {
    namespaces([namespace]); resourceName(pod);
    return this.run(['describe', 'pods', pod, `--namespace=${namespace}`, '--show-events=false', `--request-timeout=${this.config.timeoutSeconds}s`], true, { maxBuffer: 512 * 1024, signal });
  }
  async podMetrics(namespace, pod, signal) {
    namespaces([namespace]); resourceName(pod);
    return this.run(['adm', 'top', 'pod', pod, `--namespace=${namespace}`, '--containers', `--request-timeout=${this.config.timeoutSeconds}s`], true, { maxBuffer: 65536, signal });
  }
  async collect(namespace) {
    // Bounded parallelism: four CLI processes maximum, one namespace at a time.
    const items = []; const errors = []; const unavailable = [];
    for (let i = 0; i < resources.length; i += 4) {
      const batch = resources.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map(r => this.get(namespace, r)));
      results.forEach((result, index) => {
        const resource = batch[index];
        if (result.status === 'fulfilled') items.push(...result.value);
        else if (result.reason.unsupported && resource === 'deploymentconfigs.apps.openshift.io') unavailable.push(resource);
        else errors.push({ resource, message: result.reason.message });
      });
    }
    return { items, errors, unavailable };
  }
}
