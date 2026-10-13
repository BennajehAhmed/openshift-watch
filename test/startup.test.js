import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('plain node startup loads .env, respects existing variables, and tolerates a missing file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openshift-watch-startup-'));
  const entry = fileURLToPath(new URL('../src/server.js', import.meta.url));
  try {
    for (const mode of ['file', 'override', 'missing']) {
      const probe = createServer().listen(0, '127.0.0.1'); await new Promise(resolve => probe.once('listening', resolve));
      const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
      const env = { ...process.env }; delete env.PORT; delete env.POLL_SECONDS; delete env.NAMESPACES;
      if (mode === 'missing') { await rm(path.join(directory, '.env'), { force: true }); env.PORT = String(port); }
      else await writeFile(path.join(directory, '.env'), `PORT=${port}\nPOLL_SECONDS=60\n`);
      if (mode === 'override') env.POLL_SECONDS = '17';
      const child = spawn(process.execPath, [entry, '--demo'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise(resolve => child.once('close', code => resolve(code)));
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Plain-node demo startup timed out.')), 5000);
          child.stdout.on('data', chunk => { if (String(chunk).includes('OpenShift Watch:')) { clearTimeout(timeout); resolve(); } });
          child.once('error', error => { clearTimeout(timeout); reject(error); });
          child.once('exit', code => { if (code !== null) { clearTimeout(timeout); reject(new Error(`Startup exited with ${code}.`)); } });
        });
        const response = await fetch(`http://127.0.0.1:${port}/api/state`); assert.equal(response.status, 200);
        const state = await response.json(); assert.equal(state.mode, 'demo'); assert.equal(state.pollSeconds, mode === 'file' ? 60 : mode === 'override' ? 17 : 30);
      } finally { child.kill('SIGTERM'); await closed; }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
