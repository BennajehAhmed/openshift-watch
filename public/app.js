const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down', unknown: 'Unknown', 'scaled-zero': 'Scaled to zero', completed: 'Completed' };
let state, connected = false, audio;
const delivered = new Set();
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const date = value => value ? new Date(value).toLocaleString() : '—';
const badge = status => `<span class="badge ${escape(status)}"><i></i>${escape(labels[status] || status)}</span>`;
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function showError(message) { $('messages').innerHTML = `<div class="notice danger">${escape(message)}</div>`; }
function stale() { return !connected || (state?.checkedAt && Date.now() - new Date(state.checkedAt).getTime() > (state.pollSeconds + 20) * 1000); }
function render() {
  if (!state) return;
  const isStale = stale();
  const errors = state.namespaces.flatMap(n => n.errors.map(e => `${n.namespace} / ${e.resource}: ${e.message}`));
  $('messages').innerHTML = [state.setupError, state.storageError, ...errors, ...(isStale ? ['Live updates are unavailable or delayed. Displayed observations are no longer current.'] : [])].filter(Boolean).map(e => `<div class="notice danger">${escape(e)}</div>`).join('');
  $('mode').textContent = state.mode === 'demo' ? 'DEMO' : 'LIVE';
  $('context').textContent = state.context ? `Context: ${state.context}` : 'No OpenShift context';
  $('connection').textContent = !connected ? 'Dashboard disconnected' : isStale ? 'Observation delayed' : state.setupError || errors.length ? 'Cluster access issue' : state.checking ? 'Checking projects…' : state.selectedNamespaces.length ? 'Monitoring active' : 'Choose projects';
  $('connection-dot').classList.toggle('bad', isStale || errors.length > 0 || Boolean(state.setupError));
  $('last-check').textContent = `Last check: ${date(state.checkedAt)}`;
  $('refresh').disabled = state.checking;
  $('refresh').textContent = state.checking ? 'Checking…' : '↻ Check now';
  $('project-list').innerHTML = state.selectedNamespaces.map(n => `<div><span class="project-dot"></span>${escape(n)}</div>`).join('') || 'No projects selected';
  const apps = state.apps.map(a => isStale ? { ...a, status: 'unknown' } : a);
  for (const status of ['healthy', 'degraded', 'down']) $(status).textContent = apps.filter(a => a.status === status).length;
  $('total').textContent = apps.length;
  $('app-count').textContent = apps.length;
  $('project-count').textContent = `Across ${state.selectedNamespaces.length} projects`;
  $('poll-note').textContent = `Next check ${state.pollSeconds}s after completion · Alerts after ${state.alertAfter} failed checks`;
  const unknown = apps.filter(a => a.status === 'unknown').length;
  $('observation-note').textContent = unknown ? `${unknown} unknown · Last full success: ${date(state.lastSuccessfulAt)}` : 'Read-only observations · Kubernetes readiness';
  const query = $('search').value.toLowerCase();
  const filtered = apps.filter(a => `${a.name} ${a.namespace} ${a.kind}`.toLowerCase().includes(query) && ($('status-filter').value === 'all' || a.status === $('status-filter').value));
  $('app-rows').innerHTML = filtered.map(a => `<tr><td><div class="app-name"><span class="app-icon">◇</span><div><strong>${escape(a.name)}</strong><small>${escape(a.kind)}</small></div></div></td><td><span class="namespace">${escape(a.namespace)}</span></td><td>${badge(a.status)}</td><td><strong class="replicas">${a.ready} <span>/ ${a.desired ?? '?'}</span></strong></td><td>${a.pods.reduce((s, p) => s + p.restarts, 0)}</td><td><button class="detail-button" data-app="${escape(a.id)}">View pods →</button></td></tr>`).join('');
  $('empty').hidden = filtered.length > 0;
  if (!filtered.length) {
    $('empty').innerHTML = state.selectedNamespaces.length ? `<span>◎</span><h3>${state.checking ? 'Checking your projects…' : state.apps.length ? 'No matching applications' : 'No workload data to display'}</h3><p>${state.apps.length ? 'Try another search or status filter.' : 'Check project selection and any access errors above.'}</p>` : '<span>◎</span><h3>Choose the projects you want to watch</h3><p>Use Manage projects to select your OpenShift namespaces.</p>';
  }
  const active = state.incidents.filter(i => !i.resolvedAt);
  $('nav-incidents').textContent = active.length; $('incident-count').textContent = active.length;
  document.title = `${active.length ? `(${active.length}) ` : ''}OpenShift Watch`;
  $('incidents').innerHTML = state.incidents.length ? state.incidents.map(i => `<article class="incident ${i.resolvedAt ? 'resolved' : ''}"><span class="incident-symbol">${i.resolvedAt ? '✓' : '!'}</span><div class="incident-info"><strong>${escape(i.name)} <span class="incident-project">${escape(i.namespace)} · ${escape(i.kind)}</span></strong><p>${escape(i.reason)}</p><small>Opened ${escape(date(i.openedAt))}${i.resolvedAt ? ` · Recovered ${escape(date(i.resolvedAt))}` : ''}${i.acknowledgedAt ? ' · Acknowledged' : ''}${i.observationMissing ? ' · No current observation; review project selection or workload removal' : ''}</small></div>${i.resolvedAt ? '<span class="recovery">Recovered</span>' : i.acknowledgedAt ? '<span class="acknowledged">Acknowledged</span>' : `<button class="button small" data-ack="${escape(i.id)}">Acknowledge</button>`}</article>`).join('') : '<div class="quiet"><span>✓</span><div><strong>No confirmed incidents</strong><p>Problems will appear here after the configured confirmation checks.</p></div></div>';
}
function beep() {
  if (!$('sound').checked || !audio || audio.state !== 'running') return;
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  oscillator.connect(gain); gain.connect(audio.destination); oscillator.frequency.value = 740;
  gain.gain.setValueAtTime(0.08, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
  oscillator.start(); oscillator.stop(audio.currentTime + 0.4);
}
function notify(type, incident) {
  const key = `${incident.id}:${type === 'recovered' ? 'recovered' : incident.status}`;
  if (delivered.has(key) || (incident.acknowledgedAt && type !== 'recovered')) return;
  const permitted = 'Notification' in window && Notification.permission === 'granted';
  if (!permitted && !$('sound').checked) return;
  delivered.add(key);
  if (permitted) {
    try {
      const notification = new Notification(`${type === 'recovered' ? 'Recovered' : incident.kind === 'Monitor' ? 'Monitor access issue' : labels[incident.status]}: ${incident.name}`, { body: `${incident.namespace}: ${incident.reason}`, tag: incident.id, icon: '/assets/icon.svg' });
      notification.onclick = () => { window.focus(); $('incidents-section').scrollIntoView({ behavior: 'smooth' }); notification.close(); };
    } catch { /* Browser or company policy may block desktop notifications. */ }
  }
  if (type !== 'recovered') beep();
}
const events = new EventSource('/api/events');
events.onopen = () => { connected = true; render(); };
events.onerror = () => { connected = false; render(); };
events.onmessage = event => {
  const payload = JSON.parse(event.data); state = payload.state; connected = true; render();
  for (const e of payload.events) notify(e.type, e.incident);
  // Also surface an active incident after a reconnect or when opening a new tab.
  for (const incident of state.incidents.filter(i => !i.resolvedAt)) notify('opened', incident);
};
setInterval(render, 5000);
$('search').addEventListener('input', render); $('status-filter').addEventListener('change', render);
$('refresh').onclick = async () => { $('refresh').disabled = true; try { state = await api('/api/check', {}); render(); } catch (e) { showError(e.message); $('refresh').disabled = false; } };
$('notifications').onclick = async () => {
  if (!('Notification' in window)) return showError('This browser does not support desktop notifications. Use Chrome or Edge on your laptop.');
  const permission = await Notification.requestPermission();
  $('notifications').textContent = permission === 'granted' ? 'Notifications enabled ✓' : 'Notifications blocked';
  if (permission === 'denied') showError('Notifications are blocked. Allow them for localhost in your browser settings, if your company policy permits it.');
  if (permission === 'granted') for (const i of state?.incidents.filter(i => !i.resolvedAt) || []) notify('opened', i);
};
if ('Notification' in window && Notification.permission === 'granted') $('notifications').textContent = 'Notifications enabled ✓';
$('sound').onchange = async () => {
  if ($('sound').checked) { audio ||= new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); beep(); }
};
$('configure').onclick = () => { $('namespace-input').value = state?.selectedNamespaces.join(', ') || ''; $('project-error').textContent = ''; $('available-projects').innerHTML = ''; $('project-dialog').showModal(); };
$('close-dialog').onclick = () => $('project-dialog').close();
$('load-projects').onclick = async () => {
  $('load-projects').disabled = true;
  try {
    const projects = await api('/api/projects'); const selected = new Set($('namespace-input').value.split(',').map(s => s.trim()));
    $('available-projects').innerHTML = projects.map(p => `<label><input type="checkbox" value="${escape(p.name)}" ${selected.has(p.name) ? 'checked' : ''}> <span>${escape(p.name)}${p.displayName ? `<small>${escape(p.displayName)}</small>` : ''}</span></label>`).join('') || '<p>No projects returned. Enter project names below.</p>';
    $('project-error').textContent = '';
  } catch (e) { $('project-error').textContent = e.message; }
  finally { $('load-projects').disabled = false; }
};
$('available-projects').onchange = () => {
  const existing = new Set($('namespace-input').value.split(',').map(s => s.trim()).filter(Boolean));
  for (const input of $('available-projects').querySelectorAll('input')) input.checked ? existing.add(input.value) : existing.delete(input.value);
  $('namespace-input').value = [...existing].join(', ');
};
$('project-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { state = await api('/api/namespaces', { namespaces: $('namespace-input').value.split(',').map(s => s.trim()).filter(Boolean) }); $('project-dialog').close(); render(); }
  catch (e) { $('project-error').textContent = e.message; } finally { button.disabled = false; }
};
$('incidents').onclick = async event => {
  const button = event.target.closest('[data-ack]'); if (!button) return;
  try { await api(`/api/incidents/${encodeURIComponent(button.dataset.ack)}/acknowledge`, {}); } catch (e) { showError(e.message); }
};
$('app-rows').onclick = event => {
  const button = event.target.closest('[data-app]'); if (!button) return;
  const app = state.apps.find(a => a.id === button.dataset.app); if (!app) return;
  $('detail-title').textContent = `${app.name} · Pods`;
  $('detail-content').innerHTML = `<p>${escape(app.namespace)} / ${escape(app.kind)}</p><div class="notice">${escape(app.reason)}${stale() || app.stale ? ' · Last known data; current health is unknown' : ''}</div>${app.pods.length ? `<div class="table-scroll"><table class="pods-table"><thead><tr><th>POD</th><th>READY</th><th>REASON</th><th>RESTARTS</th></tr></thead><tbody>${app.pods.map(p => `<tr><td><strong>${escape(p.name)}</strong>${p.containers.map(c => `<small>${escape(c.name)}: ${c.ready ? 'ready' : escape(c.reason)} (${c.restarts} restarts)</small>`).join('')}</td><td>${p.ready ? 'Yes' : 'No'}</td><td>${escape(p.reason)}</td><td>${p.restarts}</td></tr>`).join('')}</tbody></table></div>` : '<p>No pods observed. A workload with desired replicas above zero is still tracked.</p>'}`;
  $('detail-dialog').showModal();
};
$('close-details').onclick = () => $('detail-dialog').close();
if ($('scenario')) $('scenario').onchange = async () => { try { state = await api('/api/demo', { scenario: $('scenario').value }); render(); } catch (e) { showError(e.message); } };
