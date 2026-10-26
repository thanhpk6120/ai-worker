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
test('computeJobRuntimeMs: tính tổng thời gian thực tế của mọi lần chạy, trả về 0 nếu chưa chạy', () => {
  const { computeJobRuntimeMs } = require('../src/server');
  const dummyJob = { id: 'test-runtime-dummy', status: 'TO DO' };

  // 1. Chưa từng chạy (chấp nhận 0 hoặc null theo quy chuẩn TASK-PIPELINE-FIX)
  const emptyRes = computeJobRuntimeMs(dummyJob, []);
  assert.ok(emptyRes === 0 || emptyRes === null, 'Chưa chạy phải trả về 0 hoặc null');

  // 2. Chạy 2 steps (ví dụ PLANNING 2000ms và IMPLEMENT 3000ms)
  const steps = [
    {
      id: 1, job_id: dummyJob.id, step_type: 'PLANNING',
      started_at: '2026-10-23T10:00:00.000Z',
      finished_at: '2026-10-23T10:00:02.000Z'
    },
    {
      id: 2, job_id: dummyJob.id, step_type: 'IMPLEMENT',
      started_at: '2026-10-23T10:00:05.000Z',
      finished_at: '2026-10-23T10:00:08.000Z'
    }
  ];
  assert.equal(computeJobRuntimeMs(dummyJob, steps), 5000, 'Tổng thời gian phải là 5000ms');

  // 3. Chạy lại (thêm vòng FIXING sau khi chạy lại)
  steps.push({
    id: 3, job_id: dummyJob.id, step_type: 'FIXING',
    started_at: '2026-10-23T10:05:00.000Z',
    finished_at: '2026-10-23T10:05:04.000Z'
  });
  assert.equal(computeJobRuntimeMs(dummyJob, steps), 9000, 'Chạy lại phải cộng dồn thời gian (5000 + 4000 = 9000ms)');
});

test('verifyTaskEvidence: không đánh FAILED nếu 2 file trùng MD5 thuộc cùng 1 test case', () => {
  const { verifyTaskEvidence } = require('../src/server');
  const taskCode = 'TASK-DUP-SAME-CASE';
  const featDir = path.join(tmpWorkspace, 'docs', 'features', taskCode);
  const evDir = path.join(featDir, 'evidence');
  fs.mkdirSync(evDir, { recursive: true });

  const testPlanContent = `# Test Plan\n- TC-UI-01: UI list (UI_SCREENSHOT)\n`;
  fs.writeFileSync(path.join(featDir, 'test_plan.md'), testPlanContent, 'utf8');

  // Tạo 2 file ảnh PNG có nội dung giống hệt nhau
  const pngDummy = Buffer.alloc(6000, 0xAA);
  fs.writeFileSync(path.join(evDir, '01_ui_list_en.png'), pngDummy);
  fs.writeFileSync(path.join(evDir, '01_ui_list_vi.png'), pngDummy);

  // Metadata khai báo cả 2 file cho CÙNG 1 test case TC-UI-01
  const meta = {
    taskCode,
    verdict: 'PASS',
    tests: [
      {
        id: 'TC-UI-01',
        name: 'UI List',
        status: 'PASSED',
        evidence: ['01_ui_list_en.png', '01_ui_list_vi.png']
      }
    ]
  };
  fs.writeFileSync(path.join(evDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');

  const res = verifyTaskEvidence({
    jobId: 'dummy-verify-job',
    evidenceDir: evDir,
    featureDir: featDir,
    taskCode,
    emit: () => {}
  });

  // Không được coi là failed vì cả 2 thuộc cùng 1 test case (file alias/duplicate cùng case)
  assert.equal(res.failed, false, 'Không được đánh FAILED khi 2 ảnh trùng nội dung thuộc cùng 1 test case');
  assert.equal(res.failedEvidenceFiles.has('01_ui_list_vi.png'), false, 'Không được đưa vào failedEvidenceFiles');
});

test('verifyTaskEvidence: đánh FAILED nếu 2 file trùng MD5 thuộc 2 test case KHÁC NHAU', () => {
  const { verifyTaskEvidence } = require('../src/server');
  const taskCode = 'TASK-DUP-DIFF-CASE';
  const featDir = path.join(tmpWorkspace, 'docs', 'features', taskCode);
  const evDir = path.join(featDir, 'evidence');
  fs.mkdirSync(evDir, { recursive: true });

  const testPlanContent = `# Test Plan\n- TC-UI-01: UI list\n- TC-UI-02: UI detail\n`;
  fs.writeFileSync(path.join(featDir, 'test_plan.md'), testPlanContent, 'utf8');

  const pngDummy = Buffer.alloc(6000, 0xBB);
  fs.writeFileSync(path.join(evDir, '01_list.png'), pngDummy);
  fs.writeFileSync(path.join(evDir, '02_detail.png'), pngDummy);

  // Metadata khai báo 2 file cho 2 test case KHÁC NHAU
  const meta = {
    taskCode,
    verdict: 'PASS',
    tests: [
      { id: 'TC-UI-01', name: 'UI List', status: 'PASSED', evidence: ['01_list.png'] },
      { id: 'TC-UI-02', name: 'UI Detail', status: 'PASSED', evidence: ['02_detail.png'] }
    ]
  };
  fs.writeFileSync(path.join(evDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');

  const res = verifyTaskEvidence({
    jobId: 'dummy-diff-verify-job',
    evidenceDir: evDir,
    featureDir: featDir,
    taskCode,
    emit: () => {}
  });

  // Bắt buộc phải đánh FAILED vì lấy 1 ảnh giả mạo cho 2 test case khác nhau
  assert.equal(res.failed, true, 'Phải đánh FAILED khi 2 ảnh trùng MD5 thuộc 2 test case khác nhau');
  assert.equal(res.failedEvidenceFiles.has('02_detail.png'), true, '02_detail.png phải bị đánh FAILED');
});

test('GET /api/v1/jobs: trả về runtime_ms dạng số cho từng task trong danh sách', async () => {
  const res = await fetch(`${baseUrl}/api/v1/jobs`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.jobs));
  if (data.jobs.length > 0) {
    for (const j of data.jobs) {
      assert.ok(j.runtime_ms === null || typeof j.runtime_ms === 'number', 'Mỗi job trong danh sách phải có trường runtime_ms là number hoặc null');
    }
  }
});
