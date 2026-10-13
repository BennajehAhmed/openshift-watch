export class DemoClient {
  constructor() { this.context = 'demo-cluster'; this.step = 0; this.scenario = 'healthy'; }
  async initialize() {}
  async projects() { return [{ name: 'payments-dev' }, { name: 'customer-tools' }]; }
  async collect(namespace) {
    const items = [];
    for (const [index, name] of ['catalog-api', 'admin-portal', 'event-worker'].entries()) {
      const affected = index === 0 && namespace === 'payments-dev';
      const ready = affected && this.scenario === 'outage' ? 0 : affected && this.scenario === 'degraded' ? 1 : 2;
      items.push({ kind: 'Deployment', metadata: { name, namespace, generation: 1 }, spec: { replicas: 2, selector: { matchLabels: { app: name } } }, status: { observedGeneration: 1, availableReplicas: ready } });
      items.push({ kind: 'ReplicaSet', metadata: { name: `${name}-demo`, ownerReferences: [{ kind: 'Deployment', name, controller: true }] } });
      for (let i = 0; i < 2; i++) items.push({ kind: 'Pod', metadata: { name: `${name}-demo-${i}`, labels: { app: name }, ownerReferences: [{ kind: 'ReplicaSet', name: `${name}-demo`, controller: true }] }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: i < ready ? 'True' : 'False' }], containerStatuses: [{ name: 'app', ready: i < ready, restartCount: i < ready ? 0 : 7, state: i < ready ? { running: {} } : { waiting: { reason: 'CrashLoopBackOff' } } }] } });
    }
    if (this.scenario === 'connection') return { items: [], errors: [{ resource: 'pods', message: 'Simulated network failure' }], unavailable: [] };
    return { items, errors: [], unavailable: [] };
  }
}
