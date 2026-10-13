import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeFixes } from '../src/advice.js';

const app = reason => ({ name: 'api', namespace: 'dev', kind: 'Deployment', status: 'down', reason, pods: [{ name: 'api-abc', reason, owner: { kind: 'ReplicaSet', name: 'api-rs' }, workload: 'Deployment/api', ready: false, containers: [{ name: 'web', reason, type: 'app', restarts: 3 }] }] });
test('crash loop guidance explains diagnosis and offers previous logs, not deletion', () => {
  const advice = proposeFixes(app('CrashLoopBackOff'), 'cluster'); assert.match(advice.issue, /repeatedly exits/);
  assert.ok(advice.steps.some(s => s.command?.includes('--previous=true'))); assert.ok(!advice.steps.some(s => s.command?.includes('delete pod')));
});
test('memory and image failures receive distinct guidance', () => {
  const memory = app('CrashLoopBackOff'); memory.pods[0].containers[0].lastReason = 'OOMKilled';
  assert.match(proposeFixes(memory).issue, /memory/); assert.ok(proposeFixes(memory).steps.some(s => s.command?.includes('top pod')));
  assert.match(proposeFixes(app('ImagePullBackOff')).issue, /image/);
});
test('optional delete requires verified ReplicaSet ownership and is labeled disruptive', () => {
  const advice = proposeFixes(app('Running')); const deletion = advice.steps.find(s => s.command?.includes('delete pod'));
  assert.equal(deletion.risk, 'disruptive'); assert.match(deletion.explanation, /PodDisruptionBudget/); assert.ok(!deletion.command.includes('--force'));
  const standalone = app('Running'); standalone.pods[0].owner = null; assert.ok(!proposeFixes(standalone).steps.some(s => s.command?.includes('delete')));
  for (const kind of ['StatefulSet', 'Pod', 'Job', 'DeploymentConfig']) { const a = app('Running'); a.kind = kind; assert.ok(!proposeFixes(a).steps.some(s => s.command?.includes('delete'))); }
});
test('unknown observations offer access checks with no repair commands', () => {
  const a = app('Last known data'); a.status = 'unknown'; const advice = proposeFixes(a); assert.match(advice.issue, /cannot be established/); assert.ok(advice.steps.every(s => !s.command || !s.command.includes('delete')));
});
test('healthy pods do not receive disruptive advice from a historical crash', () => {
  const a = app('Ready'); a.status = 'healthy'; a.pods[0].containers[0].lastReason = 'OOMKilled'; assert.ok(!proposeFixes(a).steps.some(s => s.command));
});
test('commands pin the cluster and correctly quote context for PowerShell', () => {
  const advice = proposeFixes(app('CrashLoopBackOff'), "cluster's-context"); assert.ok(advice.steps.filter(s => s.command).every(s => s.command.includes("--context='cluster''s-context'")));
});
