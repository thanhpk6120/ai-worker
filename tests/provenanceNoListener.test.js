/**
 * tests/provenanceNoListener.test.js
 * Bảo vệ [PROVENANCE-NO-LISTENER]: "agent đã dừng service để nhả port" KHÔNG được
 * coi là "chạy build cũ".
 *
 * Vì sao: PHUB-679 lặp vô hạn ở FIXING. Agent chụp ảnh xong, dừng service 3015 đúng
 * như prompt yêu cầu, rồi worker chấm `[NO_LISTENER]` => ép exitCode=1 => tính là
 * một vòng sửa thất bại (log 10:57:38 exit 0 → 10:57:42 "Vòng sửa 2/10 thất bại").
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-prov-nolisten-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-prov-nolisten.sqlite');

const db = require('../src/storage/db');
const buildProvenance = require('../src/execution/buildProvenance');
const { verifyRuntimeProvenance } = require('../src/server');

describe('verifyRuntimeProvenance - phân biệt "không listener" và "build cũ"', () => {
  const jobId = 'test-prov-job-1';
  const original = buildProvenance.checkRuntimeProvenance;

  before(() => {
    db.initDb();
    db.createJob({ id: jobId, title: 'Prov test', prompt: 'p', status: 'FIXING' });
  });

  after(() => {
    buildProvenance.checkRuntimeProvenance = original;
    try {
      db.updateJob(jobId, { status: 'CANCELLED' });
      db.deleteJob(jobId);
    } catch (e) {}
    try { fs.rmSync(TMP_DB_DIR, { recursive: true, force: true }); } catch (e) {}
  });

  const portCtx = { ports: { 'svc-fe': 3015 }, stepStartedAt: Date.now() - 1000, buildHash: 'abc123', markerWritten: false };

  test('mọi service [NO_LISTENER] => noListener=true, wrongBuild=false', async () => {
    buildProvenance.checkRuntimeProvenance = async () => ({
      ok: false,
      mode: 'strict',
      services: [{ serviceKey: 'svc-fe', port: 3015, problems: ['NO_LISTENER'], ok: false }],
      reason: 'svc-fe:3015[NO_LISTENER]'
    });
    const res = await verifyRuntimeProvenance(jobId, portCtx, 'FIXING');
    assert.equal(res.ok, false);
    assert.equal(res.noListener, true, 'không còn listener phải được nhận diện riêng');
    assert.equal(res.wrongBuild, false, 'không được coi là build cũ');
  });

  test('có listener nhưng hash cũ => wrongBuild=true (phải chặn)', async () => {
    buildProvenance.checkRuntimeProvenance = async () => ({
      ok: false,
      mode: 'strict',
      services: [{ serviceKey: 'svc-fe', port: 3015, servedHash: 'old999', problems: ['HASH_MISMATCH'], ok: false }],
      reason: 'hash mismatch'
    });
    const res = await verifyRuntimeProvenance(jobId, portCtx, 'FIXING');
    assert.equal(res.noListener, false);
    assert.equal(res.wrongBuild, true);
  });

  test('service đúng build thì ok=true, không bị gắn cờ lỗi', async () => {
    buildProvenance.checkRuntimeProvenance = async () => ({
      ok: true, mode: 'strict', services: [{ serviceKey: 'svc-fe', port: 3015, servedHash: 'abc123', ok: true }]
    });
    const res = await verifyRuntimeProvenance(jobId, portCtx, 'FIXING');
    assert.equal(res.ok, true);
    assert.equal(res.noListener, false);
    assert.equal(res.wrongBuild, false);
  });

  test('port context rỗng thì bỏ qua kiểm tra (không chặn oan)', async () => {
    const res = await verifyRuntimeProvenance(jobId, { ports: {}, stepStartedAt: Date.now() }, 'FIXING');
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
  });
});
