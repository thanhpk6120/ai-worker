/**
 * tests/evidenceCompleteness.test.js
 * Luật hoàn tất bằng chứng — bịt 3 lỗ hổng khiến PHUB-678 DONE dù việc thật chưa xong:
 *  (a) pendingItems còn PENDING, (b) kế hoạch nhắc DDL mà không có bằng chứng kênh DB,
 *  (c) test bị skipped/@Disabled vẫn tính là đạt.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ec = require('../src/verification/evidenceCompleteness');
const { verifyTaskEvidence } = require('../src/server.js');

function makeFeature(testPlan) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-ec-'));
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'test_plan.md'), testPlan || '# Test plan\n\nKhong co gi dac biet.\n', 'utf8');
  return { root, featureDir: root, evidenceDir };
}

test('analyzePendingItems: PENDING là CHƯA ĐÓNG', () => {
  const r = ec.analyzePendingItems({
    pendingItems: [{ id: 'PENDING-01', item: 'Chạy migration DDL Oracle', status: 'PENDING' }]
  });
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].why, /chưa phải trạng thái đóng/);
});

test('analyzePendingItems: DONE là đã đóng', () => {
  const r = ec.analyzePendingItems({ pendingItems: [{ id: 'P-1', status: 'done' }] });
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.resolved.length, 1);
});

test('analyzePendingItems: miễn trừ phải kèm lý do cụ thể', () => {
  const withoutReason = ec.analyzePendingItems({ pendingItems: [{ id: 'P-1', status: 'NOT_APPLICABLE' }] });
  assert.equal(withoutReason.unresolved.length, 1);
  assert.match(withoutReason.unresolved[0].why, /thiếu lý do/);

  const withReason = ec.analyzePendingItems({
    pendingItems: [{ id: 'P-1', status: 'NOT_APPLICABLE', reason: 'Không có quyền DBA trên partner_hub' }]
  });
  assert.equal(withReason.unresolved.length, 0);
  assert.equal(withReason.waivers.length, 1);
});

test('hasDbEvidence: nhận file db_assert*/reconciliation* có nội dung SQL', () => {
  const files = { 'database_assertion.json': '{"sql":"SELECT 1 FROM dual","rowCount":1}' };
  const read = (n) => files[n] || '';
  assert.equal(ec.hasDbEvidence(['database_assertion.json'], read), 'database_assertion.json');
  assert.equal(ec.hasDbEvidence(['03_api_verification.json'], read), null);
  assert.equal(ec.hasDbEvidence(['05_service_runtime.log'], read), null);
});

test('findSkippedTests: bắt dòng Skipped > 0 và @Disabled', () => {
  const hits = ec.findSkippedTests([
    { name: '01_test_execution.log', content: 'Tests run: 68, Failures: 0, Errors: 0, Skipped: 3' }
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].skipped, 3);
  const disabled = ec.findSkippedTests([{ name: 'x.log', content: 'class FooTest @Disabled(...)' }]);
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].skipped, 0);
});

test('evaluate: kế hoạch nhắc DDL + không có bằng chứng DB => VI PHẠM', () => {
  const r = ec.evaluateEvidenceCompleteness({
    metadataObj: {},
    validEvidenceFiles: ['01_test_execution.log'],
    logEntries: [{ name: '01_test_execution.log', content: 'BUILD SUCCESS\n' }],
    planTexts: ['| 1 | Chạy `db/01_add_user_profile_columns.sql` (ALTER TABLE ...) trên Oracle |'],
    readEvidenceFile: () => ''
  });
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /không có bằng chứng kênh DB|KHÔNG có/);
});

test('evaluate: có miễn trừ NOT_APPLICABLE kèm lý do DDL => chỉ CẢNH BÁO', () => {
  const r = ec.evaluateEvidenceCompleteness({
    metadataObj: {
      pendingItems: [{ id: 'P-1', item: 'Chạy migration DDL Oracle', status: 'NOT_APPLICABLE', reason: 'Không có quyền DBA trên schema partner_hub' }]
    },
    validEvidenceFiles: ['01_test_execution.log'],
    logEntries: [],
    planTexts: ['Chạy migration `Alter Table BH_ADMIN_USERS`'],
    readEvidenceFile: () => ''
  });
  assert.equal(r.violations.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('evaluate: test skipped không khai báo => VI PHẠM', () => {
  const r = ec.evaluateEvidenceCompleteness({
    metadataObj: {},
    validEvidenceFiles: ['01_test_execution.log'],
    logEntries: [{ name: '01_test_execution.log', content: 'Tests run: 10, Failures: 0, Errors: 0, Skipped: 2' }],
    planTexts: ['# test plan'],
    readEvidenceFile: () => ''
  });
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /2 test bị skipped/);
});

test('PHUB-678: gate thật đánh trượt job khi còn pendingItems + thiếu bằng chứng DB', () => {
  const { featureDir, evidenceDir } = makeFeature(
    '# Test plan\n\n| 1 | Chạy `docs/features/PHUB-678/db/01_add_user_profile_columns.sql` (ALTER TABLE) trên Oracle | PENDING |\n'
  );
  fs.writeFileSync(path.join(evidenceDir, '01_test_execution.log'), 'Tests run: 68, Failures: 0, Errors: 0, Skipped: 0\nBUILD SUCCESS\n', 'utf8');
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-678',
    tests: [{ id: 'TC-678-VAL-01', name: 'TC-678-VAL-01', status: 'PASSED', evidence: ['01_test_execution.log'] }],
    summary: { totalTestCases: 1, passed: 1, failed: 0 },
    pendingItems: [{ id: 'PENDING-01', item: 'Chạy migration docs/features/PHUB-678/db/01_add_user_profile_columns.sql trên Oracle partner_hub', status: 'PENDING' }]
  }, null, 2), 'utf8');

  const res = verifyTaskEvidence({ jobId: 'job-678', evidenceDir, featureDir, taskCode: 'T-678', emit: () => {} });

  assert.equal(res.failed, true, 'job phải bị đánh trượt: còn hạng mục PENDING và thiếu bằng chứng DB');
  const joined = res.reasons.join(' | ');
  assert.match(joined, /pendingItems/);
  assert.match(joined, /kênh DB|KHÔNG có bằng chứng kênh DB/);
});

test('Khi mọi hạng mục đã đóng và có bằng chứng DB thật => không vi phạm', () => {
  const { featureDir, evidenceDir } = makeFeature(
    '# Test plan\n\n| 1 | Chạy migration DDL `ALTER TABLE BH_ADMIN_USERS` |\n'
  );
  fs.writeFileSync(path.join(evidenceDir, '02_db_assertion.json'), JSON.stringify({
    sql: 'SELECT column_name FROM user_tab_columns WHERE table_name=\'BH_ADMIN_USERS\'',
    rowCount: 5,
    matched: true
  }), 'utf8');
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-OK',
    tests: [
      { id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['02_db_assertion.json'] },
      { id: 'TC-02', name: 'TC-02', status: 'PASSED', evidence: ['02_db_assertion.json'] }
    ],
    pendingItems: [{ id: 'P-1', item: 'Chạy migration DDL', status: 'DONE' }]
  }, null, 2), 'utf8');

  const res = verifyTaskEvidence({ jobId: 'job-ok', evidenceDir, featureDir, taskCode: 'T-OK', emit: () => {} });
  assert.equal(res.failed, false, `không được đánh trượt: ${res.reasons.join(' | ')}`);
});
