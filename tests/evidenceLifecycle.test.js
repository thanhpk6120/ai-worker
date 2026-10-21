/**
 * tests/evidenceLifecycle.test.js
 * Vòng đời trạng thái evidence: NOT VERIFY -> PASS | FAILED
 * + tên/mô tả + sắp xếp theo step test
 * + bảo toàn 3 shape metadata.json (array / map / tests[])
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/verification/evidenceStore');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-ev-'));
}

function writeMeta(dir, data) {
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(data, null, 2), 'utf8');
}

// --- normalizeStatus -------------------------------------------------------

test('normalizeStatus chuan hoa ve 3 gia tri', () => {
  assert.equal(store.normalizeStatus(undefined), 'NOT VERIFY');
  assert.equal(store.normalizeStatus(null), 'NOT VERIFY');
  assert.equal(store.normalizeStatus(''), 'NOT VERIFY');
  assert.equal(store.normalizeStatus('CAPTURED'), 'NOT VERIFY');
  assert.equal(store.normalizeStatus('PENDING'), 'NOT VERIFY');
  assert.equal(store.normalizeStatus('NOT VERIFY'), 'NOT VERIFY');
  assert.equal(store.normalizeStatus('PASS'), 'PASS');
  assert.equal(store.normalizeStatus('PASSED'), 'PASS');
  assert.equal(store.normalizeStatus('passed'), 'PASS');
  assert.equal(store.normalizeStatus('FAILED'), 'FAILED');
  assert.equal(store.normalizeStatus('FAIL'), 'FAILED');
});

test('NOT VERIFY khong chua "not verified" (tranh regex chan bao loi lua doi)', () => {
  const re = /partial|conditional|not\s*verified|skipped|bypass|unknown\s*error|chưa\s*chạy|chua\s*chay/i;
  assert.equal(re.test('NOT VERIFY'), false, '"NOT VERIFY" phai KHONG match regex chan bao loi lua doi');
  assert.equal(re.test('NOT VERIFIED'), true);
});

// --- Shape TESTS: khong lam mat tests[] -------------------------------------

test('shape {taskCode, verdict, tests[]} giu nguyen tests[] khi ghi trang thai', () => {
  const dir = tmpDir();
  const original = {
    taskCode: 'RSGATE-44',
    verdict: 'FAILED',
    hasVisualDefects: true,
    notes: 'ghi chu cua agent',
    tests: [
      { name: 'TC-01', status: 'PASSED', evidence: ['a.png'], expected: 'co cot http_method' },
      { name: 'TC-02', status: 'FAILED', evidence: ['b.png'], expected: 'khong con cot loi' }
    ]
  };
  writeMeta(dir, original);

  const before = store.readMetadata(dir);
  assert.equal(before.shape, 'tests');
  assert.equal(before.records.length, 2);

  const ok = store.setStatuses(dir, { 'a.png': 'PASS', 'b.png': 'FAILED' });
  assert.equal(ok, true);

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  // tests[] phai con nguyen
  assert.equal(Array.isArray(after.tests), true, 'tests[] bi mat!');
  assert.equal(after.tests.length, 2);
  assert.equal(after.tests[0].name, 'TC-01');
  assert.equal(after.tests[0].evidence[0], 'a.png');
  // cac field goc khac giu nguyen
  assert.equal(after.taskCode, 'RSGATE-44');
  assert.equal(after.hasVisualDefects, true);
  assert.equal(after.notes, 'ghi chu cua agent');
  // trang thai duoc ghi
  assert.equal(after.evidenceStatus['a.png'].status, 'PASS');
  assert.equal(after.evidenceStatus['b.png'].status, 'FAILED');
});

test('shape tests[]: file chua khai bao trong tests[] van nhan trang thai', () => {
  const dir = tmpDir();
  writeMeta(dir, { taskCode: 'X', tests: [{ name: 'TC-01', status: 'PASSED', evidence: ['a.png'] }] });
  store.setStatuses(dir, { 'a.png': 'PASS', 'z.png': 'FAILED' });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(after.tests.length, 1, 'tests[] khong duoc doi');
  assert.equal(after.evidenceStatus['z.png'].status, 'FAILED');
});

// --- Shape MAP: khong lam mat key goc ---------------------------------------

test('shape map {file: meta} giu nguyen key goc va bo qua key khong phai file', () => {
  const dir = tmpDir();
  writeMeta(dir, {
    taskCode: 'T-1',
    verdict: 'PASS',
    notes: 'ghi chu',
    'a.png': { status: 'CAPTURED', stepName: 'step 1' }
  });

  const meta = store.readMetadata(dir);
  assert.equal(meta.shape, 'map');
  assert.equal(meta.records.length, 1, 'key taskCode/verdict/notes khong duoc thanh record');
  assert.equal(meta.records[0].fileName, 'a.png');
  assert.equal(meta.records[0].status, 'NOT VERIFY');

  store.setStatuses(dir, { 'a.png': 'PASS' });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(after.taskCode, 'T-1', 'key goc bi mat');
  assert.equal(after.verdict, 'PASS', 'key goc bi mat');
  assert.equal(after.notes, 'ghi chu', 'key goc bi mat');
  assert.equal(after['a.png'].status, 'PASS');
});

// --- Shape ARRAY -----------------------------------------------------------

test('shape array giu nguyen cau truc va ghi duoc trang thai', () => {
  const dir = tmpDir();
  writeMeta(dir, [{ fileName: 'a.png', stepName: 's1', status: 'CAPTURED' }]);
  const meta = store.readMetadata(dir);
  assert.equal(meta.shape, 'array');
  store.setStatuses(dir, { 'a.png': 'FAILED' });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(Array.isArray(after), true);
  assert.equal(after[0].status, 'FAILED');
  assert.equal(after[0].stepName, 's1');
});

// --- Vong doi trang thai ---------------------------------------------------

test('evidence moi sinh = NOT VERIFY, verify thanh cong = PASS, verify loi = FAILED', () => {
  const dir = tmpDir();
  writeMeta(dir, [
    { fileName: 'ok.png', status: 'CAPTURED' },
    { fileName: 'loi.png', status: 'CAPTURED' }
  ]);
  const items = store.listEvidence(dir);
  // file thuc te phai ton tai tren dia de listEvidence nhan
  assert.equal(items.length, 0, 'chua co file that tren dia');

  fs.writeFileSync(path.join(dir, 'ok.png'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'loi.png'), 'x'.repeat(100));

  const listed = store.listEvidence(dir);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((e) => e.status === 'NOT VERIFY'), 'evidence moi phai NOT VERIFY');
  assert.ok(listed.every((e) => e.verdict === null), 'verdict phai null khi chua verify');

  store.setStatuses(dir, { 'ok.png': 'PASS', 'loi.png': 'FAILED' });
  const after = store.listEvidence(dir);
  const byName = Object.fromEntries(after.map((e) => [e.fileName, e]));
  assert.equal(byName['ok.png'].status, 'PASS');
  assert.equal(byName['ok.png'].verdict, 'PASS');
  assert.equal(byName['loi.png'].status, 'FAILED');
  assert.equal(byName['loi.png'].verdict, 'FAIL');
});

// --- Ten / mo ta -----------------------------------------------------------

test('evidence co ten va mo ta', () => {
  const dir = tmpDir();
  writeMeta(dir, [{
    fileName: 'a.png',
    name: 'Man hinh danh sach doi soat',
    description: 'Bang doi soat hien thi cot HTTP Method',
    passCriteria: 'Co cot HTTP Method va khong con cot Ma loi/Mo ta loi'
  }]);
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));
  const items = store.listEvidence(dir);
  assert.equal(items[0].name, 'Man hinh danh sach doi soat');
  assert.equal(items[0].description, 'Bang doi soat hien thi cot HTTP Method');
  assert.ok(items[0].passCriteria.includes('HTTP Method'));
});

// --- Sap xep theo step ------------------------------------------------------

test('sap xep evidence theo order -> stepIndex -> timestamp', () => {
  const recs = [
    store.normalizeRecord({ fileName: 'c.png', order: 3, stepIndex: 3 }),
    store.normalizeRecord({ fileName: 'a.png', order: 1, stepIndex: 1 }),
    store.normalizeRecord({ fileName: 'b.png', order: 2, stepIndex: 2 })
  ];
  const sorted = store.sortRecords(recs);
  assert.deepEqual(sorted.map((r) => r.fileName), ['a.png', 'b.png', 'c.png']);
});

test('sap xep theo stepIndex khi khong co order', () => {
  const recs = [
    store.normalizeRecord({ fileName: 's3.png', stepIndex: 3 }),
    store.normalizeRecord({ fileName: 's1.png', stepIndex: 1 }),
    store.normalizeRecord({ fileName: 's2.png', stepIndex: 2 })
  ];
  const sorted = store.sortRecords(recs);
  assert.deepEqual(sorted.map((r) => r.fileName), ['s1.png', 's2.png', 's3.png']);
});

test('evidence khong co order/stepIndex sap theo timestamp', () => {
  const recs = [
    store.normalizeRecord({ fileName: 'late.png', timestamp: '2026-10-20T03:00:00.000Z' }),
    store.normalizeRecord({ fileName: 'early.png', timestamp: '2026-10-20T01:00:00.000Z' })
  ];
  const sorted = store.sortRecords(recs);
  assert.deepEqual(sorted.map((r) => r.fileName), ['early.png', 'late.png']);
});

test('record co order duoc uu tien hon record chi co stepIndex', () => {
  const recs = [
    store.normalizeRecord({ fileName: 'b.png', stepIndex: 1 }),
    store.normalizeRecord({ fileName: 'a.png', order: 5 })
  ];
  const sorted = store.sortRecords(recs);
  assert.equal(sorted[0].fileName, 'a.png');
});
