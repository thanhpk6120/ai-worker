const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const db = require('../src/storage/db');
const {
  MultiVerificationGate,
  UiEvidenceCollector,
  ApiTestRunner,
  LogScanner,
  DatabaseVerifier
} = require('../src/verification/multiVerificationGate');

describe('VerificationGate & SQLite Schema Test Suite', () => {
  describe('SQLite Schema Integrity (src/storage/db.js)', () => {
    let database;

    before(() => {
      database = db.initDb();
    });

    it('khởi tạo thành công database qua initDb()', () => {
      assert.ok(database, 'initDb() phải trả về database instance');
      const currentDb = db.getDb();
      assert.strictEqual(currentDb, database, 'getDb() phải trả về cùng một instance');
    });

    it('thẩm định đầy đủ các bảng cốt lõi: jobs, steps, dual_plans, evidence, questions', () => {
      const stmt = database.prepare("SELECT name FROM sqlite_master WHERE type='table';");
      const tables = stmt.all().map((row) => row.name);

      const requiredTables = ['jobs', 'steps', 'dual_plans', 'evidence', 'questions'];
      for (const table of requiredTables) {
        assert.ok(
          tables.includes(table),
          `Bảng "${table}" phải tồn tại trong cơ sở dữ liệu SQLite`
        );
      }
    });

    it('thẩm định các trường bắt buộc của bảng jobs', () => {
      const columns = database.prepare("PRAGMA table_info(jobs);").all().map((c) => c.name);
      const expectedFields = [
        'id',
        'task_code',
        'title',
        'prompt',
        'repo_path',
        'base_branch',
        'worktree_path',
        'status',
        'created_at',
        'updated_at',
        'completed_at',
        'priority',
        'had_pending'
      ];
      for (const field of expectedFields) {
        assert.ok(columns.includes(field), `Bảng jobs phải chứa cột "${field}"`);
      }
    });

    it('thẩm định các trường bắt buộc của bảng steps', () => {
      const columns = database.prepare("PRAGMA table_info(steps);").all().map((c) => c.name);
      const expectedFields = [
        'id',
        'job_id',
        'step_index',
        'step_type',
        'status',
        'started_at',
        'finished_at',
        'stdout',
        'stderr',
        'exit_code'
      ];
      for (const field of expectedFields) {
        assert.ok(columns.includes(field), `Bảng steps phải chứa cột "${field}"`);
      }
    });

    it('thẩm định các trường bắt buộc của bảng dual_plans', () => {
      const columns = database.prepare("PRAGMA table_info(dual_plans);").all().map((c) => c.name);
      const expectedFields = ['id', 'job_id', 'dev_plan', 'test_plan', 'status', 'created_at', 'updated_at'];
      for (const field of expectedFields) {
        assert.ok(columns.includes(field), `Bảng dual_plans phải chứa cột "${field}"`);
      }
    });

    it('thẩm định các trường bắt buộc của bảng evidence', () => {
      const columns = database.prepare("PRAGMA table_info(evidence);").all().map((c) => c.name);
      const expectedFields = ['id', 'job_id', 'type', 'data', 'verdict', 'created_at'];
      for (const field of expectedFields) {
        assert.ok(columns.includes(field), `Bảng evidence phải chứa cột "${field}"`);
      }
    });

    it('thẩm định các trường bắt buộc của bảng questions', () => {
      const columns = database.prepare("PRAGMA table_info(questions);").all().map((c) => c.name);
      const expectedFields = ['id', 'job_id', 'question', 'options', 'answer', 'status', 'created_at', 'answered_at'];
      for (const field of expectedFields) {
        assert.ok(columns.includes(field), `Bảng questions phải chứa cột "${field}"`);
      }
    });

    it('thực thi toàn vẹn luồng CRUD cơ bản trên các bảng lưu trữ', () => {
      const testJobId = `test-job-${Date.now()}`;

      // 1. Job CRUD
      const createdJob = db.createJob({
        id: testJobId,
        title: 'Verification Test Job',
        prompt: 'Check evidence and tables',
        status: 'DONE',
        priority: 5
      });
      assert.strictEqual(createdJob.id, testJobId);
      assert.strictEqual(createdJob.status, 'DONE');

      // 2. Step CRUD
      const step = db.createStep({
        job_id: testJobId,
        step_index: 1,
        step_type: 'VERIFY',
        runner: 'node:test',
        status: 'RUNNING'
      });
      assert.ok(step.id);
      assert.strictEqual(step.job_id, testJobId);

      // 3. Dual Plans CRUD
      const dualPlan = db.saveDualPlan({
        job_id: testJobId,
        dev_plan: 'Implement feature',
        test_plan: 'Verify all 4 channels',
        status: 'APPROVED'
      });
      assert.ok(dualPlan.id);
      assert.strictEqual(dualPlan.job_id, testJobId);

      // 4. Evidence CRUD
      const evidence = db.addEvidence({
        job_id: testJobId,
        type: 'gate_result',
        data: JSON.stringify({ passed: true }),
        verdict: 'PASS'
      });
      assert.ok(evidence.id);
      assert.strictEqual(evidence.job_id, testJobId);

      // 5. Questions CRUD
      const question = db.addQuestion({
        job_id: testJobId,
        question: 'Deploy immediately?',
        options: ['YES', 'NO']
      });
      assert.ok(question.id);
      const answered = db.answerQuestion(question.id, 'YES');
      assert.strictEqual(answered.answer, 'YES');
      assert.strictEqual(answered.status, 'ANSWERED');

      // Dọn dẹp dữ liệu test
      db.deleteJob(testJobId);
      assert.strictEqual(db.getJobById(testJobId), null);
    });
  });

  describe('MultiVerificationGate 4-Channel Evaluation', () => {
    it('tổng kết passed === true khi cả 4 kênh (UI, API, Log, DB) đều pass', async () => {
      // Giả lập 4 verifier đều đạt 100%
      const mockUi = {
        verify: async () => ({
          passed: true,
          channel: 'ui',
          summary: 'Tất cả UI screenshot hợp lệ'
        })
      };

      const mockApi = {
        runTests: async () => ({
          passed: true,
          channel: 'api',
          summary: '10/10 API tests passed',
          total: 10,
          passedCount: 10
        })
      };

      const mockLog = {
        scanLogs: () => ({
          passed: true,
          channel: 'log',
          summary: 'Không phát hiện lỗi nghiêm trọng trong log',
          errorCount: 0
        })
      };

      const mockDb = {
        verify: async () => ({
          passed: true,
          channel: 'db',
          summary: 'Toàn bộ SQL assertions chính xác'
        })
      };

      const gate = new MultiVerificationGate({
        uiCollector: mockUi,
        apiRunner: mockApi,
        logScanner: mockLog,
        dbVerifier: mockDb
      });

      let gatePassedEvent = null;
      gate.on('gate_passed', (evt) => {
        gatePassedEvent = evt;
      });

      const result = await gate.evaluateAll({
        featureName: 'Test-All-Pass',
        baseUrl: 'http://localhost:3000',
        jobId: 'job-pass-1'
      });

      assert.strictEqual(result.passed, true, 'MultiVerificationGate phải pass khi cả 4 kênh đều pass');
      assert.strictEqual(result.failedChannels.length, 0);
      assert.ok(result.channels.ui.passed);
      assert.ok(result.channels.api.passed);
      assert.ok(result.channels.log.passed);
      assert.ok(result.channels.db.passed);
      assert.ok(gatePassedEvent, 'Phải emit event gate_passed');
      assert.strictEqual(gatePassedEvent.jobId, 'job-pass-1');
    });

    it('tổng kết passed === false khi kênh UI thất bại', async () => {
      const gate = new MultiVerificationGate({
        uiCollector: {
          verify: async () => ({ passed: false, channel: 'ui', summary: 'Screenshot sai lệch layout' })
        },
        apiRunner: { runTests: async () => ({ passed: true, channel: 'api' }) },
        logScanner: { scanLogs: () => ({ passed: true, channel: 'log' }) },
        dbVerifier: { verify: async () => ({ passed: true, channel: 'db' }) }
      });

      let gateFailedEvent = null;
      gate.on('gate_failed', (evt) => {
        gateFailedEvent = evt;
      });

      const result = await gate.evaluateAll({
        featureName: 'Test-UI-Fail',
        baseUrl: 'http://localhost:3000'
      });

      assert.strictEqual(result.passed, false, 'Khi UI thất bại, kết quả chung phải là false');
      assert.ok(result.failedChannels.includes('ui'));
      assert.ok(gateFailedEvent, 'Phải emit event gate_failed');
    });

    it('tổng kết passed === false khi kênh API thất bại', async () => {
      const gate = new MultiVerificationGate({
        uiCollector: { verify: async () => ({ passed: true, channel: 'ui' }) },
        apiRunner: {
          runTests: async () => ({ passed: false, channel: 'api', summary: 'Endpoint trả về HTTP 500' })
        },
        logScanner: { scanLogs: () => ({ passed: true, channel: 'log' }) },
        dbVerifier: { verify: async () => ({ passed: true, channel: 'db' }) }
      });

      const result = await gate.evaluateAll({
        featureName: 'Test-API-Fail',
        baseUrl: 'http://localhost:3000'
      });

      assert.strictEqual(result.passed, false);
      assert.ok(result.failedChannels.includes('api'));
    });

    it('tổng kết passed === false khi kênh Log phát hiện ngoại lệ nghiêm trọng', async () => {
      const gate = new MultiVerificationGate({
        uiCollector: { verify: async () => ({ passed: true, channel: 'ui' }) },
        apiRunner: { runTests: async () => ({ passed: true, channel: 'api' }) },
        logScanner: {
          scanLogs: () => ({ passed: false, channel: 'log', summary: 'Phát hiện NullPointerException trong log' })
        },
        dbVerifier: { verify: async () => ({ passed: true, channel: 'db' }) }
      });

      const result = await gate.evaluateAll({
        featureName: 'Test-Log-Fail',
        baseUrl: 'http://localhost:3000'
      });

      assert.strictEqual(result.passed, false);
      assert.ok(result.failedChannels.includes('log'));
    });

    it('tổng kết passed === false khi kênh DB không khớp assertions', async () => {
      const gate = new MultiVerificationGate({
        uiCollector: { verify: async () => ({ passed: true, channel: 'ui' }) },
        apiRunner: { runTests: async () => ({ passed: true, channel: 'api' }) },
        logScanner: { scanLogs: () => ({ passed: true, channel: 'log' }) },
        dbVerifier: {
          verify: async () => ({ passed: false, channel: 'db', summary: 'Dữ liệu không được ghi vào DB' })
        }
      });

      const result = await gate.evaluateAll({
        featureName: 'Test-DB-Fail',
        baseUrl: 'http://localhost:3000'
      });

      assert.strictEqual(result.passed, false);
      assert.ok(result.failedChannels.includes('db'));
    });

    it('xử lý an toàn khi một kênh kiểm chứng gặp sự cố CRASH/ném lỗi', async () => {
      const gate = new MultiVerificationGate({
        uiCollector: {
          verify: async () => {
            throw new Error('Mất kết nối với Browser');
          }
        },
        apiRunner: { runTests: async () => ({ passed: true, channel: 'api' }) },
        logScanner: { scanLogs: () => ({ passed: true, channel: 'log' }) },
        dbVerifier: { verify: async () => ({ passed: true, channel: 'db' }) }
      });

      const result = await gate.evaluateAll({
        featureName: 'Test-Crash-Handling',
        baseUrl: 'http://localhost:3000'
      });

      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.channels.ui.status, 'CRASHED');
      assert.ok(result.failedChannels.includes('ui'));
    });
  });
});
