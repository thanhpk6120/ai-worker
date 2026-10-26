const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/storage/db');

describe('Pause, Resume and Edit Task APIs', () => {
  const now = Date.now();
  const testJobId = 'test-pause-resume-' + now;
  const initialTaskCode = 'TP-' + now;
  const editedTaskCode = 'TP-EDIT-' + now;

  test('Khởi tạo job thử nghiệm ở TO DO và sửa thông tin qua PUT', async () => {
    db.createJob({
      id: testJobId,
      task_code: initialTaskCode,
      title: 'Tiêu đề ban đầu',
      prompt: 'Prompt ban đầu',
      status: 'TO DO',
      current_step: 'TO DO',
      repo_path: './'
    });

    const res = await fetch(`http://127.0.0.1:3000/api/v1/jobs/${testJobId}`, {
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

    const res = await fetch(`http://127.0.0.1:3000/api/v1/jobs/${testJobId}/pause`, {
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
    const res = await fetch(`http://127.0.0.1:3000/api/v1/jobs/${testJobId}/pause`, {
      method: 'POST'
    });
    assert.equal(res.status, 400);
  });

  test('Tiếp tục (Resume) job từ PAUSED quay lại đúng bước PLANNING', async () => {
    const res = await fetch(`http://127.0.0.1:3000/api/v1/jobs/${testJobId}/resume`, {
      method: 'POST'
    });
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.resumed_step, 'PLANNING');
    assert.equal(data.job.status, 'PLANNING');

    const fresh = db.getJobById(testJobId);
    assert.equal(fresh.status, 'PLANNING');
  });

  test('Không cho phép Resume khi task không ở trạng thái PAUSED', async () => {
    const res = await fetch(`http://127.0.0.1:3000/api/v1/jobs/${testJobId}/resume`, {
      method: 'POST'
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.match(data.error, /Chỉ có thể tiếp tục khi task ở trạng thái PAUSED/);
  });

  test('Không cho phép chỉnh sửa khi task đang trong quá trình thực thi', async () => {
    const res = await fetch(`http://127.0.0.1:3000/api/v1/jobs/${testJobId}`, {
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

    // Dọn dẹp test job
    db.deleteJob(testJobId);
  });
});
