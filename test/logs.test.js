import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LogService, logOptions, logArgs, LOG_LIMITS } from '../src/logs.js';
import { LogBuffer, visibleRange } from '../public/log-model.js';
import { Monitor } from '../src/monitor.js';
import { DemoClient } from '../src/demo.js';

async function setup() { const monitor = await new Monitor({ demo: true, namespaces: [], pollSeconds: 30, alertAfter: 2, alertDegraded: true }, new DemoClient()).initialize(); monitor.stop(); await monitor.tick(); return monitor; }
const input = { namespace: 'payments-dev', pod: 'catalog-api-demo-0', container: 'app', tail: 1000, sinceSeconds: 3600 };
test('log input accepts only monitored pods and containers; limits requests', async () => {
  const monitor = await setup(); assert.equal(logOptions(input, monitor).tail, 1000);
  for (const change of [{ pod: 'api;whoami' }, { pod: '--help' }, { namespace: 'unwatched' }, { container: 'other' }, { tail: -1 }, { tail: 10001 }, { sinceSeconds: -1 }, { previous: 'true' }]) assert.throws(() => logOptions({ ...input, ...change }, monitor));
  assert.throws(() => logOptions({ ...input, previous: true }, monitor, true));
});
test('snapshot command has server-side tail, timestamps and byte limit; follow is bounded by service', () => {
  assert.deepEqual(logArgs({ ...input, previous: true }), ['logs', input.pod, '--namespace=payments-dev', '--container=app', '--tail=1000', '--timestamps=true', '--since=3600s', '--previous=true', '--limit-bytes=1048576', '--request-timeout=15s']);
  const live = logArgs(input, true); assert.ok(live.includes('--follow=true')); assert.ok(!live.some(a => a.startsWith('--limit-bytes=')));
});
test('snapshot keeps bounded output and always releases its slot', async () => {
  const monitor = await setup(); const service = new LogService(monitor);
  monitor.client.logs = async () => 'x'.repeat(LOG_LIMITS.bytes + 100);
  const result = await service.snapshot(input); assert.ok(result.limited); assert.equal(result.bytes, LOG_LIMITS.bytes); assert.equal(service.active.size, 0);
  monitor.client.logs = async () => { throw new Error('No previous instance'); }; await assert.rejects(() => service.snapshot(input)); assert.equal(service.active.size, 0);
});
test('snapshot concurrency is capped and shutdown cancels reads', async () => {
  const monitor = await setup(); const service = new LogService(monitor);
  monitor.client.logs = (o, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  const first = service.snapshot(input), second = service.snapshot(input), third = service.snapshot(input);
  await assert.rejects(() => service.snapshot(input), e => e.status === 429); service.close();
  const results = await Promise.allSettled([first, second, third]); assert.ok(results.every(r => r.status === 'rejected')); assert.equal(service.active.size, 0);
});
test('log snapshots and caller cancellation work when AbortSignal.any is unavailable', async () => {
  const savedAny = AbortSignal.any; AbortSignal.any = undefined;
  try {
    const monitor = await setup(); const service = new LogService(monitor);
    const controller = new AbortController();
    const result = await service.snapshot(input, controller.signal); assert.equal(result.lines.length, 1000);
    monitor.client.logs = (options, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    const pending = service.snapshot(input, controller.signal); controller.abort();
    await assert.rejects(() => pending, /Cancelled/); assert.equal(service.active.size, 0);
  } finally { AbortSignal.any = savedAny; }
});
test('already cancelled requests never start log collection', async () => {
  const monitor = await setup(); const service = new LogService(monitor); let called = false;
  monitor.client.logs = async () => { called = true; return ''; };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => service.snapshot(input, controller.signal), e => e.name === 'AbortError');
  assert.equal(called, false); assert.equal(service.active.size, 0);
});
test('snapshot removes the caller abort listener after success or failure', async () => {
  const monitor = await setup(); const service = new LogService(monitor);
  for (const fails of [false, true]) {
    let attached = 0, detached = 0;
    const signal = { aborted: false, addEventListener: () => attached++, removeEventListener: () => detached++ };
    monitor.client.logs = async () => { if (fails) throw new Error('Failed'); return 'INFO test\n'; };
    if (fails) await assert.rejects(() => service.snapshot(input, signal)); else await service.snapshot(input, signal);
    assert.equal(attached, 1); assert.equal(detached, 1);
  }
});
function streamingSetup(monitor) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); let killed = 0;
  child.kill = () => { killed++; };
  monitor.client.followLogs = () => child;
  const response = new EventEmitter(); const packets = [];
  response.status = () => response; response.set = () => response; response.flushHeaders = () => {};
  response.write = value => { packets.push(JSON.parse(value)); return true; };
  response.end = () => { response.writableEnded = true; };
  return { child, response, packets, killed: () => killed };
}
test('live logs decode split UTF-8 and stop child on disconnect', async () => {
  const monitor = await setup(); const service = new LogService(monitor); const stream = streamingSetup(monitor);
  service.follow(input, stream.response);
  const encoded = Buffer.from('INFO café 😃\nERROR fail\n');
  stream.child.stdout.write(encoded.subarray(0, 12)); stream.child.stdout.write(encoded.subarray(12));
  stream.response.emit('close');
  assert.deepEqual(stream.packets.filter(p => p.type === 'lines').flatMap(p => p.lines), ['INFO café 😃', 'ERROR fail']); assert.equal(stream.killed(), 1); assert.equal(service.active.size, 0);
});
test('live stream applies backpressure and resumes on drain', async () => {
  const monitor = await setup(); const service = new LogService(monitor); const stream = streamingSetup(monitor);
  let writes = 0; stream.response.write = () => ++writes > 1;
  service.follow(input, stream.response); assert.ok(stream.child.stdout.isPaused()); stream.response.emit('drain'); assert.ok(!stream.child.stdout.isPaused()); service.close();
});
test('oversized line and revoked project stop live collection', async () => {
  const monitor = await setup(); const service = new LogService(monitor); const stream = streamingSetup(monitor);
  service.follow(input, stream.response); stream.child.stdout.write('x'.repeat(LOG_LIMITS.lineBytes + 1));
  assert.ok(stream.packets.some(p => p.type === 'error')); assert.equal(service.active.size, 0);
  const second = streamingSetup(monitor); service.follow(input, second.response); monitor.selected = []; monitor.publish(); assert.equal(second.killed(), 1); assert.equal(service.active.size, 0);
});
test('ring buffer bounds both line count and bytes and filters the whole retained window', () => {
  const buffer = new LogBuffer(3, 20); buffer.append(['INFO 1', 'ERROR 2', 'WARN 3', 'INFO 4']);
  assert.equal(buffer.size, 3); assert.equal(buffer.dropped, 1); assert.deepEqual(buffer.filter('error').map(i => buffer.at(i).text), ['ERROR 2']);
  assert.equal(buffer.filter('', 'warn').length, 1); buffer.append(['x'.repeat(21)]); assert.equal(buffer.dropped, 2);
  buffer.reset(); assert.equal(buffer.size, 0); assert.equal(buffer.bytes, 0);
});
test('10,000 logs remain searchable while viewport renders a small window', () => {
  const buffer = new LogBuffer(); buffer.append(Array.from({ length: 10000 }, (_, i) => `INFO request ${i}`));
  assert.equal(buffer.size, 10000); assert.equal(buffer.filter('request 9999').length, 1);
  const range = visibleRange(120000, 390, 10000); assert.ok(range.end - range.start < 40);
});
