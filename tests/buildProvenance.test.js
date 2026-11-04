/**
 * tests/buildProvenance.test.js
 * Kiểm thử cơ chế chứng minh service đang chạy đúng build của worktree:
 *  - hash đổi khi mã nguồn đổi
 *  - marker được ghi vào thư mục static
 *  - service phục vụ đúng hash => pass; sai hash => fail
 *  - service không listen => fail; process cũ (start trước bước) => fail
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execSync } = require('node:child_process');

const bp = require('../src/execution/buildProvenance');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-prov-'));
  execSync('git init -q -b main', { cwd: root });
  execSync('git config user.email t@t.local', { cwd: root });
  execSync('git config user.name T', { cwd: root });
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  execSync('git add .', { cwd: root });
  execSync('git commit -q -m init', { cwd: root });
  return root;
}

/** Server tĩnh nhỏ phục vụ marker, dùng để mô phỏng service đang chạy. */
function startMarkerServer(port, marker) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === bp.MARKER_ROUTE || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(marker));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

test('hash worktree đổi khi mã nguồn đổi', () => {
  const repo = makeRepo();
  const job = { id: 'j1', task_code: 'T1', worktree_path: repo };
  const h1 = bp.computeWorktreeHash(job);
  assert.ok(h1.hash, 'phải có hash');
  assert.equal(h1.dirty, false);

  fs.writeFileSync(path.join(repo, 'index.html'), '<html>changed</html>');
  const h2 = bp.computeWorktreeHash(job);
  assert.equal(h2.dirty, true);
  assert.notEqual(h1.hash, h2.hash, 'đổi code phải đổi hash');
})

test('ghi marker vào thư mục static của worktree', () => {
  const repo = makeRepo();
  const job = { id: 'j2', task_code: 'T2', worktree_path: repo };
  const res = bp.writeBuildMarker(job, { frontend: 3010 });
  assert.equal(res.written, true);
  assert.ok(res.files.length >= 1);
  const written = JSON.parse(fs.readFileSync(path.join(repo, 'public', bp.MARKER_NAME), 'utf8'));
  assert.equal(written.build_hash, res.hash);
  assert.equal(written.task_code, 'T2');
});

test('service phục vụ đúng hash + vừa start => PASS', async () => {
  const repo = makeRepo();
  const job = { id: 'j3', task_code: 'T3', worktree_path: repo };
  const hash = bp.computeWorktreeHash(job).hash;
  const port = 19210;
  const stepStartedAt = Date.now() - 5000;
  const server = await startMarkerServer(port, { build_hash: hash, ports: { frontend: port } });
  try {
    const res = await bp.checkRuntimeProvenance({
      job, ports: { frontend: port }, stepStartedAt, expectedHash: hash, markerWritten: true
    });
    assert.equal(res.ok, true, JSON.stringify(res.services));
    assert.equal(res.services[0].hashMatched, true);
    assert.equal(res.services[0].restartedInThisStep, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('service phục vụ hash khác (build cũ) => FAIL', async () => {
  const repo = makeRepo();
  const job = { id: 'j4', task_code: 'T4', worktree_path: repo };
  const hash = bp.computeWorktreeHash(job).hash;
  const port = 19211;
  const server = await startMarkerServer(port, { build_hash: 'deadbeefdeadbeef' });
  try {
    const res = await bp.checkRuntimeProvenance({
      job, ports: { frontend: port }, stepStartedAt: Date.now() - 5000, expectedHash: hash, markerWritten: true
    });
    assert.equal(res.ok, false);
    assert.ok(res.services[0].problems.includes('BUILD_HASH_MISMATCH'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('không có service listen => FAIL NO_LISTENER', async () => {
  const repo = makeRepo();
  const job = { id: 'j5', task_code: 'T5', worktree_path: repo };
  const hash = bp.computeWorktreeHash(job).hash;
  const res = await bp.checkRuntimeProvenance({
    job, ports: { frontend: 19212 }, stepStartedAt: Date.now(), expectedHash: hash, markerWritten: true
  });
  assert.equal(res.ok, false);
  assert.ok(res.services[0].problems.includes('NO_LISTENER'));
});

test('process đã chạy TRƯỚC bước test => FAIL REUSED_OLD_PROCESS', async () => {
  const repo = makeRepo();
  const job = { id: 'j6', task_code: 'T6', worktree_path: repo };
  const hash = bp.computeWorktreeHash(job).hash;
  const port = 19213;
  const server = await startMarkerServer(port, { build_hash: hash });
  try {
    // stepStartedAt ở TƯƠNG LAI => process hiện tại bị coi là "cũ".
    const stepStartedAt = Date.now() + 10 * 60 * 1000;
    const res = await bp.checkRuntimeProvenance({
      job, ports: { frontend: port }, stepStartedAt, expectedHash: hash, markerWritten: true
    });
    assert.equal(res.ok, false);
    assert.ok(res.services[0].problems.includes('REUSED_OLD_PROCESS'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
