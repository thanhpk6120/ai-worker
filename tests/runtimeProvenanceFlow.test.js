/**
 * tests/runtimeProvenanceFlow.test.js
 * Test tích hợp (không cần AI agent): mô phỏng đúng chuỗi thao tác worker thực hiện
 * trong một bước TESTING:
 *   1. Cấp lease port (exclusive) cho job
 *   2. Ghi marker build vào worktree
 *   3. "Agent" build + khởi động service phục vụ marker
 *   4. Worker verify provenance (hash + process vừa start)
 *   5. Job thứ 2 cùng service phải CHỜ (không nhận port khác)
 *   6. Release -> job 2 nhận đúng port cũ
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-flow-'));
process.env.DB_PATH = path.join(TMP, 'flow.sqlite');
process.env.AIWORKER_PORT_POOLS = JSON.stringify({
  FE: [19310, 19311],
  BE: [19320, 19321],
  MOCK: [19330, 19331],
  OTHER: [19340, 19341]
});

const db = require('../src/storage/db');
const lease = require('../src/execution/portLeaseManager');
const bp = require('../src/execution/buildProvenance');

function makeWorktree() {
  const root = fs.mkdtempSync(path.join(TMP, 'wt-'));
  execSync('git init -q -b main', { cwd: root });
  execSync('git config user.email t@t.local', { cwd: root });
  execSync('git config user.name T', { cwd: root });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>v1</html>');
  execSync('git add .', { cwd: root });
  execSync('git commit -q -m init', { cwd: root });
  return root;
}

function serveMarker(port, marker) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === bp.MARKER_ROUTE) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(marker));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>ok</html>');
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('luồng đầy đủ: lease -> marker -> verify -> job 2 chờ -> release -> nhận đúng port', async () => {
  db.initDb();
  lease.ensureSchema();
  lease.clearAllLeases();

  const wt1 = makeWorktree();
  const job1 = { id: 'job-flow-1', task_code: 'FLOW-1', worktree_path: wt1 };
  const stepStartedAt = Date.now();

  // 1. Cấp port
  const got = await lease.acquire({ jobId: job1.id, serviceKey: 'bankhub-admin-fe', taskCode: 'FLOW-1', timeoutMs: 3000 });
  assert.equal(got.ok, true);

  // 2. Marker + hash
  const hash = bp.computeWorktreeHash(job1).hash;
  const marker = bp.writeBuildMarker(job1, { 'bankhub-admin-fe': got.port }, hash);
  assert.equal(marker.written, true);

  // 3. "Agent" build + service phục vụ marker
  const server = await serveMarker(got.port, { build_hash: hash });
  try {
    // 4. Verify
    const prov = await bp.checkRuntimeProvenance({
      job: job1,
      ports: { 'bankhub-admin-fe': got.port },
      stepStartedAt,
      expectedHash: hash,
      markerWritten: true
    });
    assert.equal(prov.ok, true, JSON.stringify(prov.services));
    assert.equal(prov.mode, 'marker');

    // 5. Job 2 cùng service phải chờ
    const job2 = await lease.acquire({ jobId: 'job-flow-2', serviceKey: 'bankhub-admin-fe', timeoutMs: 2500 });
    assert.equal(job2.ok, false);
    assert.equal(job2.reason, 'PORT_WAIT_TIMEOUT');
    assert.equal(job2.holders[0].job_id, 'job-flow-1');
  } finally {
    await new Promise((r) => server.close(r));
  }

  // 6. Release -> job 2 lấy đúng port cũ
  lease.releaseByJob('job-flow-1');
  const job2b = await lease.acquire({ jobId: 'job-flow-2', serviceKey: 'bankhub-admin-fe', timeoutMs: 4000 });
  assert.equal(job2b.ok, true);
  assert.equal(job2b.port, got.port, 'phải dùng đúng port cũ, không đổi port');
  lease.releaseByJob('job-flow-2');
});

test('sau khi sửa code, build cũ bị phát hiện qua hash marker', async () => {
  lease.clearAllLeases();
  const wt = makeWorktree();
  const port = 19311;
  const job = { id: 'job-flow-3', task_code: 'FLOW-3', worktree_path: wt };
  const hashBefore = bp.computeWorktreeHash(job).hash;

  // Build cũ đang chạy (phục vụ hash trước khi sửa).
  const server = await serveMarker(port, { build_hash: hashBefore });
  try {
    // Agent sửa code nhưng KHÔNG build lại.
    fs.writeFileSync(path.join(wt, 'index.html'), '<html>v2-fixed</html>');
    const hashAfter = bp.computeWorktreeHash(job).hash;
    assert.notEqual(hashAfter, hashBefore, 'sửa code phải đổi hash');

    const prov = await bp.checkRuntimeProvenance({
      job,
      ports: { 'bankhub-admin-fe': port },
      stepStartedAt: Date.now() - 3000,
      expectedHash: hashAfter,
      markerWritten: true
    });
    assert.equal(prov.ok, false, 'service vẫn là build cũ nên phải fail');
    assert.ok(prov.services[0].problems.includes('BUILD_HASH_MISMATCH'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
