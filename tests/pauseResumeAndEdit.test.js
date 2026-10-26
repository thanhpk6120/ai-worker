/**
 * tests/pauseResumeAndEdit.test.js
 * Kiểm thử toàn diện API Tạm dừng (Pause), Tiếp tục (Resume) và Chỉnh sửa (Edit) Task.
 * Cách ly 100%: Dùng DB tạm thời, port HTTP ngẫu nhiên, stub runner không gọi CLI thật.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// PHẢI set DB_PATH TRƯỚC mọi require để không ghi vào DB production ai-worker.sqlite
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pause-db-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-pause.sqlite');

const db = require('../src/storage/db');
const { runnerRegistry } = require('../src/runners/runnerRegistry');
const { app } = require('../src/server');

// Stub runner để test không kích hoạt Claude Code hay spawn lệnh bash thật
const originalGetAvailableRunner = runnerRegistry.getAvailableRunner.bind(runnerRegistry);
runnerRegistry.getAvailableRunner = () => ({
  name: 'stub-runner',
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
});

describe('Pause, Resume and Edit Task APIs', () => {
  let server;
  let baseUrl;
  let tmpWorkspace;
  const now = Date.now();
  const testJobId = 'test-pause-resume-' + now;
  const initialTaskCode = 'TP-' + now;
  const editedTaskCode = 'TP-EDIT-' + now;

  before(async () => {
    tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'test-pause-ws-'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    // Chuyển status về CANCELLED để db.deleteJob được phép xóa an toàn
    try {
      db.updateJob(testJobId, { status: 'CANCELLED' });
      db.deleteJob(testJobId);
    } catch (e) {}

    // Phục hồi runner
    runnerRegistry.getAvailableRunner = originalGetAvailableRunner;

    // Đóng test server
    if (server && server.close) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Dọn dẹp thư mục tạm
    try {
      fs.rmSync(TMP_DB_DIR, { recursive: true, force: true });
      fs.rmSync(tmpWorkspace, { recursive: true, force: true });
    } catch (e) {}
  });

  test('Khởi tạo job thử nghiệm ở TO DO và sửa thông tin qua PUT', async () => {
    db.createJob({
      id: testJobId,
      task_code: initialTaskCode,
      title: 'Tiêu đề ban đầu',
      prompt: 'Prompt ban đầu',
      status: 'TO DO',
      current_step: 'TO DO',
      repo_path: tmpWorkspace
    });

    const res = await fetch(`${baseUrl}/api/v1/jobs/${testJobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Tiêu đề đã sửa thành công',
        prompt: 'Prompt đã sửa thành công',
        task_code: editedTaskCode
      })
    });

    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.job.title, 'Tiêu đề đã sửa thành công');
    assert.equal(data.job.prompt, 'Prompt đã sửa thành công');
  });

  test('Tạm dừng (Pause) job khi đang ở PLANNING chuyển sang PAUSED', async () => {
    db.updateJob(testJobId, { status: 'PLANNING', current_step: 'PLANNING' });

    const res = await fetch(`${baseUrl}/api/v1/jobs/${testJobId}/pause`, {
      method: 'POST'
    });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.paused_step, 'PLANNING');
    assert.equal(data.job.status, 'PAUSED');

    const fresh = db.getJobById(testJobId);
    assert.equal(fresh.status, 'PAUSED');
  });

  test('Không cho phép Pause khi task đã ở PAUSED', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs/${testJobId}/pause`, {
      method: 'POST'
    });
    assert.equal(res.status, 400);
  });

  test('Tiếp tục (Resume) job từ PAUSED quay lại đúng bước PLANNING', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs/${testJobId}/resume`, {
      method: 'POST'
    });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.resumed_step, 'PLANNING');
    assert.equal(data.job.status, 'PLANNING');

    const fresh = db.getJobById(testJobId);
    assert.ok(['PLANNING', 'IMPLEMENT'].includes(fresh.status), `Status phải là PLANNING hoặc đã chuyển tiếp IMPLEMENT (thực tế: ${fresh.status})`);
  });

  test('Không cho phép Resume khi task không ở trạng thái PAUSED', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs/${testJobId}/resume`, {
      method: 'POST'
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.match(data.error, /Chỉ có thể tiếp tục khi task ở trạng thái PAUSED/);
  });

  test('Không cho phép chỉnh sửa khi task đang trong quá trình thực thi', async () => {
    const res = await fetch(`${baseUrl}/api/v1/jobs/${testJobId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Cố tình sửa khi đang chạy'
      })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.match(data.error, /Không thể chỉnh sửa khi Task đang trong quá trình thực thi/);
  });
});
