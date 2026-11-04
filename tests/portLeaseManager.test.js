/**
 * tests/portLeaseManager.test.js
 * Kiểm thử cơ chế cấp phát port theo lease: không trùng port, giải phóng được,
 * lease hết hạn thì thu hồi, và port đang bị process khác giữ thì bị bỏ qua.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-portlease-'));
process.env.DB_PATH = path.join(TMP, 'portlease.sqlite');

// Pool nhỏ để test nhanh và không đụng port thật của máy.
process.env.AIWORKER_PORT_POOLS = JSON.stringify({
  FE: [19010, 19011],
  BE: [19020, 19021],
  MOCK: [19030, 19031],
  OTHER: [19040, 19041]
});

const db = require('../src/storage/db');
const portLease = require('../src/execution/portLeaseManager');

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('classifyServiceKey phân loại đúng FE/BE/MOCK', () => {
  assert.equal(portLease.classifyServiceKey('bankhub-admin-fe'), 'FE');
  assert.equal(portLease.classifyServiceKey('bankhub-admin-be'), 'BE');
  assert.equal(portLease.classifyServiceKey('mock-cyberid'), 'MOCK');
  assert.equal(portLease.classifyServiceKey('worker'), 'OTHER');
});

test('cùng một service: job thứ 2 phải CHỜ, không được cấp port khác', async () => {
  db.initDb();
  portLease.ensureSchema();
  portLease.clearAllLeases();

  const a = await portLease.acquire({ jobId: 'job-a', serviceKey: 'bankhub-admin-fe', timeoutMs: 2000 });
  assert.equal(a.ok, true);

  // Job B cùng service: phải timeout (chờ), KHÔNG được nhận port 3011.
  const b = await portLease.acquire({ jobId: 'job-b', serviceKey: 'bankhub-admin-fe', timeoutMs: 2500 });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'PORT_WAIT_TIMEOUT');
  assert.equal(b.holders.length, 1);
  assert.equal(b.holders[0].job_id, 'job-a');
});

test('job thứ 2 nhận được service ngay khi job đầu nhả', async () => {
  portLease.clearAllLeases();
  const a = await portLease.acquire({ jobId: 'job-h1', serviceKey: 'bankhub-admin-be', timeoutMs: 1000 });
  assert.equal(a.ok, true);

  // Nhả sau 1.5s, job B chờ tối đa 8s => phải lấy được đúng service đó.
  setTimeout(() => portLease.releaseByJob('job-h1'), 1500);
  const b = await portLease.acquire({ jobId: 'job-h2', serviceKey: 'bankhub-admin-be', timeoutMs: 8000 });
  assert.equal(b.ok, true);
  assert.equal(b.port, a.port, 'cùng service phải dùng đúng port cũ, không đổi port');
});

test('hai service khác nhau vẫn chạy song song được (FE + BE)', async () => {
  portLease.clearAllLeases();
  const fe = await portLease.acquire({ jobId: 'job-p1', serviceKey: 'bankhub-admin-fe', timeoutMs: 2000 });
  const be = await portLease.acquire({ jobId: 'job-p1', serviceKey: 'bankhub-admin-be', timeoutMs: 2000 });
  assert.equal(fe.ok, true);
  assert.equal(be.ok, true);
  assert.notEqual(fe.port, be.port);
});

test('port đang bị process khác giữ thì không được cấp', async () => {
  portLease.clearAllLeases();
  const busyPort = 19020; // BE pool
  const server = await listenOn(busyPort);
  try {
    // Chỉ còn 19021 là trống trong pool BE.
    const res = await portLease.acquire({ jobId: 'job-c', serviceKey: 'be-c', timeoutMs: 6000 });
    assert.equal(res.ok, true);
    assert.equal(res.port, 19021, 'phải bỏ qua port đang bận và cấp port còn trống');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('hết chỗ thì trả PORT_WAIT_TIMEOUT và không cấp port', async () => {
  portLease.clearAllLeases();
  const a = await portLease.acquire({ jobId: 'job-d1', serviceKey: 'fe-d1', timeoutMs: 1000 });
  const b = await portLease.acquire({ jobId: 'job-d2', serviceKey: 'fe-d2', timeoutMs: 1000 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const c = await portLease.acquire({ jobId: 'job-d3', serviceKey: 'fe-d3', timeoutMs: 3000 });
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'PORT_WAIT_TIMEOUT');
});

test('releaseByJob giải phóng và tái sử dụng lại port', async () => {
  portLease.clearAllLeases();
  const a = await portLease.acquire({ jobId: 'job-e1', serviceKey: 'fe-e1', timeoutMs: 1000 });
  const b = await portLease.acquire({ jobId: 'job-e2', serviceKey: 'fe-e2', timeoutMs: 1000 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  portLease.releaseByJob('job-e1');
  const reused = await portLease.acquire({ jobId: 'job-e3', serviceKey: 'fe-e3', timeoutMs: 3000 });
  assert.equal(reused.ok, true, 'sau khi giải phóng phải cấp lại được');
  assert.ok([a.port, b.port].includes(reused.port));
});

test('lease hết hạn được thu hồi và port quay lại pool', async () => {
  portLease.clearAllLeases();
  const a = await portLease.acquire({ jobId: 'job-f1', serviceKey: 'fe-f1', timeoutMs: 1000 });
  const b = await portLease.acquire({ jobId: 'job-f2', serviceKey: 'fe-f2', timeoutMs: 1000 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  // Ép lease hết hạn.
  db.getDb().prepare('UPDATE port_leases SET lease_expires_at = ?').run(Date.now() - 1000);
  const reclaimed = portLease.reclaimExpired();
  assert.equal(reclaimed, 2);

  const c = await portLease.acquire({ jobId: 'job-f3', serviceKey: 'fe-f3', timeoutMs: 3000 });
  assert.equal(c.ok, true);
});

test('buildPortContract luôn nêu đúng port được cấp', () => {
  const contract = portLease.buildPortContract({ frontend: 19010 });
  assert.match(contract, /PORT CONTRACT/);
  assert.match(contract, /frontend: \*\*19010\*\*/);
  assert.match(contract, /AIWORKER_PORT_MAP=\{"frontend":19010\}/);
});

test('port contract bắt buộc restart service trước khi test/verify', () => {
  const contract = portLease.buildPortContract({ frontend: 19010 });
  assert.match(contract, /BẮT BUỘC RESTART SERVICE/);
  assert.match(contract, /build lại/);
  assert.match(contract, /không dùng lại\s+instance/i);
});

test('thời gian chờ port mặc định 60 phút và cấu hình được', () => {
  const config = require('../src/config');
  assert.equal(config.PORT_WAIT_TIMEOUT_MINUTES, 60);
  assert.equal(config.PORT_WAIT_TIMEOUT_MS, 60 * 60 * 1000);
});

test('heartbeat gia hạn lease để không hết hạn giữa bước chạy dài', async () => {
  portLease.clearAllLeases();
  const lease = await portLease.acquire({ jobId: 'job-hb', serviceKey: 'fe-hb', timeoutMs: 2000 });
  assert.equal(lease.ok, true);

  // Ép lease về quá khứ để mô phỏng bước chạy dài.
  db.getDb().prepare('UPDATE port_leases SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1000, lease.leaseId);

  const hb = portLease.startLeaseHeartbeat([{ leaseId: lease.leaseId, serviceKey: 'fe-hb', port: lease.port }], { intervalMs: 50 });
  await new Promise((r) => setTimeout(r, 180));
  hb.stop();

  const row = db.getDb().prepare('SELECT lease_expires_at FROM port_leases WHERE id = ?').get(lease.leaseId);
  assert.ok(row, 'lease phải còn sau heartbeat');
  assert.ok(row.lease_expires_at > Date.now(), 'lease phải được gia hạn về tương lai');

  // Sau khi stop, không gia hạn nữa.
  const afterStop = db.getDb().prepare('SELECT lease_expires_at FROM port_leases WHERE id = ?').get(lease.leaseId).lease_expires_at;
  await new Promise((r) => setTimeout(r, 120));
  const stillOld = db.getDb().prepare('SELECT lease_expires_at FROM port_leases WHERE id = ?').get(lease.leaseId).lease_expires_at;
  assert.equal(stillOld, afterStop);
});

test('prepareServicesForTest trả ok khi port trống (không còn service cũ)', async () => {
  portLease.clearAllLeases();
  const leaseRes = await portLease.acquire({ jobId: 'job-r1', serviceKey: 'fe-r1', timeoutMs: 2000 });
  assert.equal(leaseRes.ok, true);
  const prep = await portLease.prepareServicesForTest(
    { id: 'job-r1', task_code: 'TEST-R1' },
    { 'fe-r1': leaseRes.port }
  );
  assert.equal(prep.ok, true);
  assert.equal(prep.killedCount, 0);
});

test('clearAllLeases dọn sạch sau restart', async () => {
  portLease.clearAllLeases();
  await portLease.acquire({ jobId: 'job-g1', serviceKey: 'fe-g1', timeoutMs: 1000 });
  assert.equal(portLease.listLeases().length, 1);
  assert.equal(portLease.clearAllLeases(), 1);
  assert.equal(portLease.listLeases().length, 0);
});
