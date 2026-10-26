/**
 * tests/systemLogs.test.js
 * Kiểm thử tính năng xem log toàn hệ thống của Worker (System Logs API & SSE Stream)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-syslog-db-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-syslog.sqlite');

const { app, systemLogEmitter } = require('../src/server');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('systemLogEmitter & hook: bắt được log sinh ra từ console.log', () => {
  let captured = null;
  const testMessage = `[TEST-HOOK] Test log capture at ${Date.now()}`;

  const listener = (entry) => {
    if (entry.text && entry.text.includes(testMessage)) {
      captured = entry;
    }
  };

  systemLogEmitter.on('log', listener);
  console.log(testMessage);
  systemLogEmitter.off('log', listener);

  assert.ok(captured, 'systemLogEmitter phải bắt được thông điệp từ console.log');
  assert.ok(captured.text.includes(testMessage));
  assert.equal(captured.isError, false);
});

test('GET /api/v1/system/logs: trả về danh sách log toàn hệ thống theo chunk', async () => {
  console.log('[SYSTEM-TEST] Sample log for GET endpoint test');
  const res = await fetch(`${baseUrl}/api/v1/system/logs?limit=50`);
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.logs), 'data.logs phải là một mảng');
  assert.ok(data.logs.length > 0, 'Phải có ít nhất 1 dòng log');
  assert.ok(Number.isInteger(data.totalLines), 'Phải có totalLines');
  assert.ok(Number.isInteger(data.startLine), 'Phải có startLine');
  assert.ok(Number.isInteger(data.endLine), 'Phải có endLine');

  const sample = data.logs[data.logs.length - 1];
  assert.ok(typeof sample.lineNum === 'number', 'Dòng log phải có lineNum');
  assert.ok(typeof sample.text === 'string', 'Dòng log phải có text string');
});
test('GET /api/v1/system/logs/stream: SSE stream kết nối thành công và nhận event init', async () => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  const res = await fetch(`${baseUrl}/api/v1/system/logs/stream`, {
    signal: controller.signal,
    headers: { 'Accept': 'text/event-stream' }
  });

  clearTimeout(timeoutId);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/event-stream'));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let receivedData = '';

  for (let i = 0; i < 3; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    receivedData += decoder.decode(value);
    if (receivedData.includes('event: init')) {
      break;
    }
  }
  reader.cancel();

  assert.ok(receivedData.includes('event: init'), 'SSE stream phải gửi event init ban đầu');
});

test('DELETE /api/v1/system/logs: xóa sạch log hệ thống thành công', async () => {
  const res = await fetch(`${baseUrl}/api/v1/system/logs`, {
    method: 'DELETE'
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
});
