/**
 * tests/fileContext.test.js
 * Unit offline cho src/systemone/fileContext.js:
 * - gom noi dung file vao state (gateway chi doc `state`)
 * - cat theo ngan sach context (khong vuot context window cua model)
 * - bo qua file binary / build / dep
 * - khong doc file ngoài workspace (ke ca thu muc anh em cung tien to)
 * - listChangedFiles gom ca file UNTRACKED (output cua buoc IMPLEMENT)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');

const {
  collectFileContext,
  mergeStateWithFiles,
  listChangedFiles,
  isReadableTextFile,
  isInsideWorkspace,
  CHARS_PER_TOKEN
} = require('../src/systemone/fileContext');

let ws = null;

before(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'filecontext-'));
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'a.js'), 'const a = 1;\n'.repeat(50));
  fs.writeFileSync(path.join(ws, 'src', 'big.js'), 'x'.repeat(200000));
  fs.writeFileSync(path.join(ws, 'node_modules', 'dep.js'), 'should be skipped');
  fs.writeFileSync(path.join(ws, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

after(() => {
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (e) {}
});

describe('fileContext - gom noi dung file', () => {
  it('doc duoc noi dung file text va gan nhanh', async () => {
    const r = await collectFileContext(['src/a.js'], { workspacePath: ws });
    assert.equal(r.files.length, 1);
    assert.ok(r.text.includes('const a = 1;'), 'phai chua noi dung file thật');
    assert.ok(r.text.includes('--- FILE:'), 'phai co nhan file');
    assert.equal(r.truncatedFiles.length, 0);
  });

  it('bo qua file trong node_modules', async () => {
    const r = await collectFileContext(['node_modules/dep.js'], { workspacePath: ws });
    assert.equal(r.files.length, 0);
    assert.ok(r.skipped.includes('node_modules/dep.js'));
  });

  it('bo qua file binary (khong phai text)', async () => {
    assert.strictEqual(isReadableTextFile(path.join(ws, 'image.png')), false);
    const r = await collectFileContext(['image.png'], { workspacePath: ws });
    assert.equal(r.files.length, 0);
  });

  it('cat file lon theo ngan sach context va bao cao file bi cat', async () => {
    const r = await collectFileContext(['src/big.js'], { workspacePath: ws, maxStateTokens: 1000 });
    assert.equal(r.files.length, 1);
    assert.deepEqual(r.truncatedFiles, ['src/big.js']);
    assert.ok(r.text.includes('TRUNCATED'));
    assert.ok(r.tokens <= 1000 + 50, `tokens ${r.tokens} vuot ngan sach`);
  });

  it('nhieu file: tong tokens van duoi ngan sach', async () => {
    const r = await collectFileContext(['src/big.js', 'src/a.js'], { workspacePath: ws, maxStateTokens: 2000 });
    assert.ok(r.tokens <= 2000 + 100, `tokens ${r.tokens} vuot ngan sach`);
  });

  it('khong doc file ngoài workspace khi duong dan tuong doi', async () => {
    const r = await collectFileContext(['../outside.js'], { workspacePath: ws });
    assert.equal(r.files.length, 0);
    assert.ok(r.skipped.length >= 1);
  });

  it('khong doc thu muc anh em cung tien to (ws-evil)', async () => {
    // ws = <tmp>/filecontext-xxx ; sibling = <tmp>/filecontext-xxx-evil
    const evil = `${ws}-evil`;
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'secret.js'), 'SECRET_CONTENT_MARKER');
    try {
      const r = await collectFileContext([path.join(evil, 'secret.js')], { workspacePath: ws });
      assert.equal(r.files.length, 0, 'khong duoc doc file trong thu muc anh em');
      assert.ok(!r.text.includes('SECRET_CONTENT_MARKER'), 'khong duoc lo noi dung file ngoài workspace');
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });
});

describe('fileContext - isInsideWorkspace', () => {
  it('tu choi duong dan cung tien to', () => {
    const wsAbs = path.resolve('C:\\a\\ws');
    assert.strictEqual(isInsideWorkspace(path.resolve('C:\\a\\ws\\x.js'), wsAbs), true);
    assert.strictEqual(isInsideWorkspace(path.resolve('C:\\a\\ws-evil\\x.js'), wsAbs), false);
    assert.strictEqual(isInsideWorkspace(path.resolve('C:\\a\\other\\x.js'), wsAbs), false);
  });
});

describe('fileContext - merge state', () => {
  it('noi dung file duoc nhung vao state (gateway chi doc state)', () => {
    const state = mergeStateWithFiles('Job X fix attempt 1/3.', '--- FILE: src/a.js ---\nconst a = 1;');
    assert.ok(state.includes('Job X fix attempt 1/3.'));
    assert.ok(state.includes('const a = 1;'), 'noi dung file phai nam trong state');
  });

  it('cat state theo budget (khong vuot context window)', () => {
    const big = 'y'.repeat(100000);
    const s = mergeStateWithFiles(big, 'file body', 1000);
    assert.ok(s.length <= 1000 * CHARS_PER_TOKEN + 10, `state dai ${s.length}`);
  });

  it('state rong + file rong => chuoi rong', () => {
    assert.strictEqual(mergeStateWithFiles('', ''), '');
  });
});

describe('fileContext - listChangedFiles', () => {
  it('tra ve danh sach file (fallback khi khong phai git repo)', async () => {
    const files = await listChangedFiles(ws, ['src/a.js', 'src/b.js'], 8);
    assert.ok(Array.isArray(files));
    assert.ok(files.length <= 8);
  });

  it('gioi han maxFiles', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i}.js`);
    assert.equal((await listChangedFiles(ws, many, 5)).length, 5);
  });

  it('gom ca file UNTRACKED (git diff KHONG thay duoc)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrepo-'));
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: repo, stdio: 'ignore' });
      fs.writeFileSync(path.join(repo, 'tracked.js'), 'const t = 1;');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
      // File agent TAO MOI o buoc IMPLEMENT => untracked
      fs.writeFileSync(path.join(repo, 'created-by-agent.js'), 'const n = 2;');
      // File da track bi sua
      fs.writeFileSync(path.join(repo, 'tracked.js'), 'const t = 2;');

      const files = await listChangedFiles(repo, [], 8);
      assert.ok(files.includes('created-by-agent.js'), `phai thay file untracked, got: ${JSON.stringify(files)}`);
      assert.ok(files.includes('tracked.js'), `phai thay file da sua, got: ${JSON.stringify(files)}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('uu tien file co ten trong stack trace truoc file khac', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrepo2-'));
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: repo, stdio: 'ignore' });
      fs.writeFileSync(path.join(repo, 'aaa-doc.md'), 'doc');
      fs.writeFileSync(path.join(repo, 'zzz-target.js'), 'const z = 1;');
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
      fs.writeFileSync(path.join(repo, 'aaa-doc.md'), 'doc2');
      fs.writeFileSync(path.join(repo, 'zzz-target.js'), 'const z = 2;');

      const files = await listChangedFiles(repo, [], 8, 'Error in zzz-target.js at line 10');
      assert.strictEqual(files[0], 'zzz-target.js', `file trong stack trace phai dung dau, got: ${JSON.stringify(files)}`);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
