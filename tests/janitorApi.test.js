/**
 * tests/janitorApi.test.js
 * Kiểm thử API + đường chạy THẬT của Process Janitor ở chế độ DRY-RUN
 * (không kill gì cả, chỉ đọc tiến trình thật của máy).
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-janitor-api-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-janitor-api.sqlite');
process.env.JANITOR_ENABLED = 'false';

const db = require('../src/storage/db');
const { app } = require('../src/server');

describe('Janitor API', () => {
  let server;
  let baseUrl;

  const get = async (p) => {
    const r = await fetch(baseUrl + p);
    return { status: r.status, body: await r.json() };
  };
  const post = async (p, body) => {
    const r = await fetch(baseUrl + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return { status: r.status, body: await r.json() };
  };

  before(async () => {
    db.initDb();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(TMP_DB_DIR, { recursive: true, force: true }); } catch (e) {}
  });

  test('GET /janitor/status trả cấu hình chu kỳ và cờ bật/tắt', async () => {
    const { status, body } = await get('/api/v1/janitor/status');
    assert.equal(status, 200);
    assert.equal(typeof body.enabled, 'boolean');
    assert.equal(body.interval_ms, 600000, 'chu kỳ mặc định phải là 10 phút');
    assert.equal(typeof body.config.grace_minutes, 'number');
    assert.equal(body.config.idle_agent_trees, false, 'quét cây agent mặc định phải TẮT cho an toàn');
    assert.equal(body.running, false);
  });

  test('GET /janitor/runs rỗng khi chưa có lần chạy nào', async () => {
    const { status, body } = await get('/api/v1/janitor/runs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.runs));
    assert.equal(body.runs.length, 0);
  });

  test('POST /janitor/run (dry-run) quét thật nhưng không kill gì', async () => {
    const { status, body } = await post('/api/v1/janitor/run', { dryRun: true });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const rep = body.report;
    assert.equal(rep.dry_run, true);
    assert.equal(rep.killed, 0, 'dry-run không được kill');
    assert.ok(Array.isArray(rep.killed_list));
    assert.ok(Array.isArray(rep.log) && rep.log.length > 0, 'phải có log');
    assert.ok(rep.log.some((l) => /\[START\]/.test(l)));
    assert.ok(rep.log.some((l) => /\[END\]/.test(l)));
    if (process.platform === 'win32') {
      assert.ok(rep.scanned > 0, 'phải đọc được danh sách tiến trình thật');
      assert.ok(rep.protected_count > 0, 'phải bảo vệ chính worker + con cháu');
    }
  });

  test('GET /janitor/runs/:id trả chi tiết kèm log; id lạ trả 404', async () => {
    const list = await get('/api/v1/janitor/runs');
    assert.ok(list.body.runs.length >= 1);
    const id = list.body.runs[0].id;

    const detail = await get(`/api/v1/janitor/runs/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.run.id, id);
    assert.ok(Array.isArray(detail.body.run.log));
    assert.ok(Array.isArray(detail.body.run.killed_list));
    assert.ok(Array.isArray(detail.body.run.protected_list));

    const missing = await get('/api/v1/janitor/runs/khong-ton-tai');
    assert.equal(missing.status, 404);
  });

  test('mọi tiến trình bị đề xuất kill đều có LÝ DO rõ ràng', async () => {
    const list = await get('/api/v1/janitor/runs');
    const id = list.body.runs[0].id;
    const detail = await get(`/api/v1/janitor/runs/${id}`);
    for (const item of detail.body.run.killed_list) {
      assert.ok(item.reason && item.reason.length > 5, 'thiếu lý do kill');
      assert.ok(Number.isFinite(Number(item.rootPid)), 'thiếu rootPid');
    }
  });
});
