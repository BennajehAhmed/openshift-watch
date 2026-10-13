import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

export class DemoClient {
  constructor() { this.context = 'demo-cluster'; this.step = 0; this.scenario = 'healthy'; }
  async initialize() {}
  async projects() { return [{ name: 'payments-dev' }, { name: 'customer-tools' }]; }
  async logs(options) {
    const lines = [];
    for (let i = 0; i < options.tail; i++) {
      const level = i % 13 === 0 ? 'ERROR' : i % 7 === 0 ? 'WARN' : 'INFO';
      const message = level === 'ERROR' ? 'Database connection timed out; retrying' : level === 'WARN' ? 'Request latency above threshold' : `Request completed request_id=demo-${i} duration=${12 + i % 30}ms`;
      lines.push(`${new Date(Date.now() - (options.tail - i) * 1000).toISOString()} ${level} [${options.container}] ${options.previous ? 'previous instance: ' : ''}${message}`);
    }
    return lines.join('\n') + '\n';
  }
  followLogs(options) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let stopped = false, timer;
    child.kill = () => { if (stopped) return; stopped = true; clearInterval(timer); child.stdout.end(); child.stderr.end(); child.emit('close', 0); };
    setTimeout(async () => {
      if (stopped) return;
      child.stdout.write(await this.logs(options));
      timer = setInterval(() => child.stdout.write(`${new Date().toISOString()} INFO [${options.container}] Live request completed\n`), 500);
    }, 0);
    return child;
  }
  async collect(namespace) {
    const items = [];
    for (const [index, name] of ['catalog-api', 'admin-portal', 'event-worker'].entries()) {
      const affected = index === 0 && namespace === 'payments-dev';
      const ready = affected && ['outage', 'oom', 'image', 'pending', 'config'].includes(this.scenario) ? 0 : affected && this.scenario === 'degraded' ? 1 : 2;
      const failure = this.scenario === 'image' ? 'ImagePullBackOff' : this.scenario === 'config' ? 'CreateContainerConfigError' : this.scenario === 'pending' ? 'Pending' : 'CrashLoopBackOff';
      items.push({ kind: 'Deployment', metadata: { name, namespace, generation: 1 }, spec: { replicas: 2, selector: { matchLabels: { app: name } } }, status: { observedGeneration: 1, availableReplicas: ready } });
      items.push({ kind: 'ReplicaSet', metadata: { name: `${name}-demo`, ownerReferences: [{ kind: 'Deployment', name, controller: true }] } });
      for (let i = 0; i < 2; i++) items.push({ kind: 'Pod', metadata: { name: `${name}-demo-${i}`, labels: { app: name }, ownerReferences: [{ kind: 'ReplicaSet', name: `${name}-demo`, controller: true }] }, status: { phase: i >= ready && this.scenario === 'pending' ? 'Pending' : 'Running', conditions: [{ type: 'Ready', status: i < ready ? 'True' : 'False' }, ...(i >= ready && this.scenario === 'pending' ? [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] : [])], containerStatuses: [{ name: 'app', ready: i < ready, restartCount: i < ready ? 0 : 7, state: i < ready ? { running: {} } : { waiting: { reason: failure } }, ...(i >= ready && this.scenario === 'oom' ? { lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } } : {}) }] } });
    }
    if (this.scenario === 'connection') return { items: [], errors: [{ resource: 'pods', message: 'Simulated network failure' }], unavailable: [] };
    return { items, errors: [], unavailable: [] };
  }
}
