import { resourceName } from './commands.js';

const kinds = { Deployment: 'deployments.apps', DeploymentConfig: 'deploymentconfigs.apps.openshift.io', StatefulSet: 'statefulsets.apps', DaemonSet: 'daemonsets.apps', ReplicaSet: 'replicasets.apps', ReplicationController: 'replicationcontrollers', Job: 'jobs.batch', Build: 'builds.build.openshift.io', Pod: 'pods' };
const LIMIT = 200;
const text = value => String(value ?? '').slice(0, 2000);
const owner = object => (object.metadata?.ownerReferences || []).find(o => o.controller) || object.metadata?.ownerReferences?.[0];
function conditions(object) { return (object.status?.conditions || []).map(c => ({ type: c.type, status: c.status, reason: c.reason || '', message: text(c.message), changedAt: c.lastTransitionTime || null })); }
function probe(p) {
  if (!p) return null;
  return { action: p.httpGet ? `${p.httpGet.scheme || 'HTTP'} GET ${p.httpGet.path || '/'} on port ${p.httpGet.port}` : p.tcpSocket ? `TCP ${p.tcpSocket.port}` : p.grpc ? `gRPC ${p.grpc.port}` : p.exec ? 'Exec probe configured (command omitted)' : 'Probe configured', initialDelay: p.initialDelaySeconds || 0, period: p.periodSeconds ?? 10, timeout: p.timeoutSeconds ?? 1, failureThreshold: p.failureThreshold ?? 3 };
}
export function summarizePod(pod) {
  const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || []), ...(pod.status?.ephemeralContainerStatuses || [])];
  const containers = [...(pod.spec?.initContainers || []).map(c => ({ ...c, type: 'init' })), ...(pod.spec?.containers || []).map(c => ({ ...c, type: 'app' })), ...(pod.spec?.ephemeralContainers || []).map(c => ({ ...c, type: 'ephemeral' }))];
  // Whitelist fields: no env values, commands, args, annotations, or secret contents.
  return {
    name: pod.metadata.name, uid: pod.metadata.uid || null, createdAt: pod.metadata.creationTimestamp || null, phase: pod.status?.phase || 'Unknown', node: pod.spec?.nodeName || 'Not scheduled', ip: pod.status?.podIP || null, qos: pod.status?.qosClass || 'Unknown', owner: owner(pod) ? { kind: owner(pod).kind, name: owner(pod).name } : null,
    conditions: conditions(pod),
    containers: containers.map(c => {
      const s = statuses.find(s => s.name === c.name) || {}; const current = s.state?.terminated, previous = s.lastState?.terminated;
      return { name: c.name, type: c.type, image: c.image || '', ready: Boolean(s.ready), restarts: s.restartCount || 0, state: s.state?.waiting?.reason || current?.reason || (s.state?.running ? 'Running' : 'Not started'), exitCode: current?.exitCode ?? previous?.exitCode ?? null, lastExit: previous?.reason || null, lastFinishedAt: previous?.finishedAt || current?.finishedAt || null, resources: { requests: c.resources?.requests || {}, limits: c.resources?.limits || {} }, ports: (c.ports || []).map(p => ({ name: p.name || '', port: p.containerPort, protocol: p.protocol || 'TCP' })), probes: { readiness: probe(c.readinessProbe), liveness: probe(c.livenessProbe), startup: probe(c.startupProbe) }, references: [...(c.envFrom || []).map(e => ({ kind: e.secretRef ? 'Secret' : 'ConfigMap', name: e.secretRef?.name || e.configMapRef?.name })), ...(c.env || []).filter(e => e.valueFrom?.secretKeyRef || e.valueFrom?.configMapKeyRef).map(e => ({ kind: e.valueFrom.secretKeyRef ? 'Secret' : 'ConfigMap', name: e.valueFrom.secretKeyRef?.name || e.valueFrom.configMapKeyRef?.name }))].filter(e => e.name) };
    }),
    claims: [...new Set((pod.spec?.volumes || []).map(v => v.persistentVolumeClaim?.claimName).filter(Boolean))].slice(0, 10)
  };
}
export function redactDescribe(raw) {
  const output = []; let skippedIndent = null;
  for (const line of String(raw).split(/\r?\n/)) {
    const indent = line.match(/^\s*/)[0].length;
    if (skippedIndent !== null) { if (!line.trim() || indent > skippedIndent) continue; skippedIndent = null; }
    if (/^\s*(?:Environment(?: Variables from)?|Annotations|Command|Args):/.test(line)) {
      output.push(line.replace(/:.*/, ': [values omitted]')); skippedIndent = indent; continue;
    }
    if (/^\s*(?:Liveness|Readiness|Startup):/i.test(line)) { output.push(line.replace(/:.*/, ': [probe details omitted; see structured probes]')); continue; }
    output.push(line);
  }
  return output.join('\n');
}
export function eventList(result) {
  return (result.items || []).map(e => ({ object: `${e.involvedObject?.kind || e.regarding?.kind || ''}/${e.involvedObject?.name || e.regarding?.name || ''}`, type: e.type || 'Normal', reason: e.reason || '', message: text(e.message || e.note), count: e.series?.count ?? e.count ?? 1, firstAt: e.firstTimestamp || e.eventTime || e.metadata?.creationTimestamp || null, lastAt: e.series?.lastObservedTime || e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || null })).sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0)).slice(0, LIMIT);
}
export function summarizeWorkload(w) {
  return { name: w.metadata.name, kind: w.kind, generation: w.metadata.generation ?? null, observedGeneration: w.status?.observedGeneration ?? null, desired: w.kind === 'DaemonSet' ? w.status?.desiredNumberScheduled ?? null : w.spec?.replicas ?? null, ready: w.kind === 'DaemonSet' ? w.status?.numberReady ?? 0 : w.status?.readyReplicas ?? 0, available: w.kind === 'DaemonSet' ? w.status?.numberAvailable ?? null : w.status?.availableReplicas ?? null, updated: w.status?.updatedReplicas ?? w.status?.updatedNumberScheduled ?? null, conditions: conditions(w), strategy: w.spec?.strategy?.type || w.spec?.updateStrategy?.type || null, paused: Boolean(w.spec?.paused) };
}
export function diagnosticFindings(report) {
  const findings = []; const add = (title, evidence, next) => findings.push({ title, evidence, next });
  for (const condition of report.pod?.conditions || []) if (condition.status === 'False') add(`${condition.type} is False`, condition.message || condition.reason || 'The pod condition is not satisfied.', 'Inspect matching events and probe configuration below.');
  for (const c of report.pod?.containers || []) {
    if (c.lastExit === 'OOMKilled' || c.state === 'OOMKilled') add(`${c.name}: OOMKilled`, `Last exit ${c.exitCode ?? 'unknown'}; memory limit ${c.resources.limits.memory || 'not set'}.`, 'Compare usage and limits; current metrics are not historical peak usage.');
    if (/CreateContainerConfigError|CreateContainerError/.test(c.state)) add(`${c.name}: startup configuration failure`, c.state, 'Inspect configuration/mount events and the referenced Secret/ConfigMap names; values are omitted.');
    else if (/CrashLoopBackOff/.test(c.state)) add(`${c.name}: repeated crash`, `${c.restarts} restarts; last exit ${c.lastExit || c.exitCode || 'unknown'}.`, 'Use previous-instance logs to find the error preceding the restart.');
    else if (/ImagePullBackOff|ErrImagePull/.test(c.state)) add(`${c.name}: image pull failure`, c.image, 'Read image/registry events; verify the expected image tag and registry access with your platform team.');
    if (c.type === 'app' && !c.probes.readiness) add(`${c.name}: no readiness probe`, 'Kubernetes readiness may not detect a functional application failure.', 'Compare user-facing symptoms with service backends and logs.');
  }
  for (const pvc of report.storage || []) if (pvc.phase !== 'Bound') add(`Storage claim ${pvc.name}: ${pvc.phase}`, `Storage class ${pvc.storageClass || 'default/unspecified'}; requested ${pvc.requested || 'unspecified'}.`, 'Inspect volume provisioning and FailedMount/FailedScheduling events.');
  for (const service of report.services || []) if (service.endpointsKnown && service.readyEndpoints === 0) add(`${service.name}: no ready service backends`, `${service.totalEndpoints} endpoints reported in EndpointSlices.`, 'Compare the service selector, pod labels/readiness, and target ports. A running pod alone does not guarantee a working service.');
  for (const service of report.services || []) for (const p of service.ports) if (typeof p.targetPort === 'string' && !(report.pod?.containers || []).some(c => c.type === 'app' && (c.ports || []).some(cp => cp.name === p.targetPort && cp.protocol === p.protocol))) add(`${service.name}: target port name is not declared`, `Service targetPort ${p.targetPort} has no matching application container port.`, 'Inspect the Service targetPort name and declared container ports.');
  for (const route of report.routes || []) if (route.admitted !== true) add(`${route.name}: route admission ${route.admitted === false ? 'failed' : 'unknown'}`, route.reason || 'No confirmed router admission.', 'Review route admission and service/target-port configuration with the platform team.');
  for (const q of report.quotas || []) for (const [resource, hard] of Object.entries(q.hard)) if (q.used[resource] !== undefined && String(q.used[resource]) === String(hard)) add(`Quota ${q.name}: ${resource} at its limit`, `${q.used[resource]} used / ${hard} hard limit (equal reported quantities).`, 'Look for quota rejection in workload events; matching quantity strings are only a simple saturation indicator.');
  const warnings = (report.events || []).filter(e => e.type === 'Warning');
  if (warnings.length) add(`${warnings.length} recent warning event groups`, [...new Set(warnings.map(e => e.reason))].slice(0, 5).join(', '), 'Check timestamps: events can describe an earlier issue that has already recovered.');
  if (!findings.length) add('No obvious issue in the available evidence', 'The collected state did not match a known failure pattern.', 'Inspect logs and confirm application behavior. Missing optional permissions may limit this report.');
  return findings.slice(0, 30);
}
export function diagnosticText(r) {
  const rows = ['OpenShift Watch — read-only diagnostic report', `Collected: ${r.collectedAt}`, `Context: ${r.context}`, `Project: ${r.namespace}`, `Workload: ${r.kind}/${r.name}`, `Pod: ${r.pod?.name || 'not observed'}`, `Phase: ${r.pod?.phase || 'unknown'} | Node: ${r.pod?.node || 'unknown'}`];
  if (r.workload) rows.push(`Replicas: ${r.workload.ready}/${r.workload.desired ?? '?'} ready; generation ${r.workload.observedGeneration ?? '?'}/${r.workload.generation ?? '?'}`);
  for (const c of r.pod?.containers || []) rows.push(`Container ${c.name}: ${c.state}; ${c.restarts} restarts; last exit ${c.lastExit || c.exitCode || 'n/a'}`);
  rows.push('', 'Findings:'); for (const f of r.findings) rows.push(`- ${f.title}: ${f.evidence}`, `  Next: ${f.next}`);
  rows.push('', 'Recent events:'); for (const e of (r.events || []).slice(0, 20)) rows.push(`- ${e.lastAt || ''} ${e.object} ${e.type} ${e.reason} x${e.count}: ${e.message}`);
  if (r.errors.length) { rows.push('', 'Unavailable checks:'); for (const e of r.errors) rows.push(`- ${e.section}: ${e.message}`); }
  rows.push('', 'No logs, environment values, secret contents, annotations, or raw describe output are included.');
  return rows.join('\n');
}

export class DiagnosticsService {
  constructor(monitor) { this.monitor = monitor; this.active = new Set(); this.cache = new Map(); }
  validate(input) {
    if (!input || typeof input.appId !== 'string') throw new Error('Select a monitored application.');
    if (Object.keys(input).some(k => !['appId', 'pod', 'refresh'].includes(k))) throw new Error('Only application, pod, and refresh settings are accepted.');
    const app = this.monitor.state.apps.find(a => a.id === input.appId);
    if (!app || !this.monitor.selected.includes(app.namespace) || !kinds[app.kind]) throw new Error('Application is not available for diagnostics.');
    resourceName(app.name);
    if (input.pod && !app.pods.some(p => p.name === input.pod)) throw new Error('Pod is not part of this application.');
    if (input.pod) resourceName(input.pod);
    if (input.refresh !== undefined && typeof input.refresh !== 'boolean') throw new Error('Refresh must be true or false.');
    return app;
  }
  async load(input, callerSignal) {
    const app = this.validate(input); const selectedPod = app.pods.find(p => p.name === input.pod) || app.pods.find(p => !p.ready && !p.completed) || app.pods[0];
    const key = `${app.id}/${selectedPod?.name || ''}/${selectedPod?.uid || ''}/${this.monitor.state.checkedAt || ''}`;
    for (const [key, value] of this.cache) if (Date.now() - value.time >= 10000) this.cache.delete(key);
    if (!input.refresh && this.cache.has(key)) return { ...this.cache.get(key).report, cached: true };
    if (this.active.size >= 2) { const error = new Error('Two diagnostic collections are already running. Try again shortly.'); error.status = 429; throw error; }
    const controller = new AbortController(); this.active.add(controller);
    const cancel = () => controller.abort(); if (callerSignal?.aborted) cancel(); else callerSignal?.addEventListener('abort', cancel, { once: true });
    const report = { name: app.name, kind: app.kind, namespace: app.namespace, context: this.monitor.client.context, collectedAt: null, cached: false, pod: null, workload: null, events: [], services: [], routes: [], storage: [], quotas: [], limitRanges: [], metrics: null, describe: null, errors: [], notices: [] };
    const read = async (section, action) => {
      if (controller.signal.aborted) return null;
      try { return await action(); } catch (error) { report.errors.push({ section, message: error.message }); return null; }
    };
    const object = (section, resource, options = {}) => read(section, () => this.monitor.client.readObject(app.namespace, resource, { ...options, signal: controller.signal }));
    try {
      const [pod, workload, quotas] = await Promise.all([
        selectedPod ? object('Pod', 'pods', { name: selectedPod.name }) : null,
        object('Workload', kinds[app.kind], { name: app.name }),
        object('Quotas', 'resourcequotas')
      ]);
      const freshPod = pod && (!selectedPod.uid || !pod.metadata.uid || selectedPod.uid === pod.metadata.uid) ? pod : null;
      if (pod && !freshPod) report.errors.push({ section: 'Pod', message: 'Pod identity changed. Click Check now before inspecting the replacement.' });
      if (freshPod) report.pod = summarizePod(freshPod);
      if (workload) report.workload = summarizeWorkload(workload);
      if (quotas) report.quotas = (quotas.items || []).slice(0, 30).map(q => ({ name: q.metadata.name, used: q.status?.used || {}, hard: q.status?.hard || q.spec?.hard || {} }));
      const eventUid = freshPod?.metadata.uid || workload?.metadata.uid;
      const [events, services, limits] = await Promise.all([
        object('Events', 'events', eventUid ? { uid: eventUid } : { objectName: freshPod?.metadata.name || app.name }),
        freshPod ? object('Services', 'services') : null,
        object('Limit ranges', 'limitranges')
      ]);
      if (events) { report.events = eventList(events); if ((events.items || []).length > LIMIT) report.notices.push('Only the latest 200 event groups are shown.'); }
      if (limits) report.limitRanges = (limits.items || []).slice(0, 30).map(l => ({ name: l.metadata.name, limits: (l.spec?.limits || []).slice(0, 10) }));
      const matched = (services?.items || []).filter(s => Object.keys(s.spec?.selector || {}).length && Object.entries(s.spec.selector).every(([k, v]) => freshPod?.metadata.labels?.[k] === v));
      if (matched.length > 5) report.notices.push('Service checks are limited to five matching services.');
      report.services = matched.slice(0, 5).map(s => ({ name: s.metadata.name, type: s.spec?.type || 'ClusterIP', clusterIP: s.spec?.clusterIP || null, selector: s.spec?.selector || {}, ports: (s.spec?.ports || []).map(p => ({ name: p.name || '', port: p.port, targetPort: p.targetPort ?? p.port, protocol: p.protocol || 'TCP' })), readyEndpoints: null, totalEndpoints: null, endpointsKnown: false }));
      const jobs = [];
      if (freshPod?.metadata.uid && workload?.metadata.uid && freshPod.metadata.uid !== workload.metadata.uid) jobs.push(async () => {
        const ownerEvents = await object('Workload events', 'events', { uid: workload.metadata.uid });
        if (ownerEvents) report.events = [...report.events, ...eventList(ownerEvents)].sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0)).slice(0, LIMIT);
      });
      if (freshPod) {
        jobs.push(async () => { const raw = await read('Describe pod', () => this.monitor.client.describePod(app.namespace, freshPod.metadata.name, controller.signal)); if (raw !== null) report.describe = redactDescribe(raw); });
        jobs.push(async () => { report.metrics = await read('Live resource usage', () => this.monitor.client.podMetrics(app.namespace, freshPod.metadata.name, controller.signal)); });
      }
      for (const claim of report.pod?.claims || []) jobs.push(async () => {
        const pvc = await object(`Storage: ${claim}`, 'persistentvolumeclaims', { name: claim });
        if (pvc) report.storage.push({ name: claim, phase: pvc.status?.phase || 'Unknown', storageClass: pvc.spec?.storageClassName || null, requested: pvc.spec?.resources?.requests?.storage || null, capacity: pvc.status?.capacity?.storage || null });
      });
      for (const service of report.services) jobs.push(async () => {
        const slices = await object(`Backends: ${service.name}`, 'endpointslices.discovery.k8s.io', { service: service.name });
        if (slices) {
          // Deduplicate addresses + target UID across slices, including terminating endpoints.
          const endpoints = new Map();
          for (const slice of slices.items || []) for (const e of slice.endpoints || []) for (const address of e.addresses || []) endpoints.set(`${e.targetRef?.uid || ''}/${address}`, e);
          service.endpointsKnown = true; service.totalEndpoints = endpoints.size; service.readyEndpoints = [...endpoints.values()].filter(e => e.conditions?.ready !== false && e.conditions?.terminating !== true).length;
        }
      });
      if (report.services.length) jobs.push(async () => {
        const routes = await object('OpenShift routes', 'routes.route.openshift.io');
        if (routes) report.routes = (routes.items || []).filter(r => report.services.some(s => (s.name === r.spec?.to?.name && (r.spec?.to?.weight ?? 100) > 0) || (r.spec?.alternateBackends || []).some(b => b.name === s.name && (b.weight ?? 100) > 0))).slice(0, 20).map(r => {
          const admissions = (r.status?.ingress || []).flatMap(i => i.conditions || []).filter(c => c.type === 'Admitted');
          return { name: r.metadata.name, host: r.spec?.host || null, service: r.spec?.to?.name || '', targetPort: r.spec?.port?.targetPort ?? null, admitted: admissions.some(c => c.status === 'True') ? true : admissions.length ? false : null, reason: admissions.filter(c => c.status !== 'True').map(c => c.reason || c.message).join('; ') };
        });
      });
      for (let i = 0; i < jobs.length && !controller.signal.aborted; i += 3) await Promise.all(jobs.slice(i, i + 3).map(job => job()));
      if (controller.signal.aborted) throw new Error('Diagnostic collection cancelled.');
      if (!this.monitor.selected.includes(app.namespace)) throw new Error('Project is no longer monitored.');
      report.collectedAt = new Date().toISOString(); report.findings = diagnosticFindings(report); report.summary = diagnosticText(report);
      if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { time: Date.now(), report }); return report;
    } finally { callerSignal?.removeEventListener('abort', cancel); this.active.delete(controller); }
  }
  close() { for (const controller of this.active) controller.abort(); this.cache.clear(); }
}
