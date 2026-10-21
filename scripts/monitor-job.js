/**
 * scripts/monitor-job.js
 * Theo doi 1 job ai-worker: in cac moc quan trong (doi step, quick cap,
 * repeat-check, timeout, fixgate) theo thoi gian thuc.
 *
 * Dung: node scripts/monitor-job.js <jobId> [soPhut]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');

const jobId = process.argv[2] || 'bd88ae0a-da46-4d35-af4e-49252e16dade';
const maxMinutes = Number(process.argv[3] || 180);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'ai-worker.sqlite');
const LOG_PATH = path.join(__dirname, '..', 'logs', `${jobId}.log`);

const db = new DatabaseSync(DB_PATH);
const deadline = Date.now() + maxMinutes * 60 * 1000;

const KEY_PATTERNS = [
  /\[SYSTEMONE-TRIAGE\]/,
  /\[SYSTEMONE-FIXGATE\]/,
  /\[REPEAT-CHECK\]/,
  /\[TIMEOUT\]/,
  /\[IMPLEMENT\]\s+(Hoan tat|Hoàn tất|FAILED)/,
  /\[IMPLEMENT-FAILED\]/,
  /\[FIXING-FAILED\]/,
  /\[FIXING-RETRY\]/,
  /\[IMPLEMENT\]/,
  /\[RATE-LIMIT\]/,
  /\[PIPELINE-START\]/,
  /\[PIPELINE-SKIP\]/
];

// Bat dau TAI CUOI file => KHONG replay log cu (de doc nham su kien cua luan chay truoc).
let lastOffset = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH).size : 0;

function readNewLog() {
  if (!fs.existsSync(LOG_PATH)) return '';
  const size = fs.statSync(LOG_PATH).size;
  if (size < lastOffset) lastOffset = 0; // log bị truncate/rotate
  if (size === lastOffset) return '';
  const fd = fs.openSync(LOG_PATH, 'r');
  const buf = Buffer.alloc(size - lastOffset);
  fs.readSync(fd, buf, 0, buf.length, lastOffset);
  fs.closeSync(fd);
  lastOffset = size;
  return buf.toString('utf8').replace(/\u0000/g, '');
}

function jobRow() {
  return db.prepare('SELECT status, current_step, error_message, gate_result, updated_at FROM jobs WHERE id=?').get(jobId);
}

function stepRows() {
  return db.prepare('SELECT step_index, step_type, status, started_at, finished_at, exit_code FROM steps WHERE job_id=? ORDER BY started_at').all(jobId);
}

function fmtDuration(ms) {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let tick = 0;
const timer = setInterval(() => {
  tick += 1;
  const chunk = readNewLog();
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    if (KEY_PATTERNS.some((re) => re.test(line))) {
      console.log(`[${new Date().toISOString()}] ${line.slice(0, 400)}`);
    }
  }

  const row = jobRow();
  if (!row) { console.log('[MONITOR] job khong ton tai'); clearInterval(timer); return; }
  if (row.status !== lastStatus || row.current_step !== lastStep) {
    console.log(`[${new Date().toISOString()}] === STATUS ${lastStatus || '-'} -> ${row.status} | step ${lastStep || '-'} -> ${row.current_step} ===`);
    lastStatus = row.status;
    lastStep = row.current_step;
  }
  if (tick % 10 === 0) {
    const steps = stepRows();
    const last = steps[steps.length - 1];
    const dur = last && last.finished_at ? Date.parse(last.finished_at) - Date.parse(last.started_at) : (Date.now() - (last ? Date.parse(last.started_at) : Date.now()));
    console.log(`[${new Date().toISOString()}] --- ${row.status}/${row.current_step} | steps=${steps.length} | last=${last ? `${last.step_type}#${last.step_index}:${last.status}` : '-'} (${fmtDuration(dur)})`);
  }

  const terminal = ['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(row.status);
  if (terminal) {
    console.log(`[${new Date().toISOString()}] === TERMINAL ${row.status} ===`);
    console.log(`error_message: ${row.error_message || '(null)'}`);
    console.log(`gate_result  : ${row.gate_result || '(null)'}`);
    console.log('--- STEPS ---');
    for (const s of stepRows()) {
      const d = s.finished_at ? fmtDuration(Date.parse(s.finished_at) - Date.parse(s.started_at)) : '-';
      console.log(`  #${String(s.step_index).padStart(2)} ${String(s.step_type).padEnd(10)} ${String(s.status).padEnd(12)} ${d.padEnd(10)} exit=${s.exit_code}`);
    }
    clearInterval(timer);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.log(`[${new Date().toISOString()}] === TIMEOUT MONITOR sau ${maxMinutes} phut, job van ${row.status}/${row.current_step} ===`);
    clearInterval(timer);
    process.exit(0);
  }
}, 3000);

console.log(`[MONITOR] Bat dau theo doi job ${jobId} (toi da ${maxMinutes} phut). DB=${DB_PATH}`);
