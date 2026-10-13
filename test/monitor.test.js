import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/monitor.js';
import { DemoClient } from '../src/demo.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
test('clear incident history persists across a restart in live mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openshift-watch-test-'));
  const liveConfig = { ...config, demo: false, namespaces: ['payments-dev'], dataDir: directory };
  try {
    const client = new DemoClient(); client.scenario = 'outage';
    const monitor = await new Monitor(liveConfig, client).initialize(); monitor.stop(); await monitor.tick(); assert.equal(monitor.state.incidents.length, 1);
    await monitor.clearIncidents('all'); assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'incidents.json'), 'utf8')), []);
    const restarted = await new Monitor(liveConfig, new DemoClient()).initialize(); restarted.stop(); assert.equal(restarted.incidents.history.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
