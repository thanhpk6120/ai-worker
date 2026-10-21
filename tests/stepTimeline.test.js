/**
 * tests/stepTimeline.test.js
 * Bang `steps` phai ghi timeline thuoc tung phase (PLANNING/IMPLEMENT/TESTING/
 * FIXING/VERIFY) de do duoc "tai sao task nho lai ton 4 gio".
 *
 * Truoc day chi co 1 step PENDING tao luc tao job va `updateStep` khong co
 * caller nao => khong do duoc thoi gian tung buoc.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// DB rieng cho test de khong anh huong DB chinh
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-steps-'));
process.env.DB_PATH = path.join(TMP, 'steps-test.sqlite');

const db = require('../src/storage/db');

test('createStep ghi step_type + started_at', () => {
  const jobId = 'job-steps-1';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });
  const step = db.createStep({
    job_id: jobId,
    step_type: 'PLANNING',
    step_index: 1,
    status: 'RUNNING',
    runner: 'claude-code',
    started_at: '2026-10-20T01:00:00.000Z'
  });
  assert.ok(step && step.id, 'phai tra step co id');
  assert.equal(step.step_type, 'PLANNING');
  assert.equal(step.status, 'RUNNING');
  assert.equal(step.started_at, '2026-10-20T01:00:00.000Z');
});

test('updateStep ghi finished_at + exit_code + status', () => {
  const jobId = 'job-steps-2';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });
  const step = db.createStep({
    job_id: jobId,
    step_type: 'TESTING',
    step_index: 1,
    status: 'RUNNING',
    started_at: '2026-10-20T01:00:00.000Z'
  });
  const updated = db.updateStep(step.id, {
    status: 'COMPLETED',
    finished_at: '2026-10-20T01:30:00.000Z',
    exit_code: 0
  });
  assert.equal(updated.status, 'COMPLETED');
  assert.equal(updated.finished_at, '2026-10-20T01:30:00.000Z');
  assert.equal(updated.exit_code, 0);
  // Thoi luong doc duoc tu started_at/finished_at
  const dur = Date.parse(updated.finished_at) - Date.parse(updated.started_at);
  assert.equal(dur, 30 * 60 * 1000, 'thoi luong 30 phut phai tinh duoc');
});

test('getStepsByJobId tra ve cac step theo thu tu, moi step co started_at', () => {
  const jobId = 'job-steps-3';
  db.createJob({ id: jobId, title: 'T', prompt: 'p', status: 'TO DO' });
  const phases = ['PLANNING', 'IMPLEMENT', 'TESTING', 'FIXING'];
  phases.forEach((ph, i) => {
    const s = db.createStep({
      job_id: jobId,
      step_type: ph,
      step_index: i + 1,
      status: 'RUNNING',
      started_at: new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString()
    });
    db.updateStep(s.id, {
      status: 'COMPLETED',
      finished_at: new Date(Date.UTC(2026, 9, 20, 1, i + 1)).toISOString(),
      exit_code: 0
    });
  });
  const steps = db.getStepsByJobId(jobId);
  assert.equal(steps.length, 4);
  assert.deepEqual(steps.map((s) => s.step_type), phases);
  assert.ok(steps.every((s) => s.started_at && s.finished_at), 'moi step phai co started_at va finished_at');
  // Tong thoi gian = 4 phase x 1 phut
  const total = steps.reduce((acc, s) => acc + (Date.parse(s.finished_at) - Date.parse(s.started_at)), 0);
  assert.equal(total, 4 * 60 * 1000);
});
