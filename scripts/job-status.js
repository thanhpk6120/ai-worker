/**
 * scripts/job-status.js
 * In trang thai 1 job: status, step, danh sach step gan nhat, error.
 * Dung: node scripts/job-status.js <jobId> [soStep]
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const jobId = process.argv[2] || 'bd88ae0a-da46-4d35-af4e-49252e16dade';
const limit = Number(process.argv[3] || 6);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'ai-worker.sqlite');

const db = new DatabaseSync(DB_PATH);
const j = db.prepare('SELECT id, task_code, status, current_step, error_message, gate_result, pipeline_config, updated_at FROM jobs WHERE id=?').get(jobId);
if (!j) { console.log('job khong ton tai:', jobId); process.exit(1); }

const fmt = (ms) => {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

console.log(`=== ${new Date().toISOString()} ===`);
console.log(`task   : ${j.task_code} (${j.id})`);
console.log(`status : ${j.status} / ${j.current_step}`);
console.log(`config : ${j.pipeline_config}`);
if (j.error_message) console.log(`error  : ${j.error_message}`);
if (j.gate_result) console.log(`gate   : ${j.gate_result}`);

const steps = db.prepare('SELECT step_index, step_type, status, started_at, finished_at, exit_code FROM steps WHERE job_id=? ORDER BY started_at').all(jobId);
console.log(`steps  : ${steps.length} (hien ${limit} gan nhat)`);
for (const s of steps.slice(-limit)) {
  const dur = s.finished_at ? fmt(Date.parse(s.finished_at) - Date.parse(s.started_at)) : `${fmt(Date.now() - Date.parse(s.started_at))}*`;
  console.log(`  #${String(s.step_index).padStart(2)} ${String(s.step_type).padEnd(10)} ${String(s.status).padEnd(12)} ${dur.padEnd(10)} exit=${s.exit_code}  ${s.started_at}`);
}
