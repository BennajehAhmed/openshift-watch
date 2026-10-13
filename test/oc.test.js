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
