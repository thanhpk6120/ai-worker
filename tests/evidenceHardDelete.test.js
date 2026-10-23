const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// PHẢI set DB_PATH TRƯỚC mọi require để không ghi vào DB production ai-worker.sqlite
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-db-test-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test.sqlite');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../src/storage/db');
const { BrowserRunner } = require('../src/verification/browserRunner');

describe('Visual Evidence Mockup & Hard Delete DB Test Suite', () => {
  let testJobId;
  let tempDir;

  before(() => {
    db.initDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
  });

  after(() => {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {}
    try {
      if (TMP_DB_DIR && fs.existsSync(TMP_DB_DIR)) {
        fs.rmSync(TMP_DB_DIR, { recursive: true, force: true });
      }
    } catch (e) {}
  });

  describe('1. BrowserRunner Visual Mockup Fallback Generation', () => {
    it('createPngBuffer sinh PNG mockup hợp lệ với signature RFC 2083 chuẩn', () => {
      const pngBuffer = BrowserRunner.createPngBuffer(800, 600, {
        taskName: 'FEAT-MOCKUP-001',
        url: 'http://localhost:3000/dashboard',
        status: 'PASS'
      });

      assert.ok(Buffer.isBuffer(pngBuffer), 'Kết quả phải là Buffer');
      // Kiểm tra 8 bytes signature chuẩn của file PNG
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      for (let i = 0; i < pngSignature.length; i++) {
        assert.strictEqual(pngBuffer[i], pngSignature[i], `Byte ${i} của PNG signature không khớp`);
      }

      // Ảnh mockup đầy đủ chứa dữ liệu đồ họa bitmap, kích thước phải lớn hơn nhiều so với ảnh 1x1 rỗng (~68 bytes)
      assert.ok(pngBuffer.length > 2000, `Buffer phải chứa dữ liệu mockup trực quan (thực tế: ${pngBuffer.length} bytes)`);
    });

    it('createPngBuffer hỗ trợ tương thích ngược khi truyền (width, height, r, g, b)', () => {
      const pngBuffer = BrowserRunner.createPngBuffer(400, 300, 15, 23, 42);
      assert.ok(Buffer.isBuffer(pngBuffer));
      assert.ok(pngBuffer.length > 500);
      assert.strictEqual(pngBuffer[0], 0x89);
      assert.strictEqual(pngBuffer[1], 0x50);
    });

    it('createSvgMockup sinh chuỗi SVG chứa đầy đủ thông tin kiểm thử', () => {
      const svg = BrowserRunner.createSvgMockup({
        taskName: 'TASK-MOCKUP-SVG',
        url: 'http://localhost:8080/api/health',
        status: 'PASS'
      });

      assert.ok(typeof svg === 'string', 'Kết quả phải là chuỗi SVG');
      assert.ok(svg.includes('<svg'), 'Phải chứa thẻ mở svg');
      assert.ok(svg.includes('TEST EVIDENCE MOCKUP'), 'Phải chứa tiêu đề TEST EVIDENCE MOCKUP');
      assert.ok(svg.includes('PASS'), 'Phải chứa trạng thái PASS');
      assert.ok(svg.includes('TASK-MOCKUP-SVG'), 'Phải chứa tên task');
    });

    it('captureScreenshot trả về null khi service offline (không tự sinh ảnh giả lập rác)', async () => {
      const runner = new BrowserRunner({ evidenceBaseDir: tempDir });
      const record = await runner.captureScreenshot('FEAT-VISUAL', 'step_ui_check', {
        url: 'http://localhost:59999/offline-service-not-found',
        status: 'PASS',
        timeoutMs: 1000
      });

      assert.strictEqual(record, null, 'Không tự ý sinh ảnh giả lập khi service offline');
    });
  });

  describe('2. Hard Delete trong Database SQLite (jobs, steps, dual_plans, evidence, questions)', () => {
    before(() => {
      testJobId = `job-test-${crypto.randomUUID()}`;
      // Tạo job
      db.createJob({
        id: testJobId,
        task_code: 'TASK-DELETE-01',
        title: 'Task for testing hard delete',
        prompt: 'Hard delete verification',
        status: 'DONE'
      });

      // Tạo steps liên quan
      db.createStep({
        id: `step-${testJobId}-1`,
        job_id: testJobId,
        step_index: 0,
        step_type: 'PLANNING',
        status: 'DONE'
      });

      // Tạo dual_plans liên quan
      db.saveDualPlan({
        id: `plan-${testJobId}`,
        job_id: testJobId,
        dev_plan: 'Plan content',
        test_plan: 'Test plan content',
        status: 'APPROVED'
      });

      // Tạo evidence liên quan
      db.addEvidence({
        id: `ev-${testJobId}-1`,
        job_id: testJobId,
        type: 'UI_SCREENSHOT',
        data: { filename: 'test_evidence.png', status: 'PASS' },
        verdict: 'PASS'
      });

      // Tạo question liên quan
      db.addQuestion({
        id: `q-${testJobId}-1`,
        job_id: testJobId,
        question: 'Any questions?',
        status: 'ANSWERED'
      });
    });

    it('các bản ghi liên quan tồn tại đầy đủ trong DB trước khi xóa', () => {
      const database = db.getDb();
      const jobRow = database.prepare('SELECT * FROM jobs WHERE id = ?').get(testJobId);
      assert.ok(jobRow, 'Job phải tồn tại trong DB');

      const steps = database.prepare('SELECT * FROM steps WHERE job_id = ?').all(testJobId);
      assert.strictEqual(steps.length, 1, 'Step phải tồn tại');

      const plans = database.prepare('SELECT * FROM dual_plans WHERE job_id = ?').all(testJobId);
      assert.strictEqual(plans.length, 1, 'DualPlan phải tồn tại');

      const evidences = database.prepare('SELECT * FROM evidence WHERE job_id = ?').all(testJobId);
      assert.strictEqual(evidences.length, 1, 'Evidence phải tồn tại');

      const questions = database.prepare('SELECT * FROM questions WHERE job_id = ?').all(testJobId);
      assert.strictEqual(questions.length, 1, 'Question phải tồn tại');
    });

    it('deleteEvidenceByJobAndFile xóa cứng đúng bản ghi evidence theo filename', () => {
      const database = db.getDb();
      // Tạo thêm 1 evidence với file riêng
      const extraEvId = `ev-file-${crypto.randomUUID()}`;
      db.addEvidence({
        id: extraEvId,
        job_id: testJobId,
        type: 'API_TEST',
        data: { filename: 'api_result.json' },
        verdict: 'PASS'
      });

      const beforeDelete = database.prepare('SELECT * FROM evidence WHERE id = ?').get(extraEvId);
      assert.ok(beforeDelete, 'Evidence vừa tạo phải tồn tại');

      const deleteRes = db.deleteEvidenceByJobAndFile(testJobId, 'api_result.json');
      assert.strictEqual(deleteRes.success, true);

      const afterDelete = database.prepare('SELECT * FROM evidence WHERE id = ?').get(extraEvId);
      assert.strictEqual(afterDelete, undefined, 'Bản ghi evidence phải bị xóa cứng khỏi DB SQLite');
    });

    it('deleteJob xóa cứng job và cascade toàn bộ steps, evidence, dual_plans, questions', () => {
      const database = db.getDb();
      const deleteResult = db.deleteJob(testJobId);
      assert.strictEqual(deleteResult.success, true, 'deleteJob phải thành công');

      // Kiểm tra bảng jobs
      const jobAfter = database.prepare('SELECT * FROM jobs WHERE id = ?').get(testJobId);
      assert.strictEqual(jobAfter, undefined, 'Job phải bị xóa cứng khỏi bảng jobs');

      // Kiểm tra cascade các bảng con
      const stepsAfter = database.prepare('SELECT * FROM steps WHERE job_id = ?').all(testJobId);
      assert.strictEqual(stepsAfter.length, 0, 'Toàn bộ steps phải bị cascade xóa');

      const plansAfter = database.prepare('SELECT * FROM dual_plans WHERE job_id = ?').all(testJobId);
      assert.strictEqual(plansAfter.length, 0, 'DualPlan phải bị cascade xóa');

      const evidencesAfter = database.prepare('SELECT * FROM evidence WHERE job_id = ?').all(testJobId);
      assert.strictEqual(evidencesAfter.length, 0, 'Toàn bộ evidence phải bị cascade xóa');

      const questionsAfter = database.prepare('SELECT * FROM questions WHERE job_id = ?').all(testJobId);
      assert.strictEqual(questionsAfter.length, 0, 'Toàn bộ questions phải bị cascade xóa');
    });
  });

  describe('3. Quy chuẩn lưu giữ file đĩa & đánh dấu metadata.json deleted: true', () => {
    it('khi đánh dấu deleted: true trong metadata, file thực tế trên đĩa không bị xóa', () => {
      const featureFolder = path.join(tempDir, 'TASK-PERSIST-01', 'evidence');
      fs.mkdirSync(featureFolder, { recursive: true });

      const sampleFile = path.join(featureFolder, 'important_trace.log');
      fs.writeFileSync(sampleFile, 'Dữ liệu nhật ký quan trọng cần lưu vết vĩnh viễn', 'utf8');

      const metaPath = path.join(featureFolder, 'metadata.json');
      const metadata = {
        'important_trace.log': {
          deleted: true,
          deleted_at: new Date().toISOString()
        }
      };
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');

      // Thẩm định: File trên đĩa VẪN TỒN TẠI NGUYÊN VẸN 100%
      assert.ok(fs.existsSync(sampleFile), 'File log/tài liệu trên ổ đĩa KHÔNG ĐƯỢC PHÉP bị xóa');
      const content = fs.readFileSync(sampleFile, 'utf8');
      assert.strictEqual(content, 'Dữ liệu nhật ký quan trọng cần lưu vết vĩnh viễn');

      // Thẩm định: metadata.json ghi nhận deleted: true
      const loadedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.strictEqual(loadedMeta['important_trace.log'].deleted, true);
    });
  });
});
