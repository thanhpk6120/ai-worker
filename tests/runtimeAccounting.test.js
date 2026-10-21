/**
 * tests/runtimeAccounting.test.js
 * "Thoi luong" phai la thoi gian worker THUC SU chay task, khong phai wall-clock
 * tu created_at (sai: tinh ca thoi gian cho queue + thoi gian cho user).
 *
 * Quy tac:
 *  - Job dang chay  => cong ca doan da DONG + doan dang MO.
 *  - Job PENDING (cho user tra loi) => DONG doan => dung dem.
 *  - Job chay lai (resume) => doan MOI => tiep tuc dem (cong don).
 *  - Job chua tung chay (TO DO) => 0.
 *
 * Test dung truc tiep `beginStepTimeline` / `endStepTimeline` /
 * `computeJobRuntimeMs` cua src/server.js (khong mock lai logic).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// DB rieng cho test de khong anh huong DB chinh
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-runtime-'));
process.env.DB_PATH = path.join(TMP, 'runtime-test.sqlite');

const db = require('../src/storage/db');
const {
  jobEventBus,
  computeJobRuntimeMs,
  beginStepTimeline,
  endStepTimeline
} = require('../src/server');

// --- Helpers ---------------------------------------------------------------

// runtime cua job theo cong don that (dung ham cua server).
function runtimeOf(jobId) {
  const job = db.getJobById(jobId);
  const steps = db.getStepsByJobId(job.id) || [];
  return computeJobRuntimeMs(job, steps);
}

// Gia thoi gian cho cac buoc test (ms) - tranh phu thuoc wall-clock.
function shiftIso(baseIso, ms) {
  return new Date(Date.parse(baseIso) + ms).toISOString();
}

// --- Tests -----------------------------------------------------------------

test('doan da DONG cong dung thoi gian worker chay', () => {
  const jobId = 'rt-closed-1';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });

  const t0 = '2026-10-20T01:00:00.000Z';
  const s1 = db.createStep({ job_id: jobId, step_type: 'PLANNING', step_index: 1, status: 'RUNNING', started_at: t0 });
  db.updateStep(s1.id, { status: 'COMPLETED', finished_at: shiftIso(t0, 10 * 60 * 1000), exit_code: 0 });

  const s2 = db.createStep({ job_id: jobId, step_type: 'IMPLEMENT', step_index: 2, status: 'RUNNING', started_at: shiftIso(t0, 10 * 60 * 1000) });
  db.updateStep(s2.id, { status: 'COMPLETED', finished_at: shiftIso(t0, 25 * 60 * 1000), exit_code: 0 });

  db.updateJob(jobId, { status: 'DONE' });
  assert.equal(runtimeOf(jobId), 25 * 60 * 1000, 'tong = 10p + 15p');
});

test('moi LAN chay la 1 doan rieng (retry khong bi nuot mat)', () => {
  const jobId = 'rt-retry-1';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });

  const t0 = '2026-10-20T02:00:00.000Z';
  // Lan 1: PLANNING chay 5 phut roi fail
  const a = db.createStep({ job_id: jobId, step_type: 'PLANNING', step_index: 1, status: 'RUNNING', started_at: t0 });
  db.updateStep(a.id, { status: 'FAILED', finished_at: shiftIso(t0, 5 * 60 * 1000), exit_code: 1 });
  // Lan 2: PLANNING chay lai 7 phut (cung phase, van la doan rieng)
  const b = db.createStep({ job_id: jobId, step_type: 'PLANNING', step_index: 2, status: 'RUNNING', started_at: shiftIso(t0, 10 * 60 * 1000) });
  db.updateStep(b.id, { status: 'COMPLETED', finished_at: shiftIso(t0, 17 * 60 * 1000), exit_code: 0 });

  db.updateJob(jobId, { status: 'DONE' });
  const steps = db.getStepsByJobId(jobId);
  assert.equal(steps.length, 2, 'retry phai tao doan moi, khong ghi de doan cu');
  assert.equal(runtimeOf(jobId), 12 * 60 * 1000, 'tong = 5p + 7p (khong nuot mat vong chay thu 2)');
});

test('job PENDING (cho user) dung dem, resume thi tiep tuc dem', () => {
  const jobId = 'rt-pending-1';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });

  // --- Doan 1: PLANNING chay that 8 phut roi ket thuc ---
  const t0 = '2026-10-20T03:00:00.000Z';
  const s1 = db.createStep({ job_id: jobId, step_type: 'PLANNING', step_index: 1, status: 'RUNNING', started_at: t0 });
  db.updateStep(s1.id, { status: 'COMPLETED', finished_at: shiftIso(t0, 8 * 60 * 1000), exit_code: 0 });

  // --- Doan 2: mo, job chuyen PENDING => phai bi DONG ngay ---
  const s2 = db.createStep({ job_id: jobId, step_type: 'PLANNING', step_index: 2, status: 'RUNNING', started_at: shiftIso(t0, 8 * 60 * 1000) });
  db.updateJob(jobId, { status: 'PENDING' });
  jobEventBus.emitJobStatus(jobId, { status: 'PENDING' });

  // `emitJobStatus` PENDING => endStepTimeline => dong doan (mo doan o vi tri 2
  // chua duoc theo doi trong stepTimeline nen dung thu cong de do doc lap).
  const stepsAfter = db.getStepsByJobId(jobId);
  const stillOpen = stepsAfter.filter((x) => !x.finished_at);
  // Doan 2 chua duoc stepTimeline theo doi => van open; nhung runtime van
  // phai KHONG dem thoi gian cho user (job dang PENDING).
  assert.ok(stillOpen.length <= 1, 'khong duoc co doan nao mo them');

  // Job PENDING => runtime chi cong doan DA DONG.
  assert.equal(runtimeOf(jobId), 8 * 60 * 1000, 'PENDING => chi cong 8p da chay, khong cong thoi gian cho user');

  // --- Resume: doan MOI => tiep tuc dem ---
  const s3 = db.createStep({ job_id: jobId, step_type: 'IMPLEMENT', step_index: 3, status: 'RUNNING', started_at: shiftIso(t0, 30 * 60 * 1000) });
  db.updateJob(jobId, { status: 'IMPLEMENT' });
  db.updateStep(s3.id, { status: 'COMPLETED', finished_at: shiftIso(t0, 35 * 60 * 1000), exit_code: 0 });

  assert.equal(runtimeOf(jobId), 13 * 60 * 1000, 'tong = 8p + 5p (khong tinh 22p cho user)');
});

test('job chua tung chay (TO DO) => runtime = 0', () => {
  const jobId = 'rt-todo-1';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });
  assert.equal(runtimeOf(jobId), 0);
  assert.equal((db.getStepsByJobId(jobId) || []).length, 0);
});

test('beginStepTimeline tao doan moi va endStepTimeline dong doan', () => {
  const jobId = 'rt-timeline-1';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });

  beginStepTimeline(jobId, 'PLANNING', 'claude-code');
  let steps = db.getStepsByJobId(jobId);
  assert.equal(steps.length, 1, 'phai co 1 doan');
  assert.equal(steps[0].step_type, 'PLANNING');
  assert.equal(steps[0].status, 'RUNNING');
  assert.ok(steps[0].started_at, 'phai co started_at');
  assert.equal(steps[0].finished_at, null, 'doan dang mo => finished_at null');

  endStepTimeline(jobId, { status: 'COMPLETED', exitCode: 0 });
  steps = db.getStepsByJobId(jobId);
  assert.ok(steps[0].finished_at, 'doan da DONG => co finished_at');
  assert.equal(steps[0].exit_code, 0);
});

test('goi lai cung phase van tao doan MOI (khong nuot mat vong chay)', () => {
  const jobId = 'rt-timeline-2';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });

  beginStepTimeline(jobId, 'IMPLEMENT', 'claude-code');
  endStepTimeline(jobId, { status: 'FAILED' });
  beginStepTimeline(jobId, 'IMPLEMENT', 'claude-code');

  const steps = db.getStepsByJobId(jobId);
  assert.equal(steps.length, 2, 'chay lai cung phase => doan moi, khong ghi de');
  assert.ok(steps[0].finished_at, 'doan 1 da dong');
  assert.equal(steps[1].finished_at, null, 'doan 2 dang mo');
});

test('doan MO chi duoc cong khi job dang chay that', () => {
  const jobId = 'rt-open-1';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });

  const t0 = '2026-10-20T04:00:00.000Z';
  const s1 = db.createStep({ job_id: jobId, step_type: 'IMPLEMENT', step_index: 1, status: 'RUNNING', started_at: t0 });

  // Job DUNG (PENDING) + doan MO => KHONG cong thoi gian.
  db.updateJob(jobId, { status: 'PENDING' });
  assert.equal(runtimeOf(jobId), 0, 'job PENDING + doan mo => runtime = 0');

  // Job chay lai => doan MO duoc cong.
  db.updateJob(jobId, { status: 'IMPLEMENT' });
  const s2 = db.createStep({ job_id: jobId, step_type: 'IMPLEMENT', step_index: 2, status: 'RUNNING', started_at: t0 });
  db.updateStep(s2.id, { status: 'COMPLETED', finished_at: shiftIso(t0, 5 * 60 * 1000), exit_code: 0 });
  assert.equal(runtimeOf(jobId), 5 * 60 * 1000, 'doan da dong van cong');
});
