/**
 * tests/planningReusePlan.test.js
 * PLANNING khi ke hoach da co san (job chay lai) => phai tro DUONG DAN plan
 * cho agent de VERIFY + CAP NHAT, thay vi khao sat lai tu dau.
 *
 * Job RSGATE-44: dev_plan.md 39KB + test_plan.md 48KB da day du, nhung PLANNING
 * mat 20 phut khao sat lai vi agent khong thay plan trong prompt.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultFileManager: fileManager } = require('../src/storage/fileManager');

function makeWorkspace(taskCode, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-plan-'));
  const featureDir = path.join(root, 'docs', 'features', taskCode);
  fs.mkdirSync(featureDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(featureDir, name), content, 'utf8');
  }
  return { root, featureDir };
}

test('PLANNING: co dev_plan + test_plan => prompt tro duong dan ca 2 file', () => {
  const { root } = makeWorkspace('T-REUSE-1', {
    'dev_plan.md': '# dev plan\n' + 'x'.repeat(50000),
    'test_plan.md': '# test plan\n' + 'y'.repeat(60000)
  });
  const ctx = fileManager.loadPreviousContext(root, 'T-REUSE-1', 'planning');
  assert.match(ctx, /dev_plan\.md/, 'phai tro duong dan dev_plan.md');
  assert.match(ctx, /test_plan\.md/, 'phai tro duong dan test_plan.md');
  assert.match(ctx, /Kế hoạch đã có sẵn/, 'phai co tieu de "ke hoach da co san"');
  assert.match(ctx, /KHÔNG khảo sát lại từ đầu/, 'phai yeu cau khong khao sat lai');
});

test('PLANNING: KHONG nhoi full text plan vao prompt (prompt phinh to)', () => {
  const { root } = makeWorkspace('T-REUSE-2', {
    'dev_plan.md': '# dev plan\n' + 'A'.repeat(50000),
    'test_plan.md': '# test plan\n' + 'B'.repeat(60000)
  });
  const ctx = fileManager.loadPreviousContext(root, 'T-REUSE-2', 'planning');
  // 50KB + 60KB = 110KB. Prompt phai nho hon 1/10 cua do (chi duong dan).
  assert.ok(ctx.length < 12000, `prompt phai nho (<12000 ky tu), thuc te ${ctx.length}`);
  assert.equal(ctx.includes('A'.repeat(1000)), false, 'khong duoc nhoi noi dung dev_plan');
  assert.equal(ctx.includes('B'.repeat(1000)), false, 'khong duoc nhoi noi dung test_plan');
});

test('PLANNING: chi co dev_plan => chi tro dev_plan', () => {
  const { root } = makeWorkspace('T-REUSE-3', { 'dev_plan.md': '# dev plan\n' });
  const ctx = fileManager.loadPreviousContext(root, 'T-REUSE-3', 'planning');
  assert.match(ctx, /dev_plan\.md/);
  assert.equal(/test_plan\.md/.test(ctx), false, 'khong tro file khong ton tai');
});

test('PLANNING: khong co plan nao => khong them gi (job moi)', () => {
  const { root } = makeWorkspace('T-REUSE-4', { 'expect.md': '# expect\n' });
  const ctx = fileManager.loadPreviousContext(root, 'T-REUSE-4', 'planning');
  assert.equal(/Kế hoạch đã có sẵn/.test(ctx), false, 'job moi khong duoc tro plan gia');
  assert.match(ctx, /expect\.md/, 'van nap expect.md nhu truoc');
});

test('IMPLEMENT: van nap day du dev_plan + test_plan (khong doi)', () => {
  const { root } = makeWorkspace('T-REUSE-5', {
    'dev_plan.md': '# dev plan\n' + 'A'.repeat(2000),
    'test_plan.md': '# test plan\n' + 'B'.repeat(2000)
  });
  const ctx = fileManager.loadPreviousContext(root, 'T-REUSE-5', 'implement');
  assert.match(ctx, /dev_plan\.md/);
  assert.match(ctx, /test_plan\.md/);
  assert.equal(/Kế hoạch đã có sẵn/.test(ctx), false, 'IMPLEMENT nap noi dung that, khong can tro duong dan');
});

test('TESTING: van nap day du dev_plan + test_plan + report', () => {
  const { root } = makeWorkspace('T-REUSE-6', {
    'dev_plan.md': '# dev plan\n',
    'test_plan.md': '# test plan\n',
    'report.md': '# report\n'
  });
  const ctx = fileManager.loadPreviousContext(root, 'T-REUSE-6', 'testing');
  assert.match(ctx, /dev_plan\.md/);
  assert.match(ctx, /test_plan\.md/);
  assert.match(ctx, /report\.md/);
});
