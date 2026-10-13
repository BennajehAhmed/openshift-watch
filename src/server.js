import { getConfig } from './config.js';
import { OcClient } from './oc.js';
import { DemoClient } from './demo.js';
import { Monitor } from './monitor.js';
import { createApp } from './app.js';

try {
  const config = getConfig();
  const monitor = await new Monitor(config, config.demo ? new DemoClient() : new OcClient(config)).initialize();
  const server = createApp(monitor).listen(config.port, '127.0.0.1', () => {
    console.log(`OpenShift Watch: http://localhost:${config.port} (${config.demo ? 'DEMO' : 'live'})`);
    monitor.tick();
  });
  server.on('error', error => { console.error(`Cannot start dashboard: ${error.message}`); monitor.stop(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    monitor.stop(); server.close(); server.closeAllConnections();
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
