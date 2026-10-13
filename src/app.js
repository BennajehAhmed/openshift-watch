import express from 'express';
import { engine } from 'express-handlebars';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogService } from './logs.js';
import { proposeFixes } from './advice.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function createApp(monitor) {
  const app = express(); const csrf = randomBytes(32).toString('hex');
  const logs = new LogService(monitor); app.locals.logs = logs;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Loopback-only server plus Host check prevents DNS rebinding.
    const allowed = new Set([`localhost:${monitor.config.port}`, `127.0.0.1:${monitor.config.port}`]);
    if (!allowed.has(req.headers.host)) return res.status(403).json({ error: 'Use localhost or 127.0.0.1 with the configured port.' });
    if (req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { return res.status(403).json({ error: 'Origin is not allowed.' }); }
      if (origin.protocol !== 'http:' || !allowed.has(origin.host)) return res.status(403).json({ error: 'Origin is not allowed.' });
    }
    res.set({ 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.engine('handlebars', engine({ defaultLayout: 'main', layoutsDir: path.join(root, 'views/layouts') }));
  app.set('view engine', 'handlebars'); app.set('views', path.join(root, 'views'));
  app.use('/assets', express.static(path.join(root, 'public')));
  app.get('/', (req, res) => res.render('dashboard', { csrf, demo: monitor.config.demo }));
  app.get('/api/state', (req, res) => res.json(monitor.snapshot()));
  app.get('/api/advice', (req, res) => {
    let entity = monitor.state.apps.find(a => a.id === req.query.appId);
    if (!entity) {
      const incident = monitor.incidents.history.find(i => i.entityId === req.query.appId);
      if (incident) entity = { ...incident, status: 'unknown', pods: [] };
    }
    if (!entity) return res.status(404).json({ error: 'Application or incident was not found.' });
    if (monitor.state.checkedAt && Date.now() - Date.parse(monitor.state.checkedAt) > (monitor.config.pollSeconds + 20) * 1000) entity = { ...entity, status: 'unknown' };
    res.json(proposeFixes(entity, monitor.client.context));
  });
  app.get('/api/projects', async (req, res) => {
    if (!monitor.client.context) await monitor.client.initialize();
    res.json(await monitor.client.projects());
  });
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' }); res.flushHeaders();
    const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ state: monitor.snapshot(), events: [] });
    const listener = payload => send(payload); monitor.on('update', listener);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); monitor.off('update', listener); });
  });
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const token = req.get('X-CSRF-Token') || '';
    if (Buffer.byteLength(token) !== Buffer.byteLength(csrf) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) return res.status(403).json({ error: 'Reload the dashboard before making changes.' });
    next();
  });
  // Keep state mutations sequential, including namespace edits and acknowledgements.
  let mutations = Promise.resolve();
  const mutate = handler => async (req, res, next) => {
    const operation = mutations.then(() => handler(req, res));
    mutations = operation.catch(() => {});
    try { await operation; } catch (error) { next(error); }
  };
  app.post('/api/check', mutate(async (req, res) => res.json(await monitor.tick())));
  app.post('/api/logs', async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try { const result = await logs.snapshot(req.body, controller.signal); if (!res.destroyed) res.json(result); }
    finally { res.off('close', cancel); }
  });
  app.post('/api/logs/follow', (req, res) => logs.follow(req.body, res));
  app.post('/api/incidents/clear', mutate(async (req, res) => res.json(await monitor.clearIncidents(req.body.scope))));
  app.post('/api/namespaces', mutate(async (req, res) => res.json(await monitor.select(req.body.namespaces))));
  app.post('/api/incidents/:id/acknowledge', mutate(async (req, res) => { await monitor.acknowledge(req.params.id); res.json({ ok: true }); }));
  if (monitor.config.demo) app.post('/api/demo', mutate(async (req, res) => {
    if (!['healthy', 'outage', 'degraded', 'connection', 'oom', 'image', 'pending', 'config'].includes(req.body.scenario)) return res.status(400).json({ error: 'Unknown demo scenario.' });
    if (monitor.running) await monitor.running;
    monitor.client.scenario = req.body.scenario; res.json(await monitor.tick());
  }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 400).json({ error: error instanceof SyntaxError ? 'Invalid request.' : error.message || 'Request failed.' });
  });
  return app;
}
