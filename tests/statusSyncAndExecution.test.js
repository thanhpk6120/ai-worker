/**
 * tests/statusSyncAndExecution.test.js
 * Kiểm thử đồng bộ trạng thái và kích hoạt thực thi bước (IMPLEMENT, TESTING, VERIFY, FIXING)
 * khi thay đổi trạng thái qua API (PATCH /status) và qua Duyệt/Trả lời câu hỏi.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// PHẢI set DB_PATH TRƯỚC mọi require để không ghi vào DB production ai-worker.sqlite
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sync-db-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-sync.sqlite');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const db = require('../src/storage/db');
const { taskQueue } = require('../src/queue/taskQueue');
const { runnerRegistry } = require('../src/runners/runnerRegistry');
const { app, jobEventBus } = require('../src/server');

let tmpWorkspace;
// Stub runner để test không gọi CLI thật
const originalGetAvailableRunner = runnerRegistry.getAvailableRunner.bind(runnerRegistry);
runnerRegistry.getAvailableRunner = () => ({
  name: 'stub-runner',
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
});

let server;
let baseUrl;
const createdJobIds = [];

test.before(async () => {
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sync-ws-'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  for (const id of createdJobIds) {
    taskQueue.cancel(id);
    try { db.deleteJob(id); } catch (e) {}
  }
  for (const j of taskQueue.getRunningJobs()) {
    taskQueue.cancel(j.id);
    try { db.deleteJob(j.id); } catch (e) {}
  }
  runnerRegistry.getAvailableRunner = originalGetAvailableRunner;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpWorkspace) {
    try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }); } catch (e) {}
  }
  if (TMP_DB_DIR) {
    try { fs.rmSync(TMP_DB_DIR, { recursive: true, force: true }); } catch (e) {}
  }
  setTimeout(() => process.exit(0), 100).unref();
});

test('emitJobLog: không bị ReferenceError byteLen khi ghi log stream', () => {
  const dummyJobId = 'test-job-bytelen-' + Date.now();
  assert.doesNotThrow(() => {
    jobEventBus.emitJobLog(dummyJobId, { text: 'Dòng log kiểm tra tính toán byteLen\n' });
  });
});

test('POST /api/v1/jobs/:id/answer: không được phát event status: IMPLEMENT ngay khi vừa trả lời', async () => {
  const jobId = 'test-answer-status-' + Date.now();
  createdJobIds.push(jobId);
  db.createJob({
    id: jobId,
    task_code: 'TASK-ANS-TEST',
    title: 'Test Answer Question',
    repo_path: tmpWorkspace,
    status: 'PENDING',
    current_step: 'PENDING'
  });

  const emittedStatuses = [];
  const onStatus = (data) => {
    emittedStatuses.push(data.status);
  };
  jobEventBus.on(`job:${jobId}:status`, onStatus);

  db.addQuestion({
    job_id: jobId,
    question: 'Bạn muốn triển khai theo kiến trúc nào?',
    options: '[]',
    status: 'PENDING'
  });

  // Gửi request POST /answer
  const reqBody = { answer: 'Kiến trúc Microservices' };
  const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody)
  });
  assert.equal(res.status, 200);

  // Status ngay sau khi ghi nhận câu trả lời phải là PLANNING, không được gán IMPLEMENT trước khi hoàn tất plan
  assert.equal(emittedStatuses[0], 'PLANNING', 'Status đầu tiên được emit phải là PLANNING');
  jobEventBus.off(`job:${jobId}:status`, onStatus);
  taskQueue.cancel(jobId);
});

test('PATCH /api/v1/jobs/:id/status: chuyển sang IMPLEMENT khi job đang enqueued hoặc running', async () => {
  const jobId = 'test-patch-status-' + Date.now();
  createdJobIds.push(jobId);
  db.createJob({
    id: jobId,
    task_code: 'TASK-PATCH-IMP',
    title: 'Test Patch to Implement',
    repo_path: tmpWorkspace,
    status: 'PENDING',
    current_step: 'PENDING'
  });

  // Giả lập job đang trong runningJobs của taskQueue
  const fakeRunning = {
    job: { id: jobId, task_code: 'TASK-PATCH-IMP' },
    runFn: () => new Promise(() => {}),
    priority: 0,
    startTime: Date.now()
  };
  taskQueue.runningJobs.set(jobId, fakeRunning);
  assert.equal(taskQueue.isJobEnqueuedOrRunning(jobId), true);

  // Gọi PATCH status sang IMPLEMENT
  const response = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'IMPLEMENT' })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.job.status, 'IMPLEMENT');
  assert.equal(data.job.current_step, 'IMPLEMENT');

  taskQueue.cancel(jobId);
});

test('PATCH /api/v1/jobs/:id/status: chuyển sang CANCELLED hoặc TO DO phải cancel job trong taskQueue', async () => {
  const jobId = 'test-patch-cancel-' + Date.now();
  createdJobIds.push(jobId);
  db.createJob({
    id: jobId,
    task_code: 'TASK-CANCEL-TEST',
    title: 'Test Cancel Running Job',
    repo_path: tmpWorkspace,
    status: 'TO DO',
    current_step: 'TO DO'
  });

  let cancelledFired = false;
  taskQueue.runningJobs.set(jobId, {
    job: { id: jobId },
    runFn: () => {},
    priority: 0
  });

  taskQueue.once('job:cancel', ({ jobId: cId }) => {
    if (cId === jobId) cancelledFired = true;
  });

  // Gọi PATCH status sang CANCELLED
  const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CANCELLED' })
  });
  assert.equal(res.status, 200);

  assert.equal(taskQueue.isJobEnqueuedOrRunning(jobId), false, 'Job phải bị remove khỏi queue');
  assert.equal(cancelledFired, true, 'Event job:cancel phải được kích hoạt để ngắt tiến trình con');
});

test('PATCH /api/v1/jobs/:id/status: chuyển sang các bước khác (PLANNING, TESTING, VERIFY, FIXING) đều đồng bộ current_step', async () => {
  const steps = ['PLANNING', 'TESTING', 'VERIFY', 'FIXING'];
  for (const step of steps) {
    const jobId = `test-step-${step}-${Date.now()}`;
    createdJobIds.push(jobId);
    db.createJob({
      id: jobId,
      task_code: `TASK-${step}`,
      title: `Test Step ${step}`,
      repo_path: tmpWorkspace,
      status: 'TO DO',
      current_step: 'TO DO'
    });

    const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: step })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.job.status, step, `Status trả về phải là ${step}`);
    assert.equal(data.job.current_step, step, `current_step trả về phải là ${step}`);

    taskQueue.cancel(jobId);
  }
});
