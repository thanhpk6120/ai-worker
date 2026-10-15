const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const config = require('../config');

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    initDb();
  }
  return dbInstance;
}

function initDb() {
  if (dbInstance) {
    return dbInstance;
  }

  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new DatabaseSync(config.DB_PATH);

  // Kích hoạt timeout chờ lock, WAL mode và foreign keys
  dbInstance.exec('PRAGMA busy_timeout = 10000;');
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');

  // Bảng jobs
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      task_code TEXT,
      title TEXT,
      prompt TEXT,
      repo_path TEXT,
      workspace_id TEXT,
      base_branch TEXT,
      worktree_path TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      runner TEXT,
      pipeline_config TEXT,
      current_step TEXT,
      error_message TEXT,
      exit_code INTEGER,
      summary TEXT,
      priority INTEGER DEFAULT 0,
      had_pending INTEGER DEFAULT 0
    );
  `);

  // Migration tự động: Thêm các cột mới vào bảng jobs nếu chưa có
  try {
    const tableInfo = dbInstance.prepare("PRAGMA table_info(jobs)").all();
    const colNames = tableInfo.map(col => col.name);
    if (!colNames.includes('task_code')) {
      dbInstance.exec('ALTER TABLE jobs ADD COLUMN task_code TEXT;');
    }
    if (!colNames.includes('gate_result')) { dbInstance.exec('ALTER TABLE jobs ADD COLUMN gate_result TEXT;'); }
    if (!colNames.includes('workspace_id')) { dbInstance.exec('ALTER TABLE jobs ADD COLUMN workspace_id TEXT;'); }
    if (!colNames.includes('had_pending')) {
      dbInstance.exec('ALTER TABLE jobs ADD COLUMN had_pending INTEGER DEFAULT 0;');
    }
  } catch (err) {
    // Bỏ qua nếu lỗi migration
  }

  // Bảng steps
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      step_index INTEGER,
      step_type TEXT,
      runner TEXT,
      status TEXT,
      started_at TEXT,
      finished_at TEXT,
      stdout TEXT,
      stderr TEXT,
      exit_code INTEGER,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    );
  `);

  // Bảng dual_plans
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS dual_plans (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      dev_plan TEXT,
      test_plan TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    );
  `);

  // Bảng evidence
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      type TEXT,
      data TEXT,
      verdict TEXT,
      created_at TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    );
  `);

  // Bảng questions
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      question TEXT,
      options TEXT,
      answer TEXT,
      status TEXT,
      created_at TEXT,
      answered_at TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
    );
  `);

  // Bảng runner_configs
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS runner_configs (
      id TEXT PRIMARY KEY,
      runner_name TEXT UNIQUE,
      enabled INTEGER DEFAULT 1,
      path TEXT,
      default_args TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  // Bảng workspaces
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT,
      path TEXT,
      features_dir TEXT DEFAULT 'docs/features',
      is_default INTEGER DEFAULT 0,
      created_at TEXT
    );
  `);

  // Migration tự động: Thêm cột features_dir vào bảng workspaces nếu chưa có
  try {
    const wsTableInfo = dbInstance.prepare("PRAGMA table_info(workspaces)").all();
    const hasFeaturesDir = wsTableInfo.some(col => col.name === 'features_dir');
    if (!hasFeaturesDir) {
      dbInstance.exec("ALTER TABLE workspaces ADD COLUMN features_dir TEXT DEFAULT 'docs/features';");
    }
  } catch (err) {
    console.error('[DB] Lỗi migration workspaces features_dir:', err);
  }

  // Khởi tạo workspace mặc định nếu bảng trống
  try {
    const wsCount = dbInstance.prepare("SELECT COUNT(*) as count FROM workspaces").get();
    if (wsCount && wsCount.count === 0) {
      const defaultWsId = crypto.randomUUID();
      const defaultPath = path.resolve(process.cwd());
      const defaultName = path.basename(defaultPath) || 'ai-worker';
      const nowWs = new Date().toISOString();
      dbInstance.prepare(`
        INSERT INTO workspaces (id, name, path, features_dir, is_default, created_at)
        VALUES (?, ?, ?, 'docs/features', 1, ?)
      `).run(defaultWsId, defaultName, defaultPath, nowWs);
    }
  } catch (err) {
    console.error('[DB] Lỗi khởi tạo default workspace:', err);
  }

  // Bảng settings
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Khởi tạo agent_mapping mặc định nếu chưa có
  try {
    const existingMapping = dbInstance.prepare("SELECT value FROM settings WHERE key = 'agent_mapping'").get();
    if (!existingMapping) {
      const defaultMapping = JSON.stringify({
        PLANNING: 'claude-code',
        IMPLEMENT: 'claude-code',
        TESTING: 'claude-code',
        FIXING: 'claude-code'
      });
      dbInstance.prepare("INSERT INTO settings (key, value) VALUES ('agent_mapping', ?)").run(defaultMapping);
    }
  } catch (err) {
    console.error('[DB] Lỗi khởi tạo default settings:', err);
  }

  return dbInstance;
}

// ==========================================
// JOBS CRUD
// ==========================================
function createJob(jobData) {
  const db = getDb();
  const id = jobData.id || crypto.randomUUID();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, task_code, title, prompt, repo_path, workspace_id, base_branch, worktree_path,
      status, created_at, updated_at, completed_at, runner,
      pipeline_config, current_step, error_message, exit_code,
      summary, priority
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `);

  stmt.run(
    id,
    jobData.task_code || jobData.taskCode || null,
    jobData.title || '',
    jobData.prompt || '',
    jobData.repo_path || '',
    jobData.workspace_id || jobData.workspaceId || null,
    jobData.base_branch || 'main',
    jobData.worktree_path || null,
    jobData.status || 'TO DO',
    jobData.created_at || now,
    jobData.updated_at || now,
    jobData.completed_at || null,
    jobData.runner || null,
    typeof jobData.pipeline_config === 'object' ? JSON.stringify(jobData.pipeline_config) : (jobData.pipeline_config || null),
    jobData.current_step || null,
    jobData.error_message || null,
    jobData.exit_code !== undefined ? jobData.exit_code : null,
    jobData.summary || null,
    jobData.priority !== undefined ? jobData.priority : 0
  );

  return getJobById(id);
}

function getJobById(id) {
  if (!id) return null;
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const exact = stmt.get(id);
  if (exact) return exact;

  // Hỗ trợ tìm kiếm theo prefix ID (short-id như e6b6f051) hoặc task_code (như RSGATE-50)
  try {
    const cleanId = String(id).trim();
    const fuzzyStmt = db.prepare('SELECT * FROM jobs WHERE id LIKE ? OR task_code = ? ORDER BY created_at DESC LIMIT 1');
    const fuzzy = fuzzyStmt.get(`${cleanId}%`, cleanId);
    if (fuzzy) return fuzzy;
  } catch (e) {}

  return null;
}

function updateJob(id, updates) {
  const db = getDb();
  let targetId = id;
  try {
    const resolved = getJobById(id);
    if (resolved && resolved.id) targetId = resolved.id;
  } catch (e) {}
  // Lấy các cột hợp lệ của bảng jobs để tránh lỗi SqliteError: no such column
  let validCols = [];
  try {
    validCols = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
  } catch (e) {}

  const keys = Object.keys(updates).filter(k => k !== 'id' && (validCols.length === 0 || validCols.includes(k)));
  if (keys.length === 0) return getJobById(id);

  const setClauses = [];
  const values = [];
  for (const key of keys) {
    setClauses.push(`${key} = ?`);
    let val = updates[key];
    if (typeof val === 'object' && val !== null) {
      val = JSON.stringify(val);
    }
    values.push(val);
  }

  if (!keys.includes('updated_at')) {
    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
  }

  values.push(targetId);

  const sql = `UPDATE jobs SET ${setClauses.join(', ')} WHERE id = ?`;
  const stmt = db.prepare(sql);
  stmt.run(...values);

  return getJobById(targetId);
}

function listJobs(filter = {}) {
  const db = getDb();
  const whereClauses = [];
  const params = [];

  if (filter.status) {
    whereClauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.runner) {
    whereClauses.push('runner = ?');
    params.push(filter.runner);
  }

  let sql = 'SELECT * FROM jobs';
  if (whereClauses.length > 0) {
    sql += ' WHERE ' + whereClauses.join(' AND ');
  }
  sql += ' ORDER BY priority DESC, created_at DESC';

  if (filter.limit) {
    sql += ' LIMIT ?';
    params.push(Number(filter.limit));
  }
  if (filter.offset) {
    sql += ' OFFSET ?';
    params.push(Number(filter.offset));
  }

  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

function deleteJob(id) {
  const db = getDb();
  const job = getJobById(id);
  if (!job) {
    return { success: false, error: 'Task không tồn tại' };
  }
  const allowedStatuses = ['TO DO', 'DONE', 'CANCELLED', 'FAILED', 'ARCHIVED'];
  if (!allowedStatuses.includes(job.status)) {
    return {
      success: false,
      error: `Chỉ cho phép xóa task khi ở trạng thái: ${allowedStatuses.join(', ')}. Trạng thái hiện tại: "${job.status}"`
    };
  }
  // Hard delete sạch trong DB SQLite với DatabaseSync tuần tự, cascade bảng con
  // TUYỆT ĐỐI KHÔNG xóa file hoặc thư mục trên ổ đĩa để đảm bảo lưu vết tài liệu
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM questions WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM evidence WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM dual_plans WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM steps WHERE job_id = ?').run(id);
    const stmt = db.prepare('DELETE FROM jobs WHERE id = ?');
    const result = stmt.run(id);
    db.exec('COMMIT');
    return { success: result.changes > 0, id };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (rollbackErr) {}
    throw err;
  }
}

function archiveJob(id) {
  const job = getJobById(id);
  if (!job) {
    return { success: false, error: 'Task không tồn tại' };
  }
  const newStatus = job.status === 'ARCHIVED' ? 'TO DO' : 'ARCHIVED';
  const updated = updateJobStatus(id, newStatus);
  return { success: true, status: newStatus, job: updated };
}

function updateJobStatus(id, newStatus) {
  const db = getDb();
  const job = getJobById(id);
  if (!job) return null;
  const now = new Date().toISOString();
  const updates = {
    status: newStatus,
    updated_at: now
  };
  if (['DONE', 'CANCELLED', 'FAILED'].includes(newStatus)) {
    updates.completed_at = now;
  }
  return updateJob(id, updates);
}

// ==========================================
// STEPS CRUD
// ==========================================
function createStep(stepData) {
  const db = getDb();
  const id = stepData.id || crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO steps (
      id, job_id, step_index, step_type, runner, status,
      started_at, finished_at, stdout, stderr, exit_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    stepData.job_id,
    stepData.step_index !== undefined ? stepData.step_index : 0,
    stepData.step_type || '',
    stepData.runner || null,
    stepData.status || 'PENDING',
    stepData.started_at || null,
    stepData.finished_at || null,
    stepData.stdout || '',
    stepData.stderr || '',
    stepData.exit_code !== undefined ? stepData.exit_code : null
  );

  const getStmt = db.prepare('SELECT * FROM steps WHERE id = ?');
  return getStmt.get(id);
}

function updateStep(id, updates) {
  const db = getDb();
  const keys = Object.keys(updates).filter(k => k !== 'id');
  if (keys.length === 0) {
    const getStmt = db.prepare('SELECT * FROM steps WHERE id = ?');
    return getStmt.get(id);
  }

  const setClauses = [];
  const values = [];

  for (const key of keys) {
    setClauses.push(`${key} = ?`);
    values.push(updates[key]);
  }

  values.push(id);

  const sql = `UPDATE steps SET ${setClauses.join(', ')} WHERE id = ?`;
  const stmt = db.prepare(sql);
  stmt.run(...values);

  const getStmt = db.prepare('SELECT * FROM steps WHERE id = ?');
  return getStmt.get(id);
}

function getStepsByJobId(jobId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM steps WHERE job_id = ? ORDER BY step_index ASC');
  return stmt.all(jobId);
}

// ==========================================
// DUAL PLANS CRUD
// ==========================================
function saveDualPlan(planData) {
  const db = getDb();
  const id = planData.id || crypto.randomUUID();
  const now = new Date().toISOString();

  const devPlanStr = typeof planData.dev_plan === 'object' ? JSON.stringify(planData.dev_plan) : (planData.dev_plan || '');
  const testPlanStr = typeof planData.test_plan === 'object' ? JSON.stringify(planData.test_plan) : (planData.test_plan || '');

  const stmt = db.prepare(`
    INSERT INTO dual_plans (
      id, job_id, dev_plan, test_plan, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    planData.job_id,
    devPlanStr,
    testPlanStr,
    planData.status || 'DRAFT',
    planData.created_at || now,
    planData.updated_at || now
  );

  return getDualPlanByJobId(planData.job_id);
}

function getDualPlanByJobId(jobId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM dual_plans WHERE job_id = ? ORDER BY created_at DESC LIMIT 1');
  return stmt.get(jobId) || null;
}

function updateDualPlan(jobId, updates) {
  const db = getDb();
  const keys = Object.keys(updates).filter(k => k !== 'job_id' && k !== 'id');
  if (keys.length === 0) return getDualPlanByJobId(jobId);

  const setClauses = [];
  const values = [];

  for (const key of keys) {
    setClauses.push(`${key} = ?`);
    let val = updates[key];
    if (typeof val === 'object' && val !== null) {
      val = JSON.stringify(val);
    }
    values.push(val);
  }

  if (!keys.includes('updated_at')) {
    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
  }

  values.push(jobId);

  const sql = `UPDATE dual_plans SET ${setClauses.join(', ')} WHERE job_id = ?`;
  const stmt = db.prepare(sql);
  stmt.run(...values);

  return getDualPlanByJobId(jobId);
}

// ==========================================
// EVIDENCE CRUD
// ==========================================
function addEvidence(evidenceData) {
  const db = getDb();
  const id = evidenceData.id || crypto.randomUUID();
  const now = new Date().toISOString();

  const dataStr = typeof evidenceData.data === 'object' ? JSON.stringify(evidenceData.data) : (evidenceData.data || '');

  const stmt = db.prepare(`
    INSERT INTO evidence (
      id, job_id, type, data, verdict, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    evidenceData.job_id,
    evidenceData.type || 'TEST_RUN',
    dataStr,
    evidenceData.verdict || 'PENDING',
    evidenceData.created_at || now
  );

  const getStmt = db.prepare('SELECT * FROM evidence WHERE id = ?');
  return getStmt.get(id);
}

function getEvidenceByJobId(jobId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM evidence WHERE job_id = ? ORDER BY created_at ASC');
  const rows = stmt.all(jobId);
  return rows.map(r => {
    let parsed = {};
    try {
      if (r.data && typeof r.data === 'string' && r.data.trim().startsWith('{')) {
        parsed = JSON.parse(r.data);
      }
    } catch (e) {}
    return {
      ...r,
      ...parsed,
      id: r.id,
      job_id: r.job_id,
      type: r.type,
      verdict: r.verdict === 'FAIL' ? 'FAIL' : 'PASS',
      status: parsed.status || (r.verdict === 'FAIL' ? 'FAIL' : 'PASSED'),
      file_path: parsed.file_path || (r.type === 'UI_SCREENSHOT' ? `/evidence/${r.id}.png` : null),
      url: parsed.url || parsed.file_path || (r.type === 'UI_SCREENSHOT' ? `/evidence/${r.id}.png` : null)
    };
  });
}
function deleteEvidence(id) {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM evidence WHERE id = ?');
  const result = stmt.run(id);
  return { success: result.changes > 0, id };
}

function deleteEvidenceByJobAndFile(jobId, filename) {
  const db = getDb();
  const safeFilename = path.basename(filename);
  const pattern = `%${safeFilename}%`;
  const stmt = db.prepare(`
    DELETE FROM evidence
    WHERE job_id = ?
      AND (
        id = ?
        OR data LIKE ?
        OR id LIKE ?
      )
  `);
  const result = stmt.run(jobId, safeFilename, pattern, pattern);
  return { success: result.changes > 0, changes: result.changes };
}


// ==========================================
// QUESTIONS CRUD
// ==========================================
function addQuestion(qData) {
  const db = getDb();
  const id = qData.id || crypto.randomUUID();
  const now = new Date().toISOString();

  const optionsStr = typeof qData.options === 'object' ? JSON.stringify(qData.options) : (qData.options || null);

  const stmt = db.prepare(`
    INSERT INTO questions (
      id, job_id, question, options, answer, status, created_at, answered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    qData.job_id,
    qData.question || '',
    optionsStr,
    qData.answer || null,
    qData.status || 'PENDING',
    qData.created_at || now,
    qData.answered_at || null
  );

  const getStmt = db.prepare('SELECT * FROM questions WHERE id = ?');
  return getStmt.get(id);
}

function getPendingQuestionByJobId(jobId) {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM questions WHERE job_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1");
  return stmt.get(jobId) || null;
}

function answerQuestion(questionId, answer) {
  const db = getDb();
  const now = new Date().toISOString();
  const answerStr = typeof answer === 'object' ? JSON.stringify(answer) : String(answer);

  const stmt = db.prepare(`
    UPDATE questions
    SET answer = ?, status = 'ANSWERED', answered_at = ?
    WHERE id = ?
  `);
  stmt.run(answerStr, now, questionId);

  const getStmt = db.prepare('SELECT * FROM questions WHERE id = ?');
  return getStmt.get(questionId);
}

function getQuestionsByJobId(jobId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM questions WHERE job_id = ? ORDER BY created_at ASC');
  return stmt.all(jobId);
}

// ==========================================
// RUNNER CONFIGS CRUD
// ==========================================
function upsertRunnerConfig(runnerName, configData) {
  const db = getDb();
  const existing = getRunnerConfig(runnerName);
  const now = new Date().toISOString();

  const defaultArgsStr = typeof configData.default_args === 'object' ? JSON.stringify(configData.default_args) : (configData.default_args || '');

  if (existing) {
    const stmt = db.prepare(`
      UPDATE runner_configs
      SET enabled = ?, path = ?, default_args = ?, updated_at = ?
      WHERE runner_name = ?
    `);
    stmt.run(
      configData.enabled !== undefined ? (configData.enabled ? 1 : 0) : existing.enabled,
      configData.path !== undefined ? configData.path : existing.path,
      defaultArgsStr !== undefined ? defaultArgsStr : existing.default_args,
      now,
      runnerName
    );
  } else {
    const id = configData.id || crypto.randomUUID();
    const stmt = db.prepare(`
      INSERT INTO runner_configs (
        id, runner_name, enabled, path, default_args, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      runnerName,
      configData.enabled !== undefined ? (configData.enabled ? 1 : 0) : 1,
      configData.path || null,
      defaultArgsStr,
      now,
      now
    );
  }

  return getRunnerConfig(runnerName);
}

function getRunnerConfigs() {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM runner_configs ORDER BY runner_name ASC');
  return stmt.all();
}

function getRunnerConfig(runnerName) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM runner_configs WHERE runner_name = ?');
  return stmt.get(runnerName) || null;
}

// ==========================================
// WORKSPACES CRUD
// ==========================================
function listWorkspaces() {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM workspaces ORDER BY is_default DESC, created_at ASC');
  return stmt.all();
}

function getWorkspaceById(id) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM workspaces WHERE id = ?');
  return stmt.get(id) || null;
}

function createWorkspace({ name, path: wsPath, features_dir }) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const resolvedPath = path.resolve(wsPath);
  const resolvedName = name || path.basename(resolvedPath) || 'Workspace';
  const resolvedFeaturesDir = features_dir || 'docs/features';

  const stmt = db.prepare(`
    INSERT INTO workspaces (id, name, path, features_dir, is_default, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `);
  stmt.run(id, resolvedName, resolvedPath, resolvedFeaturesDir, now);
  return getWorkspaceById(id);
}

function updateWorkspace(id, updates) {
  const db = getDb();
  const current = getWorkspaceById(id);
  if (!current) return null;
  
  const newName = updates.name !== undefined ? updates.name : current.name;
  const newPath = updates.path !== undefined ? path.resolve(updates.path) : current.path;
  const newFeaturesDir = updates.features_dir !== undefined ? updates.features_dir : current.features_dir;
  const newIsDefault = updates.is_default !== undefined ? updates.is_default : current.is_default;

  const stmt = db.prepare(`
    UPDATE workspaces 
    SET name = ?, path = ?, features_dir = ?, is_default = ?
    WHERE id = ?
  `);
  stmt.run(newName, newPath, newFeaturesDir, newIsDefault, id);
  return getWorkspaceById(id);
}

function setDefaultWorkspace(id) {
  const db = getDb();
  const ws = getWorkspaceById(id);
  if (!ws) return null;
  
  // Set all to 0
  db.prepare('UPDATE workspaces SET is_default = 0').run();
  
  // Set the specified to 1
  db.prepare('UPDATE workspaces SET is_default = 1 WHERE id = ?').run(id);
  
  return getWorkspaceById(id);
}

function deleteWorkspace(id) {
  const db = getDb();
  const ws = getWorkspaceById(id);
  if (!ws) {
    return { success: false, error: 'Workspace không tồn tại' };
  }
  if (ws.is_default) {
    return { success: false, error: 'Không thể xóa workspace mặc định' };
  }
  const stmt = db.prepare('DELETE FROM workspaces WHERE id = ?');
  const result = stmt.run(id);
  return { success: result.changes > 0, id };
}

// ==========================================
// SETTINGS CRUD
// ==========================================
function getSetting(key, def = null) {
  const db = getDb();
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get(key);
  if (!row) return def;
  try {
    return JSON.parse(row.value);
  } catch (e) {
    return row.value;
  }
}

function setSetting(key, val) {
  const db = getDb();
  const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
  const stmt = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, strVal);
  return getSetting(key);
}

module.exports = {
  initDb,
  getDb,
  // Jobs
  createJob,
  getJobById,
  updateJob,
  listJobs,
  deleteJob,
  archiveJob,
  updateJobStatus,
  listWorkspaces,
  getWorkspaceById,
  createWorkspace,
  deleteWorkspace,
  updateWorkspace,
  setDefaultWorkspace,
  // Settings
  getSetting,
  setSetting,
  // Steps
  createStep,
  updateStep,
  getStepsByJobId,
  // DualPlans
  saveDualPlan,
  getDualPlanByJobId,
  updateDualPlan,
  // Evidence
  addEvidence,
  createEvidence: addEvidence,
  getEvidenceByJobId,
  deleteEvidence,
  deleteEvidenceByJobAndFile,
  deleteEvidenceFile: deleteEvidenceByJobAndFile,
  // Questions
  addQuestion,
  getPendingQuestionByJobId,
  answerQuestion,
  getQuestionsByJobId,
  // RunnerConfigs
  upsertRunnerConfig,
  getRunnerConfigs,
  getRunnerConfig
};
