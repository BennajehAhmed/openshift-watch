import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticsService, summarizePod, redactDescribe, eventList } from '../src/diagnostics.js';
import { Monitor } from '../src/monitor.js';
import { DemoClient } from '../src/demo.js';

async function setup(scenario = 'healthy') {
  const client = new DemoClient(); client.scenario = scenario;
  const monitor = await new Monitor({ demo: true, namespaces: [], pollSeconds: 30, alertAfter: 2, alertDegraded: true }, client).initialize(); monitor.stop(); await monitor.tick();
  const app = monitor.state.apps.find(a => a.name === 'catalog-api' && a.namespace === 'payments-dev');
  return { monitor, client, service: new DiagnosticsService(monitor), input: { appId: app.id } };
}
test('one diagnostic collection joins conditions, events, probes, limits, metrics, services, routes, quota and storage', async () => {
  const { service, input } = await setup('oom'); const r = await service.load(input);
  assert.equal(r.pod.containers[0].lastExit, 'OOMKilled'); assert.ok(r.events.length); assert.ok(r.metrics.includes('92Mi')); assert.equal(r.pod.containers[0].resources.limits.memory, '256Mi');
  assert.match(r.pod.containers[0].probes.readiness.action, /ready/); assert.equal(r.services[0].readyEndpoints, 0); assert.equal(r.routes[0].admitted, true); assert.equal(r.storage[0].phase, 'Bound'); assert.ok(r.quotas.length); assert.ok(r.limitRanges.length);
  assert.ok(r.findings.some(f => f.title.includes('OOMKilled'))); assert.ok(r.findings.some(f => f.title.includes('no ready service backends'))); assert.equal(r.errors.length, 0);
});
test('storage, probe, route and quota failures produce their own evidence findings', async () => {
  for (const [scenario, pattern] of [['storage', /Storage claim/], ['probe', /Ready is False/], ['route', /route admission/], ['quota', /at its limit/]]) {
    const { service, input } = await setup(scenario); const r = await service.load(input); assert.ok(r.findings.some(f => pattern.test(f.title)), scenario);
    if (scenario === 'quota') { assert.equal(r.pod, null); assert.ok(r.workload); assert.ok(r.events.length); }
  }
});
test('structured summary and describe output omit env values, annotations, commands and probe credentials', async () => {
  const { client, input, service } = await setup(); const pod = await client.readObject('payments-dev', 'pods', { name: 'catalog-api-demo-0' });
  pod.spec.containers[0].env = [{ name: 'PASSWORD', value: 'sensitive-env-value' }]; pod.spec.containers[0].command = ['sensitive-command']; pod.metadata.annotations = { secret: 'sensitive-annotation' };
  pod.spec.containers[0].readinessProbe.httpGet.httpHeaders = [{ name: 'Authorization', value: 'sensitive-header' }];
  const summary = JSON.stringify(summarizePod(pod)); for (const value of ['sensitive-env-value', 'sensitive-command', 'sensitive-annotation', 'sensitive-header']) assert.ok(!summary.includes(value));
  const raw = 'Name: api\nAnnotations: sensitive-annotation\n  extra: sensitive-extra\nContainers:\n  web:\n    Command:\n      sensitive-command\n    Args:\n      sensitive-argument\n    Environment:\n      PASSWORD: sensitive-env-value\n    Readiness: exec sensitive-header\n    Mounts:\n      /data\n';
  const clean = redactDescribe(raw); for (const value of ['sensitive-annotation', 'sensitive-extra', 'sensitive-command', 'sensitive-argument', 'sensitive-env-value', 'sensitive-header']) assert.ok(!clean.includes(value)); assert.ok(clean.includes('/data'));
  const r = await service.load(input); assert.ok(!r.summary.includes('demonstration value')); assert.ok(!r.describe.includes('demonstration value'));
});
test('failed optional reads keep usable data, and an absent API is not reported healthy', async () => {
  const { client, service, input } = await setup(); client.podMetrics = async () => { throw new Error('Metrics permission denied.'); };
  const read = client.readObject.bind(client); client.readObject = (ns, resource, options) => resource === 'endpointslices.discovery.k8s.io' ? Promise.reject(new Error('Unavailable API.')) : read(ns, resource, options);
  const r = await service.load(input); assert.equal(r.errors.length, 2); assert.ok(r.pod && r.workload && r.events.length); assert.equal(r.services[0].endpointsKnown, false); assert.equal(r.services[0].readyEndpoints, null);
});
test('cache avoids repeated requests; explicit refresh bypasses it', async () => {
  const { client, service, input } = await setup(); let calls = 0; const read = client.readObject.bind(client); client.readObject = (...args) => { calls++; return read(...args); };
  const first = await service.load(input); const count = calls; const cached = await service.load(input); assert.equal(cached.cached, true); assert.equal(calls, count); assert.equal(cached.collectedAt, first.collectedAt);
  await service.load({ ...input, refresh: true }); assert.ok(calls > count);
});
test('a new health observation invalidates an older diagnostic cache', async () => {
  const { client, service, input, monitor } = await setup(); await service.load(input);
  client.scenario = 'route'; monitor.state.checkedAt = new Date(Date.now() + 1).toISOString();
  const r = await service.load(input); assert.equal(r.cached, false); assert.ok(r.findings.some(f => f.title.includes('route admission')));
});
test('only known apps and their own pods in monitored namespaces can be inspected', async () => {
  const { service, input, monitor } = await setup();
  for (const change of [{ appId: 'dev/Secret/password' }, { pod: '--help' }, { pod: 'other-app' }, { refresh: 'true' }]) await assert.rejects(() => service.load({ ...input, ...change }));
  monitor.selected = []; await assert.rejects(() => service.load(input));
});
test('replaced pod identity is not mixed into an earlier observation', async () => {
  const { client, service, input } = await setup(); const read = client.readObject.bind(client);
  client.readObject = async (ns, resource, options) => { const result = await read(ns, resource, options); if (resource === 'pods' && options.name) result.metadata.uid = 'replacement'; return result; };
  const r = await service.load(input); assert.equal(r.pod, null); assert.ok(r.errors.some(e => e.message.includes('identity changed'))); assert.equal(r.describe, null);
});
test('concurrent collections are capped, and abort/shutdown clean up active reads', async () => {
  const { client, service, input } = await setup();
  client.readObject = (ns, resource, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  const first = service.load(input), second = service.load(input); await assert.rejects(() => service.load(input), e => e.status === 429);
  service.close(); const results = await Promise.allSettled([first, second]); assert.ok(results.every(r => r.status === 'rejected')); assert.equal(service.active.size, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => service.load(input, controller.signal)); assert.equal(service.active.size, 0);
});
test('event history is sorted by last occurrence and bounded to 200 groups', () => {
  const r = eventList({ items: Array.from({ length: 1000 }, (_, i) => ({ type: 'Warning', reason: `E${i}`, message: 'message', lastTimestamp: new Date(1700000000000 + i * 1000).toISOString() })) });
  assert.equal(r.length, 200); assert.equal(r[0].reason, 'E999');
});
