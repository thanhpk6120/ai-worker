/**
 * tests/stepScopeAndAiVision.test.js
 * Kiểm thử kiểm soát scope từng step, cơ chế AI Vision verifier (không dùng OCR),
 * luồng FIXING (had_fixing) và hiển thị SystemOne theo từng task.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// PHẢI set DB_PATH TRƯỚC mọi require để không ghi vào DB production ai-worker.sqlite
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scope-db-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-scope.sqlite');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/storage/db');
const { verifyImageWithAI, getMimeType } = require('../src/verification/aiVisionVerifier');
const { PromptTemplateManager } = require('../src/runners/promptTemplateManager');

test('1. Kiểm soát Scope trong Prompt Templates: không làm thừa', () => {
  const ptm = new PromptTemplateManager();

  // PLANNING: chỉ phân tích yêu cầu + code hiện tại, lập dual plan & verify plan
  const planTpl = ptm.getTemplate('planning');
  assert.match(planTpl, /QUY TẮC PHẠM VI BƯỚC PLANNING/i);
  assert.match(planTpl, /CHỈ PHÂN TÍCH YÊU CẦU & MÃ NGUỒN HIỆN TẠI/i);
  assert.match(planTpl, /TUYỆT ĐỐI CẤM SỬA MÃ NGUỒN/i);

  // IMPLEMENT: chỉ sửa code và unittest toàn bộ hàm/class liên quan, cấm tạo evidence
  const impTpl = ptm.getTemplate('implement');
  assert.match(impTpl, /CHỈ SỬA CODE VÀ UNITTEST TOÀN BỘ NHỮNG HÀM, CLASS, BIẾN LIÊN QUAN ĐẾN THAY ĐỔI/i);
  assert.match(impTpl, /TUYỆT ĐỐI KHÔNG TẠO EVIDENCE/i);

  // TESTING: chạy test theo test plan, thu thập evidence, không cần verify ở bước này
  const testTpl = ptm.getTemplate('testing');
  assert.match(testTpl, /THU THẬP ĐẦY ĐỦ EVIDENCE THEO ĐÚNG TEST PLAN — KHÔNG CẦN VERIFY Ở BƯỚC NÀY/i);
  assert.match(testTpl, /Agent KHÔNG CẦN tự verify ở bước này/i);

  // FIXING: chỉ fix lỗi theo đúng VERIFY báo, unittest phần đã fix, chuyển lại VERIFY
  const fixTpl = ptm.getTemplate('fixing');
  assert.match(fixTpl, /CHỈ FIX LỖI THEO ĐÚNG VERIFY ĐÃ BÁO/i);
  assert.match(fixTpl, /UNITTEST ĐÚNG PHẦN ĐÃ FIX/i);
  assert.match(fixTpl, /chuyển trạng thái sang \[VERIFY\] đối soát lại/i);
});

test('2. AI Vision Verifier: hỗ trợ MIME type và bắt lỗi file không tồn tại / rỗng', async () => {
  assert.equal(getMimeType('test.png'), 'image/png');
  assert.equal(getMimeType('test.jpg'), 'image/jpeg');
  assert.equal(getMimeType('test.jpeg'), 'image/jpeg');
  assert.equal(getMimeType('test.webp'), 'image/webp');

  // File không tồn tại
  const resMissing = await verifyImageWithAI({
    imagePath: path.join(os.tmpdir(), 'non_existent_img_12345.png'),
    expectedCriteria: 'Test'
  });
  assert.equal(resMissing.passed, false);
  assert.match(resMissing.reason, /không tồn tại/i);

  // File rỗng
  const tmpEmpty = path.join(os.tmpdir(), 'empty_img_test.png');
  fs.writeFileSync(tmpEmpty, Buffer.alloc(10));
  try {
    const resEmpty = await verifyImageWithAI({
      imagePath: tmpEmpty,
      expectedCriteria: 'Test'
    });
    assert.equal(resEmpty.passed, false);
    assert.match(resEmpty.reason, /rỗng hoặc dung lượng quá nhỏ/i);
  } finally {
    try { fs.unlinkSync(tmpEmpty); } catch (e) {}
  }
});

test('3. Bảng jobs trong DB: tự động hỗ trợ cột had_fixing', () => {
  const testJobId = 'test-fixing-col-' + Date.now();
  const created = db.createJob({
    id: testJobId,
    task_code: 'TASK-FIXING-TEST',
    title: 'Test Had Fixing Column',
    status: 'TO DO'
  });

  assert.equal(Number(created.had_fixing || 0), 0);

  // Cập nhật sang FIXING kèm had_fixing = 1
  const updated = db.updateJob(testJobId, {
    status: 'FIXING',
    current_step: 'FIXING',
    had_fixing: 1
  });
  assert.equal(Number(updated.had_fixing), 1);

  // Chuyển sang VERIFY hoặc DONE thì had_fixing vẫn giữ = 1
  const completed = db.updateJob(testJobId, {
    status: 'DONE',
    current_step: 'DONE'
  });
  assert.equal(Number(completed.had_fixing), 1);

  // Dọn dẹp
  db.deleteJob(testJobId);
});

test('4. Giao diện Frontend: Đã loại bỏ SystemOne CHƯA GỌI chung và badge trên thẻ card', () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.equal(html.includes('id="systemOneBadgeWrap"'), false, 'Không còn badge SystemOne chung trên Header');
  assert.match(html, /id="activeJobSystemOneBadge" class="hidden/i, 'activeJobSystemOneBadge mặc định ẩn');

  const appJs = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  assert.equal(appJs.includes('${soBadge}'), false, 'Thẻ card không còn chứa ${soBadge}');
  assert.match(appJs, /hasTouchedFixing = status === 'FIXING' \|\|.*had_fixing/i, 'Stepper nhận diện had_fixing');
});

test('5. verifyTaskEvidenceAsync: chấp nhận NOT VERIFY ban đầu và fail-closed khi thẩm định', async () => {
  const { verifyTaskEvidenceAsync } = require('../src/server');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-async-ev-'));
  const fDir = path.join(tmpDir, 'feature');
  const eDir = path.join(fDir, 'evidence');
  fs.mkdirSync(eDir, { recursive: true });

  try {
    // Tạo 1 file log và 1 file json hợp lệ
    fs.writeFileSync(path.join(eDir, '01_test_execution.log'), 'npm test passed 1 test\n');
    fs.writeFileSync(path.join(eDir, '02_api.json'), JSON.stringify({ method: 'GET', url: 'http://localhost:8080/api/v1/orders', responseStatus: 200, body: [{ id: 1 }] }));
    fs.writeFileSync(path.join(eDir, '05_service_runtime.log'), 'Server listening on port 8080\nGET /api/v1/orders 200 OK 8ms\nrequest received response sent status 200\n');
    // metadata để status là "NOT VERIFY"
    const meta = {
      taskCode: 'TEST-01',
      status: 'NOT VERIFY',
      tests: [
        { id: 'TC-01', name: 'Log Test', status: 'NOT VERIFY', evidence: ['01_test_execution.log', '05_service_runtime.log'] },
        { id: 'TC-02', name: 'API Test', status: 'NOT VERIFY', evidence: ['02_api.json'] }
      ]
    };
    fs.writeFileSync(path.join(eDir, 'metadata.json'), JSON.stringify(meta, null, 2));

    // Chạy verifyTaskEvidenceAsync (skipAiVision = true vì không có ảnh UI)
    const res = await verifyTaskEvidenceAsync({
      jobId: 'test-async-job',
      evidenceDir: eDir,
      featureDir: fDir,
      taskCode: 'TEST-01',
      emit: () => {},
      skipAiVision: true
    });

    assert.equal(res.failed, false, 'NOT VERIFY ban đầu không được bị coi là badTest');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test.after(() => {
  if (TMP_DB_DIR) {
    try { fs.rmSync(TMP_DB_DIR, { recursive: true, force: true }); } catch (e) {}
  }
});
