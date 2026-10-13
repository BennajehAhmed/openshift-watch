import { randomUUID } from 'node:crypto';

export class Incidents {
  constructor(config, history = []) { this.config = config; this.history = history; this.counts = new Map(); }
  update(apps, namespaceResults, timestamp) {
    const entities = [...apps];
    for (const ns of namespaceResults) {
      entities.push({ id: `monitor/${ns.namespace}`, name: ns.namespace, namespace: ns.namespace, kind: 'Monitor', status: ns.errors.length ? 'down' : 'healthy', reason: ns.errors.map(e => `${e.resource}: ${e.message}`).join(' ') || 'OpenShift access restored' });
    }
    const present = new Set(entities.map(e => e.id));
    const newEvents = [];
    for (const entity of entities) {
      const bad = entity.status === 'down' || (this.config.alertDegraded && entity.status === 'degraded');
      const existing = this.history.find(i => i.entityId === entity.id && !i.resolvedAt);
      // Unknown observations must never resolve an active incident.
      if (entity.status === 'unknown') { this.counts.delete(entity.id); continue; }
      if (bad) {
        const count = (this.counts.get(entity.id) || 0) + 1; this.counts.set(entity.id, count);
        if (existing) {
          const escalated = existing.status === 'degraded' && entity.status === 'down';
          existing.status = entity.status; existing.reason = entity.reason; existing.lastSeen = timestamp; existing.observationMissing = false;
          if (escalated) newEvents.push({ type: 'escalation', incident: { ...existing } });
        } else if (count >= this.config.alertAfter) {
          const incident = { id: randomUUID(), entityId: entity.id, name: entity.name, namespace: entity.namespace, kind: entity.kind, status: entity.status, reason: entity.reason, openedAt: timestamp, lastSeen: timestamp, resolvedAt: null, acknowledgedAt: null };
          this.history.unshift(incident); newEvents.push({ type: 'opened', incident: { ...incident } });
        }
      } else {
        this.counts.delete(entity.id);
        if (existing) { existing.resolvedAt = timestamp; existing.observationMissing = false; newEvents.push({ type: 'recovered', incident: { ...existing } }); }
      }
    }
    for (const id of this.counts.keys()) if (!present.has(id)) this.counts.delete(id);
    // A disappeared controller / RBAC change is not evidence of recovery.
    for (const incident of this.history.filter(i => !i.resolvedAt && !present.has(i.entityId))) incident.observationMissing = true;
    const active = this.history.filter(i => !i.resolvedAt);
    this.history = [...active, ...this.history.filter(i => i.resolvedAt).slice(0, 200)];
    return newEvents;
  }
  acknowledge(id, timestamp) {
    const incident = this.history.find(i => i.id === id);
    if (!incident) throw new Error('Incident not found.');
    incident.acknowledgedAt = timestamp;
  }
}
