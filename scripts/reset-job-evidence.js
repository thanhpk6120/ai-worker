/**
 * scripts/reset-job-evidence.js
 * Reset 1 job về TO DO + XOÁ TOÀN BỘ evidence cũ (chuyển vào thùng rác).
 *
 * Dung: node scripts/reset-job-evidence.js <jobId> [--dry]
 *
 * - Dong cac step chua dong -> CANCELLED
 * - Reset pipeline_config (bo failure_history, fix_attempt, deadline, quick track)
 * - Xoa `pipeline_config.implement_status` (gia tri CU tich luy)
 * - Xoa evidence: thu muc `runtime/` + `evidence/metadata.json` cua feature dir
 *   -> chuyen vao THUNG RAC (khong xoa vinh vien)
 * - Xoa marker `.plan_ok.json` (ke hoach phai verify lai tu dau)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const jobId = process.argv[2];
const dry = process.argv.includes('--dry');
if (!jobId) {
  console.log('Dung: node scripts/reset-job-evidence.js <jobId> [--dry]');
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'ai-worker.sqlite');
const db = new DatabaseSync(DB_PATH);

/**
 * Chuyen file/thu muc vao thung rac (Recycle Bin). KHONG xoa vinh vien.
 * @param {string} p
 * @returns {boolean}
 */
function moveToTrash(p) {
  if (!fs.existsSync(p)) return false;
  const full = path.resolve(p).replace(/'/g, "''");
  try {
    if (process.platform === 'win32') {
      const cmd = `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `if ([System.IO.Directory]::Exists('${full}')) { ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${full}', 'OnlyErrorDialogs', 'SendToRecycleBin') } else { ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${full}', 'OnlyErrorDialogs', 'SendToRecycleBin') }`;
      execSync(`powershell.exe -NoProfile -NonInteractive -Command "${cmd}"`, { stdio: 'ignore' });
      return !fs.existsSync(p);
    }
    const trashDir = path.join(path.dirname(p), '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(p, path.join(trashDir, `${path.basename(p)}.${Date.now()}`));
    return true;
  } catch (e) {
    console.warn(`  KHONG move-to-trash duoc ${p}: ${e.message}`);
    return false;
  }
}

const job = db.prepare('SELECT id, task_code, status, current_step, pipeline_config, repo_path FROM jobs WHERE id=?').get(jobId);
if (!job) { console.log('job khong ton tai:', jobId); process.exit(1); }

console.log('=== TRUOC ===');
console.log('task   :', job.task_code);
console.log('status :', job.status, '/', job.current_step);

// ---- Tim feature dir (theo task_code trong repo_path) ------------------------
function findFeatureDir(root, taskCode) {
  if (!root) return null;
  const candidates = [
    path.join(root, 'docs', 'features', taskCode),
    path.join(root, 'features', taskCode),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Quet 1 cap trong docs/features
  const docsFeat = path.join(root, 'docs', 'features');
  if (fs.existsSync(docsFeat)) {
    for (const d of fs.readdirSync(docsFeat)) {
      if (d.toUpperCase() === String(taskCode).toUpperCase()) {
        return path.join(docsFeat, d);
      }
    }
  }
  return null;
}

const featureDir = findFeatureDir(job.repo_path, job.task_code);
console.log('feature:', featureDir || '(khong tim thay)');

const openSteps = db.prepare(
  "SELECT id, step_index, step_type FROM steps WHERE job_id=? AND finished_at IS NULL"
).all(jobId);
console.log('steps chua dong:', openSteps.map((s) => `#${s.step_index} ${s.step_type}`).join(', ') || '(khong co)');

if (dry) {
  console.log('\n--dry: KHONG ghi gi.');
  process.exit(0);
}

// ---- 1. Dong steps ----------------------------------------------------------
const nowIso = new Date().toISOString();
for (const s of openSteps) {
  db.prepare('UPDATE steps SET status=?, finished_at=?, exit_code=? WHERE id=?')
    .run('CANCELLED', nowIso, null, s.id);
  console.log(`  dong step #${s.step_index} ${s.step_type} -> CANCELLED`);
}

// ---- 2. Reset pipeline_config ----------------------------------------------
let pipe = {};
try {
  pipe = typeof job.pipeline_config === 'string'
    ? JSON.parse(job.pipeline_config)
    : (job.pipeline_config || {});
} catch (e) { pipe = {}; }
delete pipe.failure_history;
delete pipe.fix_attempt;
delete pipe.fixAttempt;
delete pipe.deadline_at;
delete pipe.deadlineAt;
delete pipe.pending_started_at;
delete pipe.implement_status;   // gia tri CU tich luy -> phai verify lai
pipe.max_retries = pipe.max_retries || pipe.maxRetries || 3;
pipe.maxRetries = pipe.max_retries;

db.prepare('UPDATE jobs SET status=?, current_step=?, error_message=?, gate_result=?, pipeline_config=?, updated_at=? WHERE id=?')
  .run('TO DO', 'TO DO', null, null, JSON.stringify(pipe), nowIso, jobId);

// ---- 3. Xoa evidence (move to trash) ---------------------------------------
if (featureDir) {
  const targets = [
    path.join(featureDir, 'runtime'),
    path.join(featureDir, 'evidence', 'metadata.json'),
    path.join(featureDir, '.plan_ok.json'),
  ];
  for (const t of targets) {
    if (!fs.existsSync(t)) { console.log('  bo qua (khong ton tai):', t); continue; }
    const ok = moveToTrash(t);
    console.log(`  ${ok ? 'DA XOA (thung rac)' : 'XO THAT BAI'}: ${t}`);
  }
  // Xoa cac file evidence con lai trong evidence/ (truoc metadata.json)
  const evDir = path.join(featureDir, 'evidence');
  if (fs.existsSync(evDir)) {
    for (const f of fs.readdirSync(evDir)) {
      if (f === 'metadata.json') continue;
      const fp = path.join(evDir, f);
      const ok = moveToTrash(fp);
      console.log(`  ${ok ? 'DA XOA (thung rac)' : 'XO THAT BAI'}: ${fp}`);
    }
  }
}

console.log('\n=== SAU ===');
const after = db.prepare('SELECT status, current_step, error_message, pipeline_config FROM jobs WHERE id=?').get(jobId);
console.log('status :', after.status, '/', after.current_step);
console.log('error  :', after.error_message);
console.log('config :', after.pipeline_config);
console.log('\nOK. POST /api/v1/jobs/' + jobId + '/start de chay lai.');
