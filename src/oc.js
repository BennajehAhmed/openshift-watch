import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { namespaces } from './config.js';

const execute = promisify(execFile);
export const resources = ['pods', 'deployments.apps', 'statefulsets.apps', 'daemonsets.apps', 'replicasets.apps', 'replicationcontrollers', 'deploymentconfigs.apps.openshift.io'];

export class OcClient {
  constructor(config, runner = execute) { this.config = config; this.runner = runner; this.context = config.context; }
  async run(args, withContext = true) {
    const full = [...(withContext && this.context ? [`--context=${this.context}`] : []), ...args];
    try {
      const { stdout } = await this.runner(this.config.ocBin, full, {
        shell: false, windowsHide: true, timeout: this.config.timeoutSeconds * 1000,
        maxBuffer: 32 * 1024 * 1024, encoding: 'utf8'
      });
      return stdout;
    } catch (error) {
      // Do not return stderr: plugins/proxies can include credentials or internal URLs.
      const stderr = String(error.stderr || '');
      if (error.code === 'ENOENT') throw new Error('oc was not found. Install the approved CLI or set OC_BIN to its absolute path.');
      if (error.killed || error.code === 'ETIMEDOUT') throw new Error('OpenShift request timed out. Check VPN/network and try again.');
      if (/Unauthorized|must be logged|expired|provide credentials/i.test(stderr)) throw new Error('OpenShift login expired or is missing. Run oc login in your terminal.');
      if (/Forbidden|cannot list/i.test(stderr)) throw new Error('Your OpenShift account cannot list this resource.');
      if (/doesn.t have a resource type|could not find the requested resource|no matches for kind/i.test(stderr)) {
        const unsupported = new Error('Resource type is unavailable in this cluster.'); unsupported.unsupported = true; throw unsupported;
      }
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
