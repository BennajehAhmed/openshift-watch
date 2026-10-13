import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Monitor } from '../src/monitor.js';
import { DemoClient } from '../src/demo.js';
import http from 'node:http';

test('renders Handlebars and protects state changes, Host and Origin', async () => {
  const config = { demo: true, namespaces: [], pollSeconds: 30, alertAfter: 1, alertDegraded: true, port: 3100 };
  const monitor = await new Monitor(config, new DemoClient()).initialize(); monitor.stop();
  const server = createApp(monitor).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const request = http.request(url + route, { method: options.method || 'GET', headers: { Host: 'localhost:3100', ...options.headers } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, headers: { get: name => response.headers[name] }, text: async () => body, json: async () => JSON.parse(body) }));
    });
    request.on('error', reject); request.end(options.body);
  });
  try {
    const response = await request('/'); const html = await response.text(); assert.equal(response.status, 200); assert.match(html, /Application health/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    const csrf = html.match(/name="csrf-token" content="([a-f0-9]+)"/)[1];
    assert.equal((await request('/api/check', { method: 'POST' })).status, 403);
    assert.equal((await request('/api/state', { headers: { Host: 'attacker.test:3100' } })).status, 403);
    assert.equal((await request('/api/state', { headers: { Origin: 'https://attacker.test' } })).status, 403);
    const check = await request('/api/check', { method: 'POST', headers: { 'X-CSRF-Token': csrf } }); assert.equal(check.status, 200); assert.equal((await check.json()).apps.length, 6);
    const invalid = await request('/api/namespaces', { method: 'POST', headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ namespaces: ['dev;whoami'] }) }); assert.equal(invalid.status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
