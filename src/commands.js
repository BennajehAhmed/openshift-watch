// This is the final boundary for every oc process started by the app.
export const readResources = new Set(['projects', 'pods', 'deployments.apps', 'deploymentconfigs.apps.openshift.io', 'statefulsets.apps', 'daemonsets.apps', 'replicasets.apps', 'replicationcontrollers', 'jobs.batch', 'builds.build.openshift.io', 'events', 'services', 'endpointslices.discovery.k8s.io', 'routes.route.openshift.io', 'resourcequotas', 'limitranges', 'persistentvolumeclaims']);
export function resourceName(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value)) throw new Error('Invalid resource name.');
  return value;
}
export function assertReadOnly(args) {
  const reject = () => { throw new Error('Only approved read-only OpenShift commands are allowed.'); };
  if (!Array.isArray(args) || args.length > 24 || args.some(a => typeof a !== 'string' || a.length > 512)) reject();
  if (args.length === 2 && args[0] === 'config' && args[1] === 'current-context') return;
  let rest, verb = args[0], resource;
  if (verb === 'get' || verb === 'describe') {
    resource = args[1]; if (!readResources.has(resource)) reject(); rest = args.slice(2);
    if (rest[0] && !rest[0].startsWith('-')) { resourceName(rest[0]); rest = rest.slice(1); }
    else if (verb === 'describe') reject();
  } else if (verb === 'logs') { resourceName(args[1]); rest = args.slice(2); }
  else if (verb === 'adm' && args[1] === 'top' && args[2] === 'pod') { resourceName(args[3]); rest = args.slice(4); }
  else reject();
  let namespace = false; const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i], key = token.split('=')[0];
    if (seen.has(key)) reject(); seen.add(key);
    if (/^--namespace=[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(token) && token.slice(12).length <= 63) { namespace = true; continue; }
    if (/^--request-timeout=(?:0|[1-9]\d{0,2})s?$/.test(token)) continue;
    if (verb === 'get' && token === '-o' && rest[++i] === 'json') continue;
    if (verb === 'get' && resource === 'events' && /^--field-selector=involvedObject\.(?:uid|name)=[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/.test(token)) continue;
    if (verb === 'get' && resource === 'endpointslices.discovery.k8s.io' && /^--selector=kubernetes\.io\/service-name=[a-z0-9][a-z0-9.-]*$/.test(token)) continue;
    if (verb === 'describe' && token === '--show-events=false') continue;
    if (verb === 'adm' && ['--containers', '--no-headers'].includes(token)) continue;
    if (verb === 'logs' && (/^--container=[a-z0-9][a-z0-9.-]*$/.test(token) || /^--tail=(?:[1-9]\d{0,3}|10000)$/.test(token) || /^--since=[1-9]\d{0,5}s$/.test(token) || ['--timestamps=true', '--previous=true', '--follow=true', '--limit-bytes=1048576'].includes(token))) continue;
    reject();
  }
  if (!namespace && resource !== 'projects') reject();
}
