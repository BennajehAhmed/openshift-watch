import dotenv from 'dotenv';
import { getConfig } from './config.js';
import { OcClient } from './oc.js';
import { DemoClient } from './demo.js';
import { Monitor } from './monitor.js';
import { createApp } from './app.js';

dotenv.config({ quiet: true });

try {
  const config = getConfig();
  const monitor = await new Monitor(config, config.demo ? new DemoClient() : new OcClient(config)).initialize();
  const app = createApp(monitor);
  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(`OpenShift Watch: http://localhost:${config.port} (${config.demo ? 'DEMO' : 'live'})`);
    monitor.tick();
  });
  server.on('error', error => { console.error(`Cannot start dashboard: ${error.message}`); monitor.stop(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    monitor.stop(); app.locals.logs.close(); server.close(); server.closeAllConnections();
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
