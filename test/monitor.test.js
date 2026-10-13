import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/monitor.js';
import { DemoClient } from '../src/demo.js';

const config = { demo: true, namespaces: [], pollSeconds: 30, alertAfter: 1, alertDegraded: true };
test('connection loss replaces healthy observations with unknown; recovery restores health', async () => {
  const client = new DemoClient(); const monitor = await new Monitor(config, client).initialize(); monitor.stop();
  await monitor.tick(); assert.equal(monitor.state.apps.length, 6);
  client.scenario = 'connection'; await monitor.tick(); assert.ok(monitor.state.apps.every(a => a.status === 'unknown'));
  assert.equal(monitor.state.incidents.filter(i => !i.resolvedAt).length, 2);
  client.scenario = 'healthy'; await monitor.tick(); assert.ok(monitor.state.apps.every(a => a.status === 'healthy')); assert.equal(monitor.state.incidents.filter(i => !i.resolvedAt).length, 0);
});
test('overlapping refreshes share the same check', async () => {
  const client = new DemoClient(); let calls = 0;
  const collect = client.collect.bind(client); client.collect = async ns => { calls++; return collect(ns); };
  const monitor = await new Monitor(config, client).initialize(); monitor.stop();
  const first = monitor.tick(), second = monitor.tick(); assert.equal(first, second); await first; assert.equal(calls, 2);
});
test('a vanished previously monitored workload remains visible and creates an incident', async () => {
  const client = new DemoClient(); const monitor = await new Monitor(config, client).initialize(); monitor.stop(); await monitor.tick();
  client.collect = async () => ({ items: [], errors: [] }); await monitor.tick();
  assert.equal(monitor.state.apps.length, 6); assert.ok(monitor.state.apps.every(a => a.missing && a.status === 'down'));
});
