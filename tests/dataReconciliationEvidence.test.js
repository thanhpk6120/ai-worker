const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyTaskEvidence } = require('../src/server');

describe('Data Reconciliation & Consistency Evidence Gate Test Suite', () => {
  let tmpFeatureDir;
  let tmpEvidenceDir;

  beforeEach(() => {
    tmpFeatureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-reconcile-'));
    tmpEvidenceDir = path.join(tmpFeatureDir, 'evidence');
    fs.mkdirSync(tmpEvidenceDir, { recursive: true });

    // Tạo test_plan.md mẫu không bắt buộc UI Screenshot
    fs.writeFileSync(path.join(tmpFeatureDir, 'test_plan.md'), `
# Test Plan
## TC-API-01: Kiểm tra API đối chiếu DB
## TC-API-02: Kiểm tra bản ghi giao dịch
`);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpFeatureDir, { recursive: true, force: true });
    } catch (e) {}
  });

  it('1. Chặn trường hợp tự mâu thuẫn: note thừa nhận mismatch API-DB nhưng status vẫn để PASSED', () => {
    // 03_api_verification.json
    fs.writeFileSync(path.join(tmpEvidenceDir, '03_api_verification.json'), JSON.stringify({
      endpoint: '/api/v1/transactions',
      status: 200,
      data: [{ id: 1, amount: 50000 }]
    }));

    // 04_database_assertion.json
    fs.writeFileSync(path.join(tmpEvidenceDir, '04_database_assertion.json'), JSON.stringify({
      query: 'SELECT * FROM transactions',
      rowCount: 20
    }));

    // metadata.json thừa nhận mismatch trong note nhưng để status: PASSED
    fs.writeFileSync(path.join(tmpEvidenceDir, 'metadata.json'), JSON.stringify({
      taskCode: 'TEST-01',
      verdict: 'PASSED',
      tests: [
        {
          id: 'TC-API-01',
          name: 'Kiểm tra API đối chiếu DB',
          status: 'PASSED',
          evidence: ['03_api_verification.json'],
          note: 'Mismatch giữa API curl và SQL query do lệch timezone và cột thời gian'
        },
        {
          id: 'TC-API-02',
          name: 'Kiểm tra bản ghi giao dịch',
          status: 'PASSED',
          evidence: ['04_database_assertion.json'],
          note: 'Khớp 100%'
        }
      ]
    }));

    const result = verifyTaskEvidence({
      jobId: 'test-job-mismatch',
      evidenceDir: tmpEvidenceDir,
      featureDir: tmpFeatureDir,
      taskCode: 'TEST-01',
      emit: () => {}
    });

    assert.strictEqual(result.failed, true, 'verifyTaskEvidence phải trả về failed: true khi phát hiện tự mâu thuẫn mismatch');
  });

  it('2. Chặn trường hợp 04_database_assertion.json có matched: false hoặc discrepancies', () => {
    fs.writeFileSync(path.join(tmpEvidenceDir, '03_api_verification.json'), JSON.stringify({
      endpoint: '/api/v1/transactions',
      status: 200,
      count: 20
    }));

    // 04_database_assertion.json ghi nhận matched: false kèm discrepancies
    fs.writeFileSync(path.join(tmpEvidenceDir, '04_database_assertion.json'), JSON.stringify({
      query: 'SELECT COUNT(*) FROM transactions',
      matched: false,
      discrepancies: [
        'Lệch số lượng bản ghi: API trả về 20 nhưng DB có 500 bản ghi',
        'Thiếu filter TRANS_TYPE = C trong SQL query'
      ]
    }));

    fs.writeFileSync(path.join(tmpEvidenceDir, 'metadata.json'), JSON.stringify({
      taskCode: 'TEST-02',
      verdict: 'PASSED',
      tests: [
        {
          id: 'TC-API-01',
          name: 'Kiểm tra API',
          status: 'PASSED',
          evidence: ['03_api_verification.json']
        },
        {
          id: 'TC-API-02',
          name: 'Kiểm tra DB assertion',
          status: 'PASSED',
          evidence: ['04_database_assertion.json']
        }
      ]
    }));

    const result = verifyTaskEvidence({
      jobId: 'test-job-db-failed',
      evidenceDir: tmpEvidenceDir,
      featureDir: tmpFeatureDir,
      taskCode: 'TEST-02',
      emit: () => {}
    });

    assert.strictEqual(result.failed, true, 'verifyTaskEvidence phải trả về failed: true khi 04_database_assertion.json có matched: false');
  });

  it('3. Cho phép PASS khi dữ liệu thực sự khớp 100% (matched: true, không có mismatch/discrepancies)', () => {
    fs.writeFileSync(path.join(tmpEvidenceDir, '03_api_verification.json'), JSON.stringify({
      endpoint: '/api/v1/transactions?transType=C&size=20',
      status: 200,
      data: [{ id: 'TX01', bankAccount: '190123456789', transType: 'C', amount: 100000 }]
    }));

    fs.writeFileSync(path.join(tmpEvidenceDir, '04_database_assertion.json'), JSON.stringify({
      query: 'SELECT * FROM BH_BANK_TRANSACTIONS WHERE BANK_ACCOUNT = ? AND TRANS_TYPE = ? FETCH FIRST 20 ROWS ONLY',
      matched: true,
      discrepancies: [],
      rows: [{ id: 'TX01', bankAccount: '190123456789', transType: 'C', amount: 100000 }]
    }));

    fs.writeFileSync(path.join(tmpEvidenceDir, '05_service_runtime.log'), 'Server listening on port 8080\nGET /api/v1/transactions?transType=C&size=20 200 OK 12ms\nPOST /api/v1/verify 200 OK\nrequest received, response sent status 200\n');

    fs.writeFileSync(path.join(tmpEvidenceDir, 'metadata.json'), JSON.stringify({
      taskCode: 'TEST-03',
      verdict: 'PASSED',
      tests: [
        {
          id: 'TC-API-01',
          name: 'Kiểm tra API curl',
          status: 'PASSED',
          evidence: ['03_api_verification.json', '05_service_runtime.log'],
          note: 'HTTP 200 OK, trả về đủ 20 bản ghi Báo có'
        },
        {
          id: 'TC-API-02',
          name: 'Kiểm tra SQL query đối soát',
          status: 'PASSED',
          evidence: ['04_database_assertion.json'],
          note: 'Dữ liệu khớp 100% từng trường với API response'
        }
      ]
    }));

    const result = verifyTaskEvidence({
      jobId: 'test-job-reconcile-success',
      evidenceDir: tmpEvidenceDir,
      featureDir: tmpFeatureDir,
      taskCode: 'TEST-03',
      emit: () => {}
    });

    assert.strictEqual(result.failed, false, 'verifyTaskEvidence phải trả về failed: false khi dữ liệu khớp 100%');
  });
});
