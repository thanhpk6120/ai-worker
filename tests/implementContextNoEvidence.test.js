/**
 * tests/implementContextNoEvidence.test.js
 * Bước IMPLEMENT không được nạp phần "bằng chứng" của test_plan.md
 * (kế hoạch thu evidence là việc của bước TESTING).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FileManager } = require('../src/storage/fileManager');

function setup() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-impl-ctx-'));
  const dir = path.join(ws, 'docs', 'features', 'T-IMP-01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dev_plan.md'), '# Dev Plan\nSua file A.js');
  fs.writeFileSync(path.join(dir, 'test_plan.md'), [
    '# Test Plan',
    '',
    '## 1. Kiem tra API',
    '- goi GET /api/users',
    '',
    '## 2. Bang chung can thu',
    '- chup man hinh danh sach UI_SCREENSHOT',
    '- luu log runtime LOG_TRACE',
    '',
    '## 3. Pass criteria',
    '- API tra 200'
  ].join('\n'), 'utf8');
  return { ws, dir };
}

test('IMPLEMENT: bo muc "Bang chung can thu" khoi test_plan.md', () => {
  const { ws } = setup();
  const fm = new FileManager();
  const ctx = fm.loadPreviousContext(ws, 'T-IMP-01', 'implement');
  assert.ok(ctx.includes('test_plan.md'), 'van phai nap test_plan.md');
  assert.ok(ctx.includes('Kiem tra API'), 'phan ke hoach kiem thu phai con');
  assert.ok(ctx.includes('Pass criteria'), 'phan con lai phai con');
  assert.ok(!/chup man hinh danh sach/i.test(ctx), 'muc bang chung phai bi lo khoi IMPLEMENT');
  assert.ok(!/luu log runtime/i.test(ctx), 'muc bang chung phai bi lo khoi IMPLEMENT');
});

test('IMPLEMENT-QUICK: cung bo muc bang chung', () => {
  const { ws } = setup();
  const fm = new FileManager();
  const ctx = fm.loadPreviousContext(ws, 'T-IMP-01', 'implement-quick');
  assert.ok(ctx.includes('test_plan.md'));
  assert.ok(!/chup man hinh danh sach/i.test(ctx), 'implement-quick cung phai bo muc bang chung');
});

test('TESTING: van thay day du muc bang chung', () => {
  const { ws } = setup();
  const fm = new FileManager();
  const ctx = fm.loadPreviousContext(ws, 'T-IMP-01', 'testing');
  assert.ok(/chup man hinh danh sach/i.test(ctx), 'TESTING phai thay day du ke hoach bang chung');
  assert.ok(/luu log runtime/i.test(ctx));
});

test('FIXING: van thay day du muc bang chung', () => {
  const { ws } = setup();
  const fm = new FileManager();
  const ctx = fm.loadPreviousContext(ws, 'T-IMP-01', 'fixing');
  assert.ok(/chup man hinh danh sach/i.test(ctx), 'FIXING phai thay day du ke hoach bang chung');
});
