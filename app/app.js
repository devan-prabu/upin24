'use strict';
/* WIRflow SPA — all 15 blueprint modules. Vanilla JS, hash router, zero build step. */

/* ================= core ================= */
const API = '/api/app';
const S = {
  token: localStorage.getItem('wf_token') || null,
  user: JSON.parse(localStorage.getItem('wf_user') || 'null'),
  project: null,
  projects: [],
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (d) => (d ? String(d).slice(0, 10) : '—');
const fmtTime = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (S.token) opts.headers.Authorization = 'Bearer ' + S.token;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(API + path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) { logout(); throw new Error('Session expired — sign in again.'); }
  if (!r.ok) throw new Error(data.error || 'Request failed (' + r.status + ')');
  return data;
}
async function uploadFile(file) {
  const r = await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + S.token }, body: file,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Upload failed');
  return d;
}
function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'alert ' + (kind === 'err' ? 'a-red' : kind === 'warn' ? 'a-warn' : 'a-green');
  t.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999;max-width:420px;box-shadow:0 10px 30px rgba(0,0,0,.2)';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

/* ================= status badges ================= */
const BADGE = {
  'Draft': 'b-gray', 'Submitted': 'b-blue', 'Under Review': 'b-indigo', 'Approved': 'b-green',
  'Rejected': 'b-red', 'Resubmit Required': 'b-amber', 'Pending': 'b-amber', 'Completed': 'b-green',
  'Open': 'b-red', 'Closed': 'b-green', 'PASS': 'b-green', 'FAIL': 'b-red',
};
const badge = (s) => `<span class="badge ${BADGE[s] || 'b-gray'}">${esc(s || '—')}</span>`;
const MCELL = { 'N/A': 'mc-na', 'Not Started': 'mc-not', 'Draft': 'mc-draft', 'Submitted': 'mc-sub', 'Under Review': 'mc-rev', 'Approved': 'mc-ok', 'Rejected': 'mc-rej', 'Resubmit Required': 'mc-rej', 'TR Pending': 'mc-tr' };

/* ================= auth & shell ================= */
function logout() {
  if (S.token) api('POST', '/auth/logout').catch(() => {});
  localStorage.removeItem('wf_token'); localStorage.removeItem('wf_user');
  S.token = null; S.user = null;
  showLogin();
}
function showLogin() { $('loginScreen').hidden = false; $('appShell').hidden = true; }
async function showApp() {
  $('loginScreen').hidden = true; $('appShell').hidden = false;
  $('userName').textContent = S.user.name;
  $('userRole').textContent = S.user.role;
  const { projects } = await api('GET', '/projects');
  S.projects = projects;
  const saved = localStorage.getItem('wf_project');
  S.project = projects.find((p) => p.id === saved) || projects[0] || null;
  $('projectSelect').innerHTML = projects.map((p) => `<option value="${p.id}" ${S.project && p.id === S.project.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  pollNotifications();
  render();
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    const d = await api('POST', '/auth/login', { email: $('loginEmail').value, password: $('loginPassword').value });
    S.token = d.token; S.user = d.user;
    localStorage.setItem('wf_token', d.token); localStorage.setItem('wf_user', JSON.stringify(d.user));
    location.hash = '#/dashboard';
    showApp();
  } catch (err) { $('loginError').textContent = err.message; }
});
$('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });
$('projectSelect').addEventListener('change', () => {
  S.project = S.projects.find((p) => p.id === $('projectSelect').value);
  localStorage.setItem('wf_project', S.project.id);
  render();
});

/* ================= notifications (M11) ================= */
let bellTimer = null;
async function pollNotifications() {
  clearTimeout(bellTimer);
  try {
    const q = S.project ? `?project_id=${S.project.id}` : '';
    const d = await api('GET', '/notifications' + q);
    $('bellCount').hidden = !d.unread;
    $('bellCount').textContent = d.unread;
    $('bellList').innerHTML = d.notifications.length ? d.notifications.map((n) => `
      <div class="notif ${n.read_at ? '' : 'unread'}">
        <div class="ntype" style="color:${/FAIL|OVERDUE|NCR_RAISED|REJECT/.test(n.type) ? 'var(--danger)' : /APPROVED|CLEARED|CLOSED/.test(n.type) ? 'var(--success)' : 'var(--accent)'}">${esc(n.type.replace(/_/g, ' '))}</div>
        <div>${esc(n.message)}</div><div class="ntime">${fmtTime(n.sent_at)}</div>
      </div>`).join('') : '<div class="notif muted">No notifications yet.</div>';
  } catch (e) { /* not logged in yet */ }
  bellTimer = setTimeout(pollNotifications, 30000);
}
$('bellBtn').addEventListener('click', () => { $('bellPanel').hidden = !$('bellPanel').hidden; });
$('markAllRead').addEventListener('click', async () => { await api('POST', '/notifications/read', {}); pollNotifications(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.bell-wrap')) $('bellPanel').hidden = true; });

/* ================= router ================= */
const routes = {
  dashboard: viewDashboard, matrix: viewMatrix, 'lab-matrix': viewLabMatrix,
  wirs: viewWirs, 'wir': viewWirDetail, 'wir-new': viewWirNew,
  trs: viewTrs, 'tr': viewTrDetail, 'tr-new': viewTrNew,
  results: viewResults, fdt: viewFdt, ncrs: viewNcrs, ncr: viewNcrDetail,
  drawings: viewDrawings, drawing: viewDrawingDetail, zones: viewZones, zone: viewZoneDetail,
  programme: viewProgramme, 'method-statements': viewMs, handover: viewHandover, team: viewTeam,
};
function parseHash() {
  const parts = (location.hash.replace(/^#\//, '') || 'dashboard').split('/');
  if (parts[0] === 'wir' && parts[1] === 'new') return { view: 'wir-new' };
  if (parts[0] === 'tr' && parts[1] === 'new') return { view: 'tr-new', arg: parts[2] };
  if (parts[1]) return { view: parts[0], arg: parts[1] };
  return { view: parts[0] };
}
async function render() {
  if (!S.token || !S.user) return showLogin();
  if (!S.project) { $('view').innerHTML = '<div class="card">No projects yet. Ask an Admin/QA to create one.</div>'; return; }
  const { view, arg } = parseHash();
  const fn = routes[view] || viewDashboard;
  document.querySelectorAll('#sideNav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === view || (view === 'wir' && a.dataset.nav === 'wirs') || (view === 'tr' && a.dataset.nav === 'trs') || (view === 'ncr' && a.dataset.nav === 'ncrs') || (view === 'drawing' && a.dataset.nav === 'drawings') || (view === 'zone' && a.dataset.nav === 'zones')));
  $('view').innerHTML = '<div class="muted">Loading…</div>';
  try { await fn(arg); } catch (err) { $('view').innerHTML = `<div class="alert a-red">${esc(err.message)}</div>`; }
}
window.addEventListener('hashchange', render);
const P = () => S.project.id;
const setTitle = (t) => { $('pageTitle').textContent = t; };
const canQA = () => ['QA', 'Admin'].includes(S.user.role);

/* ================= dashboard ================= */
async function viewDashboard() {
  setTitle('Dashboard');
  const [d, prog, wirs] = await Promise.all([
    api('GET', `/dashboard?project_id=${P()}`),
    api('GET', `/programme?project_id=${P()}`),
    api('GET', `/wirs?project_id=${P()}`),
  ]);
  const flagged = prog.activities.filter((a) => a.flag);
  const recent = wirs.wirs.slice(0, 6);
  $('view').innerHTML = `
  <div class="grid cols-4">
    <div class="card stat blue"><div class="n">${d.wirs.awaiting}</div><div class="l">WIRs awaiting review</div></div>
    <div class="card stat amber"><div class="n">${d.trs.pending}</div><div class="l">Test results pending</div></div>
    <div class="card stat red"><div class="n">${d.trs.overdue + d.ncrs.open}</div><div class="l">Overdue results + open NCRs</div></div>
    <div class="card stat green"><div class="n">${d.wirs.approved}/${d.wirs.total}</div><div class="l">WIRs approved</div></div>
  </div>
  <div class="grid cols-2" style="margin-top:16px">
    <div class="card"><h3>⚠️ Upcoming inspections without WIR</h3>
      ${flagged.length ? `<table class="tbl">${flagged.map((a) => `<tr><td>${esc(a.zone_name)}</td><td>${esc(a.name)}</td><td>${fmtDate(a.planned_start)}</td><td><span class="badge ${a.flag === 'WIR Overdue' ? 'b-red' : 'b-amber'}">${a.flag}</span></td></tr>`).join('')}</table>
      <p class="small" style="margin-top:8px"><a href="#/wir/new">Raise a WIR →</a></p>` : '<p class="muted">All planned activities have WIRs. 👌</p>'}
    </div>
    <div class="card"><h3>Recent WIRs</h3>
      <table class="tbl">${recent.map((w) => `<tr class="click" onclick="location.hash='#/wir/${w.id}'"><td><b>${esc(w.wir_number)}</b></td><td>${esc(w.zone_name || '')}</td><td>${badge(w.status)}</td><td class="small muted">${esc(w.engineer_name || '')}</td></tr>`).join('')}</table>
    </div>
  </div>`;
}

/* ================= M08 IR matrix ================= */
async function viewMatrix() {
  setTitle('IR Matrix — Zone × Activity');
  const d = await api('GET', `/matrix?project_id=${P()}`);
  const cellHtml = (z, t, c) => {
    if (c.state === 'N/A') return `<span class="mcell mc-na">—</span>`;
    const cls = MCELL[c.state] || 'mc-not';
    const target = c.wirs.length === 1 ? `#/wir/${c.wirs[0].id}` : `#/wirs`;
    const label = c.state + (c.tr_pending ? ` (${c.tr_pending} TR)` : '');
    return `<a class="mcell ${cls}" href="${target}" title="${c.wirs.map((w) => w.wir_number).join(', ') || 'No WIR yet'}">${esc(label)}</a>`;
  };
  $('view').innerHTML = `
  <div class="legend">
    <span><span class="dot" style="background:#e5e7eb"></span>Not Started</span>
    <span><span class="dot" style="background:#fef9c3"></span>Draft</span>
    <span><span class="dot" style="background:#dbeafe"></span>Submitted</span>
    <span><span class="dot" style="background:#e0e7ff"></span>Under Review</span>
    <span><span class="dot" style="background:#bbf7d0"></span>Approved</span>
    <span><span class="dot" style="background:#fecaca"></span>Rejected</span>
    <span><span class="dot" style="background:#fed7aa"></span>TR Pending</span>
  </div>
  <div class="card matrix-wrap"><table class="matrix">
    <tr><th>Zone</th>${d.activity_types.map((t) => `<th>${esc(t)}</th>`).join('')}</tr>
    ${d.grid.map((row) => `<tr>
      <td class="zone-cell">${esc(row.zone.name)}<div class="prog-outer"><div class="prog-inner" style="width:${row.progress}%"></div></div><span class="small muted">${row.progress}% approved</span></td>
      ${d.activity_types.map((t) => `<td>${cellHtml(row.zone, t, row.cells[t])}</td>`).join('')}
    </tr>`).join('')}
  </table></div>`;
}

/* ================= M09 lab matrix ================= */
async function viewLabMatrix() {
  setTitle('Lab Test Matrix');
  const d = await api('GET', `/lab-matrix?project_id=${P()}`);
  const cell = (c) => {
    const cls = c.state === 'PASS' ? 'mc-ok' : c.state === 'FAIL' ? 'mc-rej' : c.state === 'Pending' ? 'mc-draft' : 'mc-na';
    const first = c.trs[0];
    const href = first ? `#/tr/${first.id}` : null;
    const label = c.state === 'N/A' ? '—' : c.state;
    return href ? `<a class="mcell ${cls}" href="${href}" title="${c.trs.map((t) => t.tr_number).join(', ')}">${label}</a>` : `<span class="mcell ${cls}">${label}</span>`;
  };
  $('view').innerHTML = `
  <div class="card matrix-wrap"><table class="matrix">
    <tr><th>WIR / Activity</th>${d.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
    ${d.rows.map((r) => `<tr>
      <td class="zone-cell"><a href="#/wir/${r.wir.id}"><b>${esc(r.wir.wir_number)}</b></a><br><span class="small muted">${esc(r.wir.zone_name || '')} · ${esc(r.wir.activity_type || '')}</span></td>
      ${d.columns.map((c) => `<td>${cell(r.cells[c])}</td>`).join('')}
    </tr>`).join('')}
    <tr><td class="zone-cell"><b>Pass rate</b></td>${d.columns.map((c) => {
      const s = d.summary[c];
      return `<td class="small" style="text-align:center">${s.done ? Math.round(100 * s.pass / s.done) + '%' : '—'}<br><span class="muted">${s.done}/${s.total} done</span></td>`;
    }).join('')}</tr>
  </table></div>`;
}

/* ================= M04 WIR tracker ================= */
async function viewWirs() {
  setTitle('Work Inspection Requests');
  const zones = (await api('GET', `/zones?project_id=${P()}`)).zones;
  const qStatus = sessionStorage.getItem('wf_wir_status') || '';
  const qZone = sessionStorage.getItem('wf_wir_zone') || '';
  const q = `?project_id=${P()}` + (qStatus ? `&status=${encodeURIComponent(qStatus)}` : '') + (qZone ? `&zone_id=${qZone}` : '');
  const d = await api('GET', '/wirs' + q);
  $('view').innerHTML = `
  <div class="pagehead"><h2>WIRs (${d.wirs.length})</h2>
    <div class="filters">
      <select id="fStatus"><option value="">All statuses</option>${['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Resubmit Required'].map((s) => `<option ${s === qStatus ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="fZone"><option value="">All zones</option>${zones.map((z) => `<option value="${z.id}" ${z.id === qZone ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select>
      <a class="btn btn-cta btn-sm" href="#/wir/new">+ New WIR</a>
    </div></div>
  <div class="card" style="padding:0;overflow-x:auto"><table class="tbl">
    <tr><th>WIR #</th><th>Date</th><th>Zone</th><th>Activity</th><th>Status</th><th>Tests</th><th>NCR</th><th>Engineer</th></tr>
    ${d.wirs.map((w) => `<tr class="click" onclick="location.hash='#/wir/${w.id}'">
      <td><b>${esc(w.wir_number)}</b></td><td>${fmtDate(w.inspection_date)}</td><td>${esc(w.zone_name || '—')}</td>
      <td>${esc(w.description || w.activity_type || '')}</td><td>${badge(w.status)}</td>
      <td>${w.tr_total ? `${w.tr_total - w.tr_pending}/${w.tr_total}${w.tr_failed ? ` <span class="badge b-red">${w.tr_failed} fail</span>` : ''}${w.tr_pending ? ` <span class="badge b-amber">${w.tr_pending} pending</span>` : ''}` : '<span class="muted">—</span>'}</td>
      <td>${w.ncr_open ? `<span class="badge b-red">${w.ncr_open} open</span>` : '—'}</td>
      <td class="small">${esc(w.engineer_name || '')}</td></tr>`).join('')}
  </table></div>`;
  $('fStatus').onchange = (e) => { sessionStorage.setItem('wf_wir_status', e.target.value); render(); };
  $('fZone').onchange = (e) => { sessionStorage.setItem('wf_wir_zone', e.target.value); render(); };
}

async function viewWirDetail(id) {
  const { wir: w } = await api('GET', `/wirs/${id}`);
  setTitle(w.wir_number);
  const actions = [];
  if (w.status === 'Draft' && (S.user.id === w.engineer_id || canQA())) actions.push(['Submitted', 'Submit', 'btn-cta']);
  if (canQA()) {
    if (w.status === 'Submitted') actions.push(['Under Review', 'Start Review', 'btn-navy']);
    if (['Submitted', 'Under Review'].includes(w.status)) {
      actions.push(['Approved', 'Approve', 'btn-cta'], ['Rejected', 'Reject', 'btn-danger'], ['Resubmit Required', 'Request Resubmission', 'btn-outline']);
    }
  }
  if (['Rejected', 'Resubmit Required'].includes(w.status) && (S.user.id === w.engineer_id || canQA())) actions.push(['Submitted', 'Resubmit', 'btn-cta']);
  $('view').innerHTML = `
  <div class="pagehead"><h2>${esc(w.wir_number)} ${badge(w.status)}</h2>
    <div>${actions.map(([st, label, cls]) => `<button class="btn ${cls} btn-sm" data-status="${st}" ${st === 'Approved' && w.approval_blockers.length ? 'disabled title="' + esc(w.approval_blockers.join('; ')) + '"' : ''}>${label}</button>`).join(' ')}</div></div>
  ${w.approval_blockers.length ? `<div class="alert a-warn"><b>Cannot approve:</b> ${esc(w.approval_blockers.join(' · '))}</div>` : ''}
  <div class="grid cols-2">
    <div class="card"><h3>Details</h3><table class="tbl">
      <tr><td class="muted">Description</td><td>${esc(w.description || '—')}</td></tr>
      <tr><td class="muted">Zone</td><td>${esc(w.zone_name || '—')}</td></tr>
      <tr><td class="muted">Activity</td><td>${esc(w.activity_name || w.activity_type || '—')} (${esc(w.activity_type)})</td></tr>
      <tr><td class="muted">Location</td><td>${esc(w.location || '—')}</td></tr>
      <tr><td class="muted">Contractor</td><td>${esc(w.contractor || '—')}</td></tr>
      <tr><td class="muted">Inspection date</td><td>${fmtDate(w.inspection_date)}</td></tr>
      <tr><td class="muted">Engineer</td><td>${esc(w.engineer_name || '—')}</td></tr></table>
      <h3 style="margin-top:14px">Checklist</h3>
      <table class="tbl">${w.checklist.map((c) => `<tr><td>${esc(c.item)}</td><td>${badge(c.result === 'Pass' ? 'PASS' : c.result === 'Fail' ? 'FAIL' : c.result)}</td></tr>`).join('') || '<tr><td class="muted">No checklist recorded</td></tr>'}</table>
      ${w.remarks ? `<p class="small" style="margin-top:8px"><b>Remarks:</b> ${esc(w.remarks)}</p>` : ''}
    </div>
    <div>
      <div class="card"><h3>Attached drawings (${w.drawings.length})</h3>
        ${w.drawings.map((dr) => `<div style="padding:5px 0;border-bottom:1px solid #f0f2f5"><a href="#/drawing/${dr.id}"><b>${esc(dr.drawing_number)}</b></a> ${esc(dr.revision)} <span class="small muted">${esc(dr.title || '')}</span></div>`).join('') || '<p class="muted">None attached.</p>'}
      </div>
      <div class="card" style="margin-top:14px"><h3>Lab tests (${w.trs.length})
        <a class="btn btn-outline btn-sm" style="float:right" href="#/tr/new/${w.id}">+ Test Request</a></h3>
        <table class="tbl">${w.trs.map((t) => `<tr class="click" onclick="location.hash='#/tr/${t.id}'"><td><b>${esc(t.tr_number)}</b></td><td>${esc(t.test_type)}</td><td>${t.pass_fail ? badge(t.pass_fail) : badge('Pending')}</td><td class="small muted">${t.due_28day ? '28d due ' + fmtDate(t.due_28day) : ''}</td></tr>`).join('') || '<tr><td class="muted">No test requests.</td></tr>'}</table>
      </div>
      <div class="card" style="margin-top:14px"><h3>NCRs (${w.ncrs.length})</h3>
        ${w.ncrs.map((n) => `<div style="padding:5px 0"><a href="#/ncr/${n.id}"><b>${esc(n.ncr_number)}</b></a> ${badge(n.status)} <span class="small muted">${esc(n.description.slice(0, 80))}</span></div>`).join('') || '<p class="muted">None.</p>'}
      </div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Timeline & comments</h3>
    <div class="timeline">${w.comments.map((c) => `<div class="tl-item"><b>${esc(c.user_name || 'System')}</b> <span class="muted small">${fmtTime(c.created_at)}</span><br>${c.status_change ? badge(c.status_change) + ' ' : ''}${esc(c.text)}</div>`).join('') || '<p class="muted">No activity yet.</p>'}</div>
    <form id="commentForm" style="display:flex;gap:8px"><input id="commentText" placeholder="Add a comment…" style="flex:1;padding:9px;border:1px solid var(--border);border-radius:9px"><button class="btn btn-navy btn-sm">Post</button></form>
  </div>`;
  document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    const status = b.dataset.status;
    let comment;
    if (['Rejected', 'Resubmit Required'].includes(status)) comment = prompt('Reason for ' + status + ':') || undefined;
    try {
      await api('PATCH', `/wirs/${id}/status`, { status, comment });
      toast(`${w.wir_number} → ${status}`);
      render(); pollNotifications();
    } catch (err) { toast(err.message, 'err'); }
  }));
  $('commentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('commentText').value.trim()) return;
    await api('POST', `/wirs/${id}/comments`, { text: $('commentText').value.trim() });
    render();
  });
}

/* ================= M03 WIR form ================= */
async function viewWirNew() {
  setTitle('New WIR');
  const ctx = await api('GET', `/wir-form-context?project_id=${P()}`);
  const prog = await api('GET', `/programme?project_id=${P()}`);
  const CHECKLIST = ['Work matches latest drawing revision', 'Materials approved and undamaged', 'Setting out / levels checked', 'Safety access in place', 'Housekeeping acceptable'];
  const TESTS = ['Slump', 'Concrete Cube C25', 'Concrete Cube C30', 'Concrete Cube C40', 'FDT', 'Steel Tensile'];
  let selectedDrawings = []; // {id, label}
  $('view').innerHTML = `
  <div class="card" style="max-width:860px">
    <h3>Work Inspection Request — ${esc(ctx.next_wir_number)}</h3>
    <div id="msWarning"></div>
    <div class="frow">
      <div class="field"><label>Zone</label><select id="wZone"><option value="">Select zone…</option>${ctx.zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Activity type</label><select id="wType">${ctx.activity_types.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
    </div>
    <div class="frow">
      <div class="field"><label>Programme activity (optional)</label><select id="wActivity"><option value="">—</option></select></div>
      <div class="field"><label>Inspection date</label><input type="date" id="wDate" value="${new Date().toISOString().slice(0, 10)}"></div>
    </div>
    <div class="field"><label>Description of work</label><input id="wDesc" placeholder="e.g. GF slab pour 420m³ C40 — grid A1-F6"></div>
    <div class="frow">
      <div class="field"><label>Location / grid ref</label><input id="wLoc" placeholder="A1-F6"></div>
      <div class="field"><label>Contractor</label><input id="wContractor" placeholder="Gulf Build LLC"></div>
    </div>
    <div class="field"><label>Drawings <span class="muted small">(zone selection auto-suggests — type to search all)</span></label>
      <input id="wDrawSearch" placeholder="Search drawing number…">
      <div id="wDrawResults" class="chips"></div>
      <div class="small muted" style="margin-top:6px">Attached:</div>
      <div id="wDrawSelected" class="chips"></div>
    </div>
    <div class="field"><label>Checklist</label>
      <table class="tbl">${CHECKLIST.map((c, i) => `<tr><td>${esc(c)}</td><td style="white-space:nowrap">
        ${['Pass', 'Fail', 'N/A'].map((r) => `<label style="margin-right:10px;font-weight:400"><input type="radio" name="chk${i}" value="${r}" ${r === 'Pass' ? 'checked' : ''}> ${r}</label>`).join('')}
      </td></tr>`).join('')}</table>
    </div>
    <div class="field"><label>Lab tests required <span class="muted small">(TRs auto-created on submit)</span></label>
      <div class="chips">${TESTS.map((t) => `<span class="chip test-chip" data-test="${esc(t)}">${esc(t)}</span>`).join('')}</div>
    </div>
    <div class="field"><label>Remarks</label><textarea id="wRemarks" rows="2"></textarea></div>
    <div style="display:flex;gap:10px">
      <button class="btn btn-cta" id="wSubmit">Submit WIR</button>
      <button class="btn btn-outline" id="wDraft">Save as Draft</button>
    </div>
  </div>`;

  const renderSelected = () => {
    $('wDrawSelected').innerHTML = selectedDrawings.map((d) => `<span class="chip on" data-id="${d.id}">${esc(d.label)}<span class="x">×</span></span>`).join('') || '<span class="muted small">none yet</span>';
    $('wDrawSelected').querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
      selectedDrawings = selectedDrawings.filter((d) => d.id !== c.dataset.id); renderSelected();
    }));
  };
  renderSelected();
  const addDrawing = (d) => {
    if (!selectedDrawings.some((x) => x.id === d.id)) selectedDrawings.push({ id: d.id, label: `${d.drawing_number} ${d.revision}` });
    renderSelected();
  };
  // M13→M03: zone auto-suggest + filter programme activities
  $('wZone').addEventListener('change', async () => {
    const zid = $('wZone').value;
    $('wActivity').innerHTML = '<option value="">—</option>' + prog.activities.filter((a) => a.zone_id === zid).map((a) => `<option value="${a.id}" data-type="${esc(a.type)}">${esc(a.name)} (${fmtDate(a.planned_start)})</option>`).join('');
    if (!zid) return;
    const d = await api('GET', `/zones/${zid}/drawings`);
    d.drawings.forEach(addDrawing);
    if (d.drawings.length) toast(`${d.drawings.length} drawing(s) auto-suggested for this zone`);
  });
  $('wActivity').addEventListener('change', (e) => {
    const t = e.target.selectedOptions[0] && e.target.selectedOptions[0].dataset.type;
    if (t) { $('wType').value = t; $('wType').dispatchEvent(new Event('change')); }
  });
  // M02→M03: live drawing search
  let searchTimer;
  $('wDrawSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('wDrawSearch').value.trim();
      if (!q) { $('wDrawResults').innerHTML = ''; return; }
      const d = await api('GET', `/drawings?project_id=${P()}&q=${encodeURIComponent(q)}`);
      $('wDrawResults').innerHTML = d.drawings.slice(0, 8).map((dr) => `<span class="chip" data-id="${dr.id}" data-num="${esc(dr.drawing_number)}" data-rev="${esc(dr.revision)}">${esc(dr.drawing_number)} ${esc(dr.revision)}</span>`).join('') || '<span class="muted small">no matches</span>';
      $('wDrawResults').querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => addDrawing({ id: c.dataset.id, drawing_number: c.dataset.num, revision: c.dataset.rev })));
    }, 250);
  });
  // M10 gate warning
  const msCheck = () => {
    const gate = ctx.ms_status[$('wType').value];
    $('msWarning').innerHTML = gate && !gate.approved
      ? `<div class="alert a-warn">⚠️ No approved Method Statement for <b>${esc($('wType').value)}</b>${gate.ms ? ` (${esc(gate.ms.ms_number)} is ${esc(gate.ms.status)})` : ''}. You can save a Draft but not submit.</div>`
      : '';
  };
  $('wType').addEventListener('change', msCheck); msCheck();

  const save = async (status) => {
    const checklist = CHECKLIST.map((item, i) => ({ item, result: (document.querySelector(`input[name=chk${i}]:checked`) || {}).value || 'N/A' }));
    const tests = [...document.querySelectorAll('.test-chip.on')].map((c) => c.dataset.test);
    try {
      const d = await api('POST', '/wirs', {
        project_id: P(), zone_id: $('wZone').value || null, activity_id: $('wActivity').value || null,
        activity_type: $('wType').value, description: $('wDesc').value, location: $('wLoc').value,
        contractor: $('wContractor').value, inspection_date: $('wDate').value,
        checklist, drawing_ids: selectedDrawings.map((x) => x.id), tests_required: tests, remarks: $('wRemarks').value,
        status,
      });
      toast(`${d.wir.wir_number} ${status === 'Submitted' ? 'submitted' : 'saved as draft'}${d.spawned_trs.length ? ' · TRs: ' + d.spawned_trs.join(', ') : ''}`);
      location.hash = `#/wir/${d.wir.id}`;
    } catch (err) { toast(err.message, 'err'); }
  };
  document.querySelectorAll('.test-chip').forEach((c) => c.addEventListener('click', () => c.classList.toggle('on')));
  $('wSubmit').addEventListener('click', () => save('Submitted'));
  $('wDraft').addEventListener('click', () => save('Draft'));
}

/* ================= M05 test requests ================= */
async function viewTrs() {
  setTitle('Test Requests');
  const d = await api('GET', `/trs?project_id=${P()}`);
  $('view').innerHTML = `
  <div class="pagehead"><h2>Test Requests (${d.trs.length})</h2><a class="btn btn-cta btn-sm" href="#/tr/new">+ New TR</a></div>
  <div class="card" style="padding:0;overflow-x:auto"><table class="tbl">
    <tr><th>TR #</th><th>Test</th><th>WIR</th><th>Sample date</th><th>Due</th><th>Status</th><th>Result</th></tr>
    ${d.trs.map((t) => `<tr class="click" onclick="location.hash='#/tr/${t.id}'">
      <td><b>${esc(t.tr_number)}</b></td><td>${esc(t.test_type)}</td><td>${esc(t.wir_number || '—')}</td>
      <td>${fmtDate(t.sample_date)}</td>
      <td>${t.overdue ? `<span class="badge b-red">OVERDUE ${fmtDate(t.due)}</span>` : fmtDate(t.due)}</td>
      <td>${badge(t.status)}</td><td>${t.pass_fail ? badge(t.pass_fail) : '—'}</td></tr>`).join('')}
  </table></div>`;
}
async function viewTrNew(wirId) {
  setTitle('New Test Request');
  const specs = await api('GET', '/specs');
  const wirs = await api('GET', `/wirs?project_id=${P()}`);
  $('view').innerHTML = `
  <div class="card" style="max-width:640px"><h3>Test Request</h3>
    <div class="field"><label>Parent WIR</label><select id="tWir"><option value="">— standalone —</option>${wirs.wirs.map((w) => `<option value="${w.id}" ${w.id === wirId ? 'selected' : ''}>${esc(w.wir_number)} — ${esc(w.description || w.activity_type || '')}</option>`).join('')}</select></div>
    <div class="frow">
      <div class="field"><label>Test type</label><select id="tType">${specs.test_types.map((t) => `<option>${esc(t)}</option>`).join('')}</select></div>
      <div class="field"><label>Sample date</label><input type="date" id="tDate" value="${new Date().toISOString().slice(0, 10)}"></div>
    </div>
    <div class="frow">
      <div class="field"><label>Location</label><input id="tLoc"></div>
      <div class="field"><label>Sample count</label><input type="number" id="tCount" value="3"></div>
    </div>
    <div class="frow">
      <div class="field"><label>Spec reference</label><input id="tSpec" placeholder="e.g. C40 / target 160mm"></div>
      <div class="field"><label>Lab name</label><input id="tLab" value="Gulf Lab Services"></div>
    </div>
    <div id="tFdtExtra" class="frow" hidden>
      <div class="field"><label>Layer number</label><input type="number" id="tLayer" value="1"></div>
      <div class="field"><label>Area compacted (m²)</label><input type="number" id="tArea"></div>
    </div>
    <div id="tHint" class="alert a-blue" hidden></div>
    <div class="field"><label>Notes</label><textarea id="tNotes" rows="2"></textarea></div>
    <button class="btn btn-cta" id="tSave">Create TR</button>
  </div>`;
  const hint = () => {
    const t = $('tType').value;
    $('tFdtExtra').hidden = t !== 'FDT';
    const s = specs.specs[t];
    if (/Concrete Cube/.test(t)) { $('tHint').hidden = false; $('tHint').textContent = `7-day and 28-day result due dates will be scheduled automatically. Spec: min ${s.limit} ${s.unit}.`; }
    else if (s && s.limit != null) { $('tHint').hidden = false; $('tHint').textContent = `Spec: ${s.rule === 'tolerance' ? '±' : 'min '}${s.limit} ${s.unit}${s.note ? ' (' + s.note + ')' : ''}.`; }
    else $('tHint').hidden = true;
  };
  $('tType').addEventListener('change', hint); hint();
  $('tSave').addEventListener('click', async () => {
    try {
      const d = await api('POST', '/trs', {
        project_id: P(), wir_id: $('tWir').value || null, test_type: $('tType').value,
        sample_date: $('tDate').value, location: $('tLoc').value, sample_count: Number($('tCount').value) || null,
        spec_reference: $('tSpec').value, lab_name: $('tLab').value, notes: $('tNotes').value,
        layer_no: $('tFdtExtra').hidden ? null : Number($('tLayer').value), area_m2: $('tFdtExtra').hidden ? null : Number($('tArea').value) || null,
      });
      toast(`${d.tr.tr_number} created${d.tr.due_7day ? ` · results due ${fmtDate(d.tr.due_7day)} / ${fmtDate(d.tr.due_28day)}` : ''}`);
      location.hash = `#/tr/${d.tr.id}`;
    } catch (err) { toast(err.message, 'err'); }
  });
}
async function viewTrDetail(id) {
  const { tr } = await api('GET', `/trs/${id}`);
  setTitle(tr.tr_number);
  const latest = tr.results[0];
  $('view').innerHTML = `
  <div class="pagehead"><h2>${esc(tr.tr_number)} ${badge(tr.status)}</h2>
    ${tr.status === 'Pending' ? `<a class="btn btn-cta btn-sm" href="#/results" onclick="sessionStorage.setItem('wf_result_tr','${tr.id}')">Enter Result</a>` : ''}</div>
  <div class="grid cols-2">
    <div class="card"><h3>Request</h3><table class="tbl">
      <tr><td class="muted">Test type</td><td>${esc(tr.test_type)}</td></tr>
      <tr><td class="muted">Parent WIR</td><td>${tr.wir_id ? `<a href="#/wir/${tr.wir_id}">${esc(tr.wir_number)}</a>` : '—'}</td></tr>
      <tr><td class="muted">Sample date</td><td>${fmtDate(tr.sample_date)}</td></tr>
      ${tr.due_7day ? `<tr><td class="muted">7-day due</td><td>${fmtDate(tr.due_7day)}</td></tr><tr><td class="muted">28-day due</td><td>${fmtDate(tr.due_28day)}</td></tr>` : ''}
      ${tr.layer_no ? `<tr><td class="muted">Layer / area</td><td>Layer ${tr.layer_no} · ${tr.area_m2 || '?'} m²</td></tr>` : ''}
      <tr><td class="muted">Spec ref</td><td>${esc(tr.spec_reference || '—')}</td></tr>
      <tr><td class="muted">Lab</td><td>${esc(tr.lab_name || '—')}</td></tr>
      <tr><td class="muted">Spec limit</td><td>${tr.spec && tr.spec.limit != null ? `${tr.spec.rule === 'tolerance' ? '±' : 'min '}${tr.spec.limit} ${tr.spec.unit}` : '—'}</td></tr>
    </table>${tr.notes ? `<p class="small" style="margin-top:8px">${esc(tr.notes)}</p>` : ''}</div>
    <div class="card"><h3>Results</h3>
      ${latest ? `<div class="pass-big ${latest.pass_fail === 'PASS' ? 'pass' : 'fail'}">${latest.result_value} → ${latest.pass_fail}</div>
        <p class="small muted">vs limit ${latest.spec_limit ?? '—'} · ${fmtDate(latest.result_date)} · by ${esc(latest.entered_by_name || '')}</p>
        ${latest.report_url ? `<p><a href="${esc(latest.report_url)}" target="_blank">Lab report ↗</a></p>` : ''}` : '<p class="muted">Awaiting result.</p>'}
      ${tr.results.length > 1 ? `<h3 style="margin-top:12px">History</h3><table class="tbl">${tr.results.map((r) => `<tr><td>${r.result_value}</td><td>${badge(r.pass_fail)}</td><td>${fmtDate(r.result_date)}</td></tr>`).join('')}</table>` : ''}
    </div>
  </div>`;
}

/* ================= M06 results desk ================= */
async function viewResults() {
  setTitle('Lab Results Desk');
  const d = await api('GET', `/trs?project_id=${P()}&status=Pending`);
  const specs = await api('GET', '/specs');
  const preselect = sessionStorage.getItem('wf_result_tr'); sessionStorage.removeItem('wf_result_tr');
  const rows = d.trs;
  $('view').innerHTML = `
  <div class="pagehead"><h2>Pending results (${rows.length})</h2></div>
  <div class="grid cols-2">
    <div class="card" style="padding:0;overflow-x:auto"><table class="tbl">
      <tr><th>TR</th><th>Test</th><th>WIR</th><th>Due</th><th></th></tr>
      ${rows.map((t) => `<tr ${t.overdue ? 'style="background:#fff5f5"' : ''}>
        <td><b>${esc(t.tr_number)}</b></td><td>${esc(t.test_type)}</td><td>${esc(t.wir_number || '—')}</td>
        <td>${t.overdue ? `<span class="badge b-red">OVERDUE</span>` : fmtDate(t.due)}</td>
        <td><button class="btn btn-outline btn-sm pick" data-id="${t.id}">Enter</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing pending. 🎉</td></tr>'}
    </table></div>
    <div class="card" id="entryCard"><h3>Enter result</h3><p class="muted">Pick a TR from the list.</p></div>
  </div>`;
  const openEntry = (trId) => {
    const t = rows.find((x) => x.id === trId);
    if (!t) return;
    const spec = specs.specs[t.test_type] || {};
    $('entryCard').innerHTML = `<h3>Enter result — ${esc(t.tr_number)}</h3>
      <p class="small muted">${esc(t.test_type)} · ${t.wir_number ? 'for ' + esc(t.wir_number) : 'standalone'}</p>
      <div class="alert a-blue">Spec: ${spec.limit != null ? `${spec.rule === 'tolerance' ? '±' : 'min '}${spec.limit} ${spec.unit}` : 'record only'}${spec.note ? ' · ' + spec.note : ''}</div>
      <div class="frow">
        <div class="field"><label>Result value</label><input type="number" step="0.1" id="rValue" autofocus></div>
        <div class="field"><label>Spec limit override</label><input type="number" step="0.1" id="rLimit" placeholder="${spec.limit ?? ''}"></div>
      </div>
      <div class="frow">
        <div class="field"><label>Result date</label><input type="date" id="rDate" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Lab report (PDF)</label><input type="file" id="rFile" accept=".pdf"></div>
      </div>
      <button class="btn btn-cta" id="rSave">Save Result</button>
      <div id="rOutcome"></div>`;
    $('rSave').addEventListener('click', async () => {
      try {
        let report_url = null;
        const f = $('rFile').files[0];
        if (f) report_url = (await uploadFile(f)).url;
        const body = { result_value: Number($('rValue').value), result_date: $('rDate').value, report_url };
        if ($('rLimit').value) body.spec_limit = Number($('rLimit').value);
        const res = await api('POST', `/trs/${trId}/result`, body);
        if (res.pass_fail === 'FAIL') {
          $('rOutcome').innerHTML = `<div class="alert a-red" style="margin-top:12px"><b>FAIL</b> — ${esc(res.spec_detail)}.<br>
            <b>${esc(res.ncr.ncr_number)}</b> has been auto-raised and the QA manager notified. ${res.ncr.wir_id ? 'WIR approval is now blocked.' : ''}<br>
            <a href="#/ncr/${res.ncr.id}">Open NCR →</a></div>`;
        } else {
          $('rOutcome').innerHTML = `<div class="alert a-green" style="margin-top:12px"><b>PASS</b> — ${esc(res.spec_detail)}.</div>`;
          setTimeout(render, 1600);
        }
        pollNotifications();
      } catch (err) { toast(err.message, 'err'); }
    });
  };
  document.querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => openEntry(b.dataset.id)));
  if (preselect) openEntry(preselect);
}

/* ================= M07 FDT tracker ================= */
async function viewFdt() {
  setTitle('FDT Frequency Tracker');
  const d = await api('GET', `/fdt?project_id=${P()}`);
  $('view').innerHTML = `
  <div class="alert a-blue">Rule: required FDTs = ⌈area ÷ ${d.area_per_test} m²⌉ per layer per zone.</div>
  <div class="grid cols-2">
    <div class="card"><h3>Coverage by zone / layer</h3>
      <table class="tbl"><tr><th>Zone</th><th>Layer</th><th>Area m²</th><th>Required</th><th>Done</th><th>Status</th></tr>
      ${d.summary.map((s) => `<tr><td>${esc(s.zone_name)}</td><td>${s.layer_no}</td><td>${s.area_m2 || '—'}</td><td>${s.required}</td><td>${s.done}${s.failed ? ` <span class="badge b-red">${s.failed} fail</span>` : ''}</td>
        <td>${s.deficient ? '<span class="badge b-red">Deficient</span>' : '<span class="badge b-green">Sufficient</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No FDT logs yet.</td></tr>'}
      </table>
      <p class="small muted" style="margin-top:8px">Deficient coverage blocks approval of Backfill WIRs in that zone.</p>
    </div>
    <div class="card"><h3>FDT log</h3>
      <table class="tbl"><tr><th>TR</th><th>Zone</th><th>Layer</th><th>Result % MDD</th><th></th></tr>
      ${d.logs.map((l) => `<tr class="click" onclick="location.hash='#/tr/${l.id}'"><td><b>${esc(l.tr_number)}</b></td><td>${esc(l.zone_name)}</td><td>${l.layer_no}</td>
        <td>${l.result_value != null ? l.result_value + '% ' + badge(l.pass_fail) : badge('Pending')}</td><td class="small muted">${esc(l.wir_number)}</td></tr>`).join('')}
      </table>
      <p style="margin-top:10px"><a class="btn btn-outline btn-sm" href="#/tr/new">+ Log FDT (new TR, type FDT)</a></p>
    </div>
  </div>`;
}

/* ================= M15 NCRs ================= */
async function viewNcrs() {
  setTitle('Non-Conformance Reports');
  const d = await api('GET', `/ncrs?project_id=${P()}`);
  $('view').innerHTML = `
  <div class="pagehead"><h2>NCRs (${d.ncrs.length})</h2><button class="btn btn-cta btn-sm" id="newNcr">+ Raise NCR</button></div>
  <div class="card" style="padding:0;overflow-x:auto"><table class="tbl">
    <tr><th>NCR #</th><th>Source</th><th>Description</th><th>Status</th><th>Raised</th><th>Closed</th></tr>
    ${d.ncrs.map((n) => `<tr class="click" onclick="location.hash='#/ncr/${n.id}'">
      <td><b>${esc(n.ncr_number)}</b></td><td>${esc(n.tr_number || n.wir_number || n.source_type)}</td>
      <td>${esc(n.description.slice(0, 90))}</td><td>${badge(n.status)}</td>
      <td>${fmtDate(n.raised_at)}</td><td>${fmtDate(n.closed_at)}</td></tr>`).join('')}
  </table></div>`;
  $('newNcr').addEventListener('click', async () => {
    const description = prompt('Non-conformance description:');
    if (!description) return;
    const d2 = await api('POST', '/ncrs', { project_id: P(), description, source_type: 'Manual' });
    location.hash = `#/ncr/${d2.ncr.id}`;
  });
}
async function viewNcrDetail(id) {
  const { ncr: n } = await api('GET', `/ncrs/${id}`);
  setTitle(n.ncr_number);
  $('view').innerHTML = `
  <div class="pagehead"><h2>${esc(n.ncr_number)} ${badge(n.status)}</h2>
    <div>${n.status === 'Open' ? '<button class="btn btn-navy btn-sm" id="nReview">Move to Under Review</button>' : ''}
    ${n.status !== 'Closed' && canQA() ? '<button class="btn btn-cta btn-sm" id="nClose">Close NCR</button>' : ''}</div></div>
  <div class="grid cols-2">
    <div class="card"><h3>Non-conformance</h3>
      <p>${esc(n.description)}</p>
      <table class="tbl" style="margin-top:10px">
        <tr><td class="muted">Source</td><td>${n.tr_number ? `TR ${esc(n.tr_number)}` : esc(n.source_type)}${n.wir_number ? ` · <a href="#/wir/${n.wir_id}">${esc(n.wir_number)}</a>` : ''}</td></tr>
        <tr><td class="muted">Raised</td><td>${fmtTime(n.raised_at)}</td></tr>
        ${n.closed_at ? `<tr><td class="muted">Closed</td><td>${fmtTime(n.closed_at)} by ${esc(n.signed_off_name || '')}</td></tr>` : ''}
      </table>
      ${n.status !== 'Closed' ? `<div class="alert a-warn" style="margin-top:10px">This NCR blocks approval of ${n.wir_number ? esc(n.wir_number) : 'the linked WIR'} until closed.</div>` : ''}
    </div>
    <div class="card"><h3>Investigation & close-out</h3>
      <div class="field"><label>Root cause</label><textarea id="nRoot" rows="2" ${n.status === 'Closed' ? 'disabled' : ''}>${esc(n.root_cause || '')}</textarea></div>
      <div class="field"><label>Corrective action</label><textarea id="nAction" rows="2" ${n.status === 'Closed' ? 'disabled' : ''}>${esc(n.corrective_action || '')}</textarea></div>
      <div class="field"><label>Close-out evidence <span class="muted small">(required to close — e.g. passing re-test TR)</span></label><textarea id="nEvidence" rows="2" ${n.status === 'Closed' ? 'disabled' : ''}>${esc(n.closeout_evidence || '')}</textarea></div>
      ${n.status !== 'Closed' ? '<button class="btn btn-outline btn-sm" id="nSave">Save</button>' : '<p class="small muted">Closed — read only.</p>'}
    </div>
  </div>`;
  const saveFields = () => api('PATCH', `/ncrs/${id}`, { root_cause: $('nRoot').value, corrective_action: $('nAction').value, closeout_evidence: $('nEvidence').value });
  if ($('nSave')) $('nSave').addEventListener('click', async () => { await saveFields(); toast('Saved'); });
  if ($('nReview')) $('nReview').addEventListener('click', async () => { await saveFields(); await api('PATCH', `/ncrs/${id}`, { status: 'Under Review' }); render(); });
  if ($('nClose')) $('nClose').addEventListener('click', async () => {
    try { await saveFields(); await api('PATCH', `/ncrs/${id}`, { status: 'Closed' }); toast(`${n.ncr_number} closed`); render(); }
    catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= M02 drawings ================= */
async function viewDrawings() {
  setTitle('Shop Drawing Registry');
  const q = sessionStorage.getItem('wf_draw_q') || '';
  const d = await api('GET', `/drawings?project_id=${P()}${q ? '&q=' + encodeURIComponent(q) : ''}&latest=0`);
  $('view').innerHTML = `
  <div class="pagehead"><h2>Drawings (${d.drawings.length})</h2>
    <div class="filters"><input id="dq" placeholder="Search number or title…" value="${esc(q)}">
    <button class="btn btn-cta btn-sm" id="dUploadBtn">+ Upload Drawing</button></div></div>
  <div id="dUploadForm" class="card" hidden style="margin-bottom:14px">
    <h3>Upload drawing</h3>
    <div class="frow">
      <div class="field"><label>Drawing number</label><input id="uNum" placeholder="SD-STR-031"></div>
      <div class="field"><label>Revision</label><input id="uRev" placeholder="Rev 0"></div>
    </div>
    <div class="frow">
      <div class="field"><label>Title</label><input id="uTitle"></div>
      <div class="field"><label>Discipline</label><select id="uDisc"><option>Structural</option><option>MEP</option><option>Civil</option><option>Architectural</option></select></div>
    </div>
    <div class="field"><label>PDF file</label><input type="file" id="uFile" accept=".pdf"></div>
    <div class="alert a-blue small">Same drawing number → the new upload becomes Latest and previous revisions are marked Superseded automatically.</div>
    <button class="btn btn-cta btn-sm" id="uSave">Save</button>
  </div>
  <div class="card" style="padding:0;overflow-x:auto"><table class="tbl">
    <tr><th>Number</th><th>Title</th><th>Discipline</th><th>Revision</th><th>Status</th><th>Used in WIRs</th></tr>
    ${d.drawings.map((dr) => `<tr class="click" onclick="location.hash='#/drawing/${dr.id}'">
      <td><b>${esc(dr.drawing_number)}</b></td><td>${esc(dr.title || '')}</td><td>${esc(dr.discipline)}</td><td>${esc(dr.revision)}</td>
      <td>${dr.is_latest ? '<span class="badge b-green">Latest Rev</span>' : '<span class="badge b-gray">Superseded</span>'}</td>
      <td>${dr.wir_count || 0}</td></tr>`).join('')}
  </table></div>`;
  let t;
  $('dq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { sessionStorage.setItem('wf_draw_q', e.target.value); render(); }, 350); });
  $('dUploadBtn').addEventListener('click', () => { $('dUploadForm').hidden = !$('dUploadForm').hidden; });
  $('uSave').addEventListener('click', async () => {
    try {
      let file_url = null;
      if ($('uFile').files[0]) file_url = (await uploadFile($('uFile').files[0])).url;
      await api('POST', '/drawings', { project_id: P(), drawing_number: $('uNum').value, revision: $('uRev').value || 'Rev 0', title: $('uTitle').value, discipline: $('uDisc').value, file_url });
      toast('Drawing saved'); render();
    } catch (err) { toast(err.message, 'err'); }
  });
}
async function viewDrawingDetail(id) {
  const d = await api('GET', `/drawings/${id}`);
  setTitle(d.drawing.drawing_number);
  $('view').innerHTML = `
  <div class="pagehead"><h2>${esc(d.drawing.drawing_number)} <span class="muted" style="font-size:.85em">${esc(d.drawing.title || '')}</span></h2>
    ${d.drawing.file_url ? `<a class="btn btn-outline btn-sm" href="${esc(d.drawing.file_url)}" target="_blank">Open PDF ↗</a>` : ''}</div>
  <div class="grid cols-2">
    <div class="card"><h3>Revision history</h3><table class="tbl"><tr><th>Revision</th><th>Uploaded</th><th>Status</th></tr>
      ${d.revisions.map((r) => `<tr><td>${esc(r.revision)}</td><td>${fmtDate(r.created_at)}</td><td>${r.is_latest ? '<span class="badge b-green">Latest</span>' : '<span class="badge b-gray">Superseded</span>'}</td></tr>`).join('')}</table></div>
    <div class="card"><h3>Referenced by WIRs</h3>
      ${d.wirs.map((w) => `<div style="padding:4px 0"><a href="#/wir/${w.id}"><b>${esc(w.wir_number)}</b></a> ${badge(w.status)}</div>`).join('') || '<p class="muted">Not referenced yet.</p>'}</div>
  </div>`;
}

/* ================= M13 zones ================= */
async function viewZones() {
  setTitle('Zones');
  const d = await api('GET', `/zones?project_id=${P()}`);
  $('view').innerHTML = `
  <div class="pagehead"><h2>Zones (${d.zones.length})</h2>${canQA() ? '<button class="btn btn-cta btn-sm" id="zNew">+ New Zone</button>' : ''}</div>
  <div class="grid cols-3">
    ${d.zones.map((z) => `<div class="card click" style="cursor:pointer" onclick="location.hash='#/zone/${z.id}'">
      <h3>${esc(z.name)}</h3>
      <p class="small muted">Grid ${esc(z.grid_ref || '—')}</p>
      <p class="small">${z.drawing_count} drawings mapped · ${z.wir_count} WIRs</p>
    </div>`).join('')}
  </div>`;
  if ($('zNew')) $('zNew').addEventListener('click', async () => {
    const name = prompt('Zone name (e.g. Z05 - Level 2):');
    if (!name) return;
    const grid_ref = prompt('Grid reference (optional):') || null;
    await api('POST', '/zones', { project_id: P(), name, grid_ref });
    render();
  });
}
async function viewZoneDetail(id) {
  const [d, all] = await Promise.all([api('GET', `/zones/${id}`), api('GET', `/drawings?project_id=${P()}`)]);
  setTitle(d.zone.name);
  const mapped = new Set(d.drawings.map((x) => x.drawing_number));
  $('view').innerHTML = `
  <div class="pagehead"><h2>${esc(d.zone.name)}</h2></div>
  <div class="grid cols-2">
    <div class="card"><h3>Mapped drawings <span class="muted small">(auto-suggested in WIR form)</span></h3>
      <div class="chips">${all.drawings.map((dr) => `<span class="chip zmap ${mapped.has(dr.drawing_number) ? 'on' : ''}" data-id="${dr.id}">${esc(dr.drawing_number)} ${esc(dr.revision)}</span>`).join('')}</div>
      ${canQA() || S.user.role === 'Engineer' ? '<button class="btn btn-navy btn-sm" id="zSave" style="margin-top:12px">Save Mapping</button>' : ''}
    </div>
    <div class="card"><h3>FDT coverage in this zone</h3>
      <table class="tbl"><tr><th>Layer</th><th>Area</th><th>Req</th><th>Done</th><th>Status</th></tr>
      ${(d.fdt || []).map((s) => `<tr><td>${s.layer_no}</td><td>${s.area_m2}</td><td>${s.required}</td><td>${s.done}</td><td>${s.deficient ? '<span class="badge b-red">Deficient</span>' : '<span class="badge b-green">OK</span>'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No FDT logs.</td></tr>'}</table>
    </div>
  </div>`;
  document.querySelectorAll('.zmap').forEach((c) => c.addEventListener('click', () => c.classList.toggle('on')));
  if ($('zSave')) $('zSave').addEventListener('click', async () => {
    const ids = [...document.querySelectorAll('.zmap.on')].map((c) => c.dataset.id);
    await api('POST', `/zones/${id}/drawings`, { drawing_ids: ids });
    toast('Zone mapping saved'); render();
  });
}

/* ================= M14 programme ================= */
async function viewProgramme() {
  setTitle('Master Programme');
  const [d, zones] = await Promise.all([api('GET', `/programme?project_id=${P()}`), api('GET', `/zones?project_id=${P()}`)]);
  $('view').innerHTML = `
  <div class="pagehead"><h2>Programme activities (${d.activities.length})</h2>
    <div><button class="btn btn-outline btn-sm" id="aImportBtn">Import rows</button> <button class="btn btn-cta btn-sm" id="aNewBtn">+ Activity</button></div></div>
  <div id="aForm" class="card" hidden style="margin-bottom:14px"><h3>Add activity</h3>
    <div class="frow">
      <div class="field"><label>Zone</label><select id="aZone">${zones.zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Type</label><select id="aType">${d.activity_types.map((t) => `<option>${t}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Activity name</label><input id="aName"></div>
    <div class="frow">
      <div class="field"><label>Planned start</label><input type="date" id="aStart"></div>
      <div class="field"><label>Planned end</label><input type="date" id="aEnd"></div>
    </div>
    <button class="btn btn-cta btn-sm" id="aSave">Add</button>
  </div>
  <div id="aImport" class="card" hidden style="margin-bottom:14px"><h3>Bulk import</h3>
    <p class="small muted">One row per line: <code>Zone name | Activity | Type | Start | End</code> (dates YYYY-MM-DD)</p>
    <textarea id="aRows" rows="5" style="width:100%" placeholder="Z03 | L1 slab formwork | Formwork | 2026-07-20 | 2026-07-24"></textarea>
    <button class="btn btn-cta btn-sm" id="aImportSave" style="margin-top:8px">Import</button>
  </div>
  <div class="card" style="padding:0;overflow-x:auto"><table class="tbl">
    <tr><th>Zone</th><th>Activity</th><th>Type</th><th>Planned start</th><th>Planned end</th><th>WIR</th><th>Flag</th></tr>
    ${d.activities.map((a) => `<tr>
      <td>${esc(a.zone_name)}</td><td>${esc(a.name)}</td><td>${esc(a.type)}</td>
      <td>${fmtDate(a.planned_start)}</td><td>${fmtDate(a.planned_end)}</td>
      <td>${a.wir_number ? `${esc(a.wir_number)} ${badge(a.wir_status)}` : '<span class="badge b-gray">Not Raised</span>'}</td>
      <td>${a.flag ? `<span class="badge ${a.flag === 'WIR Overdue' ? 'b-red' : 'b-amber'}">${a.flag}</span>` : ''}</td></tr>`).join('')}
  </table></div>`;
  $('aNewBtn').addEventListener('click', () => { $('aForm').hidden = !$('aForm').hidden; });
  $('aImportBtn').addEventListener('click', () => { $('aImport').hidden = !$('aImport').hidden; });
  $('aSave').addEventListener('click', async () => {
    await api('POST', '/activities', { project_id: P(), zone_id: $('aZone').value, name: $('aName').value, type: $('aType').value, planned_start: $('aStart').value || null, planned_end: $('aEnd').value || null });
    toast('Activity added'); render();
  });
  $('aImportSave').addEventListener('click', async () => {
    const rows = $('aRows').value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((r) => r.length >= 2)
      .map(([zone, activity, type, start, end]) => ({ zone, activity, type, start, end }));
    const d2 = await api('POST', '/activities/import', { project_id: P(), rows });
    toast(`Imported ${d2.imported} activities`); render();
  });
}

/* ================= M10 method statements ================= */
async function viewMs() {
  setTitle('Method Statements');
  const d = await api('GET', `/method-statements?project_id=${P()}`);
  $('view').innerHTML = `
  <div class="pagehead"><h2>Method Statements (${d.method_statements.length})</h2><button class="btn btn-cta btn-sm" id="msNew">+ Upload MS</button></div>
  <div id="msForm" class="card" hidden style="margin-bottom:14px"><h3>New Method Statement</h3>
    <div class="frow">
      <div class="field"><label>Title</label><input id="mTitle"></div>
      <div class="field"><label>Activity type</label><select id="mType">${['Rebar', 'Formwork', 'Concrete Pour', 'MEP Rough-in', 'Backfill', 'Finishes'].map((t) => `<option>${t}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>PDF</label><input type="file" id="mFile" accept=".pdf"></div>
    <button class="btn btn-cta btn-sm" id="mSave">Save</button>
  </div>
  <div class="card" style="padding:0;overflow-x:auto"><table class="tbl">
    <tr><th>MS #</th><th>Title</th><th>Activity type</th><th>Status</th><th>Approved</th><th>WIRs</th>${canQA() ? '<th></th>' : ''}</tr>
    ${d.method_statements.map((m) => `<tr>
      <td><b>${esc(m.ms_number)}</b></td><td>${m.file_url ? `<a href="${esc(m.file_url)}" target="_blank">${esc(m.title)} ↗</a>` : esc(m.title)}</td>
      <td>${esc(m.activity_type)}</td><td>${badge(m.status)}</td><td>${fmtDate(m.approved_date)}</td><td>${m.wir_count}</td>
      ${canQA() ? `<td style="white-space:nowrap">${m.status !== 'Approved' ? `<button class="btn btn-cta btn-sm msact" data-id="${m.id}" data-s="Approved">Approve</button>` : ''}
        ${m.status !== 'Rejected' ? `<button class="btn btn-outline btn-sm msact" data-id="${m.id}" data-s="Rejected">Reject</button>` : ''}</td>` : ''}</tr>`).join('')}
  </table></div>
  <div class="alert a-blue" style="margin-top:12px">WIR submission is blocked for an activity type without an <b>Approved</b> Method Statement (M10 gate).</div>`;
  $('msNew').addEventListener('click', () => { $('msForm').hidden = !$('msForm').hidden; });
  $('mSave').addEventListener('click', async () => {
    let file_url = null;
    if ($('mFile').files[0]) file_url = (await uploadFile($('mFile').files[0])).url;
    await api('POST', '/method-statements', { project_id: P(), title: $('mTitle').value, activity_type: $('mType').value, file_url });
    toast('Method statement saved'); render();
  });
  document.querySelectorAll('.msact').forEach((b) => b.addEventListener('click', async () => {
    await api('PATCH', `/method-statements/${b.dataset.id}`, { status: b.dataset.s });
    toast('MS ' + b.dataset.s.toLowerCase()); render();
  }));
}

/* ================= M12 handover ================= */
async function viewHandover() {
  setTitle('Handover Pack Builder');
  const zones = (await api('GET', `/zones?project_id=${P()}`)).zones;
  $('view').innerHTML = `
  <div class="card" style="max-width:760px">
    <h3>Step 1 — Scope</h3>
    <div class="frow">
      <div class="field"><label>Zone</label><select id="hZone"><option value="">All zones</option>${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></div>
      <div class="field"><label>WIR filter</label><select id="hApproved"><option value="1">Approved WIRs only</option><option value="0">All WIRs</option></select></div>
    </div>
    <div class="frow">
      <div class="field"><label>From date</label><input type="date" id="hFrom"></div>
      <div class="field"><label>To date</label><input type="date" id="hTo"></div>
    </div>
    <button class="btn btn-navy btn-sm" id="hPreview">Preview index</button>
    <div id="hIndex" style="margin-top:14px"></div>
    <div id="hGen" hidden style="margin-top:14px">
      <h3>Step 3 — Generate</h3>
      <button class="btn btn-cta" id="hGenerate">⬇ Generate Pack</button>
      <div id="hResult" style="margin-top:10px"></div>
    </div>
  </div>`;
  const filters = () => ({ zone_id: $('hZone').value || undefined, approved_only: $('hApproved').value === '1', from: $('hFrom').value || undefined, to: $('hTo').value || undefined });
  $('hPreview').addEventListener('click', async () => {
    const f = filters();
    const qs = new URLSearchParams({ project_id: P(), ...(f.zone_id ? { zone_id: f.zone_id } : {}), approved_only: f.approved_only ? '1' : '0', ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}) });
    const d = await api('GET', `/handover/preview?${qs}`);
    $('hIndex').innerHTML = `<h3>Step 2 — Index preview</h3>` + d.sections.map((s) => `
      <div style="margin:10px 0"><b>${esc(s.title)} (${s.count})</b>
        <div class="small muted" style="max-height:130px;overflow-y:auto;margin-top:4px">${s.items.map((i) => esc(i)).join('<br>') || 'none'}</div></div>`).join('');
    $('hGen').hidden = false;
  });
  $('hGenerate').addEventListener('click', async () => {
    $('hResult').innerHTML = '<span class="muted">Compiling…</span>';
    const d = await api('POST', '/handover/generate', { project_id: P(), filters: filters() });
    $('hResult').innerHTML = `<div class="alert a-green">Pack generated — ${d.counts.wirs} WIRs, ${d.counts.results} results, ${d.counts.ncrs} NCRs, ${d.counts.ms} MS.<br>
      <a href="${esc(d.url)}" target="_blank"><b>Open handover pack ↗</b></a> <span class="small muted">(print → save as PDF)</span></div>`;
  });
}

/* ================= M01 team ================= */
async function viewTeam() {
  setTitle('Team');
  const d = await api('GET', `/projects/${P()}/team`);
  $('view').innerHTML = `
  <div class="pagehead"><h2>${esc(S.project.name)} — team (${d.members.length})</h2></div>
  <div class="grid cols-2">
    <div class="card" style="padding:0"><table class="tbl">
      <tr><th>Name</th><th>Email</th><th>Role</th></tr>
      ${d.members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${badge(m.project_role)}</td></tr>`).join('')}
    </table></div>
    ${canQA() ? `<div class="card"><h3>Invite member</h3>
      <div class="field"><label>Email</label><input id="iEmail" type="email"></div>
      <div class="field"><label>Name</label><input id="iName"></div>
      <div class="field"><label>Role</label><select id="iRole"><option>Engineer</option><option>QA</option><option>DocControl</option><option>Admin</option></select></div>
      <button class="btn btn-cta btn-sm" id="iSave">Invite</button>
      <p class="small muted" style="margin-top:8px">New users get password <code>changeme123</code>.</p>
    </div>` : ''}
  </div>`;
  if ($('iSave')) $('iSave').addEventListener('click', async () => {
    try {
      await api('POST', `/projects/${P()}/team`, { email: $('iEmail').value, name: $('iName').value, role: $('iRole').value });
      toast('Member invited'); render();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ================= boot ================= */
if (S.token && S.user) showApp().catch(() => logout());
else showLogin();
