import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Monitor } from '../src/monitor.js';
import { DemoClient } from '../src/demo.js';

test('log HTTP endpoints enforce CSRF, return bounded snapshots, and stop live reads on abort', async () => {
  const config = { demo: true, namespaces: [], pollSeconds: 30, alertAfter: 2, alertDegraded: true, port: 3100 };
  const monitor = await new Monitor(config, new DemoClient()).initialize(); monitor.stop(); await monitor.tick();
  const app = createApp(monitor), server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); config.port = server.address().port;
  const url = `http://127.0.0.1:${config.port}`, html = await (await fetch(url)).text();
  const csrf = html.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
  const options = { namespace: 'payments-dev', pod: 'catalog-api-demo-0', container: 'app', tail: 5000 };
  const request = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + '/api/logs', { method: 'POST' })).status, 403);
    const snapshot = await request('/api/logs', options); assert.equal(snapshot.status, 200); const data = await snapshot.json(); assert.equal(data.lines.length, 5000); assert.ok(data.bytes <= 1048576);
    assert.equal((await request('/api/logs', { ...options, container: 'other' })).status, 400);
    assert.equal((await request('/api/logs/follow', { ...options, previous: true })).status, 400);
    const controller = new AbortController();
    const live = await fetch(url + '/api/logs/follow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ ...options, tail: 500 }), signal: controller.signal });
    assert.equal(live.status, 200); assert.match(live.headers.get('content-type'), /ndjson/); const reader = live.body.getReader();
    const first = await reader.read(); assert.ok(new TextDecoder().decode(first.value).includes('start')); controller.abort();
    for (let i = 0; app.locals.logs.active.size && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(app.locals.logs.active.size, 0);
    monitor.client.scenario = 'outage'; await monitor.tick(); await monitor.tick(); assert.equal(monitor.state.incidents.length, 1);
    const advice = await (await fetch(url + `/api/advice?appId=${encodeURIComponent(monitor.state.apps.find(a => a.status === 'down').id)}`)).json(); assert.match(advice.issue, /repeatedly exits/);
    assert.equal((await fetch(url + '/api/incidents/clear', { method: 'POST' })).status, 403);
    const cleared = await (await request('/api/incidents/clear', { scope: 'all' })).json(); assert.equal(cleared.removed, 1); assert.equal(cleared.state.incidents.length, 0); assert.equal(cleared.state.apps.filter(a => a.status === 'down').length, 1);
    await monitor.tick(); assert.equal(monitor.state.incidents.length, 0); await monitor.tick(); assert.equal(monitor.state.incidents.length, 1);
    assert.equal((await request('/api/incidents/clear', { scope: 'invalid' })).status, 400);
  } finally { app.locals.logs.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
