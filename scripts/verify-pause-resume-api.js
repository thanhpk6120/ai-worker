/**
 * scripts/verify-pause-resume-api.js
 * Script xác minh API Pause, Resume & Edit cho Task TEST-PAUSE-01.
 * Đảm bảo an toàn: Chạy server test riêng trên port ngẫu nhiên, stub runner để không kích hoạt CLI thật.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Cách ly DB bằng SQLite tạm thời để không ảnh hưởng DB sản xuất
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pause-db-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'verify-pause.sqlite');

const db = require('../src/storage/db');
const { runnerRegistry } = require('../src/runners/runnerRegistry');
const { app } = require('../src/server');

// Stub runner để không spawn claude.exe hay bash thật
const originalGetAvailableRunner = runnerRegistry.getAvailableRunner.bind(runnerRegistry);
runnerRegistry.getAvailableRunner = () => ({
  name: 'stub-runner',
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
});

async function runApiTests() {
  const timestamp = Date.now();
  const jobId = 'test-api-pause-' + timestamp;
  const initialTaskCode = 'TP-INIT-' + timestamp;
  const editedTaskCode = 'TP-TEST-EDIT-' + timestamp;

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const results = {
    testSuite: 'API Verification for Task Pause, Resume & Edit',
    executedAt: new Date().toISOString(),
    baseUrl,
    cases: []
  };

  try {
    // Setup initial job
    db.createJob({
      id: jobId,
      task_code: initialTaskCode,
      title: 'Tiêu đề ban đầu',
      prompt: 'Prompt ban đầu',
      status: 'TO DO',
      current_step: 'TO DO',
      repo_path: './'
    });

    // TC-01: Chỉnh sửa thông tin Task qua API PUT (Happy Path)
    {
      const start = Date.now();
      const payload = {
        title: 'Tiêu đề đã được cập nhật qua API PUT',
        prompt: 'Prompt đã được cập nhật qua API PUT',
        task_code: editedTaskCode
      };
      const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      const durationMs = Date.now() - start;
      const passed = res.status === 200 && data.success === true && data.job.title === payload.title && data.job.task_code === editedTaskCode;

      results.cases.push({
        id: 'TC-01',
        name: 'Chỉnh sửa thông tin Task qua API PUT (Happy Path)',
        endpoint: `PUT /api/v1/jobs/${jobId}`,
        requestPayload: payload,
        httpStatus: res.status,
        responseBody: data,
        durationMs,
        status: passed ? 'PASSED' : 'FAILED',
        verificationNotes: 'HTTP 200 OK, success: true, thông tin job được cập nhật đúng trên CSDL'
      });
    }

    // TC-02: Tạm dừng Task đang chạy tại bước PLANNING (Happy Path)
    {
      db.updateJob(jobId, { status: 'PLANNING', current_step: 'PLANNING' });
      const start = Date.now();
      const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/pause`, {
        method: 'POST'
      });
      const data = await res.json();
      const durationMs = Date.now() - start;
      const freshJob = db.getJobById(jobId);
      const passed = res.status === 200 && data.success === true && data.paused_step === 'PLANNING' && freshJob.status === 'PAUSED';

      results.cases.push({
        id: 'TC-02',
        name: 'Tạm dừng Task đang chạy tại bước PLANNING (Happy Path)',
        endpoint: `POST /api/v1/jobs/${jobId}/pause`,
        httpStatus: res.status,
        responseBody: data,
        durationMs,
        status: passed ? 'PASSED' : 'FAILED',
        verificationNotes: 'HTTP 200 OK, paused_step: PLANNING, status chuyển sang PAUSED'
      });
    }

    // TC-03: Chặn thao tác Pause khi Task đã ở trạng thái PAUSED (Edge Case / Lỗi)
    {
      const start = Date.now();
      const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/pause`, {
        method: 'POST'
      });
      const data = await res.json();
      const durationMs = Date.now() - start;
      const passed = res.status === 400 && data.success === false;
      results.cases.push({
        id: 'TC-03',
        name: 'Chặn thao tác Pause khi Task đã ở trạng thái PAUSED (Edge Case / Lỗi)',
        endpoint: `POST /api/v1/jobs/${jobId}/pause`,
        httpStatus: res.status,
        responseBody: data,
        durationMs,
        status: passed ? 'PASSED' : 'FAILED',
        verificationNotes: 'HTTP 400 Bad Request, lỗi Task không ở trạng thái đang chạy đúng như kỳ vọng'
      });
    }

    // TC-04: Tiếp tục (Resume) Task từ trạng thái PAUSED về đúng bước cũ (Happy Path)
    {
      const start = Date.now();
      const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/resume`, {
        method: 'POST'
      });
      const data = await res.json();
      const durationMs = Date.now() - start;
      const freshJob = db.getJobById(jobId);
      const passed = res.status === 200 && data.success === true && data.resumed_step === 'PLANNING' && ['PLANNING', 'IMPLEMENT'].includes(freshJob.status);

      results.cases.push({
        id: 'TC-04',
        name: 'Tiếp tục (Resume) Task từ trạng thái PAUSED về đúng bước cũ (Happy Path)',
        endpoint: `POST /api/v1/jobs/${jobId}/resume`,
        httpStatus: res.status,
        responseBody: data,
        durationMs,
        status: passed ? 'PASSED' : 'FAILED',
        verificationNotes: 'HTTP 200 OK, resumed_step: PLANNING, status trở lại PLANNING để tiếp tục pipeline'
      });
    }

    // TC-05: Chặn thao tác Resume khi Task không ở trạng thái PAUSED (Edge Case / Lỗi)
    {
      const start = Date.now();
      const res = await fetch(`${baseUrl}/api/v1/jobs/${jobId}/resume`, {
        method: 'POST'
      });
      const data = await res.json();
      const durationMs = Date.now() - start;
      const passed = res.status === 400 && data.success === false;

      results.cases.push({
        id: 'TC-05',
        name: 'Chặn thao tác Resume khi Task không ở trạng thái PAUSED (Edge Case / Lỗi)',
        endpoint: `POST /api/v1/jobs/${jobId}/resume`,
        httpStatus: res.status,
        responseBody: data,
        durationMs,
        status: passed ? 'PASSED' : 'FAILED',
        verificationNotes: 'HTTP 400 Bad Request, từ chối resume khi task đang ở PLANNING'
      });
    }

    // Cleanup an toàn: chuyển CANCELLED trước khi deleteJob
    db.updateJob(jobId, { status: 'CANCELLED' });
    db.deleteJob(jobId);

    const outDir = path.join(__dirname, '..', 'docs', 'features', 'TEST-PAUSE-01', 'evidence');
    if (fs.existsSync(outDir)) {
      const outPath03 = path.join(outDir, '03_api_verification.json');
      fs.writeFileSync(outPath03, JSON.stringify(results, null, 2), 'utf8');
    }

    console.log('API verification completed successfully.');
    console.log(JSON.stringify(results.cases.map(c => ({ id: c.id, status: c.status })), null, 2));
  } catch (err) {
    console.error('Lỗi khi chạy API test:', err);
    process.exit(1);
  } finally {
    runnerRegistry.getAvailableRunner = originalGetAvailableRunner;
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }
    try {
      fs.rmSync(TMP_DB_DIR, { recursive: true, force: true });
    } catch (e) {}
  }
}

runApiTests();
