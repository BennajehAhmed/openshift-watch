// Local rules only: no logs or cluster information are sent to an AI service.
const kinds = { Deployment: 'deployment', DeploymentConfig: 'deploymentconfig', StatefulSet: 'statefulset', DaemonSet: 'daemonset', ReplicaSet: 'replicaset', ReplicationController: 'replicationcontroller', Job: 'job', Pod: 'pod', Build: 'build' };
// Single-quote arguments for PowerShell; quoted apostrophes are doubled.
const quote = value => `'${String(value).replace(/'/g, "''")}'`;
const arg = value => /^[a-z0-9][a-z0-9./_-]*$/i.test(value) ? value : quote(value);
export function proposeFixes(app, context = '') {
  const base = `oc${context ? ` --context=${quote(context)}` : ''}`;
  const ns = ` --namespace=${arg(app.namespace)}`;
  const cmd = text => base + ' ' + text + ns;
  const steps = [];
  const add = (title, explanation, command = null, risk = 'inspect') => steps.push({ title, explanation, command, risk });
  const pod = app.pods?.find(p => !p.ready && !p.completed) || app.pods?.[0];
  const container = pod?.containers?.find(c => !c.ready && c.type !== 'ephemeral') || pod?.containers?.[0];
  const signals = [...new Set([app.reason, pod?.reason, ...(pod?.containers || []).flatMap(c => [c.reason, c.lastReason]), ...(pod?.conditions || []).map(c => c.reason)].filter(Boolean))];
  const evidence = signals.join(' · ');
  let issue = app.reason || 'Workload needs inspection';
  const resource = kinds[app.kind];
  if (app.kind === 'Monitor' || app.status === 'unknown' || app.stale) {
    issue = 'Current cluster health cannot be established';
    add('Check access from the same terminal', 'Verify VPN/network, kubeconfig context, and account permissions. A failed observation does not prove the app itself is down.', cmd('get pods'));
    add('Renew an expired login', 'Use your approved oc login procedure with the same kubeconfig, then click Check now. Never paste credentials into this dashboard.');
    add('Verify read permissions', 'Ask the platform team for the required read permissions. Logs additionally need get access to pods/log.', cmd('auth can-i get pods/log'));
    return { issue, evidence, confidence: 'Observation unavailable', steps, generatedAt: new Date().toISOString() };
  }
  if (app.status === 'healthy' || app.status === 'completed' || app.status === 'scaled-zero') {
    add('No outage fix indicated', app.status === 'scaled-zero' ? 'Zero replicas are intentional in the observed specification. Confirm whether that matches your desired environment.' : 'The current observation does not indicate an outage. Inspect logs if users are reporting a functional issue.');
    return { issue: app.reason, evidence, confidence: 'Based on cluster state, not an end-to-end check', steps, generatedAt: new Date().toISOString() };
  }
  if (pod) {
    add('Inspect pod events and conditions', 'Events often explain scheduling, image pulls, failed mounts, and readiness failures.', cmd(`describe pod ${arg(pod.name)}`));
    if (container) {
      const logs = `logs ${arg(pod.name)} --container=${arg(container.name)} --tail=200 --timestamps=true`;
      add('Read the failing container logs', 'Use the Logs tab to search recent output and inspect the full line.', cmd(logs));
      if (container.restarts > 0) add('Read logs before the last restart', 'Previous-instance logs can retain the error that caused a crash. They may be unavailable after rotation or pod replacement.', cmd(logs + ' --previous=true'));
    }
  } else if (resource) add('Inspect the workload', 'The controller requests replicas, but none were observed. Look for ReplicaFailure, quotas, scheduling problems, or a planned deletion.', cmd(`describe ${resource} ${arg(app.name)}`));
  if (/OOMKilled/.test(evidence)) {
    issue = 'A container was killed for exceeding available memory';
    add('Check current memory usage', 'Metrics may be unavailable or the container may already have restarted; current usage is not historical proof of the peak.', cmd(`top pod ${arg(pod.name)} --containers`));
    add('Fix memory usage or resource sizing', 'Investigate heap settings, memory leaks, workload size, and configured requests/limits. Change the owning workload through your normal review/deployment process; no arbitrary limit is recommended here.', null, 'change');
  } else if (/ImagePullBackOff|ErrImagePull|InvalidImageName/.test(evidence)) {
    issue = 'The container image could not be pulled';
    add('Correct image or registry access', 'Read pod events, verify the repository/tag, registry availability, and referenced image-pull-secret configuration. Do not expose secret values. Change the workload through your approved process.', null, 'change');
  } else if (/CrashLoopBackOff|ContainerFailed|Error/.test(evidence)) {
    issue = 'The container repeatedly exits or cannot stay running';
    add('Fix the cause before restarting', 'Check current/previous logs, exit code, startup configuration, dependency connectivity, and liveness/startup probes. Kubernetes already retries a crash-looping container.', null, 'change');
  } else if (/Unschedulable|Pending/.test(evidence)) {
    issue = 'The pod has not reached a running, ready state';
    add('Investigate scheduling and storage', 'Use the events from describe pod. Check resource requests/capacity, quotas, node selectors, taints, and persistent volume claims. Container logs may not exist yet.');
  } else if (/CreateContainerConfigError|CreateContainerError|FailedMount|ContainerCreating|PodInitializing/.test(evidence)) {
    issue = 'Container startup is blocked';
    add('Repair the referenced startup resources', 'Inspect events for missing ConfigMaps/Secrets, failed volume mounts, init-container errors, or runtime issues. Correct references through your deployment process.', null, 'change');
  } else if (/Evicted|NodeLost|NodeNotReady/.test(evidence)) {
    issue = 'Pod or node disruption is preventing availability';
    add('Inspect node and capacity problems', 'Ask the platform team to review node readiness, disk/memory pressure, and workload scheduling. Recreating a pod does not fix node pressure.');
  } else {
    issue = pod ? 'Pods are not all ready or the rollout is incomplete' : 'The workload has no observed ready pods';
    add('Review readiness and rollout conditions', 'Inspect readiness dependencies/probes and controller conditions. If a rollout is in progress, observe it before changing the workload.');
  }
  if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(app.kind)) add('Observe rollout status', 'This reads rollout progress; it does not restart the workload.', cmd(`rollout status ${resource}/${arg(app.name)} --timeout=30s`));
  // Deletion is never offered as a root-cause fix for deterministic startup failures.
  const persistentFailure = /OOMKilled|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|InvalidImageName|Pending|Unschedulable|CreateContainer|FailedMount|PodInitializing/.test(evidence);
  if (pod && app.kind === 'Deployment' && pod.owner?.kind === 'ReplicaSet' && pod.workload === `Deployment/${app.name}` && !persistentFailure && !app.missing && !pod.completed) {
    add('Optional: recreate this controller-managed pod', 'Only after investigation suggests a transient pod-specific fault. Confirm its ReplicaSet ownership, other replica capacity, and your change approval. Deletion interrupts that pod, loses its ephemeral data, and may reduce service capacity. The controller normally recreates it. Direct deletion does not enforce a PodDisruptionBudget; never use force deletion.', cmd(`delete pod ${arg(pod.name)}`), 'disruptive');
  }
  add('Verify after any approved change', 'Click Check now, inspect new pod events/logs, and confirm user-facing behavior. Acknowledging or clearing an incident does not repair the app.');
  return { issue, evidence, confidence: 'Suggested investigation based on observed state; verify before changing anything', steps, generatedAt: new Date().toISOString() };
}
