import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApps, podHealth } from '../src/health.js';

const deployment = (replicas = 2, kind = 'Deployment') => ({ kind, metadata: { name: 'api', generation: 3 }, spec: { replicas, selector: { matchLabels: { app: 'api' } } }, status: { observedGeneration: 3, availableReplicas: replicas } });
const pod = (name = 'api-1', ready = true, phase = 'Running') => ({ kind: 'Pod', metadata: { name, labels: { app: 'api' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'api-rs', controller: true }] }, status: { phase, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], containerStatuses: [{ name: 'web', ready, restartCount: 0, state: ready ? { running: {} } : { waiting: { reason: 'CrashLoopBackOff' } } }] } });
const rs = { kind: 'ReplicaSet', metadata: { name: 'api-rs', ownerReferences: [{ kind: 'Deployment', name: 'api', controller: true }] } };
const apps = (items, errors = []) => buildApps('dev', { items, errors });

test('deployment still exists as down when all pods have vanished', () => {
  const [app] = apps([deployment(), rs]); assert.equal(app.status, 'down'); assert.equal(app.ready, 0); assert.equal(app.desired, 2);
});
test('owner chain groups pods, health uses readiness rather than Running alone', () => {
  const [app] = apps([deployment(), rs, pod(), pod('api-2', false)]);
  assert.equal(app.status, 'degraded'); assert.equal(app.ready, 1); assert.equal(app.pods.length, 2);
});
test('healthy deployment has all replicas ready', () => assert.equal(apps([deployment(), rs, pod(), pod('api-2')])[0].status, 'healthy'));
test('intentional scale-to-zero is not an outage', () => assert.equal(apps([deployment(0)])[0].status, 'scaled-zero'));
test('missing pod permission is unknown, never down or healthy', () => assert.equal(apps([deployment()], [{ resource: 'pods', message: 'Forbidden' }])[0].status, 'unknown'));
test('completed jobs do not trigger an outage', () => {
  const p = pod('job-pod', false, 'Succeeded'); p.metadata.ownerReferences = [{ kind: 'Job', name: 'nightly', controller: true }];
  assert.equal(apps([p])[0].status, 'completed');
});
test('terminating pods cannot count as ready', () => {
  const p = pod(); p.metadata.deletionTimestamp = '2026-01-01'; assert.equal(podHealth(p).ready, false);
});
test('ready condition with a waiting container is not healthy', () => {
  const p = pod(); p.status.containerStatuses[0].state = { waiting: { reason: 'ImagePullBackOff' } }; assert.equal(podHealth(p).ready, false);
});
test('init-container failures and restarts are displayed', () => {
  const p = pod('api-1', false, 'Pending'); p.status.initContainerStatuses = [{ restartCount: 4, state: { waiting: { reason: 'InitCrash' } } }];
  assert.equal(podHealth(p).reason, 'InitCrash'); assert.equal(podHealth(p).restarts, 4);
});
test('legacy DC pods are linked through annotated replication controllers', () => {
  const dc = deployment(1, 'DeploymentConfig'); dc.spec.selector = { app: 'api' };
  const rc = { kind: 'ReplicationController', metadata: { name: 'api-1', annotations: { 'openshift.io/deployment-config.name': 'api' } } };
  const p = pod(); p.metadata.ownerReferences = [{ kind: 'ReplicationController', name: 'api-1', controller: true }];
  const result = apps([dc, rc, p]); assert.equal(result.length, 1); assert.equal(result[0].status, 'healthy');
});
test('DaemonSet uses scheduled node count', () => {
  const ds = deployment(1, 'DaemonSet'); ds.status.desiredNumberScheduled = 2; ds.status.numberAvailable = 1;
  const p = pod(); p.metadata.ownerReferences = [{ kind: 'DaemonSet', name: 'api', controller: true }];
  assert.equal(apps([ds, p])[0].status, 'degraded');
});
test('unobserved controller generation stays degraded', () => {
  const d = deployment(1); d.status.observedGeneration = 2; assert.equal(apps([d, rs, pod()])[0].status, 'degraded');
});
test('ownership prevents selector overlap from double counting', () => {
  const other = deployment(1); other.metadata.name = 'other';
  const result = apps([other, deployment(1), rs, pod()]); assert.equal(result.find(a => a.name === 'other').ready, 0); assert.equal(result.find(a => a.name === 'api').ready, 1);
});
