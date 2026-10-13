import test from 'node:test';
import assert from 'node:assert/strict';
import { Incidents } from '../src/incidents.js';

const config = { alertAfter: 2, alertDegraded: true };
const entity = status => ({ id: 'dev/Deployment/api', name: 'api', namespace: 'dev', kind: 'Deployment', reason: status, status });
test('two bad observations open once; good observation resolves once', () => {
  const incidents = new Incidents(config);
  assert.equal(incidents.update([entity('down')], [], '1').length, 0);
  assert.equal(incidents.update([entity('down')], [], '2')[0].type, 'opened');
  assert.equal(incidents.update([entity('down')], [], '3').length, 0);
  assert.equal(incidents.update([entity('healthy')], [], '4')[0].type, 'recovered');
  assert.equal(incidents.update([entity('healthy')], [], '5').length, 0);
});
test('healthy check interrupts the confirmation streak', () => {
  const incidents = new Incidents(config); for (const s of ['down', 'healthy', 'down']) incidents.update([entity(s)], [], '1');
  assert.equal(incidents.history.length, 0);
});
test('unknown does not resolve incidents or bridge consecutive checks', () => {
  const incidents = new Incidents(config);
  for (const s of ['down', 'unknown', 'down']) incidents.update([entity(s)], [], '1'); assert.equal(incidents.history.length, 0);
  incidents.update([entity('down')], [], '2'); incidents.update([entity('unknown')], [], '3');
  assert.equal(incidents.history[0].resolvedAt, null);
});
test('acknowledging does not mark the app recovered', () => {
  const incidents = new Incidents({ ...config, alertAfter: 1 }); incidents.update([entity('down')], [], '1');
  incidents.acknowledge(incidents.history[0].id, '2'); assert.equal(incidents.history[0].acknowledgedAt, '2'); assert.equal(incidents.history[0].resolvedAt, null);
});
test('degraded to down escalation sends an event', () => {
  const incidents = new Incidents({ ...config, alertAfter: 1 }); incidents.update([entity('degraded')], [], '1');
  assert.equal(incidents.update([entity('down')], [], '2')[0].type, 'escalation');
});
test('disappearance is not false recovery', () => {
  const incidents = new Incidents({ ...config, alertAfter: 1 }); incidents.update([entity('down')], [], '1'); incidents.update([], [], '2');
  assert.equal(incidents.history[0].resolvedAt, null); assert.equal(incidents.history[0].observationMissing, true);
});
test('collector failure creates a monitor incident, then recovers', () => {
  const incidents = new Incidents({ ...config, alertAfter: 1 });
  incidents.update([], [{ namespace: 'dev', errors: [{ resource: 'pods', message: 'Expired login' }] }], '1');
  assert.equal(incidents.history[0].kind, 'Monitor');
  assert.equal(incidents.update([], [{ namespace: 'dev', errors: [] }], '2')[0].type, 'recovered');
});
test('degraded can be disabled for notifications', () => {
  const incidents = new Incidents({ ...config, alertAfter: 1, alertDegraded: false }); incidents.update([entity('degraded')], [], '1'); assert.equal(incidents.history.length, 0);
});
test('clear resolved preserves active incidents; clear all re-arms confirmation', () => {
  const incidents = new Incidents(config);
  incidents.update([entity('down')], [], '1'); incidents.update([entity('down')], [], '2'); incidents.update([entity('healthy')], [], '3');
  incidents.update([entity('down')], [], '4'); incidents.update([entity('down')], [], '5');
  assert.equal(incidents.clear('resolved'), 1); assert.equal(incidents.history.length, 1);
  assert.equal(incidents.clear('all'), 1); assert.equal(incidents.history.length, 0);
  assert.equal(incidents.update([entity('down')], [], '6').length, 0); assert.equal(incidents.update([entity('down')], [], '7')[0].type, 'opened');
  assert.throws(() => incidents.clear('invalid'));
});
