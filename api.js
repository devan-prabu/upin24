'use strict';
/*
 * WIRflow REST API — implements blueprint modules M01-M15 and the SYS.03
 * connection layer. Mounted by server.js under /api/app/*.
 * Zero dependencies (node:sqlite via db.js).
 */

const fs = require('fs');
const path = require('path');
const { db, uuid, now, today, hashPassword, verifyPassword, nextNumber, UPLOAD_DIR } = require('./db');

/* ================= M06 spec table (built-in) ================= */
const SPEC_TABLE = {
  'Concrete Cube C25': { limit: 25, unit: 'MPa', rule: 'min' },
  'Concrete Cube C30': { limit: 30, unit: 'MPa', rule: 'min' },
  'Concrete Cube C40': { limit: 40, unit: 'MPa', rule: 'min' },
  'FDT':               { limit: 95, unit: '% MDD', rule: 'min', note: 'roads: 98' },
  'Steel Tensile':     { limit: 500, unit: 'MPa', rule: 'min' },
  'Slump':             { limit: 25, unit: 'mm', rule: 'tolerance', target: 150, note: 'per mix design ±25mm' },
  'Asphalt Core':      { limit: 93, unit: '% density', rule: 'min' },
  'Other':             { limit: null, unit: '', rule: 'min' },
};
const ACTIVITY_TYPES = ['Rebar', 'Formwork', 'Concrete Pour', 'MEP Rough-in', 'Backfill', 'Finishes'];
const TEST_TYPES = Object.keys(SPEC_TABLE);
const FDT_AREA_PER_TEST = 250; // M07: 1 test per 250 m² per layer

/* ================= tiny framework ================= */
const routes = []; // {method, pattern:RegExp, keys:[], handler(req,res,params,body,user)}
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-zA-Z_]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, auth: opts.auth !== false });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ================= auth (M01) ================= */
function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  return row || null;
}
function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new ApiError(403, `Requires role: ${roles.join(' or ')}`);
}
function publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role }; }

route('POST', '/auth/login', async (req, res, p, body) => {
  const { email, password } = body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) throw new ApiError(401, 'Invalid email or password.');
  const token = require('crypto').randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').run(token, user.id, now());
  json(res, 200, { token, user: publicUser(user) });
}, { auth: false });

route('POST', '/auth/logout', async (req, res) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) db.prepare('DELETE FROM sessions WHERE token = ?').run(h.slice(7));
  json(res, 200, { ok: true });
}, { auth: false });

route('GET', '/me', async (req, res, p, b, user) => json(res, 200, { user }));

/* ================= M11 notification engine ================= */
function notify(userIds, type, message, refType, refId, dedupeKey) {
  for (const uid of new Set(userIds.filter(Boolean))) {
    try {
      db.prepare('INSERT INTO notifications (id,user_id,type,message,ref_type,ref_id,dedupe_key,sent_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(uuid(), uid, type, message, refType || null, refId || null, dedupeKey || null, now());
    } catch (e) { /* dedupe collision — already sent */ }
  }
}
function projectMembersByRole(project_id, roles) {
  const q = db.prepare(`SELECT user_id, role FROM project_members WHERE project_id = ?`).all(project_id);
  return q.filter((m) => roles.includes(m.role)).map((m) => m.user_id);
}

/* Scheduled checks (SYS.03: TR due dates, programme lookahead). Ran lazily, deduped. */
function runScheduledChecks(project_id) {
  const t = today();
  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const trs = db.prepare(`SELECT * FROM test_requests WHERE project_id = ? AND status = 'Pending'`).all(project_id);
  for (const tr of trs) {
    for (const [due, label] of [[tr.due_7day, '7-day'], [tr.due_28day, '28-day']]) {
      if (!due) continue;
      const targets = [tr.created_by, ...projectMembersByRole(project_id, ['QA'])];
      if (due < t) {
        notify([...targets, ...projectMembersByRole(project_id, ['Admin'])], 'TR_OVERDUE',
          `${tr.tr_number} ${label} result is OVERDUE (was due ${due})`, 'tr', tr.id, `overdue:${tr.id}:${label}`);
      } else if (due <= soon) {
        notify(targets, 'TR_DUE_SOON', `${tr.tr_number} ${label} result due ${due}`, 'tr', tr.id, `due:${tr.id}:${label}`);
      }
    }
  }
  const lookahead = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const acts = db.prepare(`
    SELECT a.*, z.name AS zone_name FROM activities a JOIN zones z ON z.id = a.zone_id
    WHERE a.project_id = ? AND a.planned_start IS NOT NULL AND a.planned_start >= ? AND a.planned_start <= ?
      AND NOT EXISTS (SELECT 1 FROM wirs w WHERE w.activity_id = a.id)`).all(project_id, t, lookahead);
  for (const a of acts) {
    notify(projectMembersByRole(project_id, ['Engineer', 'QA']), 'WIR_DUE_SOON',
      `${a.name} (${a.zone_name}) starts ${a.planned_start} — no WIR raised yet`, 'activity', a.id, `wirdue:${a.id}`);
  }
}

route('GET', '/notifications', async (req, res, p, b, user, query) => {
  if (query.project_id) runScheduledChecks(query.project_id);
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY sent_at DESC LIMIT 50').all(user.id);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).c;
  json(res, 200, { notifications: rows, unread });
});
route('POST', '/notifications/read', async (req, res, p, body, user) => {
  if (body.id) db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(now(), body.id, user.id);
  else db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), user.id);
  json(res, 200, { ok: true });
});

/* ================= M01 projects & team ================= */
route('GET', '/projects', async (req, res, p, b, user) => {
  const rows = db.prepare(`
    SELECT pr.*, (SELECT COUNT(*) FROM wirs w WHERE w.project_id = pr.id) AS wir_count,
           (SELECT COUNT(*) FROM project_members m WHERE m.project_id = pr.id) AS member_count
    FROM projects pr JOIN project_members pm ON pm.project_id = pr.id
    WHERE pm.user_id = ? ORDER BY pr.created_at DESC`).all(user.id);
  json(res, 200, { projects: rows });
});
route('POST', '/projects', async (req, res, p, body, user) => {
  requireRole(user, ['Admin', 'QA']);
  const id = uuid();
  db.prepare('INSERT INTO projects (id,name,location,client,contract_no,start_date,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req0(body.name, 'name'), body.location || null, body.client || null, body.contract_no || null, body.start_date || null, user.id, now());
  db.prepare('INSERT INTO project_members (id,project_id,user_id,role) VALUES (?,?,?,?)').run(uuid(), id, user.id, user.role);
  json(res, 201, { project: db.prepare('SELECT * FROM projects WHERE id=?').get(id) });
});
route('GET', '/projects/:id/team', async (req, res, p) => {
  const rows = db.prepare(`SELECT m.id AS member_id, m.role AS project_role, u.id, u.name, u.email FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`).all(p.id);
  json(res, 200, { members: rows });
});
route('POST', '/projects/:id/team', async (req, res, p, body, user) => {
  requireRole(user, ['Admin', 'QA']);
  const email = String(req0(body.email, 'email')).toLowerCase().trim();
  const role = ACTIVITY_ROLES.includes(body.role) ? body.role : 'Engineer';
  let u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) {
    const idU = uuid();
    db.prepare('INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(idU, email, body.name || email.split('@')[0], role, hashPassword(body.password || 'changeme123'), now());
    u = db.prepare('SELECT * FROM users WHERE id = ?').get(idU);
  }
  try { db.prepare('INSERT INTO project_members (id,project_id,user_id,role) VALUES (?,?,?,?)').run(uuid(), p.id, u.id, role); }
  catch (e) { throw new ApiError(409, 'Already a member of this project.'); }
  json(res, 201, { member: { id: u.id, email: u.email, name: u.name, project_role: role } });
});
const ACTIVITY_ROLES = ['Engineer', 'QA', 'DocControl', 'Admin'];

function req0(v, name) { if (v === undefined || v === null || v === '') throw new ApiError(400, `Missing "${name}".`); return v; }
function pid(query) { return req0(query.project_id, 'project_id'); }

/* ================= file uploads (drawings, reports, floor plans, MS) ================= */
route('POST', '/upload', async (req, res, p, body, user, query, raw) => {
  const name = String(query.name || 'file.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!raw || !raw.length) throw new ApiError(400, 'Empty upload.');
  const id = uuid().slice(0, 8);
  const fname = `${id}-${name}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), raw);
  json(res, 201, { url: `/uploads/${fname}`, name: fname, size: raw.length });
}, { raw: true });
routes[routes.length - 1].raw = true;

/* ================= M02 shop drawing registry ================= */
route('GET', '/drawings', async (req, res, p, b, user, query) => {
  const q = (query.q || '').trim();
  let sql = `SELECT d.*, (SELECT COUNT(*) FROM wir_drawings wd WHERE wd.drawing_id = d.id) AS wir_count
             FROM shop_drawings d WHERE d.project_id = ?`;
  const args = [pid(query)];
  if (q) { sql += ' AND (d.drawing_number LIKE ? OR d.title LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  if (query.latest !== '0') sql += ' AND d.is_latest = 1';
  sql += ' ORDER BY d.drawing_number, d.revision DESC';
  json(res, 200, { drawings: db.prepare(sql).all(...args) });
});
route('POST', '/drawings', async (req, res, p, body, user) => {
  const project_id = req0(body.project_id, 'project_id');
  const number = String(req0(body.drawing_number, 'drawing_number')).trim();
  const revision = String(req0(body.revision, 'revision')).trim();
  // KEY RULE (M02): duplicate drawing_number → new revision, supersede old
  db.prepare('UPDATE shop_drawings SET is_latest = 0 WHERE project_id = ? AND drawing_number = ?').run(project_id, number);
  const id = uuid();
  db.prepare('INSERT INTO shop_drawings (id,project_id,drawing_number,title,revision,discipline,file_url,is_latest,created_at) VALUES (?,?,?,?,?,?,?,1,?)')
    .run(id, project_id, number, body.title || null, revision, body.discipline || 'Structural', body.file_url || null, now());
  json(res, 201, { drawing: db.prepare('SELECT * FROM shop_drawings WHERE id=?').get(id) });
});
route('GET', '/drawings/:id', async (req, res, p) => {
  const d = db.prepare('SELECT * FROM shop_drawings WHERE id = ?').get(p.id);
  if (!d) throw new ApiError(404, 'Drawing not found.');
  const revisions = db.prepare('SELECT * FROM shop_drawings WHERE project_id = ? AND drawing_number = ? ORDER BY created_at DESC').all(d.project_id, d.drawing_number);
  const wirs = db.prepare(`SELECT w.id, w.wir_number, w.status FROM wir_drawings wd JOIN wirs w ON w.id = wd.wir_id WHERE wd.drawing_id = ?`).all(p.id);
  json(res, 200, { drawing: d, revisions, wirs });
});

/* ================= M13 zones & floor plan mapper ================= */
route('GET', '/zones', async (req, res, p, b, user, query) => {
  const rows = db.prepare(`
    SELECT z.*, (SELECT COUNT(*) FROM zone_drawings zd WHERE zd.zone_id = z.id) AS drawing_count,
           (SELECT COUNT(*) FROM wirs w WHERE w.zone_id = z.id) AS wir_count
    FROM zones z WHERE z.project_id = ? ORDER BY z.name`).all(pid(query));
  json(res, 200, { zones: rows });
});
route('POST', '/zones', async (req, res, p, body, user) => {
  requireRole(user, ['QA', 'Admin']);
  const id = uuid();
  db.prepare('INSERT INTO zones (id,project_id,name,grid_ref,description,floor_plan_url,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(id, req0(body.project_id, 'project_id'), req0(body.name, 'name'), body.grid_ref || null, body.description || null, body.floor_plan_url || null, user.id);
  json(res, 201, { zone: db.prepare('SELECT * FROM zones WHERE id=?').get(id) });
});
route('GET', '/zones/:id', async (req, res, p) => {
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(p.id);
  if (!zone) throw new ApiError(404, 'Zone not found.');
  // Follow revisions: a mapped drawing always resolves to its LATEST revision (M02 key rule)
  const drawings = db.prepare(`SELECT DISTINCT latest.* FROM zone_drawings zd
    JOIN shop_drawings mapped ON mapped.id = zd.drawing_id
    JOIN shop_drawings latest ON latest.project_id = mapped.project_id
      AND latest.drawing_number = mapped.drawing_number AND latest.is_latest = 1
    WHERE zd.zone_id = ?`).all(p.id);
  json(res, 200, { zone, drawings, fdt: fdtSummaryForZone(zone) });
});
/* SYS.03: M13 → M03 auto-suggest */
route('GET', '/zones/:id/drawings', async (req, res, p) => {
  // Follow revisions: a mapped drawing always resolves to its LATEST revision (M02 key rule)
  const drawings = db.prepare(`SELECT DISTINCT latest.* FROM zone_drawings zd
    JOIN shop_drawings mapped ON mapped.id = zd.drawing_id
    JOIN shop_drawings latest ON latest.project_id = mapped.project_id
      AND latest.drawing_number = mapped.drawing_number AND latest.is_latest = 1
    WHERE zd.zone_id = ?`).all(p.id);
  json(res, 200, { drawings });
});
route('POST', '/zones/:id/drawings', async (req, res, p, body, user) => {
  requireRole(user, ['QA', 'Admin', 'Engineer']);
  const ids = Array.isArray(body.drawing_ids) ? body.drawing_ids : [];
  db.prepare('DELETE FROM zone_drawings WHERE zone_id = ?').run(p.id);
  for (const d of ids) db.prepare('INSERT OR IGNORE INTO zone_drawings (id,zone_id,drawing_id) VALUES (?,?,?)').run(uuid(), p.id, d);
  json(res, 200, { ok: true, count: ids.length });
});

/* ================= M14 master programme ================= */
route('GET', '/programme', async (req, res, p, b, user, query) => {
  const t = today();
  const lookahead = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT a.*, z.name AS zone_name,
      (SELECT w.status FROM wirs w WHERE w.activity_id = a.id ORDER BY w.created_at DESC LIMIT 1) AS wir_status,
      (SELECT w.wir_number FROM wirs w WHERE w.activity_id = a.id ORDER BY w.created_at DESC LIMIT 1) AS wir_number
    FROM activities a JOIN zones z ON z.id = a.zone_id WHERE a.project_id = ? ORDER BY a.planned_start`).all(pid(query));
  for (const r of rows) {
    r.flag = null;
    if (!r.wir_status && r.planned_start) {
      if (r.planned_start < t) r.flag = 'WIR Overdue';
      else if (r.planned_start <= lookahead) r.flag = 'WIR Due Soon';
    }
  }
  json(res, 200, { activities: rows, activity_types: ACTIVITY_TYPES });
});
route('POST', '/activities', async (req, res, p, body, user) => {
  const id = uuid();
  db.prepare('INSERT INTO activities (id,project_id,zone_id,name,type,planned_start,planned_end) VALUES (?,?,?,?,?,?,?)')
    .run(id, req0(body.project_id, 'project_id'), req0(body.zone_id, 'zone_id'), req0(body.name, 'name'),
      ACTIVITY_TYPES.includes(body.type) ? body.type : 'Rebar', body.planned_start || null, body.planned_end || null);
  json(res, 201, { activity: db.prepare('SELECT * FROM activities WHERE id=?').get(id) });
});
route('POST', '/activities/import', async (req, res, p, body, user) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const project_id = req0(body.project_id, 'project_id');
  const zones = db.prepare('SELECT id, name FROM zones WHERE project_id = ?').all(project_id);
  let n = 0;
  for (const r of rows) {
    const zone = zones.find((z) => z.name.toLowerCase().includes(String(r.zone || '').toLowerCase()) && r.zone);
    if (!zone || !r.activity) continue;
    db.prepare('INSERT INTO activities (id,project_id,zone_id,name,type,planned_start,planned_end) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), project_id, zone.id, r.activity, ACTIVITY_TYPES.includes(r.type) ? r.type : 'Rebar', r.start || null, r.end || null);
    n++;
  }
  json(res, 200, { imported: n });
});

/* ================= M10 method statements ================= */
route('GET', '/method-statements', async (req, res, p, b, user, query) => {
  const rows = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM wirs w WHERE w.activity_type = m.activity_type AND w.project_id = m.project_id) AS wir_count
    FROM method_statements m WHERE m.project_id = ? ORDER BY m.ms_number`).all(pid(query));
  json(res, 200, { method_statements: rows });
});
route('POST', '/method-statements', async (req, res, p, body, user) => {
  const project_id = req0(body.project_id, 'project_id');
  const id = uuid();
  const ms_number = body.ms_number || nextNumber('method_statements', 'ms_number', 'MS-', project_id);
  db.prepare('INSERT INTO method_statements (id,project_id,ms_number,title,activity_type,status,file_url,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, project_id, ms_number, req0(body.title, 'title'), req0(body.activity_type, 'activity_type'), 'Submitted', body.file_url || null, now());
  json(res, 201, { method_statement: db.prepare('SELECT * FROM method_statements WHERE id=?').get(id) });
});
route('PATCH', '/method-statements/:id', async (req, res, p, body, user) => {
  requireRole(user, ['QA', 'Admin']);
  const status = req0(body.status, 'status');
  if (!['Submitted', 'Approved', 'Rejected'].includes(status)) throw new ApiError(400, 'Invalid status.');
  db.prepare('UPDATE method_statements SET status = ?, approved_date = ? WHERE id = ?')
    .run(status, status === 'Approved' ? today() : null, p.id);
  json(res, 200, { method_statement: db.prepare('SELECT * FROM method_statements WHERE id=?').get(p.id) });
});

/* ================= M03 WIR form engine ================= */
function msGate(project_id, activity_type) {
  const ms = db.prepare(`SELECT * FROM method_statements WHERE project_id = ? AND activity_type = ? ORDER BY (status='Approved') DESC LIMIT 1`).get(project_id, activity_type);
  return { ms: ms || null, approved: !!(ms && ms.status === 'Approved') };
}
route('GET', '/wir-form-context', async (req, res, p, b, user, query) => {
  const project_id = pid(query);
  json(res, 200, {
    next_wir_number: nextNumber('wirs', 'wir_number', 'WIR-', project_id),
    zones: db.prepare('SELECT id, name FROM zones WHERE project_id = ? ORDER BY name').all(project_id),
    activity_types: ACTIVITY_TYPES,
    ms_status: Object.fromEntries(ACTIVITY_TYPES.map((t) => [t, msGate(project_id, t)])),
  });
});
route('POST', '/wirs', async (req, res, p, body, user) => {
  const project_id = req0(body.project_id, 'project_id');
  const activity_type = req0(body.activity_type, 'activity_type');
  const status = body.status === 'Submitted' ? 'Submitted' : 'Draft';
  // M10 gate: block SUBMISSION (drafts allowed) without an approved MS
  if (status === 'Submitted') {
    const gate = msGate(project_id, activity_type);
    if (!gate.approved) throw new ApiError(422, `No approved Method Statement for "${activity_type}". Save as Draft, or get ${gate.ms ? gate.ms.ms_number : 'an MS'} approved first.`);
  }
  const id = uuid();
  const wir_number = nextNumber('wirs', 'wir_number', 'WIR-', project_id);
  db.prepare(`INSERT INTO wirs (id,project_id,zone_id,activity_id,wir_number,activity_type,description,location,contractor,
    inspection_types,checklist,remarks,status,engineer_id,inspection_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project_id, body.zone_id || null, body.activity_id || null, wir_number, activity_type,
      body.description || null, body.location || null, body.contractor || null,
      JSON.stringify(body.inspection_types || []), JSON.stringify(body.checklist || []),
      body.remarks || null, status, user.id, body.inspection_date || today(), now());
  for (const d of body.drawing_ids || []) db.prepare('INSERT OR IGNORE INTO wir_drawings (id,wir_id,drawing_id) VALUES (?,?,?)').run(uuid(), id, d);
  // SYS.03: M03 → M05 spawn TR placeholders
  const spawned = [];
  for (const t of body.tests_required || []) {
    if (!TEST_TYPES.includes(t)) continue;
    spawned.push(createTR({ project_id, wir_id: id, test_type: t, sample_date: body.inspection_date || today() }, user));
  }
  // SYS.03: M03 → M11 notify QA on submission
  if (status === 'Submitted') {
    notify(projectMembersByRole(project_id, ['QA']), 'WIR_SUBMITTED',
      `${wir_number} submitted by ${user.name} — ${body.description || activity_type}`, 'wir', id);
  }
  json(res, 201, { wir: getWIR(id), spawned_trs: spawned.map((t) => t.tr_number) });
});

function getWIR(id) {
  const w = db.prepare(`SELECT w.*, z.name AS zone_name, u.name AS engineer_name, a.name AS activity_name
    FROM wirs w LEFT JOIN zones z ON z.id = w.zone_id LEFT JOIN users u ON u.id = w.engineer_id
    LEFT JOIN activities a ON a.id = w.activity_id WHERE w.id = ?`).get(id);
  if (!w) return null;
  w.inspection_types = JSON.parse(w.inspection_types || '[]');
  w.checklist = JSON.parse(w.checklist || '[]');
  w.drawings = db.prepare(`SELECT d.* FROM wir_drawings wd JOIN shop_drawings d ON d.id = wd.drawing_id WHERE wd.wir_id = ?`).all(id);
  w.trs = db.prepare(`SELECT tr.*, (SELECT pass_fail FROM test_results r WHERE r.tr_id = tr.id ORDER BY r.created_at DESC LIMIT 1) AS pass_fail
    FROM test_requests tr WHERE tr.wir_id = ?`).all(id);
  w.ncrs = db.prepare('SELECT * FROM ncrs WHERE wir_id = ?').all(id);
  w.comments = db.prepare(`SELECT c.*, u.name AS user_name FROM wir_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.wir_id = ? ORDER BY c.created_at`).all(id);
  w.approval_blockers = approvalBlockers(w);
  return w;
}

/* M04 + SYS.03 rules: what blocks Approve */
function approvalBlockers(w) {
  const blockers = [];
  const pending = w.trs.filter((t) => t.status === 'Pending').length;
  if (pending) blockers.push(`${pending} test result(s) pending`);
  // A FAILED result blocks approval until remediated: a Closed NCR referencing that TR
  const failedUnresolved = w.trs.filter((t) => t.pass_fail === 'FAIL' &&
    !db.prepare(`SELECT 1 FROM ncrs WHERE source_type='TR' AND source_id = ? AND status='Closed'`).get(t.id)).length;
  if (failedUnresolved) blockers.push(`${failedUnresolved} FAILED test result(s) without closed NCR`);
  const openNcrs = w.ncrs.filter((n) => n.status !== 'Closed').length;
  if (openNcrs) blockers.push(`${openNcrs} open NCR(s)`);
  // M07: FDT frequency check for backfill-type WIRs in this zone
  if (w.zone_id && w.activity_type === 'Backfill') {
    const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(w.zone_id);
    const deficient = (fdtSummaryForZone(zone) || []).filter((r) => r.deficient);
    if (deficient.length) blockers.push(`FDT coverage deficient in ${zone.name} (layer ${deficient.map((d) => d.layer_no).join(', ')})`);
  }
  return blockers;
}

route('GET', '/wirs', async (req, res, p, b, user, query) => {
  let sql = `SELECT w.*, z.name AS zone_name, u.name AS engineer_name,
    (SELECT COUNT(*) FROM test_requests tr WHERE tr.wir_id = w.id AND tr.status = 'Pending') AS tr_pending,
    (SELECT COUNT(*) FROM test_requests tr JOIN test_results r ON r.tr_id = tr.id AND r.pass_fail = 'FAIL' WHERE tr.wir_id = w.id) AS tr_failed,
    (SELECT COUNT(*) FROM test_requests tr WHERE tr.wir_id = w.id) AS tr_total,
    (SELECT COUNT(*) FROM ncrs n WHERE n.wir_id = w.id AND n.status != 'Closed') AS ncr_open
    FROM wirs w LEFT JOIN zones z ON z.id = w.zone_id LEFT JOIN users u ON u.id = w.engineer_id
    WHERE w.project_id = ?`;
  const args = [pid(query)];
  if (query.status) { sql += ' AND w.status = ?'; args.push(query.status); }
  if (query.zone_id) { sql += ' AND w.zone_id = ?'; args.push(query.zone_id); }
  sql += ' ORDER BY w.created_at DESC';
  json(res, 200, { wirs: db.prepare(sql).all(...args) });
});
route('GET', '/wirs/:id', async (req, res, p) => {
  const w = getWIR(p.id);
  if (!w) throw new ApiError(404, 'WIR not found.');
  json(res, 200, { wir: w });
});
const WIR_FLOW = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Resubmit Required'];
route('PATCH', '/wirs/:id/status', async (req, res, p, body, user) => {
  const w = getWIR(p.id);
  if (!w) throw new ApiError(404, 'WIR not found.');
  const status = req0(body.status, 'status');
  if (!WIR_FLOW.includes(status)) throw new ApiError(400, 'Invalid status.');
  if (['Approved', 'Rejected', 'Under Review', 'Resubmit Required'].includes(status)) requireRole(user, ['QA', 'Admin']);
  if (status === 'Submitted') {
    const gate = msGate(w.project_id, w.activity_type);
    if (!gate.approved) throw new ApiError(422, `No approved Method Statement for "${w.activity_type}".`);
  }
  // RULE (M04/M06/M07/M15): approval blocked while TRs pending/failed, NCRs open, or FDT deficient
  if (status === 'Approved' && w.approval_blockers.length) {
    throw new ApiError(422, 'Cannot approve: ' + w.approval_blockers.join('; '));
  }
  db.prepare('UPDATE wirs SET status = ? WHERE id = ?').run(status, p.id);
  db.prepare('INSERT INTO wir_comments (id,wir_id,user_id,text,status_change,created_at) VALUES (?,?,?,?,?,?)')
    .run(uuid(), p.id, user.id, body.comment || `Status changed to ${status}`, status, now());
  if (status === 'Approved') notify([w.engineer_id], 'WIR_APPROVED', `${w.wir_number} approved by ${user.name}`, 'wir', p.id);
  if (status === 'Rejected' || status === 'Resubmit Required') {
    notify([w.engineer_id], 'WIR_REJECTED', `${w.wir_number} ${status.toLowerCase()} by ${user.name}${body.comment ? ': ' + body.comment : ''}`, 'wir', p.id);
  }
  if (status === 'Submitted') notify(projectMembersByRole(w.project_id, ['QA']), 'WIR_SUBMITTED', `${w.wir_number} submitted by ${user.name}`, 'wir', p.id);
  json(res, 200, { wir: getWIR(p.id) });
});
route('POST', '/wirs/:id/comments', async (req, res, p, body, user) => {
  db.prepare('INSERT INTO wir_comments (id,wir_id,user_id,text,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), p.id, user.id, req0(body.text, 'text'), now());
  json(res, 201, { ok: true });
});

/* ================= M05 test request generator ================= */
function createTR(data, user) {
  const project_id = data.project_id;
  const id = uuid();
  const tr_number = nextNumber('test_requests', 'tr_number', `TR-${new Date().getFullYear()}-`, project_id);
  const isCube = /Concrete Cube/.test(data.test_type);
  const sample = data.sample_date || today();
  const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO test_requests (id,project_id,wir_id,tr_number,test_type,sample_date,location,sample_count,spec_reference,
    lab_name,notes,layer_no,area_m2,mdd_ref,due_7day,due_28day,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project_id, data.wir_id || null, tr_number, data.test_type, sample, data.location || null,
      data.sample_count || null, data.spec_reference || null, data.lab_name || null, data.notes || null,
      data.layer_no || null, data.area_m2 || null, data.mdd_ref || null,
      isCube ? addDays(sample, 7) : null, isCube ? addDays(sample, 28) : null, 'Pending', user.id, now());
  return db.prepare('SELECT * FROM test_requests WHERE id = ?').get(id);
}
route('GET', '/trs', async (req, res, p, b, user, query) => {
  let sql = `SELECT tr.*, w.wir_number,
    (SELECT pass_fail FROM test_results r WHERE r.tr_id = tr.id ORDER BY r.created_at DESC LIMIT 1) AS pass_fail
    FROM test_requests tr LEFT JOIN wirs w ON w.id = tr.wir_id WHERE tr.project_id = ?`;
  const args = [pid(query)];
  if (query.status) { sql += ' AND tr.status = ?'; args.push(query.status); }
  sql += ' ORDER BY COALESCE(tr.due_28day, tr.due_7day, tr.sample_date)';
  const rows = db.prepare(sql).all(...args);
  const t = today();
  for (const r of rows) {
    r.due = r.due_28day && !r.pass_fail ? r.due_28day : r.due_7day;
    r.overdue = r.status === 'Pending' && ((r.due_7day && r.due_7day < t) || (r.due_28day && r.due_28day < t));
  }
  json(res, 200, { trs: rows, test_types: TEST_TYPES });
});
route('POST', '/trs', async (req, res, p, body, user) => {
  req0(body.project_id, 'project_id');
  if (!TEST_TYPES.includes(body.test_type)) throw new ApiError(400, 'Invalid test_type.');
  const tr = createTR(body, user);
  json(res, 201, { tr });
});
route('GET', '/trs/:id', async (req, res, p) => {
  const tr = db.prepare(`SELECT tr.*, w.wir_number FROM test_requests tr LEFT JOIN wirs w ON w.id = tr.wir_id WHERE tr.id = ?`).get(p.id);
  if (!tr) throw new ApiError(404, 'TR not found.');
  tr.results = db.prepare('SELECT r.*, u.name AS entered_by_name FROM test_results r LEFT JOIN users u ON u.id = r.entered_by WHERE r.tr_id = ? ORDER BY r.created_at DESC').all(p.id);
  tr.spec = SPEC_TABLE[tr.test_type] || null;
  json(res, 200, { tr });
});
route('GET', '/specs', async (req, res) => json(res, 200, { specs: SPEC_TABLE, test_types: TEST_TYPES }));

/* ================= M06 lab results desk ================= */
function evaluateResult(test_type, value, specOverride, specReference) {
  const spec = SPEC_TABLE[test_type] || SPEC_TABLE.Other;
  let limit = specOverride != null ? Number(specOverride) : spec.limit;
  if (test_type === 'Slump') {
    const target = (String(specReference || '').match(/(\d{2,3})\s*mm/) || [])[1];
    const centre = target ? Number(target) : spec.target;
    const tol = specOverride != null ? Number(specOverride) : spec.limit;
    return { pass: Math.abs(value - centre) <= tol, limit: tol, detail: `${centre}mm ±${tol}mm` };
  }
  if (limit == null) return { pass: true, limit: null, detail: 'no spec limit — recorded only' };
  return { pass: value >= limit, limit, detail: `min ${limit} ${spec.unit}` };
}
route('POST', '/trs/:id/result', async (req, res, p, body, user) => {
  const tr = db.prepare('SELECT * FROM test_requests WHERE id = ?').get(p.id);
  if (!tr) throw new ApiError(404, 'TR not found.');
  const value = Number(req0(body.result_value, 'result_value'));
  if (Number.isNaN(value)) throw new ApiError(400, 'result_value must be a number.');
  const ev = evaluateResult(tr.test_type, value, body.spec_limit, tr.spec_reference);
  const pf = ev.pass ? 'PASS' : 'FAIL';
  const rid = uuid();
  db.prepare('INSERT INTO test_results (id,tr_id,result_value,spec_limit,pass_fail,result_date,report_url,entered_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(rid, p.id, value, ev.limit, pf, body.result_date || today(), body.report_url || null, user.id, now());
  db.prepare("UPDATE test_requests SET status = 'Completed' WHERE id = ?").run(p.id);

  const wir = tr.wir_id ? db.prepare('SELECT * FROM wirs WHERE id = ?').get(tr.wir_id) : null;
  let ncr = null;
  if (pf === 'FAIL') {
    // SYS.03: M06 → M15 auto-raise NCR; M06 → M11 immediate alert
    const ncrId = uuid();
    const ncr_number = nextNumber('ncrs', 'ncr_number', `NCR-${new Date().getFullYear()}-`, tr.project_id);
    db.prepare(`INSERT INTO ncrs (id,project_id,ncr_number,source_type,source_id,wir_id,description,status,raised_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ncrId, tr.project_id, ncr_number, 'TR', tr.id, tr.wir_id,
        `${tr.test_type} result ${value} below spec (${ev.detail}) — ${tr.tr_number}${wir ? ' / ' + wir.wir_number : ''}.`, 'Open', now());
    ncr = db.prepare('SELECT * FROM ncrs WHERE id = ?').get(ncrId);
    const targets = [tr.created_by, wir && wir.engineer_id, ...projectMembersByRole(tr.project_id, ['QA', 'Admin'])];
    notify(targets, 'TEST_FAILED', `TEST FAILED: ${tr.tr_number} ${tr.test_type} = ${value} (${ev.detail}). ${ncr_number} auto-raised.`, 'ncr', ncrId);
    notify(targets, 'NCR_RAISED', `${ncr_number} raised against ${tr.tr_number}${wir ? ' / ' + wir.wir_number : ''}`, 'ncr', ncrId);
  } else if (wir) {
    // ON PASS: if all TRs cleared, tell the engineer approval is unblocked
    const remaining = db.prepare(`SELECT COUNT(*) c FROM test_requests WHERE wir_id = ? AND status = 'Pending'`).get(wir.id).c;
    const failed = db.prepare(`SELECT COUNT(*) c FROM test_requests tr JOIN test_results r ON r.tr_id = tr.id AND r.pass_fail='FAIL' WHERE tr.wir_id = ?`).get(wir.id).c;
    if (!remaining && !failed) {
      notify([wir.engineer_id, ...projectMembersByRole(tr.project_id, ['QA'])], 'TR_CLEARED',
        `All test results for ${wir.wir_number} passed — approval unblocked`, 'wir', wir.id, `cleared:${wir.id}`);
    }
  }
  json(res, 201, { result: db.prepare('SELECT * FROM test_results WHERE id = ?').get(rid), pass_fail: pf, spec_detail: ev.detail, ncr });
});

/* ================= M07 FDT frequency tracker ================= */
function fdtSummaryForZone(zone) {
  if (!zone) return [];
  const rows = db.prepare(`
    SELECT tr.layer_no, MAX(tr.area_m2) AS area_m2, COUNT(*) AS done,
      SUM(CASE WHEN r.pass_fail = 'FAIL' THEN 1 ELSE 0 END) AS failed
    FROM test_requests tr
    LEFT JOIN test_results r ON r.tr_id = tr.id
    JOIN wirs w ON w.id = tr.wir_id
    WHERE tr.test_type = 'FDT' AND w.zone_id = ? AND tr.layer_no IS NOT NULL
    GROUP BY tr.layer_no ORDER BY tr.layer_no`).all(zone.id);
  return rows.map((r) => {
    const required = r.area_m2 ? Math.ceil(r.area_m2 / FDT_AREA_PER_TEST) : 0;
    return { ...r, zone_name: zone.name, required, deficient: r.done < required };
  });
}
route('GET', '/fdt', async (req, res, p, b, user, query) => {
  const zones = db.prepare('SELECT * FROM zones WHERE project_id = ?').all(pid(query));
  const summary = zones.flatMap((z) => fdtSummaryForZone(z));
  const logs = db.prepare(`
    SELECT tr.*, z.name AS zone_name, w.wir_number,
      (SELECT result_value FROM test_results r WHERE r.tr_id = tr.id ORDER BY r.created_at DESC LIMIT 1) AS result_value,
      (SELECT pass_fail FROM test_results r WHERE r.tr_id = tr.id ORDER BY r.created_at DESC LIMIT 1) AS pass_fail
    FROM test_requests tr JOIN wirs w ON w.id = tr.wir_id JOIN zones z ON z.id = w.zone_id
    WHERE tr.project_id = ? AND tr.test_type = 'FDT' ORDER BY tr.created_at DESC`).all(pid(query));
  json(res, 200, { summary, logs, area_per_test: FDT_AREA_PER_TEST });
});

/* ================= M08 IR matrix ================= */
const STATUS_RANK = { 'Rejected': 0, 'Resubmit Required': 1, 'Draft': 2, 'Submitted': 3, 'Under Review': 4, 'Approved': 5 };
route('GET', '/matrix', async (req, res, p, b, user, query) => {
  const project_id = pid(query);
  const zones = db.prepare('SELECT id, name FROM zones WHERE project_id = ? ORDER BY name').all(project_id);
  const wirs = db.prepare(`SELECT w.id, w.wir_number, w.zone_id, w.activity_type, w.status,
    (SELECT COUNT(*) FROM test_requests tr WHERE tr.wir_id = w.id AND tr.status='Pending') AS tr_pending
    FROM wirs w WHERE w.project_id = ?`).all(project_id);
  const planned = db.prepare(`SELECT zone_id, type, COUNT(*) AS c FROM activities WHERE project_id = ? GROUP BY zone_id, type`).all(project_id);
  const grid = zones.map((z) => {
    const cells = {};
    for (const t of ACTIVITY_TYPES) {
      const cellWirs = wirs.filter((w) => w.zone_id === z.id && w.activity_type === t);
      const isPlanned = planned.some((pl) => pl.zone_id === z.id && pl.type === t);
      if (!cellWirs.length) { cells[t] = { state: isPlanned ? 'Not Started' : 'N/A', wirs: [] }; continue; }
      const worst = cellWirs.reduce((a, b) => (STATUS_RANK[a.status] <= STATUS_RANK[b.status] ? a : b));
      const trPending = cellWirs.reduce((s, w) => s + w.tr_pending, 0);
      cells[t] = { state: trPending > 0 && worst.status !== 'Rejected' ? 'TR Pending' : worst.status, wirs: cellWirs, tr_pending: trPending };
    }
    const zoneWirs = wirs.filter((w) => w.zone_id === z.id);
    const progress = zoneWirs.length ? Math.round(100 * zoneWirs.filter((w) => w.status === 'Approved').length / zoneWirs.length) : 0;
    return { zone: z, cells, progress };
  });
  json(res, 200, { grid, activity_types: ACTIVITY_TYPES });
});

/* ================= M09 lab test matrix ================= */
const LAB_COLS = ['Slump', '7-day Cube', '28-day Cube', 'FDT', 'Steel Tensile', 'Asphalt Core'];
route('GET', '/lab-matrix', async (req, res, p, b, user, query) => {
  const project_id = pid(query);
  const wirs = db.prepare(`SELECT w.id, w.wir_number, w.description, w.activity_type, z.name AS zone_name
    FROM wirs w LEFT JOIN zones z ON z.id = w.zone_id
    WHERE w.project_id = ? AND EXISTS (SELECT 1 FROM test_requests tr WHERE tr.wir_id = w.id) ORDER BY w.wir_number`).all(project_id);
  const trs = db.prepare(`SELECT tr.*, (SELECT pass_fail FROM test_results r WHERE r.tr_id = tr.id ORDER BY r.created_at DESC LIMIT 1) AS pass_fail
    FROM test_requests tr WHERE tr.project_id = ? AND tr.wir_id IS NOT NULL`).all(project_id);
  const colOf = (tr) => {
    if (/Concrete Cube/.test(tr.test_type)) {
      // 7-day result recorded but 28-day still ahead → treat entered result as 7-day
      return tr.pass_fail && tr.due_28day && tr.due_28day > today() ? '7-day Cube' : '28-day Cube';
    }
    return LAB_COLS.includes(tr.test_type) ? tr.test_type : null;
  };
  const rows = wirs.map((w) => {
    const cells = Object.fromEntries(LAB_COLS.map((c) => [c, { state: 'N/A', trs: [] }]));
    for (const tr of trs.filter((t) => t.wir_id === w.id)) {
      const col = colOf(tr);
      if (!col) continue;
      const cell = cells[col];
      cell.trs.push({ id: tr.id, tr_number: tr.tr_number, pass_fail: tr.pass_fail, status: tr.status });
      const st = tr.pass_fail === 'FAIL' ? 'FAIL' : tr.status === 'Pending' ? 'Pending' : tr.pass_fail === 'PASS' ? 'PASS' : 'Pending';
      const rank = { FAIL: 0, Pending: 1, PASS: 2, 'N/A': 3 };
      if (rank[st] < rank[cell.state]) cell.state = st;
      else if (cell.state === 'N/A') cell.state = st;
    }
    return { wir: w, cells };
  });
  const summary = Object.fromEntries(LAB_COLS.map((c) => {
    const all = rows.flatMap((r) => r.cells[c].trs);
    const done = all.filter((t) => t.pass_fail);
    return [c, { total: all.length, pass: done.filter((t) => t.pass_fail === 'PASS').length, done: done.length }];
  }));
  json(res, 200, { rows, columns: LAB_COLS, summary });
});

/* ================= M15 NCR module ================= */
route('GET', '/ncrs', async (req, res, p, b, user, query) => {
  const rows = db.prepare(`SELECT n.*, w.wir_number, tr.tr_number
    FROM ncrs n LEFT JOIN wirs w ON w.id = n.wir_id
    LEFT JOIN test_requests tr ON tr.id = n.source_id AND n.source_type = 'TR'
    WHERE n.project_id = ? ORDER BY n.raised_at DESC`).all(pid(query));
  json(res, 200, { ncrs: rows });
});
route('POST', '/ncrs', async (req, res, p, body, user) => {
  const project_id = req0(body.project_id, 'project_id');
  const id = uuid();
  const ncr_number = nextNumber('ncrs', 'ncr_number', `NCR-${new Date().getFullYear()}-`, project_id);
  db.prepare(`INSERT INTO ncrs (id,project_id,ncr_number,source_type,source_id,wir_id,description,status,raised_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, project_id, ncr_number, body.source_type || 'Manual', body.source_id || null, body.wir_id || null,
      req0(body.description, 'description'), 'Open', now());
  notify(projectMembersByRole(project_id, ['QA', 'Admin', 'Engineer']), 'NCR_RAISED', `${ncr_number} raised: ${body.description}`, 'ncr', id);
  json(res, 201, { ncr: db.prepare('SELECT * FROM ncrs WHERE id = ?').get(id) });
});
route('GET', '/ncrs/:id', async (req, res, p) => {
  const n = db.prepare(`SELECT n.*, w.wir_number, tr.tr_number, u.name AS signed_off_name
    FROM ncrs n LEFT JOIN wirs w ON w.id = n.wir_id
    LEFT JOIN test_requests tr ON tr.id = n.source_id AND n.source_type = 'TR'
    LEFT JOIN users u ON u.id = n.signed_off_by WHERE n.id = ?`).get(p.id);
  if (!n) throw new ApiError(404, 'NCR not found.');
  json(res, 200, { ncr: n });
});
route('PATCH', '/ncrs/:id', async (req, res, p, body, user) => {
  const n = db.prepare('SELECT * FROM ncrs WHERE id = ?').get(p.id);
  if (!n) throw new ApiError(404, 'NCR not found.');
  const updates = { root_cause: body.root_cause, corrective_action: body.corrective_action, retest_tr_id: body.retest_tr_id, closeout_evidence: body.closeout_evidence };
  for (const [k, v] of Object.entries(updates)) if (v !== undefined) db.prepare(`UPDATE ncrs SET ${k} = ? WHERE id = ?`).run(v, p.id);
  if (body.status) {
    if (!['Open', 'Under Review', 'Closed'].includes(body.status)) throw new ApiError(400, 'Invalid status.');
    if (body.status === 'Closed') {
      requireRole(user, ['QA', 'Admin']);
      const cur = db.prepare('SELECT * FROM ncrs WHERE id = ?').get(p.id);
      if (!cur.closeout_evidence) throw new ApiError(422, 'Close-out evidence is required before closing an NCR.');
      db.prepare('UPDATE ncrs SET status = ?, signed_off_by = ?, closed_at = ? WHERE id = ?').run('Closed', user.id, now(), p.id);
      notify(projectMembersByRole(n.project_id, ['QA', 'Engineer']), 'NCR_CLOSED', `${n.ncr_number} closed by ${user.name}`, 'ncr', p.id);
    } else {
      db.prepare('UPDATE ncrs SET status = ? WHERE id = ?').run(body.status, p.id);
    }
  }
  json(res, 200, { ncr: db.prepare('SELECT * FROM ncrs WHERE id = ?').get(p.id) });
});

/* ================= M12 handover pack builder ================= */
function handoverIndex(project_id, filters) {
  const args = [project_id];
  let wirSql = `SELECT w.*, z.name AS zone_name, u.name AS engineer_name FROM wirs w
    LEFT JOIN zones z ON z.id = w.zone_id LEFT JOIN users u ON u.id = w.engineer_id WHERE w.project_id = ?`;
  if (filters.zone_id) { wirSql += ' AND w.zone_id = ?'; args.push(filters.zone_id); }
  if (filters.approved_only !== false) wirSql += " AND w.status = 'Approved'";
  if (filters.from) { wirSql += ' AND w.inspection_date >= ?'; args.push(filters.from); }
  if (filters.to) { wirSql += ' AND w.inspection_date <= ?'; args.push(filters.to); }
  const wirs = db.prepare(wirSql + ' ORDER BY w.wir_number').all(...args);
  const wirIds = wirs.map((w) => w.id);
  const inList = wirIds.length ? `(${wirIds.map(() => '?').join(',')})` : '(NULL)';
  const results = db.prepare(`SELECT tr.tr_number, tr.test_type, tr.sample_date, r.result_value, r.spec_limit, r.pass_fail, r.result_date, w.wir_number
    FROM test_requests tr JOIN test_results r ON r.tr_id = tr.id JOIN wirs w ON w.id = tr.wir_id
    WHERE tr.wir_id IN ${inList} ORDER BY tr.tr_number`).all(...wirIds);
  const ncrs = db.prepare(`SELECT n.*, w.wir_number FROM ncrs n LEFT JOIN wirs w ON w.id = n.wir_id
    WHERE n.project_id = ? ${wirIds.length ? `AND (n.wir_id IN ${inList} OR n.wir_id IS NULL)` : ''} ORDER BY n.ncr_number`)
    .all(project_id, ...(wirIds.length ? wirIds : []));
  const ms = db.prepare(`SELECT * FROM method_statements WHERE project_id = ? AND status = 'Approved' ORDER BY ms_number`).all(project_id);
  return { wirs, results, ncrs, ms };
}
route('GET', '/handover/preview', async (req, res, p, b, user, query) => {
  const idx = handoverIndex(pid(query), { zone_id: query.zone_id, approved_only: query.approved_only !== '0', from: query.from, to: query.to });
  json(res, 200, {
    sections: [
      { title: 'Work Inspection Requests', count: idx.wirs.length, items: idx.wirs.map((w) => `${w.wir_number} — ${w.description || w.activity_type} (${w.zone_name || ''})`) },
      { title: 'Laboratory Test Results', count: idx.results.length, items: idx.results.map((r) => `${r.tr_number} ${r.test_type} = ${r.result_value} → ${r.pass_fail} (${r.wir_number})`) },
      { title: 'Non-Conformance Reports', count: idx.ncrs.length, items: idx.ncrs.map((n) => `${n.ncr_number} [${n.status}] ${n.description.slice(0, 90)}`) },
      { title: 'Method Statements', count: idx.ms.length, items: idx.ms.map((m) => `${m.ms_number} — ${m.title}`) },
    ],
  });
});
route('POST', '/handover/generate', async (req, res, p, body, user) => {
  const project_id = req0(body.project_id, 'project_id');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
  const idx = handoverIndex(project_id, body.filters || {});
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const checklistRows = (w) => JSON.parse(w.checklist || '[]').map((c) => `<tr><td>${esc(c.item)}</td><td>${esc(c.result)}</td></tr>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>QA Handover Pack — ${esc(project.name)}</title>
<style>
body{font-family:Georgia,serif;color:#111;max-width:900px;margin:0 auto;padding:40px 30px;line-height:1.5}
h1{font-size:30px;border-bottom:4px solid #0F1E38;padding-bottom:12px} h2{margin-top:44px;color:#0F1E38;border-bottom:1px solid #ccc;padding-bottom:6px;page-break-before:always}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px} th,td{border:1px solid #bbb;padding:6px 8px;text-align:left} th{background:#0F1E38;color:#fff}
.cover{text-align:center;padding:110px 0;page-break-after:always} .cover h1{border:none;font-size:38px} .meta{color:#555}
.pass{color:#166a34;font-weight:bold}.fail{color:#b91c1c;font-weight:bold}
.toc li{margin:5px 0} .wir{page-break-inside:avoid;margin:22px 0;border:1px solid #ccc;padding:14px}
@media print {.noprint{display:none}}
</style></head><body>
<div class="cover"><p class="meta">QUALITY ASSURANCE</p><h1>Handover Documentation Pack</h1>
<p><b>${esc(project.name)}</b><br>${esc(project.location)}<br>Client: ${esc(project.client)} · Contract: ${esc(project.contract_no)}</p>
<p class="meta">Generated ${today()} by ${esc(user.name)} · WIRflow</p></div>
<h2>Table of Contents</h2><ol class="toc">
<li>Work Inspection Requests (${idx.wirs.length})</li><li>Laboratory Test Results (${idx.results.length})</li>
<li>Non-Conformance Reports (${idx.ncrs.length})</li><li>Method Statements (${idx.ms.length})</li></ol>
<h2>1. Work Inspection Requests</h2>
${idx.wirs.map((w) => `<div class="wir"><h3>${esc(w.wir_number)} — ${esc(w.description || w.activity_type)}</h3>
<table><tr><th>Zone</th><td>${esc(w.zone_name)}</td><th>Status</th><td>${esc(w.status)}</td></tr>
<tr><th>Activity</th><td>${esc(w.activity_type)}</td><th>Inspection date</th><td>${esc(w.inspection_date)}</td></tr>
<tr><th>Contractor</th><td>${esc(w.contractor)}</td><th>Engineer</th><td>${esc(w.engineer_name)}</td></tr></table>
<table><tr><th>Checklist item</th><th>Result</th></tr>${checklistRows(w)}</table></div>`).join('')}
<h2>2. Laboratory Test Results</h2>
<table><tr><th>TR</th><th>Test</th><th>WIR</th><th>Sample date</th><th>Result</th><th>Spec limit</th><th>Verdict</th></tr>
${idx.results.map((r) => `<tr><td>${esc(r.tr_number)}</td><td>${esc(r.test_type)}</td><td>${esc(r.wir_number)}</td><td>${esc(r.sample_date)}</td><td>${esc(r.result_value)}</td><td>${esc(r.spec_limit)}</td><td class="${r.pass_fail === 'PASS' ? 'pass' : 'fail'}">${esc(r.pass_fail)}</td></tr>`).join('')}</table>
<h2>3. Non-Conformance Reports</h2>
<table><tr><th>NCR</th><th>Source</th><th>Description</th><th>Root cause</th><th>Corrective action</th><th>Status</th></tr>
${idx.ncrs.map((n) => `<tr><td>${esc(n.ncr_number)}</td><td>${esc(n.wir_number || n.source_type)}</td><td>${esc(n.description)}</td><td>${esc(n.root_cause)}</td><td>${esc(n.corrective_action)}</td><td>${esc(n.status)}</td></tr>`).join('')}</table>
<h2>4. Method Statements</h2>
<table><tr><th>MS</th><th>Title</th><th>Activity type</th><th>Approved</th></tr>
${idx.ms.map((m) => `<tr><td>${esc(m.ms_number)}</td><td>${esc(m.title)}</td><td>${esc(m.activity_type)}</td><td>${esc(m.approved_date)}</td></tr>`).join('')}</table>
<p class="meta noprint" style="margin-top:40px">Use your browser's Print → Save as PDF for the final document.</p>
</body></html>`;
  const fname = `handover-${project.name.replace(/[^a-zA-Z0-9]+/g, '_')}-${Date.now()}.html`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), html);
  json(res, 201, { url: `/uploads/${fname}`, counts: { wirs: idx.wirs.length, results: idx.results.length, ncrs: idx.ncrs.length, ms: idx.ms.length } });
});

/* ================= dashboard summary ================= */
route('GET', '/dashboard', async (req, res, p, b, user, query) => {
  const project_id = pid(query);
  runScheduledChecks(project_id);
  const count = (sql, ...a) => db.prepare(sql).get(project_id, ...a).c;
  json(res, 200, {
    wirs: {
      total: count('SELECT COUNT(*) c FROM wirs WHERE project_id=?'),
      approved: count("SELECT COUNT(*) c FROM wirs WHERE project_id=? AND status='Approved'"),
      awaiting: count("SELECT COUNT(*) c FROM wirs WHERE project_id=? AND status IN ('Submitted','Under Review')"),
      rejected: count("SELECT COUNT(*) c FROM wirs WHERE project_id=? AND status IN ('Rejected','Resubmit Required')"),
    },
    trs: {
      pending: count("SELECT COUNT(*) c FROM test_requests WHERE project_id=? AND status='Pending'"),
      overdue: db.prepare(`SELECT COUNT(*) c FROM test_requests WHERE project_id=? AND status='Pending'
        AND ((due_7day IS NOT NULL AND due_7day < ?) OR (due_28day IS NOT NULL AND due_28day < ?))`).get(project_id, today(), today()).c,
      failed: count("SELECT COUNT(*) c FROM test_requests tr JOIN test_results r ON r.tr_id=tr.id AND r.pass_fail='FAIL' WHERE tr.project_id=?"),
    },
    ncrs: { open: count("SELECT COUNT(*) c FROM ncrs WHERE project_id=? AND status != 'Closed'") },
  });
});

/* ================= dispatcher ================= */
async function handle(req, res) {
  const [pathname, qs] = req.url.split('?');
  const sub = pathname.replace(/^\/api\/app/, '') || '/';
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = sub.match(r.rx);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      let user = null;
      if (r.auth) {
        user = authUser(req);
        if (!user) return json(res, 401, { error: 'Not authenticated.' });
      }
      let body = {}; let raw = null;
      if (req.method !== 'GET') {
        raw = await readBody(req);
        if (!r.raw && raw.length) {
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw new ApiError(400, 'Invalid JSON body.'); }
        }
      }
      await r.handler(req, res, params, body, user, query, raw);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[api]', err);
      json(res, status, { error: err.message || 'Internal error' });
    }
    return true;
  }
  json(res, 404, { error: 'Unknown API route: ' + sub });
  return true;
}

module.exports = { handle };
