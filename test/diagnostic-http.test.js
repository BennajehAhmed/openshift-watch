import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Monitor } from '../src/monitor.js';
import { DemoClient } from '../src/demo.js';

test('diagnostic API requires CSRF, validates targets and accepts no raw command', async () => {
  const config = { demo: true, namespaces: [], pollSeconds: 30, alertAfter: 2, alertDegraded: true, port: 3100 };
  const monitor = await new Monitor(config, new DemoClient()).initialize(); monitor.stop(); await monitor.tick();
  const app = createApp(monitor), server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); config.port = server.address().port;
  const url = `http://127.0.0.1:${config.port}`, html = await (await fetch(url)).text(), csrf = html.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
  const input = { appId: monitor.state.apps[0].id };
  const post = body => fetch(url + '/api/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + '/api/diagnostics', { method: 'POST' })).status, 403);
    const response = await post(input); assert.equal(response.status, 200); const r = await response.json(); assert.ok(r.pod && r.summary && r.describe); assert.ok(r.events.some(e => e.object.startsWith('Deployment/')));
    assert.equal((await post({ ...input, command: 'oc delete pod' })).status, 400); assert.equal((await post({ ...input, pod: '--help' })).status, 400);
    assert.equal((await post({ appId: 'other/Secret/credential' })).status, 400);
    for (const route of ['/api/exec', '/api/command', '/api/delete', '/api/restart']) assert.equal((await fetch(url + route, { method: 'POST', headers: { 'X-CSRF-Token': csrf } })).status, 404);
  } finally { app.locals.logs.close(); app.locals.diagnostics.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
