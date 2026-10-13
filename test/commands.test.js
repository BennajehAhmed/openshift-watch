import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnly } from '../src/commands.js';
import { OcClient } from '../src/oc.js';

test('command boundary rejects cluster mutations, pod execution, arbitrary resources and option injection', () => {
  const invalid = [
    ['delete', 'pods', 'api', '--namespace=dev'], ['apply', '-f', 'manifest.yaml'], ['edit', 'deployments.apps', 'api'], ['patch', 'pods', 'api'], ['scale', 'deployment/api', '--replicas=0'], ['rollout', 'restart', 'deployment/api'], ['exec', 'api', '--', 'sh'], ['debug', 'pod/api'], ['adm', 'drain', 'node'], ['adm', 'top', 'nodes'],
    ['config', 'view', '--raw'], ['config', 'use-context', 'other'], ['get', 'secrets', '--namespace=dev'], ['get', 'pods,secrets', '--namespace=dev'], ['get', '--raw=/api/v1/secrets'],
    ['get', 'pods', '--namespace=dev', '--watch'], ['get', 'pods', '--all-namespaces'], ['describe', 'pods', '--namespace=dev'], ['get', 'pods', '--namespace=dev', '--namespace=other'], ['get', 'pods', '--namespace=dev;whoami'], ['get', 'pods', 'api', '--namespace=dev', '-o', 'go-template'],
    ['logs', 'api', '--namespace=dev', '--container=web', '--tail=-1'], ['get', 'events', '--namespace=dev', '--field-selector=involvedObject.uid=abc,metadata.name=other'], ['get', 'services', '--namespace=dev', '--selector=password=secret']
  ];
  for (const args of invalid) assert.throws(() => assertReadOnly(args), undefined, args.join(' '));
});
test('approved commands accept only the specific diagnostic flags', () => {
  for (const args of [
    ['config', 'current-context'], ['get', 'projects', '-o', 'json'], ['get', 'pods', 'api-1', '--namespace=dev', '-o', 'json', '--request-timeout=15s'],
    ['get', 'events', '--namespace=dev', '-o', 'json', '--field-selector=involvedObject.uid=abc-123'],
    ['get', 'endpointslices.discovery.k8s.io', '--namespace=dev', '-o', 'json', '--selector=kubernetes.io/service-name=api'],
    ['describe', 'pods', 'api', '--namespace=dev', '--show-events=false'], ['adm', 'top', 'pod', 'api', '--namespace=dev', '--containers'], ['logs', 'api', '--namespace=dev', '--container=web', '--tail=500', '--timestamps=true', '--follow=true', '--request-timeout=0']
  ]) assert.doesNotThrow(() => assertReadOnly(args));
});
test('rejected commands never start an oc process and options cannot enable a shell', async () => {
  let calls = 0, options;
  const client = new OcClient({ ocBin: 'oc', context: 'cluster', timeoutSeconds: 15 }, async (bin, args, opts) => { calls++; options = opts; return { stdout: '{"items":[]}' }; });
  await assert.rejects(() => client.run(['delete', 'pods', 'api', '--namespace=dev'])); assert.equal(calls, 0);
  await client.run(['get', 'pods', '--namespace=dev', '-o', 'json'], true, { shell: true }); assert.equal(options.shell, false);
});
