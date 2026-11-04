/**
 * tests/worktreeRestore.test.js
 * Bảo vệ hành vi [WORKTREE-RESTORE]: khi job được mở lại (FIXING/TESTING) mà worktree
 * đã bị dọn ở bước MERGING, worker phải tạo lại worktree thay vì chạy agent trong
 * repo chính (sửa trực tiếp cây dev, không thuộc branch nào, không merge lại được).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const db = require('../src/storage/db');
const { restoreMissingJobWorktree } = require('../src/server');

describe('WORKTREE-RESTORE - tạo lại worktree khi job mở lại sau merge', () => {
  const tmpDir = path.resolve(__dirname, 'tmp_worktree_restore_' + Date.now());
  const repoPath = path.join(tmpDir, 'svc-fe');
  const taskCode = 'T-RESTORE-1';
  let wsId = null;
  let jobId = null;

  const git = (cmd) => execSync(cmd, { cwd: repoPath, stdio: 'ignore' });

  before(() => {
    db.initDb();
    fs.mkdirSync(repoPath, { recursive: true });
    git('git init');
    git('git config user.name "Test AI"');
    git('git config user.email "test@ai.local"');
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# FE Service\n');
    git('git add README.md');
    git('git commit -m "init"');
    git('git branch -M dev');
    git(`git branch feature/${taskCode}`);

    const ws = db.createWorkspace({
      name: 'WS Restore Worktree',
      path: tmpDir,
      features_dir: 'docs/features'
    });
    wsId = ws.id;
    // repo_path của service là tương đối so với workspace path
    db.addWorkspaceService({
      workspace_id: wsId,
      service_key: 'svc-fe',
      repo_path: 'svc-fe',
      dev_branch: 'dev'
    });

    jobId = 'test-job-restore-' + Date.now();
    db.createJob({
      id: jobId,
      task_code: taskCode,
      title: 'Task kiểm thử restore worktree',
      prompt: 'restore worktree',
      status: 'FIXING',
      current_step: 'FIXING',
      workspace_id: wsId,
      repo_path: tmpDir,
      base_branch: 'dev'
    });
  });

  after(() => {
    try {
      execSync('git worktree prune', { cwd: repoPath, stdio: 'ignore' });
    } catch (e) {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  });

  test('job không có bản ghi worktree nào (docs-only) thì trả null, không ném lỗi', () => {
    const job = db.getJobById(jobId);
    const restored = restoreMissingJobWorktree(job, tmpDir, 'T-DOCS-ONLY');
    assert.equal(restored, null);
  });

  test('worktree bị dọn (CANCELLED) được tạo lại và cập nhật đúng bản ghi cũ', () => {
    const stalePath = path.join(repoPath, '.worktrees', taskCode);
    const row = db.addJobWorktree({
      job_id: jobId,
      service_key: 'svc-fe',
      worktree_path: stalePath,
      task_branch: `feature/${taskCode}`,
      base_dev_branch: 'dev',
      status: 'CANCELLED'
    });
    assert.equal(fs.existsSync(stalePath), false, 'worktree cũ phải không còn trên đĩa');

    const job = db.getJobById(jobId);
    const restored = restoreMissingJobWorktree(job, tmpDir, taskCode);

    assert.ok(restored, 'phải tạo lại được worktree');
    assert.equal(fs.existsSync(restored), true);
    assert.equal(fs.existsSync(path.join(restored, 'README.md')), true);

    const rows = db.listJobWorktrees(jobId);
    assert.equal(rows.length, 1, 'không được tạo bản ghi worktree trùng lặp');

    const saved = db.getJobWorktreeById(row.id);
    assert.equal(saved.status, 'ACTIVE');
    assert.equal(saved.worktree_path, restored);
  });

  test('updateJobWorktreeRestore cập nhật cả worktree_path và status', () => {
    const rows = db.listJobWorktrees(jobId);
    assert.equal(rows.length, 1);
    const newPath = path.join(repoPath, '.worktrees', taskCode + '-moved');
    const updated = db.updateJobWorktreeRestore(rows[0].id, newPath, 'ACTIVE');
    assert.equal(updated.worktree_path, newPath);
    assert.equal(updated.status, 'ACTIVE');
  });
});
