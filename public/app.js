import { LogBuffer, visibleRange, ROW_HEIGHT } from './log-model.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down', unknown: 'Unknown', 'scaled-zero': 'Scaled to zero', completed: 'Completed' };
let state, connected = false, audio;
let appPage = 0, incidentPage = 0, incidentFilter = 'active', detailId = null, adviceVersion = 0;
const PAGE_SIZE = 50;
const delivered = new Set();
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const date = value => value ? new Date(value).toLocaleString() : '—';
const badge = status => `<span class="badge ${escape(status)}"><i></i>${escape(labels[status] || status)}</span>`;
async function api(url, body, signal) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  const projectValue = $('project-filter').value;
  const projectOptions = `<option value="all">All projects</option>${state.selectedNamespaces.map(n => `<option value="${escape(n)}">${escape(n)}</option>`).join('')}`;
  if ($('project-filter').innerHTML !== projectOptions) { $('project-filter').innerHTML = projectOptions; $('project-filter').value = state.selectedNamespaces.includes(projectValue) ? projectValue : 'all'; }
  for (const status of ['healthy', 'degraded', 'down']) $(status).textContent = apps.filter(a => a.status === status).length;
  $('total').textContent = apps.length;
  $('app-count').textContent = apps.length;
  $('project-count').textContent = `Across ${state.selectedNamespaces.length} projects`;
  $('poll-note').textContent = `Next check ${state.pollSeconds}s after completion · Alerts after ${state.alertAfter} failed checks`;
  const unknown = apps.filter(a => a.status === 'unknown').length;
  $('observation-note').textContent = unknown ? `${unknown} unknown · Last full success: ${date(state.lastSuccessfulAt)}` : 'Read-only observations · Kubernetes readiness';
  const query = $('search').value.toLowerCase();
  const priority = { down: 0, degraded: 1, unknown: 2, healthy: 3, 'scaled-zero': 4, completed: 5 };
  const filtered = apps.filter(a => `${a.name} ${a.namespace} ${a.kind}`.toLowerCase().includes(query) && ($('status-filter').value === 'all' || a.status === $('status-filter').value) && ($('project-filter').value === 'all' || a.namespace === $('project-filter').value)).sort((a, b) => priority[a.status] - priority[b.status] || a.name.localeCompare(b.name));
  appPage = Math.min(appPage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  $('app-page').textContent = `${filtered.length ? appPage * PAGE_SIZE + 1 : 0}–${Math.min(filtered.length, (appPage + 1) * PAGE_SIZE)} of ${filtered.length}`;
  $('app-prev').disabled = appPage === 0; $('app-next').disabled = (appPage + 1) * PAGE_SIZE >= filtered.length;
  document.querySelectorAll('[data-status]').forEach(b => b.classList.toggle('selected-stat', b.dataset.status === $('status-filter').value));
  $('app-rows').innerHTML = filtered.slice(appPage * PAGE_SIZE, (appPage + 1) * PAGE_SIZE).map(a => `<tr class="app-row ${escape(a.status)}"><td><div class="app-name"><span class="app-icon">◇</span><div><strong>${escape(a.name)}</strong><small>${escape(a.kind)}</small><span class="row-reason">${escape(a.reason)}</span></div></div></td><td><span class="namespace">${escape(a.namespace)}</span></td><td>${badge(a.status)}</td><td><strong class="replicas">${a.ready} <span>/ ${a.desired ?? '?'}</span></strong></td><td>${a.pods.reduce((s, p) => s + p.restarts, 0)}</td><td><div class="row-actions"><button class="detail-button" data-app="${escape(a.id)}" data-open="pods">Inspect</button><button class="detail-button" data-app="${escape(a.id)}" data-open="logs" ${a.pods.length ? '' : 'disabled'}>Logs</button>${['down', 'degraded', 'unknown'].includes(a.status) ? `<button class="detail-button fixes-link" data-app="${escape(a.id)}" data-open="fixes">Proposed fixes →</button>` : ''}</div></td></tr>`).join('');
  $('empty').hidden = filtered.length > 0;
  if (!filtered.length) {
    $('empty').innerHTML = state.selectedNamespaces.length ? `<span>◎</span><h3>${state.checking ? 'Checking your projects…' : state.apps.length ? 'No matching applications' : 'No workload data to display'}</h3><p>${state.apps.length ? 'Try another search or status filter.' : 'Check project selection and any access errors above.'}</p>` : '<span>◎</span><h3>Choose the projects you want to watch</h3><p>Use Manage projects to select your OpenShift namespaces.</p>';
  }
  const active = state.incidents.filter(i => !i.resolvedAt);
  $('nav-incidents').textContent = active.length; $('incident-count').textContent = active.length;
  document.title = `${active.length ? `(${active.length}) ` : ''}OpenShift Watch`;
  const activity = state.incidents.filter(i => incidentFilter === 'all' || (incidentFilter === 'active' ? !i.resolvedAt : i.resolvedAt));
  incidentPage = Math.min(incidentPage, Math.max(0, Math.ceil(activity.length / 20) - 1));
  $('incident-summary').textContent = `${active.length} active · ${state.incidents.length - active.length} resolved`;
  $('incident-page').textContent = `Showing ${activity.length ? incidentPage * 20 + 1 : 0}–${Math.min(activity.length, (incidentPage + 1) * 20)} of ${activity.length}`;
  $('incident-prev').disabled = incidentPage === 0; $('incident-next').disabled = (incidentPage + 1) * 20 >= activity.length;
  $('clear-incidents').disabled = !state.incidents.length;
  $('incidents').innerHTML = activity.length ? activity.slice(incidentPage * 20, (incidentPage + 1) * 20).map(i => `<article class="incident ${i.resolvedAt ? 'resolved' : ''}"><span class="incident-symbol">${i.resolvedAt ? '✓' : '!'}</span><div class="incident-info"><strong>${escape(i.name)} <span class="incident-project">${escape(i.namespace)} · ${escape(i.kind)}</span></strong><p>${escape(i.reason)}</p><small>Opened ${escape(date(i.openedAt))}${i.resolvedAt ? ` · Recovered ${escape(date(i.resolvedAt))}` : ''}${i.acknowledgedAt ? ' · Acknowledged' : ''}${i.observationMissing ? ' · No current observation; review project selection or workload removal' : ''}</small></div><div class="incident-buttons">${i.resolvedAt ? '<span class="recovery">Recovered</span>' : i.acknowledgedAt ? '<span class="acknowledged">Acknowledged</span>' : `<button class="button small" data-ack="${escape(i.id)}">Acknowledge</button>`}<button class="detail-button" data-advice="${escape(i.entityId)}">Issue & fixes →</button></div></article>`).join('') : `<div class="quiet"><span>✓</span><div><strong>${incidentFilter === 'resolved' ? 'No resolved history' : 'No incidents in this view'}</strong><p>${apps.some(a => ['down', 'degraded'].includes(a.status)) ? 'Application problems remain visible above. Incidents appear after confirmation checks.' : 'Problems appear here after the configured confirmation checks.'}</p></div></div>`;
  if (detailId && $('detail-dialog').open) renderPodDetails();
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
$('search').addEventListener('input', () => { appPage = 0; render(); });
for (const id of ['status-filter', 'project-filter']) $(id).addEventListener('change', () => { appPage = 0; render(); });
$('reset-filters').onclick = () => { $('search').value = ''; $('status-filter').value = 'all'; $('project-filter').value = 'all'; appPage = 0; render(); };
document.querySelectorAll('[data-status]').forEach(b => b.onclick = () => { $('status-filter').value = b.dataset.status; appPage = 0; render(); $('search').focus(); });
$('app-prev').onclick = () => { appPage--; render(); }; $('app-next').onclick = () => { appPage++; render(); };
$('incident-prev').onclick = () => { incidentPage--; render(); }; $('incident-next').onclick = () => { incidentPage++; render(); };
document.querySelectorAll('[data-incidents]').forEach(b => b.onclick = () => { incidentFilter = b.dataset.incidents; incidentPage = 0; document.querySelectorAll('[data-incidents]').forEach(t => t.classList.toggle('selected', t === b)); render(); });
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
  const advice = event.target.closest('[data-advice]'); if (advice) return openInspector(advice.dataset.advice, 'fixes');
  const button = event.target.closest('[data-ack]'); if (!button) return;
  try { await api(`/api/incidents/${encodeURIComponent(button.dataset.ack)}/acknowledge`, {}); } catch (e) { showError(e.message); }
};
$('app-rows').onclick = event => {
  const button = event.target.closest('[data-app]'); if (!button) return;
  openInspector(button.dataset.app, button.dataset.open || 'pods');
};
$('close-details').onclick = () => $('detail-dialog').close();
$('detail-dialog').addEventListener('close', () => { stopLogs(); stopDiagnostics(); adviceVersion++; detailId = null; });
if ($('scenario')) $('scenario').onchange = async () => { try { state = await api('/api/demo', { scenario: $('scenario').value }); render(); } catch (e) { showError(e.message); } };

let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
$('clear-incidents').onclick = () => { $('clear-error').textContent = ''; $('clear-dialog').showModal(); };
$('close-clear').onclick = () => $('clear-dialog').close();
async function clearBoard(scope) {
  $('clear-resolved').disabled = true; $('clear-all').disabled = true;
  try { const result = await api('/api/incidents/clear', { scope }); state = result.state; render(); $('clear-dialog').close(); toast(`Cleared ${result.removed} incident records.`); }
  catch (e) { $('clear-error').textContent = e.message; }
  finally { $('clear-resolved').disabled = false; $('clear-all').disabled = false; }
}
$('clear-resolved').onclick = () => clearBoard('resolved'); $('clear-all').onclick = () => clearBoard('all');
function inspectedApp() { return state?.apps.find(a => a.id === detailId); }
function renderPodDetails() {
  const app = inspectedApp();
  if (!app) { $('detail-content').innerHTML = '<div class="notice">No current application observation. Use proposed fixes to check monitor access.</div>'; return; }
  $('detail-title').textContent = app.name; $('detail-subtitle').textContent = `${app.namespace} / ${app.kind} · Checked ${date(state.checkedAt)}`;
  $('detail-content').innerHTML = `<div class="inspector-summary">${badge(stale() || app.stale ? 'unknown' : app.status)}<strong>${app.ready} / ${app.desired ?? '?'} ready</strong><span>${escape(app.reason)}</span></div>${stale() || app.stale ? '<div class="notice danger">Last known observations; current health is unknown.</div>' : ''}<div class="investigation-callout"><div><strong>Find the cause, not just the status</strong><p>Inspect events, exit details, probe settings, resource limits, and service backends together.</p></div><button class="button" data-diagnose="">Investigate application →</button></div>${app.pods.length ? `<div class="table-scroll"><table class="pods-table"><thead><tr><th>POD / CONTAINERS</th><th>READY</th><th>REASON</th><th>RESTARTS</th><th>INVESTIGATE</th></tr></thead><tbody>${app.pods.map(p => `<tr><td><strong>${escape(p.name)}</strong>${p.containers.map(c => `<small>${escape(c.name)} (${escape(c.type || 'app')}): ${c.ready ? 'ready' : escape(c.reason)}${c.lastReason ? ` · Last exit: ${escape(c.lastReason)}` : ''}${c.exitCode !== null && c.exitCode !== undefined ? ` (${c.exitCode})` : ''}</small>`).join('')}</td><td>${p.ready ? 'Yes' : 'No'}</td><td>${escape(p.reason)}</td><td>${p.restarts}</td><td><div class="pod-investigation-actions"><button class="detail-button" data-diagnose="${escape(p.name)}">Diagnose</button><button class="detail-button" data-pod-logs="${escape(p.name)}">Read logs</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>No pods observed</h3><p>Diagnostics can still inspect the owning workload, quota, and controller events.</p></div>'}`;
}
function openInspector(id, pane = 'pods') {
  stopLogs(); stopDiagnostics(); detailId = id; adviceVersion++;
  const app = inspectedApp(), incident = state.incidents.find(i => i.entityId === id);
  $('detail-title').textContent = app?.name || incident?.name || 'Monitor issue';
  $('detail-subtitle').textContent = `${app?.namespace || incident?.namespace || ''} / ${app?.kind || incident?.kind || ''}`;
  renderPodDetails(); setupLogSelectors(); setupDiagnostics();
  $('detail-dialog').showModal(); selectPane(pane);
}
function selectPane(pane) {
  if (pane !== 'logs') stopLogs();
  if (pane !== 'diagnostics') stopDiagnostics();
  for (const name of ['pods', 'logs', 'diagnostics', 'fixes']) { $(`pane-${name}`).hidden = name !== pane; $(`tab-${name}`).classList.toggle('selected', name === pane); $(`tab-${name}`).setAttribute('aria-selected', String(name === pane)); }
  if (pane === 'fixes') loadAdvice();
  if (pane === 'logs') requestAnimationFrame(renderLogRows);
  if (pane === 'diagnostics' && !diagnosticReport) loadDiagnostics(false);
}
document.querySelectorAll('[data-pane]').forEach(button => button.onclick = () => selectPane(button.dataset.pane));
$('detail-content').onclick = event => {
  const diagnosis = event.target.closest('[data-diagnose]');
  if (diagnosis) { if (diagnosis.dataset.diagnose) $('diagnostic-pod').value = diagnosis.dataset.diagnose; diagnosticReport = null; selectPane('diagnostics'); return; }
  const button = event.target.closest('[data-pod-logs]'); if (!button) return;
  $('log-pod').value = button.dataset.podLogs; updateContainers(); selectPane('logs'); loadLogs(false);
};
async function loadAdvice() {
  const version = ++adviceVersion; const id = detailId;
  $('fixes-content').innerHTML = '<div class="notice">Checking observed symptoms…</div>';
  try {
    const advice = await api(`/api/advice?appId=${encodeURIComponent(id)}`);
    if (version !== adviceVersion || id !== detailId) return;
    $('fixes-content').innerHTML = `<div class="issue-card"><div class="eyebrow">OBSERVED ISSUE</div><h3>${escape(advice.issue)}</h3><p>${escape(advice.evidence)}</p><small>${escape(advice.confidence)}</small></div><div class="advice-note">Suggestions use local troubleshooting rules. Commands are formatted for PowerShell and are shown for you to review and run.</div><div class="fix-list">${advice.steps.map((step, index) => `<article class="fix-step ${escape(step.risk)}"><span class="step-number">${index + 1}</span><div><div class="fix-title"><h3>${escape(step.title)}</h3><span class="risk-badge ${escape(step.risk)}">${step.risk === 'disruptive' ? 'Disruptive operation' : step.risk === 'change' ? 'Reviewed change' : 'Investigation'}</span></div><p>${escape(step.explanation)}</p>${step.command ? `<div class="command-box"><code>${escape(step.command)}</code><button class="button small" data-copy="${escape(step.command)}">Copy</button></div>` : ''}</div></article>`).join('')}</div>`;
  } catch (e) { if (version === adviceVersion) $('fixes-content').innerHTML = `<div class="notice danger">${escape(e.message)}</div>`; }
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); } catch { toast('Clipboard access is unavailable. Select the text and copy it manually.'); } }
$('fixes-content').onclick = event => { const button = event.target.closest('[data-copy]'); if (button) copyText(button.dataset.copy); };

const logBuffer = new LogBuffer();
let logIndices = [], logController = null, logVersion = 0, logBusy = false, logFrame = 0, logFilterTimer, logFilterNeeded = false;
function logNotice(message, error = false) { $('log-notice').textContent = message; $('log-notice').classList.toggle('danger', error); }
function logButtons() {
  const noContainer = !$('log-container').value;
  $('log-load').disabled = noContainer || logBusy; $('log-live').disabled = noContainer || logBusy || $('log-previous').checked;
  $('log-stop').disabled = !logBusy; $('log-download').disabled = !logBuffer.size;
}
function stopLogs() { logVersion++; logController?.abort(); logController = null; logBusy = false; logButtons(); }
function clearLogView() { stopLogs(); logBuffer.reset(); logIndices = []; $('log-viewport').scrollTop = 0; $('log-line-detail').hidden = true; rebuildLogView(); }
function setupLogSelectors() {
  const pods = inspectedApp()?.pods || [];
  $('log-pod').innerHTML = pods.map(p => `<option value="${escape(p.name)}">${escape(p.name)}</option>`).join('');
  $('log-search').value = ''; $('log-level').value = 'all'; $('log-previous').checked = false;
  updateContainers(); logNotice(pods.length ? 'Select a container and load recent logs. Logs stay in this browser session.' : 'No observed pods are available for logs. Refresh health or inspect the proposed fixes.');
}
function updateContainers() {
  const pod = inspectedApp()?.pods.find(p => p.name === $('log-pod').value);
  $('log-container').innerHTML = (pod?.containers || []).map(c => `<option value="${escape(c.name)}">${escape(c.name)}${c.type === 'init' ? ' (init)' : c.type === 'ephemeral' ? ' (ephemeral)' : ''}</option>`).join('');
  clearLogView();
}
$('log-pod').onchange = () => { updateContainers(); logNotice('Pod changed. Load logs for the selected container.'); };
for (const id of ['log-container', 'log-tail', 'log-since', 'log-previous']) $(id).onchange = () => { clearLogView(); logNotice('Selection changed. Load logs with these settings.'); };
function logRequest() { return { namespace: inspectedApp()?.namespace, pod: $('log-pod').value, container: $('log-container').value, tail: Number($('log-tail').value), sinceSeconds: Number($('log-since').value), previous: $('log-previous').checked }; }
function appendLogs(lines) { logBuffer.append(lines); rebuildLogView(); }
function rebuildLogView() {
  logFilterNeeded = true; scheduleLogFrame(); logButtons();
}
function scheduleLogFrame() {
  if (logFrame) return;
  logFrame = requestAnimationFrame(() => { logFrame = 0; if (logFilterNeeded) { logFilterNeeded = false; applyLogFilter(); } renderLogRows(); });
}
function applyLogFilter() {
  logIndices = logBuffer.filter($('log-search').value, $('log-level').value);
  $('log-spacer').style.height = `${logIndices.length * ROW_HEIGHT}px`;
  $('log-count').textContent = `${logIndices.length.toLocaleString()} matching / ${logBuffer.size.toLocaleString()} retained lines · ${(logBuffer.bytes / 1024).toFixed(0)} KiB${logBuffer.dropped ? ` · ${logBuffer.dropped.toLocaleString()} older lines discarded` : ''}`;
  if ($('log-autoscroll').checked) $('log-viewport').scrollTop = Math.max(0, logIndices.length * ROW_HEIGHT - ($('log-viewport').clientHeight || 390));
}
function renderLogRows() {
  const viewport = $('log-viewport');
  const { start, end } = visibleRange(viewport.scrollTop, viewport.clientHeight || 390, logIndices.length);
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const line = logBuffer.at(logIndices[i]); if (!line) continue;
    const row = document.createElement('button'); row.className = `log-row ${line.level}`; row.type = 'button';
    const number = document.createElement('span'); number.className = 'line-number'; number.textContent = line.number;
    const text = document.createElement('span'); text.className = 'line-text'; text.textContent = line.text;
    row.append(number, text); row.onclick = () => { $('log-line-text').textContent = line.text; $('log-line-detail').hidden = false; };
    fragment.append(row);
  }
  if (!logIndices.length) { const empty = document.createElement('p'); empty.className = 'log-empty'; empty.textContent = logBuffer.size ? 'No loaded lines match these filters.' : 'Load logs to begin.'; fragment.append(empty); }
  $('log-rows').style.transform = `translateY(${start * ROW_HEIGHT}px)`; $('log-rows').replaceChildren(fragment);
}
$('log-viewport').onscroll = scheduleLogFrame;
$('log-search').oninput = () => { clearTimeout(logFilterTimer); logFilterTimer = setTimeout(() => { $('log-viewport').scrollTop = 0; rebuildLogView(); }, 150); };
$('log-level').onchange = () => { $('log-viewport').scrollTop = 0; rebuildLogView(); };
$('log-autoscroll').onchange = rebuildLogView;
$('log-load').onclick = () => loadLogs(false); $('log-live').onclick = () => loadLogs(true);
$('log-stop').onclick = () => { stopLogs(); logNotice('Stopped. Loaded lines remain available for search and export.'); };
async function loadLogs(live) {
  clearLogView(); const version = ++logVersion; logController = new AbortController(); const controller = logController;
  logBusy = true; logButtons(); logNotice(live ? 'Connecting live stream…' : 'Loading recent log snapshot…');
  try {
    if (!live) {
      const result = await api('/api/logs', logRequest(), controller.signal);
      if (version !== logVersion) return;
      appendLogs(result.lines); logNotice(`Snapshot loaded at ${date(result.checkedAt)}.${result.limited ? ' Tail or 1 MiB limit reached; narrow the time window for a smaller slice.' : ''}`);
    } else {
      const response = await fetch('/api/logs/follow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(logRequest()), signal: controller.signal });
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Log stream failed.'); }
      if (!response.body?.getReader) throw new Error('This browser does not support streaming logs. Use Load logs or an updated browser.');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', doneMessage = 'Log stream ended.';
      while (version === logVersion) {
        const { done, value } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const packet = pending.slice(0, newline); pending = pending.slice(newline + 1); if (!packet) continue;
          const event = JSON.parse(packet);
          if (version !== logVersion) return;
          if (event.type === 'lines') appendLogs(event.lines);
          if (event.type === 'start') logNotice('Live stream active. Stops after 5 minutes or 20 MiB; up to 20,000 lines / 4 MiB retained.');
          if (event.type === 'end') doneMessage = event.message;
          if (event.type === 'error') throw new Error(event.message);
        }
      }
      if (version === logVersion) logNotice(doneMessage);
    }
  } catch (e) { if (e.name !== 'AbortError' && version === logVersion) { controller.abort(); logNotice(e.message, true); } }
  finally { if (version === logVersion) { logBusy = false; logController = null; logButtons(); } }
}
$('log-download').onclick = () => {
  const text = logIndices.map(i => logBuffer.at(i).text).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${$('log-pod').value}-${$('log-container').value}-loaded.log`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported the loaded lines matching your filters.');
};
$('copy-log-line').onclick = () => copyText($('log-line-text').textContent);
$('close-log-line').onclick = () => $('log-line-detail').hidden = true;
window.addEventListener('pagehide', stopLogs);

let diagnosticController = null, diagnosticVersion = 0, diagnosticReport = null;
function stopDiagnostics() { diagnosticVersion++; diagnosticController?.abort(); diagnosticController = null; $('diagnostic-refresh').disabled = false; }
function setupDiagnostics() {
  diagnosticReport = null; $('diagnostic-copy').disabled = true; $('diagnostic-content').innerHTML = '';
  const app = inspectedApp(), pods = app?.pods || [];
  $('diagnostic-pod').innerHTML = pods.length ? pods.map(p => `<option value="${escape(p.name)}">${escape(p.name)}${p.ready ? '' : ' · needs attention'}</option>`).join('') : '<option value="">Workload only · no observed pods</option>';
  if (pods.length) $('diagnostic-pod').value = (pods.find(p => !p.ready && !p.completed) || pods[0]).name;
  $('diagnostic-refresh').disabled = !app;
  $('diagnostic-status').textContent = app ? 'Open Diagnostics to gather fresh read-only evidence.' : 'A current monitored application is required. Use Issue & proposed fixes for monitor access problems.';
}
$('diagnostic-pod').onchange = () => { diagnosticReport = null; loadDiagnostics(false); };
$('diagnostic-refresh').onclick = () => loadDiagnostics(true);
$('diagnostic-copy').onclick = () => { if (diagnosticReport) copyText(diagnosticReport.summary); };
async function loadDiagnostics(refresh) {
  stopDiagnostics(); const app = inspectedApp(); if (!app) return;
  const version = ++diagnosticVersion, id = detailId;
  diagnosticController = new AbortController(); const controller = diagnosticController;
  $('diagnostic-refresh').disabled = true; $('diagnostic-copy').disabled = true;
  $('diagnostic-status').textContent = 'Collecting pod details, events, usage, rollout, storage, and backend evidence…'; $('diagnostic-status').classList.remove('danger');
  try {
    const report = await api('/api/diagnostics', { appId: id, pod: $('diagnostic-pod').value || undefined, refresh }, controller.signal);
    if (version !== diagnosticVersion || detailId !== id) return;
    diagnosticReport = report;
    $('diagnostic-status').textContent = `Evidence collected ${date(report.collectedAt)}${report.cached ? ' · cached for up to 10 seconds' : ''}${report.errors.length ? ` · ${report.errors.length} checks unavailable; useful results shown below` : ''}.`;
    renderDiagnostics(report); $('diagnostic-copy').disabled = false;
  } catch (e) { if (e.name !== 'AbortError' && version === diagnosticVersion) { $('diagnostic-status').textContent = e.message; $('diagnostic-status').classList.add('danger'); } }
  finally { if (version === diagnosticVersion) { diagnosticController = null; $('diagnostic-refresh').disabled = false; } }
}
function diagnosticTable(headers, rows) { return `<div class="table-scroll"><table class="diagnostic-table"><thead><tr>${headers.map(h => `<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }
function settings(values) { return Object.entries(values || {}).map(([key, value]) => `${escape(key)}: <strong>${escape(value)}</strong>`).join('<br>') || 'Not set'; }
function renderDiagnostics(r) {
  const pod = r.pod, w = r.workload;
  const conditionRows = (pod?.conditions || []).map(c => [escape(c.type), `<span class="diagnostic-condition ${c.status === 'True' ? 'good' : 'attention'}">${escape(c.status)}</span>`, escape(c.reason), escape(c.message || '—')]);
  const containers = (pod?.containers || []).map(c => `<article class="container-diagnostic"><div class="container-diagnostic-heading"><strong>${escape(c.name)} <small>${escape(c.type)}</small></strong><span>${escape(c.state)} · ${c.restarts} restarts</span></div><p class="image-reference">${escape(c.image)}</p><div class="diagnostic-grid"><div><span class="diagnostic-label">REQUESTS</span>${settings(c.resources.requests)}</div><div><span class="diagnostic-label">LIMITS</span>${settings(c.resources.limits)}</div><div><span class="diagnostic-label">LAST EXIT</span>${escape(c.lastExit || '—')} / code ${escape(c.exitCode ?? '—')}<small>${escape(date(c.lastFinishedAt))}</small></div></div><div class="probe-grid">${Object.entries(c.probes).map(([name, p]) => `<div class="probe-card"><strong>${escape(name)} probe</strong><p>${p ? escape(p.action) : 'Not configured'}</p>${p ? `<small>Delay ${p.initialDelay}s · Every ${p.period}s · Timeout ${p.timeout}s · Failures ${p.failureThreshold}</small>` : ''}</div>`).join('')}</div>${c.references.length ? `<p class="reference-names">Configuration references: ${c.references.map(v => `${escape(v.kind)}/${escape(v.name)}`).join(', ')} · values omitted</p>` : ''}</article>`).join('');
  const events = r.events.map(e => [escape(date(e.lastAt)), `<span class="event-type ${e.type === 'Warning' ? 'warning' : ''}">${escape(e.type)}</span>`, `<strong>${escape(e.reason)}</strong><small>${escape(e.object)} · Repeated ${e.count} times</small>`, escape(e.message)]);
  const services = r.services.map(s => [escape(s.name), escape(s.type), s.endpointsKnown ? `<strong>${s.readyEndpoints} / ${s.totalEndpoints}</strong> ready addresses` : 'Unavailable', s.ports.map(p => `${escape(p.port)} → ${escape(p.targetPort)} (${escape(p.protocol)})`).join('<br>'), `<code>${escape(Object.entries(s.selector).map(([k, v]) => `${k}=${v}`).join(', '))}</code>`]);
  const routes = r.routes.map(route => [escape(route.name), escape(route.host || '—'), escape(route.service), escape(route.targetPort ?? '—'), route.admitted === true ? 'Admitted' : `<span class="diagnostic-condition attention">${route.admitted === false ? 'Not admitted' : 'Unknown'}</span><small>${escape(route.reason || '')}</small>`]);
  $('diagnostic-content').innerHTML = `<div class="diagnostic-findings"><div class="section-title"><h3>What the evidence suggests</h3><span>Review timestamps and verify before drawing conclusions</span></div>${r.findings.map(f => `<article class="finding-card"><strong>${escape(f.title)}</strong><p>${escape(f.evidence)}</p><small>${escape(f.next)}</small></article>`).join('')}</div>${r.errors.length ? `<details class="diagnostic-section"><summary>Unavailable checks (${r.errors.length})</summary><div class="diagnostic-errors">${r.errors.map(e => `<p><strong>${escape(e.section)}</strong>: ${escape(e.message)}</p>`).join('')}<p>Optional checks depend on your existing account permissions and installed APIs. Application health monitoring continues separately.</p></div></details>` : ''}${r.notices.map(n => `<div class="notice">${escape(n)}</div>`).join('')}
+<details class="diagnostic-section" open><summary>Pod conditions & identity</summary><div class="diagnostic-grid pod-identity"><div><span class="diagnostic-label">POD / PHASE</span>${escape(pod?.name || 'No pod observed')}<small>${escape(pod?.phase || 'Unknown')}</small></div><div><span class="diagnostic-label">NODE / POD IP</span>${escape(pod?.node || '—')}<small>${escape(pod?.ip || '—')}</small></div><div><span class="diagnostic-label">OWNER / QOS</span>${escape(pod?.owner ? `${pod.owner.kind}/${pod.owner.name}` : '—')}<small>${escape(pod?.qos || '—')}</small></div></div>${conditionRows.length ? diagnosticTable(['Condition', 'Status', 'Reason', 'Evidence'], conditionRows) : '<p class="diagnostic-empty">No current pod conditions available.</p>'}</details>
+<details class="diagnostic-section" open><summary>Recent events (${r.events.length})</summary><div class="event-controls"><input id="diagnostic-event-search" type="search" placeholder="Find event messages or reasons…" aria-label="Search diagnostic events"><label class="sound-toggle"><input id="diagnostic-warnings" type="checkbox"> Warnings only</label><span>Latest 200 groups · Events can expire or refer to recovered issues</span></div><div id="diagnostic-events">${events.length ? diagnosticTable(['Last observed', 'Type', 'Reason', 'Message'], events.slice(0, 50)) : '<p class="diagnostic-empty">No retained events returned. This does not prove that no failure occurred.</p>'}</div><div class="diagnostic-pagination"><button id="event-prev" class="text-button">← Previous</button><span id="event-count"></span><button id="event-next" class="text-button">Next →</button></div></details>
+<details class="diagnostic-section" open><summary>Containers, resource limits & probes</summary>${containers || '<p class="diagnostic-empty">No pod specification available.</p>'}</details>
+<details class="diagnostic-section"><summary>Workload & rollout</summary>${w ? `<div class="diagnostic-grid pod-identity"><div><span class="diagnostic-label">READY / DESIRED</span>${w.ready} / ${w.desired ?? '?'}</div><div><span class="diagnostic-label">OBSERVED / GENERATION</span>${w.observedGeneration ?? '?'} / ${w.generation ?? '?'}</div><div><span class="diagnostic-label">STRATEGY</span>${escape(w.strategy || '—')}${w.paused ? ' · paused' : ''}</div></div>${diagnosticTable(['Condition', 'Status', 'Reason', 'Evidence'], w.conditions.map(c => [escape(c.type), escape(c.status), escape(c.reason), escape(c.message || '—')]))}` : '<p class="diagnostic-empty">Workload details unavailable.</p>'}</details>
+<details class="diagnostic-section"><summary>Current CPU & memory usage</summary><p class="diagnostic-hint">This is a current sample, not historical peak usage before a crash.</p>${r.metrics ? `<pre class="diagnostic-pre">${escape(r.metrics)}</pre>` : '<p class="diagnostic-empty">Metrics unavailable or no current pod.</p>'}</details>
+<details class="diagnostic-section" open><summary>Services & route admission</summary>${services.length ? diagnosticTable(['Service', 'Type', 'Backends', 'Ports', 'Selector'], services) : '<p class="diagnostic-empty">No matching selector-based services were observed, or service access is unavailable.</p>'}${routes.length ? diagnosticTable(['Route', 'Host', 'Service', 'Port', 'Admission'], routes) : '<p class="diagnostic-empty">No related routes returned. This report does not perform HTTP requests or connectivity tests.</p>'}</details>
+<details class="diagnostic-section"><summary>Storage, quotas & namespace defaults</summary>${r.storage.length ? diagnosticTable(['Claim', 'Phase', 'Storage class', 'Requested', 'Capacity'], r.storage.map(p => [escape(p.name), escape(p.phase), escape(p.storageClass || '—'), escape(p.requested || '—'), escape(p.capacity || '—')])) : '<p class="diagnostic-empty">No referenced persistent volume claims inspected.</p>'}${r.quotas.length ? diagnosticTable(['Quota', 'Used', 'Hard'], r.quotas.map(q => [escape(q.name), settings(q.used), settings(q.hard)])) : '<p class="diagnostic-empty">No quota data returned.</p>'}${r.limitRanges.map(l => `<div class="namespace-default"><strong>${escape(l.name)}</strong><pre>${escape(JSON.stringify(l.limits, null, 2))}</pre></div>`).join('')}</details>
+<details class="diagnostic-section"><summary>Describe pod (sensitive fields omitted)</summary><p class="diagnostic-hint">Environment values, annotations, startup commands/arguments, and raw probe details are omitted. Structured probe and resource settings are above.</p>${r.describe ? `<pre class="diagnostic-pre">${escape(r.describe)}</pre>` : '<p class="diagnostic-empty">Describe output unavailable or no pod observed.</p>'}</details>`.replace(/\n\+/g, '\n');
  let eventPage = 0;
  const renderEvents = () => {
    const search = $('diagnostic-event-search').value.toLowerCase();
    const matching = r.events.filter(e => (!$('diagnostic-warnings').checked || e.type === 'Warning') && `${e.reason} ${e.message}`.toLowerCase().includes(search));
    eventPage = Math.min(eventPage, Math.max(0, Math.ceil(matching.length / 50) - 1));
    $('event-count').textContent = `${matching.length ? eventPage * 50 + 1 : 0}–${Math.min(matching.length, (eventPage + 1) * 50)} of ${matching.length}`;
    $('event-prev').disabled = eventPage === 0; $('event-next').disabled = (eventPage + 1) * 50 >= matching.length;
    $('diagnostic-events').innerHTML = matching.length ? diagnosticTable(['Last observed', 'Type', 'Reason', 'Message'], matching.slice(eventPage * 50, (eventPage + 1) * 50).map(e => [escape(date(e.lastAt)), `<span class="event-type ${e.type === 'Warning' ? 'warning' : ''}">${escape(e.type)}</span>`, `<strong>${escape(e.reason)}</strong><small>${escape(e.object)} · Repeated ${e.count} times</small>`, escape(e.message)])) : '<p class="diagnostic-empty">No retained event groups match these filters.</p>';
  };
  $('diagnostic-event-search').oninput = () => { eventPage = 0; renderEvents(); }; $('diagnostic-warnings').onchange = () => { eventPage = 0; renderEvents(); };
  $('event-prev').onclick = () => { eventPage--; renderEvents(); }; $('event-next').onclick = () => { eventPage++; renderEvents(); }; renderEvents();
}
window.addEventListener('pagehide', stopDiagnostics);
