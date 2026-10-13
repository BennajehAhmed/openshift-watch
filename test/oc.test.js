import test from 'node:test';
import assert from 'node:assert/strict';
import { OcClient } from '../src/oc.js';
import { namespaces, getConfig } from '../src/config.js';

const config = { ocBin: 'oc', context: 'my-context', timeoutSeconds: 5 };
test('executes an allowlisted read command as argument array without a shell', async () => {
  let args, options;
  const client = new OcClient(config, async (bin, a, o) => { assert.equal(bin, 'oc'); args = a; options = o; return { stdout: '{"items":[]}' }; });
  await client.get('my-project', 'pods');
  assert.deepEqual(args, ['--context=my-context', 'get', 'pods', '--namespace=my-project', '-o', 'json', '--request-timeout=5s']); assert.equal(options.shell, false); assert.equal(options.timeout, 5000);
  await assert.rejects(() => client.get('dev;whoami', 'pods')); await assert.rejects(() => client.get('dev', 'secrets'));
});
test('RBAC errors stay partial, missing DC API is supported', async () => {
  const client = new OcClient(config, async (bin, args) => {
    if (args.includes('deploymentconfigs.apps.openshift.io')) throw { stderr: 'the server doesn\'t have a resource type' };
    if (args.includes('pods')) throw { stderr: 'Forbidden: cannot list resource pods' };
    return { stdout: '{"items":[]}' };
  });
  const result = await client.collect('dev'); assert.equal(result.errors.length, 1); assert.equal(result.unavailable.length, 1);
});
test('oc errors redact potentially sensitive stderr', async () => {
  const client = new OcClient(config, async () => { throw { stderr: 'Proxy failure token=private-value' }; });
  await assert.rejects(() => client.get('dev', 'pods'), error => !error.message.includes('private-value'));
});
test('config rejects invalid namespace and invalid polling interval', () => {
  assert.throws(() => namespaces(['--all-namespaces'])); assert.throws(() => getConfig({ POLL_SECONDS: 'NaN' })); assert.throws(() => getConfig({ POLL_SECONDS: '0' }));
});
test('snapshot logs use execFile with bounded buffers and the pinned context', async () => {
  let argumentsPassed, options;
  const client = new OcClient(config, async (bin, args, opts) => { argumentsPassed = args; options = opts; return { stdout: 'INFO test\n' }; });
  const controller = new AbortController();
  assert.equal(await client.logs({ namespace: 'dev', pod: 'api-1', container: 'web', tail: 500, sinceSeconds: 300, previous: true }, controller.signal), 'INFO test\n');
  assert.ok(argumentsPassed.includes('--context=my-context')); assert.ok(argumentsPassed.includes('--previous=true')); assert.equal(options.shell, false); assert.equal(options.maxBuffer, 1048576 + 65536); assert.equal(options.signal, controller.signal);
});
test('diagnostic commands are pinned, scoped, and bounded at the actual CLI boundary', async () => {
  const calls = [];
  const client = new OcClient(config, async (bin, args, options) => { calls.push({ bin, args, options }); return { stdout: args.includes('describe') ? 'Name: api' : args.includes('top') ? 'app 12m 64Mi' : '{"items":[]}' }; });
  await client.readObject('dev', 'pods', { name: 'api' }); await client.readObject('dev', 'events', { uid: 'abc-123' });
  await client.readObject('dev', 'endpointslices.discovery.k8s.io', { service: 'api' }); await client.describePod('dev', 'api'); await client.podMetrics('dev', 'api');
  assert.equal(calls.length, 5); assert.ok(calls.every(c => c.args.includes('--context=my-context') && c.args.includes('--namespace=dev') && c.options.shell === false && c.options.maxBuffer <= 2097152));
  assert.ok(calls.some(c => c.args.includes('--field-selector=involvedObject.uid=abc-123'))); assert.ok(calls.some(c => c.args.includes('--selector=kubernetes.io/service-name=api')));
  const before = calls.length; await assert.rejects(() => client.readObject('dev', 'secrets')); await assert.rejects(() => client.describePod('dev', '--help')); assert.equal(calls.length, before);
});
