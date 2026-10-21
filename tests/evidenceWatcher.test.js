/**
 * tests/evidenceWatcher.test.js
 * Evidence realtime: watcher phai phat event khi file evidence moi xuat hien.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EvidenceWatcher } = require('../src/verification/evidenceWatcher');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-watch-'));
}

test('watcher phat event khi file moi duoc tao', async () => {
  const dir = tmpDir();
  const seen = [];
  const w = new EvidenceWatcher({
    evidenceDir: dir,
    snapshot: () => {
      try {
        return fs.readdirSync(dir)
          .filter((f) => f !== 'metadata.json')
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return { fileName: f, mtimeMs: st.mtimeMs, sizeBytes: st.size, status: 'NOT VERIFY' };
          });
      } catch (e) { return []; }
    },
    onChange: (item) => seen.push(item)
  });
  w.start();

  fs.writeFileSync(path.join(dir, 'shot.png'), Buffer.alloc(6000, 1));
  // Cho watcher quet (poll fallback 2s hoac fs.watch debounce 500ms).
  await new Promise((r) => setTimeout(r, 1200));
  w.scan();
  await new Promise((r) => setTimeout(r, 300));

  w.stop();
  assert.ok(seen.length >= 1, 'phai phat it nhat 1 event');
  assert.ok(seen.some((s) => s.fileName === 'shot.png'), 'event phai chua file moi');
});

test('watcher khong phat lai khi khong co thay doi', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(6000, 1));
  const seen = [];
  const w = new EvidenceWatcher({
    evidenceDir: dir,
    snapshot: () => {
      try {
        return fs.readdirSync(dir)
          .filter((f) => f !== 'metadata.json')
          .map((f) => ({ fileName: f, mtimeMs: 0, sizeBytes: 1, status: 'NOT VERIFY' }));
      } catch (e) { return []; }
    },
    onChange: (item) => seen.push(item)
  });
  w.start();
  const afterStart = seen.length;
  w.scan();
  w.scan();
  w.stop();
  assert.equal(seen.length, afterStart, 'khong duoc phat lai cung mot trang thai');
});

test('watcher phat lai khi trang thai evidence doi', async () => {
  const dir = tmpDir();
  const seen = [];
  let status = 'NOT VERIFY';
  const w = new EvidenceWatcher({
    evidenceDir: dir,
    snapshot: () => [{ fileName: 'a.png', mtimeMs: 1, sizeBytes: 1, status }],
    onChange: (item) => seen.push(item)
  });
  w.start();
  const before = seen.length;
  status = 'PASS';
  w.scan();
  w.stop();
  assert.ok(seen.length > before, 'doi trang thai phai phat event');
  assert.equal(seen[seen.length - 1].status, 'PASS');
});
