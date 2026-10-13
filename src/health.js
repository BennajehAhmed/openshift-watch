const controllers = new Set(['Deployment', 'DeploymentConfig', 'StatefulSet', 'DaemonSet']);
const owner = item => item.metadata?.ownerReferences?.find(o => o.controller) || item.metadata?.ownerReferences?.[0];
const refKey = (kind, name) => `${kind}/${name}`;

export function podHealth(pod) {
  const phase = pod.status?.phase || 'Unknown';
  const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || []), ...(pod.status?.ephemeralContainerStatuses || [])];
  const restarts = statuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);
  const reason = statuses.map(c => c.state?.waiting?.reason || (c.state?.terminated?.exitCode ? c.state.terminated.reason || 'ContainerFailed' : '')).find(Boolean);
  const ready = phase === 'Running' && !pod.metadata.deletionTimestamp && pod.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') && (pod.status?.containerStatuses || []).every(c => c.ready && !c.state?.waiting && !c.state?.terminated);
  const completed = phase === 'Succeeded';
  return {
    name: pod.metadata.name, uid: pod.metadata.uid || null, phase, ready: Boolean(ready), completed, restarts,
    owner: owner(pod) ? { kind: owner(pod).kind, name: owner(pod).name } : null,
    status: completed ? 'completed' : ready ? 'healthy' : 'down',
    reason: pod.metadata.deletionTimestamp ? 'Terminating' : reason || pod.status?.reason || (ready ? 'Ready' : phase),
    conditions: (pod.status?.conditions || []).filter(c => c.status !== 'True').map(c => ({ type: c.type, reason: c.reason || '', message: String(c.message || '').slice(0, 1000) })),
    containers: [...new Set([...(pod.spec?.containers || []), ...(pod.spec?.initContainers || []), ...(pod.spec?.ephemeralContainers || []), ...statuses].map(c => c.name))].map(name => {
      const c = statuses.find(s => s.name === name) || {};
      return { name, type: (pod.spec?.initContainers || []).some(s => s.name === name) ? 'init' : (pod.spec?.ephemeralContainers || []).some(s => s.name === name) ? 'ephemeral' : 'app', ready: Boolean(c.ready), restarts: c.restartCount || 0, reason: c.state?.waiting?.reason || c.state?.terminated?.reason || (c.state?.running ? 'Running' : 'Not started'), lastReason: c.lastState?.terminated?.reason || '', exitCode: c.state?.terminated?.exitCode ?? c.lastState?.terminated?.exitCode ?? null };
    })
  };
}
function selectorMatches(selector, labels = {}) {
  if (!selector) return false;
  const matchLabels = selector.matchLabels || (selector.matchExpressions ? {} : selector);
  if (!Object.keys(matchLabels).length && !selector.matchExpressions?.length) return false;
  if (!Object.entries(matchLabels).every(([k, v]) => labels[k] === v)) return false;
  return (selector.matchExpressions || []).every(e => {
    if (e.operator === 'In') return e.values.includes(labels[e.key]);
    if (e.operator === 'NotIn') return !e.values.includes(labels[e.key]);
    if (e.operator === 'Exists') return e.key in labels;
    if (e.operator === 'DoesNotExist') return !(e.key in labels);
    return false;
  });
}

export function buildApps(namespace, collection) {
  const { items, errors = [] } = collection;
  const pods = items.filter(i => i.kind === 'Pod');
  const index = new Map(items.map(i => [refKey(i.kind, i.metadata.name), i]));
  const workloads = items.filter(i => controllers.has(i.kind));
  const assigned = new Set();
  const roots = new Map();
  for (const pod of pods) {
    let current = pod; const seen = new Set();
    for (let depth = 0; depth < 10; depth++) {
      const o = owner(current);
      if (!o) break;
      const key = refKey(o.kind, o.name);
      if (seen.has(key)) break;
      seen.add(key);
      if (controllers.has(o.kind)) { roots.set(pod.metadata.name, key); break; }
      current = index.get(key);
      if (!current) break;
      // Older OpenShift RCs may use an annotation rather than an owner reference.
      const dc = current.metadata.annotations?.['openshift.io/deployment-config.name'] || current.metadata.labels?.['openshift.io/deployment-config.name'];
      if (dc) { roots.set(pod.metadata.name, refKey('DeploymentConfig', dc)); break; }
    }
  }
  const podsUnknown = errors.some(e => e.resource === 'pods');
  const apps = workloads.map(w => {
    const key = refKey(w.kind, w.metadata.name);
    const matched = pods.filter(p => {
      const root = roots.get(p.metadata.name);
      if (root) return root === key;
      // Selector fallback only if the ownership chain could not be read.
      return !assigned.has(p.metadata.name) && selectorMatches(w.spec?.selector, p.metadata.labels);
    });
    matched.forEach(p => assigned.add(p.metadata.name));
    const health = matched.map(p => ({ ...podHealth(p), workload: roots.get(p.metadata.name) || null }));
    const desired = w.kind === 'DaemonSet' ? w.status?.desiredNumberScheduled : (w.spec?.replicas ?? 1);
    const ready = health.filter(p => p.ready).length;
    const available = w.kind === 'DaemonSet' ? w.status?.numberAvailable : w.status?.availableReplicas;
    const conditionFailure = (w.status?.conditions || []).find(c => (c.type === 'ReplicaFailure' && c.status === 'True') || (c.type === 'Progressing' && c.status === 'False'));
    const observed = w.status?.observedGeneration;
    const fresh = observed !== undefined && observed >= (w.metadata.generation || 0);
    let status, reason;
    if (podsUnknown || desired === undefined) { status = 'unknown'; reason = 'Incomplete observation'; }
    else if (desired === 0) { status = 'scaled-zero'; reason = w.kind === 'DaemonSet' ? 'No eligible nodes' : 'Intentionally scaled to zero'; }
    else if (ready === 0) { status = 'down'; reason = health.find(p => !p.completed)?.reason || 'No ready pods'; }
    else if (ready < desired || health.some(p => !p.ready && !p.completed) || conditionFailure || !fresh || (available !== undefined && available < desired)) {
      status = 'degraded'; reason = conditionFailure?.reason || (!fresh ? 'Controller is reconciling' : `${ready}/${desired} replicas ready; rollout or pod issue`);
    } else { status = 'healthy'; reason = 'All desired replicas ready'; }
    return { id: `${namespace}/${key}`, namespace, name: w.metadata.name, kind: w.kind, status, reason, desired, ready, available: available ?? null, pods: health };
  });
  // Show jobs/builds/standalone pods separately; successful one-off jobs are completed.
  const groups = new Map();
  for (const p of pods.filter(p => !assigned.has(p.metadata.name))) {
    const o = owner(p); const key = o ? refKey(o.kind, o.name) : refKey('Pod', p.metadata.name);
    if (!groups.has(key)) groups.set(key, { name: o?.name || p.metadata.name, kind: o?.kind || 'Pod', pods: [] });
    groups.get(key).pods.push(podHealth(p));
  }
  for (const [key, group] of groups) {
    const ready = group.pods.filter(p => p.ready).length;
    const active = group.pods.filter(p => !p.completed);
    const status = !active.length ? 'completed' : ready === active.length ? 'healthy' : ready ? 'degraded' : 'down';
    apps.push({ id: `${namespace}/${key}`, namespace, ...group, ready, desired: active.length, available: null, status, reason: active.find(p => !p.ready)?.reason || (active.length ? 'Ready' : 'Completed') });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}
