/**
 * tests/evidenceNotVerifyGate.test.js
 * Co che: evidence MOI (do agent tu viet metadata.json) LUON la NOT VERIFY.
 * Chi buoc VERIFY (qua evidenceStore.setStatuses) moi gan PASS/FAILED.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/verification/evidenceStore');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-nv-'));
}

test('shape tests[]: agent tu khai PASSED => file van NOT VERIFY, verdict null', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    verdict: 'PASS',
    tests: [{ id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));

  const meta = store.readMetadata(dir);
  assert.equal(meta.records.length, 1);
  assert.equal(meta.records[0].status, 'NOT VERIFY', 'agent tu khai PASSED khong duoc tin');
  assert.equal(meta.records[0].verdict, null, 'verdict phai null khi chua verify');
});

test('shape array: agent tu khai PASSED => NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify([
    { fileName: 'a.png', status: 'PASSED' }
  ], null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));

  const meta = store.readMetadata(dir);
  assert.equal(meta.records[0].status, 'NOT VERIFY');
  assert.equal(meta.records[0].verdict, null);
});

test('shape map: agent tu khai PASS => NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    verdict: 'PASS',
    'a.png': { status: 'PASS' }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));

  const meta = store.readMetadata(dir);
  assert.equal(meta.records.length, 1);
  assert.equal(meta.records[0].status, 'NOT VERIFY');
  assert.equal(meta.records[0].verdict, null);
});

test('agent tu viet evidenceStatus PASSED => van NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png'] }],
    evidenceStatus: { 'a.png': { status: 'PASS', verdict: 'PASS' } }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));

  const meta = store.readMetadata(dir);
  assert.equal(meta.records[0].status, 'NOT VERIFY', 'evidenceStatus agent tu viet khong duoc tin');
});

test('VERIFY (setStatuses) van gan PASS/FAILED duoc', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png', 'b.png'] }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'b.png'), 'x'.repeat(100));

  store.setStatuses(dir, { 'a.png': 'PASS', 'b.png': 'FAILED' });
  const meta = store.readMetadata(dir);
  const byName = Object.fromEntries(meta.records.map((r) => [r.fileName, r]));
  assert.equal(byName['a.png'].status, 'PASS', 'VERIFY phai gan duoc PASS');
  assert.equal(byName['a.png'].verdict, 'PASS');
  assert.equal(byName['b.png'].status, 'FAILED');
  assert.equal(byName['b.png'].verdict, 'FAIL');
});

test('listEvidence: evidence moi = NOT VERIFY, sau VERIFY = PASS', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));

  let items = store.listEvidence(dir);
  assert.equal(items[0].status, 'NOT VERIFY', 'evidence moi phai NOT VERIFY');
  assert.equal(items[0].verdict, null, 'verdict phai null');

  store.setStatuses(dir, { 'a.png': 'PASS' });
  items = store.listEvidence(dir);
  assert.equal(items[0].status, 'PASS');
  assert.equal(items[0].verdict, 'PASS');
});

test('metadata.json ghi ra co cờ verified cho entry do VERIFY gan', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));

  store.setStatuses(dir, { 'a.png': 'PASS' });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(after.evidenceStatus['a.png'].status, 'PASS');
  assert.equal(after.evidenceStatus['a.png'].verified, true, 'entry do VERIFY gan phai co cờ verified');
  assert.equal(after.tests[0].status, 'PASSED', 'tests[] nguyen ban (gate VERIFY doc raw)');
});

test('shape array voi filePath (khong co fileName) => vẫn ra record NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify([
    { evidenceId: 'ev_1', filePath: 'D:\\tmp\\feat\\evidence\\shot.png', status: 'PASSED' }
  ], null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'shot.png'), 'x'.repeat(100));

  const meta = store.readMetadata(dir);
  assert.equal(meta.records.length, 1, 'phai co record tu filePath');
  assert.equal(meta.records[0].fileName, 'shot.png', 'phai lay basename');
  assert.equal(meta.records[0].status, 'NOT VERIFY');
  assert.equal(meta.records[0].verdict, null);
});

test('shape tests[] voi evidence la duong dan => basename, van NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-2',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['C:\\tmp\\feat\\evidence\\a.png'] }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));

  const meta = store.readMetadata(dir);
  assert.equal(meta.records.length, 1);
  assert.equal(meta.records[0].fileName, 'a.png', 'phai lay basename');
  assert.equal(meta.records[0].status, 'NOT VERIFY');
  assert.equal(meta.records[0].verdict, null);
});

test('metadata that trong repo: shape array status CAPTURED => NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify([
    {
      evidenceId: 'ev_1791801035454_dmk5x',
      stepId: 'ui_target_service',
      stepName: 'ui_target_service',
      timestamp: '2026-10-12T10:30:35.454Z',
      fileName: '1791801035454_ui_target_service.png',
      filePath: 'D:\\Thanhpk\\AI\\ai-worker\\docs\\features\\TEST-MCP-FLOW-01\\evidence\\1791801035454_ui_target_service.png',
      currentUrl: 'http://localhost:3000/',
      selector: null,
      actionType: 'screenshot',
      fileSizeBytes: 2790,
      status: 'CAPTURED',
      consoleErrors: []
    }
  ], null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, '1791801035454_ui_target_service.png'), 'x'.repeat(100));

  const items = store.listEvidence(dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'NOT VERIFY');
  assert.equal(items[0].verdict, null);
  assert.equal(items[0].stepName, 'ui_target_service', 'field goc phai con');
});

test('shape map: key top-level la ten file that => tao record NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-3',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png'] }],
    'b.png': { status: 'PASSED' }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'b.png'), 'x'.repeat(100));

  const meta = store.readMetadata(dir);
  const byName = Object.fromEntries(meta.records.map((r) => [r.fileName, r]));
  assert.equal(byName['a.png'].status, 'NOT VERIFY');
  assert.equal(byName['b.png'].status, 'NOT VERIFY', 'key top-level cung phai NOT VERIFY');
  assert.equal(byName['b.png'].verdict, null);
});
