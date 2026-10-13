import { EventEmitter } from 'node:events';
import { buildApps } from './health.js';
import { Incidents } from './incidents.js';
import { readJson, saveJson } from './storage.js';
import { namespaces } from './config.js';

export class Monitor extends EventEmitter {
  constructor(config, client) {
    super(); this.config = config; this.client = client; this.selected = config.namespaces;
    this.incidents = new Incidents(config); this.timer = null; this.running = null; this.stopped = false;
    this.state = { mode: config.demo ? 'demo' : 'live', context: '', namespaces: [], apps: [], incidents: [], checking: false, checkedAt: null, lastSuccessfulAt: null, pollSeconds: config.pollSeconds, alertAfter: config.alertAfter, alertDegraded: config.alertDegraded, setupError: null, storageError: null };
  }
  async initialize() {
    if (this.config.demo) this.selected = ['payments-dev', 'customer-tools'];
    else {
      const settings = await readJson(this.config.dataDir, 'settings.json', {});
      if (!this.selected.length) this.selected = namespaces(settings.namespaces || []);
      const history = await readJson(this.config.dataDir, 'incidents.json', []);
      if (!Array.isArray(history)) throw new Error('Invalid incident history in data/.');
      this.incidents.history = history;
    }
    try { await this.client.initialize(); }
    catch (error) { this.state.setupError = error.message; }
    this.state.context = this.client.context;
    this.state.incidents = this.incidents.history;
    return this;
  }
  snapshot() { return { ...this.state, selectedNamespaces: this.selected }; }
  publish(events = []) { this.emit('update', { state: this.snapshot(), events }); }
  async persist() {
    if (this.config.demo) return;
    try { await saveJson(this.config.dataDir, 'incidents.json', this.incidents.history); this.state.storageError = null; }
    catch { this.state.storageError = 'Incident history could not be saved. Check data/ write permissions.'; }
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.check().finally(() => {
      this.running = null;
      if (!this.stopped) { clearTimeout(this.timer); this.timer = setTimeout(() => this.tick(), this.config.pollSeconds * 1000); }
    });
    return this.running;
  }
  async check() {
    this.state.checking = true; this.publish();
    const namespaceResults = []; const apps = [];
    try {
      if (!this.client.context) await this.client.initialize();
      this.state.context = this.client.context; this.state.setupError = null;
      for (const namespace of this.selected) {
        let collection;
        try { collection = await this.client.collect(namespace); }
        catch (error) { collection = { items: [], errors: [{ resource: 'monitor', message: error.message }] }; }
        const current = buildApps(namespace, collection);
        const currentIds = new Set(current.map(a => a.id));
        // Preserve the last known rows as unknown when observations are incomplete.
        for (const previous of this.state.apps.filter(a => a.namespace === namespace && !currentIds.has(a.id))) {
          if (collection.errors.length) {
            current.push({ ...previous, status: 'unknown', reason: 'Last known data; OpenShift observation is incomplete', stale: true });
          } else if (['Deployment', 'DeploymentConfig', 'StatefulSet', 'DaemonSet'].includes(previous.kind) && previous.desired > 0) {
            current.push({ ...previous, ready: 0, pods: [], status: 'down', stale: false, missing: true, reason: 'Previously monitored workload is missing from a successful check' });
          }
        }
        apps.push(...current);
        namespaceResults.push({ namespace, errors: collection.errors, unavailable: collection.unavailable || [] });
      }
    } catch (error) {
      this.state.setupError = error.message;
      for (const namespace of this.selected) namespaceResults.push({ namespace, errors: [{ resource: 'monitor', message: error.message }] });
      apps.push(...this.state.apps.map(a => ({ ...a, status: 'unknown', stale: true, reason: 'Last known data; monitor cannot connect' })));
    }
    const timestamp = new Date().toISOString();
    const events = this.incidents.update(apps, namespaceResults, timestamp);
    this.state.apps = apps; this.state.namespaces = namespaceResults;
    this.state.incidents = this.incidents.history; this.state.checkedAt = timestamp;
    if (!this.state.setupError && this.selected.length && namespaceResults.every(n => !n.errors.length)) this.state.lastSuccessfulAt = timestamp;
    await this.persist(); this.state.checking = false; this.publish(events);
    return this.snapshot();
  }
  async select(selected) {
    const next = namespaces(selected);
    if (this.running) await this.running;
    if (!this.config.demo) await saveJson(this.config.dataDir, 'settings.json', { namespaces: next });
    this.selected = next; this.state.apps = this.state.apps.filter(a => next.includes(a.namespace));
    this.incidents.counts.clear();
    return this.tick();
  }
  async acknowledge(id) {
    if (this.running) await this.running;
    this.incidents.acknowledge(id, new Date().toISOString());
    await this.persist(); this.state.incidents = this.incidents.history; this.publish();
  }
  async clearIncidents(scope) {
    if (this.running) await this.running;
    const removed = this.incidents.clear(scope);
    await this.persist(); this.state.incidents = this.incidents.history; this.publish();
    return { removed, state: this.snapshot() };
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
