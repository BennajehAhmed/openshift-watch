import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

export class DemoClient {
  constructor() { this.context = 'demo-cluster'; this.step = 0; this.scenario = 'healthy'; }
  async initialize() {}
  async projects() { return [{ name: 'payments-dev' }, { name: 'customer-tools' }]; }
  async readObject(namespace, resource, options = {}) {
    if (this.scenario === 'connection') throw new Error('Simulated cluster access failure.');
    const items = (await this.collect(namespace)).items;
    const kinds = { pods: 'Pod', 'deployments.apps': 'Deployment', 'replicasets.apps': 'ReplicaSet' };
    if (kinds[resource]) {
      const result = items.filter(i => i.kind === kinds[resource]);
      const item = result.find(i => i.metadata.name === options.name);
      if (options.name && !item) throw new Error('Requested object no longer exists.');
      return options.name ? item : { items: result };
    }
    if (resource === 'resourcequotas') return { items: [{ metadata: { name: 'project-budget' }, status: { hard: { pods: '10', 'requests.cpu': '4', 'requests.memory': '4Gi' }, used: { pods: this.scenario === 'quota' ? '10' : '6', 'requests.cpu': '600m', 'requests.memory': '768Mi' } } }] };
    if (resource === 'limitranges') return { items: [{ metadata: { name: 'container-defaults' }, spec: { limits: [{ type: 'Container', default: { cpu: '500m', memory: '512Mi' }, defaultRequest: { cpu: '100m', memory: '128Mi' } }] } }] };
    if (resource === 'persistentvolumeclaims') return { metadata: { name: options.name }, spec: { storageClassName: 'standard', resources: { requests: { storage: '2Gi' } } }, status: { phase: this.scenario === 'storage' ? 'Pending' : 'Bound', capacity: { storage: '2Gi' } } };
    if (resource === 'events') {
      const reason = this.scenario === 'pending' ? 'FailedScheduling' : this.scenario === 'storage' ? 'FailedMount' : this.scenario === 'image' ? 'Failed' : this.scenario === 'probe' ? 'Unhealthy' : this.scenario === 'quota' ? 'FailedCreate' : 'BackOff';
      const message = this.scenario === 'probe' ? 'Readiness probe failed: HTTP probe failed with statuscode: 503' : this.scenario === 'quota' ? 'Error creating pods: exceeded quota project-budget, requested pods=1, used pods=10, limited pods=10' : this.scenario === 'storage' ? 'Unable to attach or mount volumes: claim app-data is not bound' : this.scenario === 'pending' ? '0/3 nodes are available: insufficient cpu' : this.scenario === 'image' ? 'Failed to pull expected image tag from registry' : 'Back-off restarting failed container app';
      const object = items.find(i => i.metadata.uid === options.uid);
      return { items: [{ metadata: { creationTimestamp: new Date().toISOString() }, type: this.scenario === 'healthy' || this.scenario === 'route' ? 'Normal' : 'Warning', reason: this.scenario === 'healthy' || this.scenario === 'route' ? 'Started' : reason, message: this.scenario === 'healthy' || this.scenario === 'route' ? 'Started container app' : message, count: 4, lastTimestamp: new Date().toISOString(), involvedObject: { kind: object?.kind || 'Pod', name: object?.metadata.name || options.objectName || 'catalog-api-demo-0', uid: options.uid } }] };
    }
    if (resource === 'services') return { items: ['catalog-api', 'admin-portal', 'event-worker'].map(name => ({ metadata: { name }, spec: { type: 'ClusterIP', clusterIP: '10.0.0.20', selector: { app: name }, ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP' }] } })) };
    if (resource === 'endpointslices.discovery.k8s.io') return { items: [{ endpoints: [0, 1].map(i => ({ addresses: [`10.1.1.${i + 20}`], targetRef: { uid: `endpoint-${i}` }, conditions: { ready: ['healthy', 'route'].includes(this.scenario) } })) }] };
    if (resource === 'routes.route.openshift.io') return { items: [{ metadata: { name: 'catalog-api' }, spec: { host: 'catalog.example.internal', to: { name: 'catalog-api', weight: 100 }, port: { targetPort: 'http' } }, status: { ingress: [{ conditions: [{ type: 'Admitted', status: this.scenario === 'route' ? 'False' : 'True', reason: this.scenario === 'route' ? 'HostAlreadyClaimed' : '' }] }] } }] };
    return { items: [] };
  }
  async describePod(namespace, pod) {
    return `Name:         ${pod}\nNamespace:    ${namespace}\nNode:         demo-node-1\nStatus:       Running\nContainers:\n  app:\n    Image:      internal.registry/demo/app:1.0\n    Environment:\n      EXAMPLE:  demonstration value\n    Readiness: http-get http://:8080/ready delay=10s timeout=2s period=10s\n    Mounts:\n      /data from app-data\n`;
  }
  async podMetrics(namespace, pod) { return `POD NAME                NAME    CPU(cores)   MEMORY(bytes)\n${pod}    app     18m          92Mi\n`; }
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
      const ready = affected && ['outage', 'oom', 'image', 'pending', 'config', 'storage', 'quota', 'probe'].includes(this.scenario) ? 0 : affected && this.scenario === 'degraded' ? 1 : 2;
      const failure = this.scenario === 'image' ? 'ImagePullBackOff' : this.scenario === 'config' ? 'CreateContainerConfigError' : this.scenario === 'pending' ? 'Pending' : this.scenario === 'storage' ? 'ContainerCreating' : 'CrashLoopBackOff';
      items.push({ kind: 'Deployment', metadata: { name, namespace, uid: `deployment-${namespace}-${name}`, generation: 1 }, spec: { replicas: 2, selector: { matchLabels: { app: name } }, strategy: { type: 'RollingUpdate' } }, status: { observedGeneration: 1, readyReplicas: ready, availableReplicas: ready, updatedReplicas: 2, conditions: [{ type: affected && this.scenario === 'quota' ? 'ReplicaFailure' : 'Available', status: ready === 2 || this.scenario === 'quota' ? 'True' : 'False', reason: affected && this.scenario === 'quota' ? 'FailedCreate' : 'MinimumReplicasUnavailable' }] } });
      items.push({ kind: 'ReplicaSet', metadata: { name: `${name}-demo`, ownerReferences: [{ kind: 'Deployment', name, controller: true }] } });
      if (affected && this.scenario === 'quota') continue;
      for (let i = 0; i < 2; i++) items.push({ kind: 'Pod', metadata: { name: `${name}-demo-${i}`, namespace, uid: `pod-${namespace}-${name}-${i}`, creationTimestamp: new Date(Date.now() - 3600000).toISOString(), labels: { app: name }, ownerReferences: [{ kind: 'ReplicaSet', name: `${name}-demo`, controller: true }] }, spec: { nodeName: this.scenario === 'pending' && i >= ready ? undefined : 'demo-node-1', containers: [{ name: 'app', image: `internal.registry/demo/${name}:1.0`, ports: [{ name: 'http', containerPort: 8080 }], resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } }, readinessProbe: { httpGet: { path: '/ready', port: 8080 }, initialDelaySeconds: 10, timeoutSeconds: 2 }, livenessProbe: { httpGet: { path: '/health', port: 8080 }, failureThreshold: 3 }, envFrom: [{ secretRef: { name: 'application-config' } }] }], volumes: [{ name: 'app-data', persistentVolumeClaim: { claimName: 'app-data' } }] }, status: { podIP: '10.1.1.20', qosClass: 'Burstable', phase: i >= ready && ['pending', 'storage'].includes(this.scenario) ? 'Pending' : 'Running', conditions: [{ type: 'Ready', status: i < ready ? 'True' : 'False', reason: i < ready ? 'Ready' : 'ContainersNotReady', message: i < ready ? '' : 'The app container is not ready' }, ...(i >= ready && this.scenario === 'pending' ? [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'Insufficient cpu' }] : [])], containerStatuses: [{ name: 'app', ready: i < ready, restartCount: i < ready || this.scenario === 'probe' ? 0 : 7, state: i < ready || this.scenario === 'probe' ? { running: {} } : { waiting: { reason: failure } }, ...(i >= ready && this.scenario === 'oom' ? { lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } } : {}) }] } });
    }
    if (this.scenario === 'connection') return { items: [], errors: [{ resource: 'pods', message: 'Simulated network failure' }], unavailable: [] };
    return { items, errors: [], unavailable: [] };
  }
}
