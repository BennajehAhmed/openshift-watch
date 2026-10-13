import { StringDecoder } from 'node:string_decoder';
import { integer, namespaces } from './config.js';

export const LOG_LIMITS = Object.freeze({ bytes: 1024 * 1024, tail: 10000, sessions: 3, liveBytes: 20 * 1024 * 1024, liveMs: 5 * 60 * 1000, lineBytes: 64 * 1024 });
const name = (value, label) => {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
};
export function logOptions(input, monitor, live = false) {
  if (!input || typeof input !== 'object') throw new Error('Select a pod and container.');
  const namespace = namespaces([input.namespace])[0];
  const podName = name(input.pod, 'pod'); const container = name(input.container, 'container');
  if (!monitor.selected.includes(namespace)) throw new Error('Select a monitored project.');
  const app = monitor.state.apps.find(a => a.namespace === namespace && a.pods.some(p => p.name === podName));
  const pod = app?.pods.find(p => p.name === podName);
  if (!pod || app.stale || app.status === 'unknown') throw new Error('Pod observation is unavailable. Refresh project health first.');
  if (!pod.containers.some(c => c.name === container)) throw new Error('Container is not part of this monitored pod.');
  if (input.previous !== undefined && typeof input.previous !== 'boolean') throw new Error('Previous instance must be true or false.');
  if (live && input.previous) throw new Error('Previous-instance logs support snapshots only.');
  return { namespace, pod: podName, container, tail: integer(input.tail, 1000, 1, LOG_LIMITS.tail), sinceSeconds: integer(input.sinceSeconds, 3600, 0, 7 * 86400), previous: input.previous === true };
}
export function logArgs(options, live = false, timeout = 15) {
  return ['logs', options.pod, `--namespace=${options.namespace}`, `--container=${options.container}`, `--tail=${options.tail}`, '--timestamps=true',
    ...(options.sinceSeconds ? [`--since=${options.sinceSeconds}s`] : []),
    ...(options.previous ? ['--previous=true'] : []),
    ...(live ? ['--follow=true', '--request-timeout=0'] : [`--limit-bytes=${LOG_LIMITS.bytes}`, `--request-timeout=${timeout}s`])];
}

// One service bounds all snapshot and stream reads, independent of health polling.
export class LogService {
  constructor(monitor) { this.monitor = monitor; this.active = new Set(); }
  reserve() {
    if (this.active.size >= LOG_LIMITS.sessions) { const error = new Error('Three log requests are already running. Stop a live stream or try again shortly.'); error.status = 429; throw error; }
    const token = { stop: () => {} }; this.active.add(token); return token;
  }
  async snapshot(input, signal) {
    const options = logOptions(input, this.monitor); const token = this.reserve();
    const controller = new AbortController(); token.stop = () => controller.abort();
    try {
      const raw = await this.monitor.client.logs(options, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      const bytes = Buffer.byteLength(raw);
      const text = Buffer.from(raw).subarray(0, LOG_LIMITS.bytes).toString('utf8');
      const lines = text.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
      const limited = bytes >= LOG_LIMITS.bytes || lines.length >= options.tail;
      return { lines: lines.slice(-options.tail), limited, bytes: Math.min(bytes, LOG_LIMITS.bytes), maxBytes: LOG_LIMITS.bytes, ...options, checkedAt: new Date().toISOString() };
    } finally { this.active.delete(token); }
  }
  follow(input, response) {
    const options = logOptions(input, this.monitor, true); const token = this.reserve();
    let child, timer, flushTimer, heartbeat, finished = false, pending = [], remainder = '', bytes = 0;
    const decoder = new StringDecoder('utf8');
    const send = data => {
      if (response.destroyed || response.writableEnded) return false;
      const writable = response.write(JSON.stringify(data) + '\n');
      if (!writable) child?.stdout?.pause();
      return writable;
    };
    const flush = () => { if (pending.length) { const lines = pending; pending = []; send({ type: 'lines', lines }); } };
    const end = (message, error = false) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearInterval(flushTimer); clearInterval(heartbeat);
      this.monitor.off('update', checkProject); response.off('drain', resume);
      if (remainder && !error) { pending.push(remainder); remainder = ''; }
      flush(); send({ type: error ? 'error' : 'end', message });
      child?.kill(); this.active.delete(token); response.end();
    };
    const resume = () => child?.stdout?.resume();
    const checkProject = () => { if (!this.monitor.selected.includes(options.namespace)) end('Project is no longer monitored.'); };
    token.stop = () => end('Log stream stopped.');
    try {
      response.status(200).set({ 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' }); response.flushHeaders();
      child = this.monitor.client.followLogs(options);
      send({ type: 'start', maxMinutes: 5, maxBytes: LOG_LIMITS.liveBytes });
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > LOG_LIMITS.liveBytes) return end('20 MiB stream limit reached. Start another stream to continue.');
        remainder += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (Buffer.byteLength(remainder) > LOG_LIMITS.lineBytes && !remainder.includes('\n')) return end('A log line exceeded 64 KiB. Use a narrower snapshot or your terminal.', true);
        let newline;
        while ((newline = remainder.indexOf('\n')) !== -1) {
          const line = remainder.slice(0, newline).replace(/\r$/, ''); remainder = remainder.slice(newline + 1);
          if (Buffer.byteLength(line) > LOG_LIMITS.lineBytes) return end('A log line exceeded 64 KiB. Use your terminal to inspect it.', true);
          pending.push(line); if (pending.length >= 100) flush();
        }
        if (Buffer.byteLength(remainder) > LOG_LIMITS.lineBytes) end('A log line exceeded 64 KiB. Use your terminal to inspect it.', true);
      });
      // Raw stderr can expose proxy credentials. Return a fixed failure message.
      child.stderr?.on('data', () => {});
      child.on('error', () => end('Cannot start oc logs. Check CLI access and your selected container.', true));
      child.on('close', code => { remainder += decoder.end(); end(code === 0 ? 'Container log stream ended.' : 'Log stream failed. Check pod availability, login, and pods/log permissions.', code !== 0); });
      response.on('drain', resume); response.on('close', token.stop);
      this.monitor.on('update', checkProject);
      timer = setTimeout(() => end('Five-minute stream limit reached. Start another stream to continue.'), LOG_LIMITS.liveMs);
      flushTimer = setInterval(flush, 150); heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
      return token.stop;
    } catch (error) { this.active.delete(token); end('Cannot start log stream.', true); throw error; }
  }
  close() { for (const token of [...this.active]) token.stop(); }
}
