'use strict';
/*
 * WIRflow data layer — blueprint SYS.02.
 * Single SQLite database (node:sqlite, zero dependencies). Every module
 * owns its tables and other modules read through the API layer (SYS.03).
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'wirflow.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/* ---------------- schema ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Engineer',           -- Engineer | QA | DocControl | Admin
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT, client TEXT,
  contract_no TEXT, start_date TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL,
  UNIQUE(project_id, user_id)
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, grid_ref TEXT, description TEXT, floor_plan_url TEXT,
  created_by TEXT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  zone_id TEXT NOT NULL REFERENCES zones(id),
  name TEXT NOT NULL, type TEXT NOT NULL,          -- Rebar | Formwork | Concrete Pour | MEP Rough-in | Backfill | Finishes
  planned_start TEXT, planned_end TEXT
);
CREATE TABLE IF NOT EXISTS shop_drawings (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  drawing_number TEXT NOT NULL, title TEXT, revision TEXT NOT NULL,
  discipline TEXT NOT NULL,                        -- Structural | MEP | Civil | Architectural
  file_url TEXT, is_latest INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS zone_drawings (
  id TEXT PRIMARY KEY, zone_id TEXT NOT NULL REFERENCES zones(id),
  drawing_id TEXT NOT NULL REFERENCES shop_drawings(id), UNIQUE(zone_id, drawing_id)
);
CREATE TABLE IF NOT EXISTS wirs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  zone_id TEXT REFERENCES zones(id), activity_id TEXT REFERENCES activities(id),
  wir_number TEXT UNIQUE NOT NULL, activity_type TEXT, description TEXT,
  location TEXT, contractor TEXT, inspection_types TEXT,   -- JSON array
  checklist TEXT,                                          -- JSON [{item, result}]
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',            -- Draft | Submitted | Under Review | Approved | Rejected | Resubmit Required
  engineer_id TEXT REFERENCES users(id), inspection_date TEXT,
  pdf_url TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wir_drawings (
  id TEXT PRIMARY KEY, wir_id TEXT NOT NULL REFERENCES wirs(id),
  drawing_id TEXT NOT NULL REFERENCES shop_drawings(id), UNIQUE(wir_id, drawing_id)
);
CREATE TABLE IF NOT EXISTS wir_comments (
  id TEXT PRIMARY KEY, wir_id TEXT NOT NULL REFERENCES wirs(id),
  user_id TEXT REFERENCES users(id), text TEXT NOT NULL, status_change TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_requests (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  wir_id TEXT REFERENCES wirs(id), tr_number TEXT UNIQUE NOT NULL,
  test_type TEXT NOT NULL,                          -- Concrete Cube C25/C30/C40 | Slump | FDT | Steel Tensile | Asphalt Core | Other
  sample_date TEXT, location TEXT, sample_count INTEGER, spec_reference TEXT,
  lab_name TEXT, notes TEXT,
  layer_no INTEGER, area_m2 REAL, mdd_ref TEXT,     -- FDT-specific (M07)
  due_7day TEXT, due_28day TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',           -- Pending | Completed
  created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_results (
  id TEXT PRIMARY KEY, tr_id TEXT NOT NULL REFERENCES test_requests(id),
  result_value REAL, spec_limit REAL, pass_fail TEXT NOT NULL,  -- PASS | FAIL
  result_date TEXT, report_url TEXT, entered_by TEXT REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ncrs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  ncr_number TEXT UNIQUE NOT NULL,
  source_type TEXT NOT NULL,                        -- WIR | TR | Manual
  source_id TEXT, wir_id TEXT REFERENCES wirs(id),
  description TEXT NOT NULL, root_cause TEXT, corrective_action TEXT,
  retest_tr_id TEXT REFERENCES test_requests(id),
  status TEXT NOT NULL DEFAULT 'Open',              -- Open | Under Review | Closed
  closeout_evidence TEXT, signed_off_by TEXT REFERENCES users(id),
  raised_at TEXT NOT NULL, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, message TEXT NOT NULL, ref_type TEXT, ref_id TEXT,
  dedupe_key TEXT, sent_at TEXT NOT NULL, read_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS method_statements (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  ms_number TEXT UNIQUE NOT NULL, title TEXT NOT NULL, activity_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Submitted',         -- Submitted | Approved | Rejected
  file_url TEXT, approved_date TEXT, created_at TEXT NOT NULL
);
`);

/* ---------------- helpers ---------------- */
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

/* Sequential document numbering per project (WIR-001, TR-2026-001, NCR-2026-001) */
function nextNumber(table, column, prefix, project_id, padded = 3) {
  const rows = db.prepare(`SELECT ${column} AS n FROM ${table} WHERE project_id = ?`).all(project_id);
  let max = 0;
  for (const r of rows) {
    const m = String(r.n).match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(padded, '0');
}

/* ---------------- seed (demo project) ---------------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return;
  const t = now();
  const mkUser = (email, name, role) => {
    const id = uuid();
    db.prepare('INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, email, name, role, hashPassword('demo123'), t);
    return id;
  };
  const admin = mkUser('admin@wirflow.app', 'Aisha Rahman', 'Admin');
  const qa = mkUser('qa@wirflow.app', 'Karim Haddad', 'QA');
  const eng = mkUser('engineer@wirflow.app', 'Devan Prabu', 'Engineer');
  const doc = mkUser('doc@wirflow.app', 'Marta Silva', 'DocControl');

  const project = uuid();
  db.prepare('INSERT INTO projects (id,name,location,client,contract_no,start_date,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(project, 'Marina Heights Tower', 'Dubai Marina, UAE', 'Emerald Developments LLC', 'C-2026-114', '2026-05-01', admin, t);
  for (const [u, r] of [[admin, 'Admin'], [qa, 'QA'], [eng, 'Engineer'], [doc, 'DocControl']]) {
    db.prepare('INSERT INTO project_members (id,project_id,user_id,role) VALUES (?,?,?,?)').run(uuid(), project, u, r);
  }

  const mkZone = (name, grid, desc) => {
    const id = uuid();
    db.prepare('INSERT INTO zones (id,project_id,name,grid_ref,description,created_by) VALUES (?,?,?,?,?,?)')
      .run(id, project, name, grid, desc, qa);
    return id;
  };
  const z1 = mkZone('Z01 - Basement', 'A1-D4', 'Basement raft and retaining walls');
  const z2 = mkZone('Z02 - Ground Floor', 'A1-F6', 'Ground floor slab and columns');
  const z3 = mkZone('Z03 - Level 1', 'A1-F6', 'Level 1 slab, columns, MEP risers');
  const z4 = mkZone('Z04 - Podium', 'G1-K4', 'Podium deck and landscape backfill');

  const mkDrawing = (num, title, rev, disc, latest = 1) => {
    const id = uuid();
    db.prepare('INSERT INTO shop_drawings (id,project_id,drawing_number,title,revision,discipline,is_latest,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, project, num, title, rev, disc, latest, t);
    return id;
  };
  const d1 = mkDrawing('SD-STR-001', 'Basement Raft Reinforcement Layout', 'Rev 2', 'Structural');
  mkDrawing('SD-STR-001', 'Basement Raft Reinforcement Layout', 'Rev 1', 'Structural', 0);
  const d2 = mkDrawing('SD-STR-014', 'GF Slab Reinforcement Details', 'Rev 1', 'Structural');
  const d3 = mkDrawing('SD-STR-022', 'L1 Column Schedule', 'Rev 0', 'Structural');
  const d4 = mkDrawing('SD-MEP-005', 'GF Underslab Drainage Layout', 'Rev 1', 'MEP');
  const d5 = mkDrawing('SD-CIV-003', 'Podium Backfill Levels & Compaction Plan', 'Rev 0', 'Civil');

  for (const [z, d] of [[z1, d1], [z2, d2], [z2, d4], [z3, d3], [z4, d5]]) {
    db.prepare('INSERT INTO zone_drawings (id,zone_id,drawing_id) VALUES (?,?,?)').run(uuid(), z, d);
  }

  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const mkAct = (zone, name, type, s, e) => {
    const id = uuid();
    db.prepare('INSERT INTO activities (id,project_id,zone_id,name,type,planned_start,planned_end) VALUES (?,?,?,?,?,?,?)')
      .run(id, project, zone, name, type, s, e);
    return id;
  };
  const a1 = mkAct(z1, 'Raft reinforcement fixing', 'Rebar', day(-30), day(-24));
  const a2 = mkAct(z1, 'Raft concrete pour', 'Concrete Pour', day(-22), day(-21));
  const a3 = mkAct(z2, 'GF slab formwork', 'Formwork', day(-10), day(-5));
  const a4 = mkAct(z2, 'GF slab reinforcement', 'Rebar', day(-6), day(-1));
  const a5 = mkAct(z2, 'GF slab pour', 'Concrete Pour', day(1), day(2));
  const a6 = mkAct(z2, 'GF underslab MEP', 'MEP Rough-in', day(-12), day(-8));
  mkAct(z3, 'L1 column rebar', 'Rebar', day(6), day(10));
  mkAct(z3, 'L1 column pour', 'Concrete Pour', day(11), day(12));
  const a9 = mkAct(z4, 'Podium backfill layer 1', 'Backfill', day(-4), day(-2));
  mkAct(z4, 'Podium backfill layer 2', 'Backfill', day(2), day(4));

  const mkMS = (num, title, type, status) => {
    const id = uuid();
    db.prepare('INSERT INTO method_statements (id,project_id,ms_number,title,activity_type,status,approved_date,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, project, num, title, type, status, status === 'Approved' ? day(-40) : null, t);
    return id;
  };
  mkMS('MS-001', 'Reinforcement Fixing Method Statement', 'Rebar', 'Approved');
  mkMS('MS-002', 'Concrete Pouring & Curing Method Statement', 'Concrete Pour', 'Approved');
  mkMS('MS-003', 'Formwork Erection Method Statement', 'Formwork', 'Approved');
  mkMS('MS-004', 'Backfilling & Compaction Method Statement', 'Backfill', 'Approved');
  mkMS('MS-005', 'MEP First Fix Method Statement', 'MEP Rough-in', 'Submitted');

  const mkWIR = (n, zone, act, type, desc, status, date, drawings) => {
    const id = uuid();
    db.prepare(`INSERT INTO wirs (id,project_id,zone_id,activity_id,wir_number,activity_type,description,location,contractor,
      inspection_types,checklist,status,engineer_id,inspection_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, project, zone, act, n, type, desc, 'Per drawing grid', 'Gulf Build LLC',
        JSON.stringify([type]), JSON.stringify([
          { item: 'Work matches latest drawing revision', result: 'Pass' },
          { item: 'Materials approved and undamaged', result: 'Pass' },
          { item: 'Setting out / levels checked', result: 'Pass' },
          { item: 'Safety access in place', result: 'Pass' },
          { item: 'Housekeeping acceptable', result: 'Pass' },
        ]), status, eng, date, t);
    for (const d of drawings) db.prepare('INSERT INTO wir_drawings (id,wir_id,drawing_id) VALUES (?,?,?)').run(uuid(), id, d);
    return id;
  };
  const w1 = mkWIR('WIR-001', z1, a1, 'Rebar', 'Basement raft reinforcement — zone A1-D4', 'Approved', day(-24), [d1]);
  const w2 = mkWIR('WIR-002', z1, a2, 'Concrete Pour', 'Basement raft pour 850m³ C40', 'Approved', day(-21), [d1]);
  const w3 = mkWIR('WIR-003', z2, a6, 'MEP Rough-in', 'GF underslab drainage first fix', 'Submitted', day(-8), [d4]);
  const w4 = mkWIR('WIR-004', z2, a4, 'Rebar', 'GF slab reinforcement', 'Under Review', day(-1), [d2]);
  const w5 = mkWIR('WIR-005', z4, a9, 'Backfill', 'Podium backfill layer 1 — 620m²', 'Submitted', day(-2), [d5]);

  const mkTR = (n, wir, type, sample, extra = {}) => {
    const id = uuid();
    db.prepare(`INSERT INTO test_requests (id,project_id,wir_id,tr_number,test_type,sample_date,location,sample_count,spec_reference,
      lab_name,layer_no,area_m2,due_7day,due_28day,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, project, wir, n, type, sample, extra.location || null, extra.count || 3, extra.spec || null,
        'Gulf Lab Services', extra.layer || null, extra.area || null,
        extra.due7 || null, extra.due28 || null, extra.status || 'Pending', eng, t);
    return id;
  };
  const mkResult = (tr, value, limit, pf, date) => {
    db.prepare('INSERT INTO test_results (id,tr_id,result_value,spec_limit,pass_fail,result_date,entered_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), tr, value, limit, pf, date, qa, t);
    db.prepare("UPDATE test_requests SET status='Completed' WHERE id=?").run(tr);
  };

  // Raft pour: slump passed, 7-day passed, 28-day pending (due soon)
  const tr1 = mkTR('TR-2026-001', w2, 'Slump', day(-21), { spec: 'Mix D40 target 160mm', status: 'Completed' });
  mkResult(tr1, 165, 25, 'PASS', day(-21));
  const tr2 = mkTR('TR-2026-002', w2, 'Concrete Cube C40', day(-21), { spec: 'C40', due7: day(-14), due28: day(7), status: 'Completed' });
  mkResult(tr2, 32.5, 26, 'PASS', day(-14));
  mkTR('TR-2026-003', w2, 'Concrete Cube C40', day(-21), { spec: 'C40', due7: day(-14), due28: day(7) });
  // Podium backfill FDT: one passed, one FAILED (demo NCR)
  const tr4 = mkTR('TR-2026-004', w5, 'FDT', day(-2), { layer: 1, area: 620, spec: 'min 95% MDD', status: 'Completed' });
  mkResult(tr4, 96.4, 95, 'PASS', day(-1));
  const tr5 = mkTR('TR-2026-005', w5, 'FDT', day(-2), { layer: 1, area: 620, spec: 'min 95% MDD', status: 'Completed' });
  mkResult(tr5, 91.2, 95, 'FAIL', day(-1));

  db.prepare(`INSERT INTO ncrs (id,project_id,ncr_number,source_type,source_id,wir_id,description,status,raised_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uuid(), project, 'NCR-2026-001', 'TR', tr5, w5,
      'FDT result 91.2% MDD below specified minimum 95% MDD — Podium backfill layer 1 (TR-2026-005).', 'Open', t);

  for (const [u, type, msg] of [
    [qa, 'WIR_SUBMITTED', 'WIR-005 submitted by Devan Prabu — Podium backfill layer 1'],
    [qa, 'TEST_FAILED', 'TEST FAILED: TR-2026-005 FDT 91.2% vs min 95% MDD — NCR-2026-001 auto-raised'],
    [eng, 'TEST_FAILED', 'TEST FAILED: TR-2026-005 FDT 91.2% vs min 95% MDD — NCR-2026-001 auto-raised'],
    [eng, 'TR_DUE_SOON', 'TR-2026-003 28-day cube result due in 7 days'],
  ]) {
    db.prepare('INSERT INTO notifications (id,user_id,type,message,sent_at) VALUES (?,?,?,?,?)').run(uuid(), u, type, msg, t);
  }
}
seed();

module.exports = { db, uuid, now, today, hashPassword, verifyPassword, nextNumber, UPLOAD_DIR, DATA_DIR };
