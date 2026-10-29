const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const db = require('../src/storage/db');
const worktreeManager = require('../src/utils/worktreeManager');
const { JOB_STATUSES, canTransition, validateTransition } = require('../src/state/stateMachine');
const { TaskQueue } = require('../src/queue/taskQueue');

describe('Polyrepo Multi-Service & Worktree Merging Test Suite', () => {
  const testTmpDir = path.resolve(__dirname, 'tmp_polyrepo_test_' + Date.now());
  let testWsId = null;
  let serviceARepoPath = null;
  let serviceBRepoPath = null;

  before(() => {
    // Đảm bảo DB đã init
    db.initDb();

    // Tạo thư mục test polyrepo giả lập
    fs.mkdirSync(testTmpDir, { recursive: true });

    // Tạo workspace test trong DB
    const ws = db.createWorkspace({
      name: 'Polyrepo Test Workspace',
      path: testTmpDir,
      features_dir: 'docs/features'
    });
    testWsId = ws.id;

    // Tạo Service A (git repo con với branch develop)
    serviceARepoPath = path.join(testTmpDir, 'auth-service');
    fs.mkdirSync(serviceARepoPath, { recursive: true });
    execSync('git init', { cwd: serviceARepoPath, stdio: 'ignore' });
    execSync('git config user.name "Test AI"', { cwd: serviceARepoPath, stdio: 'ignore' });
    execSync('git config user.email "test@ai.local"', { cwd: serviceARepoPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(serviceARepoPath, 'README.md'), '# Auth Service\n');
    execSync('git add README.md && git commit -m "init auth"', { cwd: serviceARepoPath, stdio: 'ignore' });
    execSync('git branch -M develop', { cwd: serviceARepoPath, stdio: 'ignore' });

    // Tạo Service B (git repo con với branch main)
    serviceBRepoPath = path.join(testTmpDir, 'order-service');
    fs.mkdirSync(serviceBRepoPath, { recursive: true });
    execSync('git init', { cwd: serviceBRepoPath, stdio: 'ignore' });
    execSync('git config user.name "Test AI"', { cwd: serviceBRepoPath, stdio: 'ignore' });
    execSync('git config user.email "test@ai.local"', { cwd: serviceBRepoPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(serviceBRepoPath, 'README.md'), '# Order Service\n');
    execSync('git add README.md && git commit -m "init order"', { cwd: serviceBRepoPath, stdio: 'ignore' });
    execSync('git branch -M main', { cwd: serviceBRepoPath, stdio: 'ignore' });
  });

  after(() => {
    // Dọn dẹp test workspace và thư mục tạm vào trash
    try {
      if (testWsId) db.deleteWorkspace(testWsId);
    } catch {}
    try {
      worktreeManager.safeMoveToTrash(testTmpDir);
    } catch {}
  });

  // ========================================================
  // 1. Database CRUD Tests for workspace_services & job_worktrees
  // ========================================================
  describe('1. Database CRUD (workspace_services & job_worktrees)', () => {
    let createdServiceId = null;

    test('addWorkspaceService() thêm service vào workspace thành công', () => {
      const svc = db.addWorkspaceService({
        workspace_id: testWsId,
        service_key: 'auth-service',
        repo_path: './auth-service',
        dev_branch: 'develop',
        deploy_branch: 'production',
        is_enabled: 1
      });

      assert.ok(svc, 'Service được tạo');
      assert.ok(svc.id, 'Có id');
      assert.equal(svc.service_key, 'auth-service');
      assert.equal(svc.dev_branch, 'develop');
      assert.equal(svc.deploy_branch, 'production');
      createdServiceId = svc.id;
    });

    test('listWorkspaceServices() liệt kê danh sách service của workspace', () => {
      const list = db.listWorkspaceServices(testWsId);
      assert.ok(Array.isArray(list));
      assert.equal(list.length, 1);
      assert.equal(list[0].service_key, 'auth-service');
    });

    test('getWorkspaceServiceByKey() tìm đúng service theo key', () => {
      const svc = db.getWorkspaceServiceByKey(testWsId, 'auth-service');
      assert.ok(svc);
      assert.equal(svc.id, createdServiceId);
    });

    test('updateWorkspaceService() cập nhật nhánh dev thành công', () => {
      const updated = db.updateWorkspaceService(createdServiceId, {
        dev_branch: 'release/v1',
        is_enabled: 0
      });
      assert.ok(updated);
      assert.equal(updated.dev_branch, 'release/v1');
      assert.equal(updated.is_enabled, 0);
    });

    test('addJobWorktree() và listJobWorktrees() theo dõi worktree của task', () => {
      const testJobId = 'job-test-wt-' + Date.now();
      db.createJob({
        id: testJobId,
        title: 'Test Worktree Job',
        prompt: 'Testing worktrees'
      });

      const wt = db.addJobWorktree({
        job_id: testJobId,
        service_key: 'auth-service',
        worktree_path: '/tmp/worktrees/task-1/auth-service',
        task_branch: 'feature/TASK-1024',
        base_dev_branch: 'develop',
        status: 'ACTIVE'
      });

      assert.ok(wt);
      assert.equal(wt.job_id, testJobId);
      assert.equal(wt.service_key, 'auth-service');
      assert.equal(wt.status, 'ACTIVE');

      const list = db.listJobWorktrees(testJobId);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, wt.id);

      // Update status
      const updatedWt = db.updateJobWorktreeStatus(wt.id, 'MERGED');
      assert.equal(updatedWt.status, 'MERGED');

      // Delete
      const delRes = db.deleteJobWorktree(wt.id);
      assert.equal(delRes.success, true);

      // Clean test job
      try {
        db.deleteJob(testJobId);
      } catch {}
    });

    test('deleteWorkspaceService() xóa service thành công', () => {
      const del = db.deleteWorkspaceService(createdServiceId);
      assert.equal(del.success, true);
      const remaining = db.listWorkspaceServices(testWsId);
      assert.equal(remaining.length, 0);
    });
  });

  // ========================================================
  // 2. WorktreeManager Core Utilities
  // ========================================================
  describe('2. WorktreeManager Core Utilities', () => {
    test('scanWorkspaceServices() tự động nhận diện git repos cấp 1 và lấy đúng nhánh checkout hiện tại', () => {
      const detected = worktreeManager.scanWorkspaceServices(testTmpDir);
      assert.ok(Array.isArray(detected));
      assert.equal(detected.length, 2, 'Tìm thấy 2 services (auth-service và order-service)');

      const authSvc = detected.find(s => s.service_key === 'auth-service');
      assert.ok(authSvc, 'Có auth-service');
      assert.equal(authSvc.dev_branch, 'develop', 'Nhánh dev của auth-service đúng là develop');

      const orderSvc = detected.find(s => s.service_key === 'order-service');
      assert.ok(orderSvc, 'Có order-service');
      assert.equal(orderSvc.dev_branch, 'main', 'Nhánh dev của order-service đúng là main');
    });

    test('createTaskWorktree() và removeTaskWorktree() tạo và xóa worktree an toàn', () => {
      const wtDest = path.join(testTmpDir, '.worktrees', 'TASK-TEST-01', 'auth-service');
      const createRes = worktreeManager.createTaskWorktree({
        repoFullPath: serviceARepoPath,
        worktreeDestPath: wtDest,
        taskBranch: 'feature/TASK-TEST-01',
        baseDevBranch: 'develop'
      });

      assert.equal(createRes.success, true, 'Tạo worktree thành công');
      assert.ok(fs.existsSync(wtDest), 'Thư mục worktree tồn tại');
      assert.ok(fs.existsSync(path.join(wtDest, '.git')), 'Thư mục .git worktree tồn tại');

      // Kiểm tra nhánh của worktree
      const wtBranch = worktreeManager.getRepoCurrentBranch(wtDest);
      assert.equal(wtBranch, 'feature/TASK-TEST-01', 'Worktree đang ở nhánh feature/TASK-TEST-01');

      // Xóa worktree an toàn
      const removeRes = worktreeManager.removeTaskWorktree(serviceARepoPath, wtDest);
      assert.equal(removeRes, true, 'Gỡ worktree thành công');
    });

    test('ensureCleanWorkingTree() và restoreWorkingTree() tự động stash và pop khi repo gốc có thay đổi', () => {
      // Tạo file dở dang ở repo gốc
      const dirtyFile = path.join(serviceARepoPath, 'uncommitted.txt');
      fs.writeFileSync(dirtyFile, 'dirty work in progress');

      const stashInfo = worktreeManager.ensureCleanWorkingTree(serviceARepoPath);
      assert.equal(stashInfo.stashed, true, 'Đã tự động stash uncommitted changes');

      // File dở dang đã được giấu
      assert.equal(fs.existsSync(dirtyFile), false, 'File dirty đã được stash');

      // Phục hồi lại
      worktreeManager.restoreWorkingTree(serviceARepoPath, stashInfo);
      assert.equal(fs.existsSync(dirtyFile), true, 'File dirty đã được restore sau khi pop');

      // Dọn dẹp file
      fs.unlinkSync(dirtyFile);
    });

    test('mergeBranch() xử lý clean merge thành công', () => {
      // 1. Tạo worktree và sửa file
      const wtDest = path.join(testTmpDir, '.worktrees', 'TASK-MERGE-CLEAN', 'order-service');
      worktreeManager.createTaskWorktree({
        repoFullPath: serviceBRepoPath,
        worktreeDestPath: wtDest,
        taskBranch: 'feature/TASK-MERGE-CLEAN',
        baseDevBranch: 'main'
      });

      fs.writeFileSync(path.join(wtDest, 'feature_clean.txt'), 'clean new feature code');
      execSync('git add feature_clean.txt && git commit -m "add clean feature"', { cwd: wtDest, stdio: 'ignore' });

      // 2. Merge vào nhánh main ở repo gốc
      const mRes = worktreeManager.mergeBranch({
        repoFullPath: serviceBRepoPath,
        targetDevBranch: 'main',
        taskBranch: 'feature/TASK-MERGE-CLEAN'
      });

      assert.equal(mRes.success, true, 'Merge thành công không conflict');
      assert.equal(mRes.conflict, false);
      assert.ok(fs.existsSync(path.join(serviceBRepoPath, 'feature_clean.txt')), 'File mới đã được merge vào repo gốc');

      // Dọn worktree
      worktreeManager.removeTaskWorktree(serviceBRepoPath, wtDest);
    });

    test('mergeBranch() phát hiện conflict và abortMerge() hoàn tác an toàn', () => {
      // Tạo conflict giữa repo gốc và task branch
      const conflictTaskBranch = 'feature/TASK-CONFLICT-TEST';
      const wtDest = path.join(testTmpDir, '.worktrees', 'TASK-CONFLICT-TEST', 'order-service');
      worktreeManager.createTaskWorktree({
        repoFullPath: serviceBRepoPath,
        worktreeDestPath: wtDest,
        taskBranch: conflictTaskBranch,
        baseDevBranch: 'main'
      });

      // Task sửa file conflicting.txt
      fs.writeFileSync(path.join(wtDest, 'conflicting.txt'), 'version from task');
      execSync('git add conflicting.txt && git commit -m "task conflicting commit"', { cwd: wtDest, stdio: 'ignore' });

      // Repo gốc cũng sửa conflicting.txt khác nội dung
      fs.writeFileSync(path.join(serviceBRepoPath, 'conflicting.txt'), 'version from root dev branch');
      execSync('git add conflicting.txt && git commit -m "root conflicting commit"', { cwd: serviceBRepoPath, stdio: 'ignore' });

      // Merge sẽ phát sinh conflict
      const mRes = worktreeManager.mergeBranch({
        repoFullPath: serviceBRepoPath,
        targetDevBranch: 'main',
        taskBranch: conflictTaskBranch
      });

      assert.equal(mRes.success, false, 'Merge báo thất bại do conflict');
      assert.equal(mRes.conflict, true, 'Phát hiện conflict');
      assert.ok(Array.isArray(mRes.conflictFiles));
      assert.ok(mRes.conflictFiles.includes('conflicting.txt'), 'File conflicting.txt nằm trong danh sách conflict');

      // Abort merge an toàn
      const aborted = worktreeManager.abortMerge(serviceBRepoPath);
      assert.equal(aborted, true, 'Hủy merge thành công');

      // Dọn worktree
      worktreeManager.removeTaskWorktree(serviceBRepoPath, wtDest);
    });
  });

  // ========================================================
  // 3. State Machine & Transitions with MERGING
  // ========================================================
  describe('3. State Machine with MERGING status', () => {
    test('JOB_STATUSES chứa trạng thái MERGING', () => {
      assert.equal(JOB_STATUSES.MERGING, 'MERGING');
    });

    test('Cho phép chuyển từ VERIFY sang MERGING khi nghiệm thu đạt', () => {
      assert.equal(canTransition(JOB_STATUSES.VERIFY, JOB_STATUSES.MERGING), true);
      assert.doesNotThrow(() => validateTransition(JOB_STATUSES.VERIFY, JOB_STATUSES.MERGING));
    });

    test('Cho phép chuyển từ MERGING sang DONE khi merge thành công', () => {
      assert.equal(canTransition(JOB_STATUSES.MERGING, JOB_STATUSES.DONE), true);
      assert.doesNotThrow(() => validateTransition(JOB_STATUSES.MERGING, JOB_STATUSES.DONE));
    });

    test('Cho phép chuyển từ MERGING về FIXING khi có conflict merge', () => {
      assert.equal(canTransition(JOB_STATUSES.MERGING, JOB_STATUSES.FIXING), true);
      assert.doesNotThrow(() => validateTransition(JOB_STATUSES.MERGING, JOB_STATUSES.FIXING));
    });

    test('Cho phép chuyển từ FIXING sang MERGING', () => {
      assert.equal(canTransition(JOB_STATUSES.FIXING, JOB_STATUSES.MERGING), true);
      assert.doesNotThrow(() => validateTransition(JOB_STATUSES.FIXING, JOB_STATUSES.MERGING));
    });
  });

  // ========================================================
  // 4. TaskQueue Service-Level Locking & Exclusive Dev Lock
  // ========================================================
  describe('4. TaskQueue Service-Level & Exclusive Dev Lock', () => {
    test('Các task có worktree_path riêng được cấp workspaceKey độc lập để chạy song song', () => {
      const q = new TaskQueue(3);
      const job1 = { id: 'job-1', worktree_path: 'D:/ws/.worktrees/task-1', workspace_id: 'ws-poly' };
      const job2 = { id: 'job-2', worktree_path: 'D:/ws/.worktrees/task-2', workspace_id: 'ws-poly' };

      const key1 = q._getWorkspaceKey(job1);
      const key2 = q._getWorkspaceKey(job2);

      assert.notEqual(key1, key2, 'Hai task trong cùng workspace nhưng có worktree riêng không bị trùng key');
    });

    test('acquireDevLock() và releaseDevLock() quản lý khóa đơn luồng theo service', () => {
      const q = new TaskQueue(2);
      const svc = 'order-service';
      const wsId = 'ws-test-lock';

      // Job 1 giành lock
      const acquired1 = q.acquireDevLock(svc, 'job-1', wsId);
      assert.equal(acquired1, true, 'Job 1 giành được Exclusive Dev Lock');
      assert.equal(q.isDevLocked(svc, wsId), true, 'Service đang bị khóa');

      // Job 2 thử giành lock trên cùng service -> Thất bại
      const acquired2 = q.acquireDevLock(svc, 'job-2', wsId);
      assert.equal(acquired2, false, 'Job 2 bị chặn vì service đang bị Job 1 giữ');

      // Job 2 thử giành lock trên service KHÁC -> Thành công
      const acquired2Other = q.acquireDevLock('auth-service', 'job-2', wsId);
      assert.equal(acquired2Other, true, 'Job 2 giành được lock trên service khác');

      // Job 1 nhả lock
      const released1 = q.releaseDevLock(svc, 'job-1', wsId);
      assert.equal(released1, true, 'Job 1 nhả lock thành công');

      // Giờ Job 2 có thể giành lock trên order-service
      const acquired2Retry = q.acquireDevLock(svc, 'job-2', wsId);
      assert.equal(acquired2Retry, true, 'Job 2 giành được lock sau khi Job 1 nhả');
    });

    test('releaseAllDevLocksForJob() giải phóng toàn bộ dev lock khi job hoàn tất hoặc bị hủy', () => {
      const q = new TaskQueue(2);
      q.acquireDevLock('svc-1', 'job-crash', 'ws-1');
      q.acquireDevLock('svc-2', 'job-crash', 'ws-1');

      assert.equal(q.isDevLocked('svc-1', 'ws-1'), true);
      assert.equal(q.isDevLocked('svc-2', 'ws-1'), true);

      const count = q.releaseAllDevLocksForJob('job-crash');
      assert.equal(count, 2, 'Giải phóng đúng 2 locks');
      assert.equal(q.isDevLocked('svc-1', 'ws-1'), false);
      assert.equal(q.isDevLocked('svc-2', 'ws-1'), false);
    });
  });
  // ========================================================
  // 5. Three-Tier State (Manifest & Registry) & Re-test Runner
  // ========================================================
  describe('5. Three-Tier State (Manifest & Registry) & Re-test Runner', () => {
    test('saveTaskManifest() và loadTaskManifest() đọc ghi .task-manifest.json chuẩn xác', () => {
      const taskWtDir = path.join(testTmpDir, '.worktrees', 'TASK-MANIFEST-TEST');
      const manifestData = {
        task_code: 'TASK-MANIFEST-TEST',
        branch: 'feature/TASK-MANIFEST-TEST',
        services: [
          { service: 'auth-service', dev_branch: 'develop' }
        ]
      };

      const saved = worktreeManager.saveTaskManifest(taskWtDir, manifestData);
      assert.ok(saved);
      assert.equal(saved.task_code, 'TASK-MANIFEST-TEST');
      assert.ok(fs.existsSync(path.join(taskWtDir, '.task-manifest.json')));

      const loaded = worktreeManager.loadTaskManifest(taskWtDir);
      assert.ok(loaded);
      assert.equal(loaded.task_code, 'TASK-MANIFEST-TEST');
      assert.equal(loaded.services.length, 1);
    });

    test('exportWorktreesRegistry() xuất snapshot worktrees/registry.json (Tầng 3)', () => {
      const regDir = path.join(testTmpDir, 'worktrees');
      const sampleWts = [
        { id: 'wt-1', service_key: 'auth-service', status: 'ACTIVE' },
        { id: 'wt-2', service_key: 'order-service', status: 'ACTIVE' }
      ];

      const outPath = worktreeManager.exportWorktreesRegistry(sampleWts, regDir);
      assert.ok(outPath);
      assert.ok(fs.existsSync(outPath));

      const content = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
      assert.equal(content.count, 2);
      assert.equal(content.worktrees.length, 2);
    });

    test('runServiceTest() thực thi kiểm thử trên repo gốc thành công', () => {
      // Test trên serviceBRepoPath (có thể pass cơ bản)
      const res = worktreeManager.runServiceTest(serviceBRepoPath);
      assert.equal(typeof res.passed, 'boolean');
      assert.ok(res.output);
    });
  });
  // ========================================================
  // 6. pullLatestCode with Remote Origin
  // ========================================================
  describe('6. pullLatestCode with Remote Origin', () => {
    test('pullLatestCode() kéo commit mới từ remote khi cùng nhánh và cập nhật ref local khi khác nhánh', () => {
      // 1. Tạo bare repo làm origin
      const bareRepoDir = path.join(testTmpDir, 'bare_origin.git');
      fs.mkdirSync(bareRepoDir, { recursive: true });
      execSync('git init --bare', { cwd: bareRepoDir, stdio: 'ignore' });
      execSync('git symbolic-ref HEAD refs/heads/develop', { cwd: bareRepoDir, stdio: 'ignore' });

      // 2. Push từ serviceARepoPath lên bare_origin
      execSync(`git remote add origin "${bareRepoDir.replace(/\\/g, '/')}"`, { cwd: serviceARepoPath, stdio: 'ignore' });
      execSync('git push -u origin develop', { cwd: serviceARepoPath, stdio: 'ignore' });
      // 3. Tạo client thứ 2 push commit mới lên remote origin
      const client2Dir = path.join(testTmpDir, 'client2_repo');
      execSync(`git clone "${bareRepoDir.replace(/\\/g, '/')}" "${client2Dir}"`, { stdio: 'ignore' });
      execSync('git config user.name "Client2"', { cwd: client2Dir, stdio: 'ignore' });
      execSync('git config user.email "c2@test.local"', { cwd: client2Dir, stdio: 'ignore' });
      fs.writeFileSync(path.join(client2Dir, 'remote_update.txt'), 'content from remote client');
      execSync('git add remote_update.txt && git commit -m "commit from remote"', { cwd: client2Dir, stdio: 'ignore' });
      execSync('git push origin develop', { cwd: client2Dir, stdio: 'ignore' });

      // 4. Test Case A: Ở serviceARepoPath đang checkout develop -> pullLatestCode kéo file về
      const pullRes1 = worktreeManager.pullLatestCode(serviceARepoPath, 'develop');
      assert.equal(pullRes1, true);
      assert.ok(fs.existsSync(path.join(serviceARepoPath, 'remote_update.txt')), 'File từ remote đã được kéo về');

      // 5. Test Case B: Tạo branch khác trên serviceARepoPath (feature/local-other)
      execSync('git checkout -b feature/local-other', { cwd: serviceARepoPath, stdio: 'ignore' });

      // Client 2 push thêm commit nữa lên develop
      fs.writeFileSync(path.join(client2Dir, 'remote_update_2.txt'), 'second content from remote');
      execSync('git add remote_update_2.txt && git commit -m "second commit"', { cwd: client2Dir, stdio: 'ignore' });
      execSync('git push origin develop', { cwd: client2Dir, stdio: 'ignore' });

      // Gọi pullLatestCode cho nhánh develop khi đang checkout feature/local-other
      const pullRes2 = worktreeManager.pullLatestCode(serviceARepoPath, 'develop');
      assert.equal(pullRes2, true);

      // Nhánh HEAD hiện tại vẫn là feature/local-other và không bị nhiễm file remote_update_2.txt
      assert.equal(worktreeManager.getRepoCurrentBranch(serviceARepoPath), 'feature/local-other');
      assert.equal(fs.existsSync(path.join(serviceARepoPath, 'remote_update_2.txt')), false, 'HEAD không bị merge bẩn');

      // Nhưng ref local của develop đã được cập nhật
      const devCommit = execSync('git rev-parse develop', { cwd: serviceARepoPath, encoding: 'utf-8' }).trim();
      const remoteCommit = execSync('git rev-parse origin/develop', { cwd: serviceARepoPath, encoding: 'utf-8' }).trim();
      assert.equal(devCommit, remoteCommit, 'Ref local của develop đã được cập nhật khớp với remote');

      // Trở lại nhánh develop
      execSync('git checkout develop', { cwd: serviceARepoPath, stdio: 'ignore' });
    });
  });
});
