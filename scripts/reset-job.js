/**
 * scripts/reset-job.js
 * Reset 1 job về trạng thái TO DO de chay lai tu dau (worker da bi kill giua
 * chung, job con "RUNNING" trong DB nhung khong co tien trinh nao).
 *
 * Dung: node scripts/reset-job.js <jobId> [--dry]
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const jobId = process.argv[2];
const dry = process.argv.includes('--dry');
if (!jobId) {
  console.log('Dung: node scripts/reset-job.js <jobId> [--dry]');
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'ai-worker.sqlite');
const db = new DatabaseSync(DB_PATH);

const job = db.prepare('SELECT id, task_code, status, current_step, pipeline_config FROM jobs WHERE id=?').get(jobId);
if (!job) { console.log('job khong ton tai:', jobId); process.exit(1); }

console.log('=== TRUOC ===');
console.log('task   :', job.task_code);
console.log('status :', job.status, '/', job.current_step);
console.log('config :', job.pipeline_config);

const openSteps = db.prepare(
  "SELECT id, step_index, step_type, status, started_at FROM steps WHERE job_id=? AND finished_at IS NULL"
).all(jobId);
console.log('steps chua dong:', openSteps.map((s) => `#${s.step_index} ${s.step_type} ${s.status}`).join(', ') || '(khong co)');

if (dry) {
  console.log('\n--dry: KHONG ghi gi. Dung lai khong co --dry de reset.');
  process.exit(0);
}

const nowIso = new Date().toISOString();
for (const s of openSteps) {
  db.prepare('UPDATE steps SET status=?, finished_at=?, exit_code=? WHERE id=?')
    .run('CANCELLED', nowIso, null, s.id);
  console.log(`  dong step #${s.step_index} ${s.step_type} -> CANCELLED`);
}

// Reset pipeline_config: bo het lich su loi, so vong fix, deadline, quick track.
let pipe = {};
try { pipe = typeof job.pipeline_config === 'string' ? JSON.parse(job.pipeline_config) : (job.pipeline_config || {}); } catch (e) {}
delete pipe.failure_history;
delete pipe.fix_attempt;
delete pipe.fixAttempt;
delete pipe.deadline_at;
delete pipe.deadlineAt;
delete pipe.pending_started_at;

db.prepare('UPDATE jobs SET status=?, current_step=?, error_message=?, gate_result=?, pipeline_config=?, updated_at=? WHERE id=?')
  .run('TO DO', 'TO DO', null, null, JSON.stringify(pipe), nowIso, jobId);

console.log('\n=== SAU ===');
const after = db.prepare('SELECT status, current_step, error_message, pipeline_config FROM jobs WHERE id=?').get(jobId);
console.log('status :', after.status, '/', after.current_step);
console.log('error  :', after.error_message);
console.log('config :', after.pipeline_config);
console.log('\nOK. Bay co the POST /api/v1/jobs/' + jobId + '/start de chay lai.');
