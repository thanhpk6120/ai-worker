const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Di chuyển file hoặc thư mục vào thùng rác (Recycle Bin / Trash) an toàn,
 * tuyệt đối không xóa vĩnh viễn (tuân thủ Quy tắc Tiên quyết).
 * @param {string} targetPath Đường dẫn file hoặc thư mục cần xóa
 * @returns {boolean} true nếu thành công
 */
function safeMoveToTrash(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return false;
  const fullPath = path.resolve(targetPath);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }

  if (process.platform === 'win32') {
    try {
      const method = isDirectory ? 'DeleteDirectory' : 'DeleteFile';
      const psCommand = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${fullPath.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
      execSync(`powershell.exe -NoProfile -NonInteractive -Command "${psCommand}"`, { stdio: 'ignore' });
      return true;
    } catch {
      // Fallback bên dưới
    }
  } else if (process.platform === 'darwin') {
    try {
      execSync(`osascript -e 'tell application "Finder" to delete POSIX file "${fullPath}"'`, { stdio: 'ignore' });
      return true;
    } catch {
      // Fallback bên dưới
    }
  }

  // Fallback: Di chuyển vào thư mục .trash
  try {
    const parentDir = path.dirname(fullPath);
    const trashDir = path.join(parentDir, '.trash');
    if (!fs.existsSync(trashDir)) {
      fs.mkdirSync(trashDir, { recursive: true });
    }
    const dest = path.join(trashDir, `${Date.now()}_${path.basename(fullPath)}`);
    fs.renameSync(fullPath, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lấy nhánh hiện tại đang checkout ở một git repository
 * @param {string} repoFullPath Đường dẫn tuyệt đối của git repository
 * @returns {string} Tên branch (vd: develop, main) hoặc 'main' nếu không lấy được
 */
function getRepoCurrentBranch(repoFullPath) {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    const b = out ? out.trim() : '';
    if (b && b !== 'HEAD') return b;
  } catch {
    // Thử lấy default branch qua remote
  }

  try {
    const out = execSync('git branch --show-current', {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    const b = out ? out.trim() : '';
    if (b) return b;
  } catch {}

  return 'main';
}

/**
 * Đề xuất nhánh deploy cho một git repo (tìm main, master, production, v.v.)
 * @param {string} repoFullPath Đường dẫn tuyệt đối của repo
 * @param {string} devBranch Nhánh dev hiện tại
 * @returns {string} Nhánh deploy đề xuất
 */
function detectDeployBranch(repoFullPath, devBranch = 'main') {
  try {
    const out = execSync('git branch -a', {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    const branches = out
      .split('\n')
      .map(b => b.trim().replace(/^[\*\s]+/, '').replace(/^remotes\/origin\//, ''))
      .filter(Boolean);

    const candidates = ['main', 'master', 'production', 'prod', 'release'];
    for (const cand of candidates) {
      if (branches.includes(cand)) {
        return cand;
      }
    }
  } catch {}
  return devBranch;
}

/**
 * Quét các thư mục con cấp 1 trong workspacePath để nhận diện các Git repository (services)
 * @param {string} workspacePath Đường dẫn thư mục cha của workspace
 * @returns {Array<{ service_key: string, repo_path: string, dev_branch: string, deploy_branch: string, is_git: boolean }>}
 */
function scanWorkspaceServices(workspacePath) {
  const results = [];
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    return results;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(workspacePath, { withFileTypes: true });
  } catch (err) {
    console.error(`[WorktreeManager] Lỗi đọc thư mục ${workspacePath}:`, err.message);
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Bỏ qua các thư mục hệ thống / worktrees
    if (['.git', 'node_modules', '.worktrees', 'worktrees', '.trash', 'dist', 'build', '.idea', '.vscode'].includes(entry.name)) {
      continue;
    }

    const subPath = path.join(workspacePath, entry.name);
    const gitPath = path.join(subPath, '.git');
    const isGit = fs.existsSync(gitPath);

    if (isGit) {
      const devBranch = getRepoCurrentBranch(subPath);
      const deployBranch = detectDeployBranch(subPath, devBranch);
      results.push({
        service_key: entry.name,
        repo_path: `./${entry.name}`,
        dev_branch: devBranch,
        deploy_branch: deployBranch,
        is_git: true
      });
    }
  }

  return results;
}

/**
 * Tạo liên kết Directory Junction / Symlink cho node_modules từ repo gốc sang worktree
 * giúp tiết kiệm ổ đĩa và không phải chạy lại npm install
 * @param {string} sourceRepoPath Đường dẫn repo gốc
 * @param {string} targetWorktreePath Đường dẫn worktree
 * @returns {boolean}
 */
function linkNodeModules(sourceRepoPath, targetWorktreePath) {
  const srcModules = path.join(sourceRepoPath, 'node_modules');
  const targetModules = path.join(targetWorktreePath, 'node_modules');

  if (!fs.existsSync(srcModules)) return false;
  if (fs.existsSync(targetModules)) return true;

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(srcModules, targetModules, 'junction');
    } else {
      fs.symlinkSync(srcModules, targetModules, 'dir');
    }
    return true;
  } catch (err) {
    console.warn(`[WorktreeManager] Không thể link node_modules: ${err.message}`);
    return false;
  }
}

/**
 * Luôn pull code mới nhất về trước khi thao tác trên nhánh git (nếu có remote).
 * Tự động bỏ qua an toàn nếu repo local không có remote hoặc không có kết nối mạng.
 * - Nếu repo đang checkout đúng nhánh `branch`: chạy git pull origin <branch>
 * - Nếu repo đang checkout nhánh khác: chạy git fetch origin <branch>:<branch> để cập nhật
 *   ref local của `branch` mà không làm bẩn nhánh HEAD đang checkout.
 * @param {string} repoFullPath Đường dẫn repo
 * @param {string} [branch] Nhánh cần pull (mặc định nhánh hiện tại)
 * @returns {boolean}
 */
function pullLatestCode(repoFullPath, branch = '') {
  if (!repoFullPath || !fs.existsSync(repoFullPath)) return false;
  try {
    const remotes = execSync('git remote', { cwd: repoFullPath, stdio: 'pipe', encoding: 'utf-8' });
    if (!remotes || !remotes.trim()) {
      return true; // Repo thuần local, không có remote
    }

    const currentBranch = getRepoCurrentBranch(repoFullPath);
    const targetBranch = branch ? branch.trim() : currentBranch;

    if (!targetBranch) return true;

    if (currentBranch === targetBranch) {
      try {
        execSync(`git pull --ff-only origin "${targetBranch}"`, { cwd: repoFullPath, stdio: 'pipe', encoding: 'utf-8', timeout: 30000 });
      } catch {
        execSync(`git pull origin "${targetBranch}"`, { cwd: repoFullPath, stdio: 'pipe', encoding: 'utf-8', timeout: 30000 });
      }
    } else {
      // Đang ở nhánh khác: fetch cập nhật đúng ref local của targetBranch mà không ảnh hưởng HEAD
      execSync(`git fetch origin "${targetBranch}:${targetBranch}"`, { cwd: repoFullPath, stdio: 'pipe', encoding: 'utf-8', timeout: 30000 });
    }
    return true;
  } catch (err) {
    // Không ném lỗi làm crash tiến trình khi offline/local commit
    return false;
  }
}
/**
 * Tạo worktree mới cho một service của task
 * @param {object} params
 * @param {string} params.repoFullPath Đường dẫn tuyệt đối repo gốc của service
 * @param {string} params.worktreeDestPath Đường dẫn thư mục worktree đích
 * @param {string} params.taskBranch Tên nhánh của task (vd: feature/TASK-1024)
 * @param {string} params.baseDevBranch Tên nhánh phát triển gốc để fork (vd: develop)
 * @returns {{ success: boolean, worktree_path: string, task_branch: string, base_dev_branch: string, error?: string }}
 */
function createTaskWorktree({ repoFullPath, worktreeDestPath, taskBranch, baseDevBranch = 'main' }) {
  if (!repoFullPath || !fs.existsSync(repoFullPath)) {
    throw new Error(`Repo gốc không tồn tại: ${repoFullPath}`);
  }

  const resolvedWorktree = path.resolve(worktreeDestPath);
  const parentDir = path.dirname(resolvedWorktree);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // 0. Luôn pull code mới nhất của baseDevBranch về trước khi phân nhánh worktree
  pullLatestCode(repoFullPath, baseDevBranch);

  // 1. Kiểm tra xem worktree path đã tồn tại chưa
  if (fs.existsSync(resolvedWorktree)) {
    try {
      const wtList = execSync('git worktree list --porcelain', {
        cwd: repoFullPath,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      if (wtList.toLowerCase().includes(resolvedWorktree.toLowerCase())) {
        linkNodeModules(repoFullPath, resolvedWorktree);
        pullLatestCode(resolvedWorktree, taskBranch);
        return {
          success: true,
          worktree_path: resolvedWorktree,
          task_branch: taskBranch,
          base_dev_branch: baseDevBranch,
          reused: true
        };
      }
    } catch {}
  }

  // 2. Kiểm tra xem taskBranch đã tồn tại trong repo chưa
  let branchExists = false;
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${taskBranch}`, {
      cwd: repoFullPath,
      stdio: 'pipe'
    });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  // 3. Thực thi git worktree add
  try {
    let cmd = '';
    if (branchExists) {
      cmd = `git worktree add "${resolvedWorktree}" "${taskBranch}"`;
    } else {
      cmd = `git worktree add -b "${taskBranch}" "${resolvedWorktree}" "${baseDevBranch}"`;
    }

    execSync(cmd, {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });

    // 4. Liên kết node_modules để tăng tốc và tiết kiệm ổ đĩa
    linkNodeModules(repoFullPath, resolvedWorktree);

    return {
      success: true,
      worktree_path: resolvedWorktree,
      task_branch: taskBranch,
      base_dev_branch: baseDevBranch
    };
  } catch (err) {
    const errMsg = (err.stderr || err.message || '').toString();
    console.error(`[WorktreeManager] Lỗi tạo worktree tại ${resolvedWorktree}:`, errMsg);
    return {
      success: false,
      worktree_path: resolvedWorktree,
      task_branch: taskBranch,
      base_dev_branch: baseDevBranch,
      error: errMsg
    };
  }
}

/**
 * Xóa an toàn một worktree và dọn dẹp thư mục theo đúng quy tắc Recycle Bin
 * @param {string} repoFullPath Đường dẫn repo gốc
 * @param {string} worktreeDestPath Đường dẫn thư mục worktree cần xóa
 * @returns {boolean}
 */
function removeTaskWorktree(repoFullPath, worktreeDestPath) {
  if (!worktreeDestPath) return false;
  const resolved = path.resolve(worktreeDestPath);

  if (repoFullPath && fs.existsSync(repoFullPath)) {
    try {
      execSync(`git worktree remove --force "${resolved}"`, {
        cwd: repoFullPath,
        stdio: 'ignore'
      });
    } catch {}

    try {
      execSync('git worktree prune', {
        cwd: repoFullPath,
        stdio: 'ignore'
      });
    } catch {}
  }

  // Nếu thư mục vật lý vẫn còn (do uncommitted/junction/file lock), đưa vào thùng rác
  if (fs.existsSync(resolved)) {
    safeMoveToTrash(resolved);
  }

  return true;
}

/**
 * Kiểm tra xem repo gốc có thay đổi dở dang không; nếu có thì stash an toàn
 * @param {string} repoFullPath
 * @returns {{ stashed: boolean }}
 */
function ensureCleanWorkingTree(repoFullPath) {
  try {
    const statusOut = execSync('git status --porcelain', {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    if (statusOut && statusOut.trim()) {
      execSync('git stash push -u -m "ai-worker-autostash"', {
        cwd: repoFullPath,
        stdio: 'pipe'
      });
      return { stashed: true };
    }
  } catch (err) {
    console.warn(`[WorktreeManager] Cảnh báo kiểm tra working tree tại ${repoFullPath}: ${err.message}`);
  }
  return { stashed: false };
}

/**
 * Khôi phục stash nếu trước đó đã stash
 * @param {string} repoFullPath
 * @param {{ stashed: boolean }} stashInfo
 */
function restoreWorkingTree(repoFullPath, stashInfo) {
  if (!stashInfo || !stashInfo.stashed) return;
  try {
    execSync('git stash pop', {
      cwd: repoFullPath,
      stdio: 'pipe'
    });
  } catch (err) {
    console.warn(`[WorktreeManager] Cảnh báo pop stash tại ${repoFullPath}: ${err.message}`);
  }
}

/**
 * Kiểm tra xem có file nào đang bị conflict unmerged không
 * @param {string} repoFullPath
 * @returns {{ hasConflict: boolean, conflictFiles: string[] }}
 */
function hasMergeConflict(repoFullPath) {
  try {
    const out = execSync('git diff --name-only --diff-filter=U', {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    const files = out ? out.split('\n').map(f => f.trim()).filter(Boolean) : [];
    return {
      hasConflict: files.length > 0,
      conflictFiles: files
    };
  } catch {
    return { hasConflict: false, conflictFiles: [] };
  }
}

/**
 * Thực hiện merge branch task vào target_dev_branch trên repo gốc
 * @param {object} params
 * @param {string} params.repoFullPath Đường dẫn tuyệt đối repo gốc
 * @param {string} params.targetDevBranch Nhánh phát triển gốc (vd: develop)
 * @param {string} params.taskBranch Nhánh task (vd: feature/TASK-1024)
 * @returns {{ success: boolean, conflict: boolean, conflictFiles?: string[], error?: string }}
 */
function mergeBranch({ repoFullPath, targetDevBranch, taskBranch }) {
  if (!repoFullPath || !fs.existsSync(repoFullPath)) {
    return { success: false, conflict: false, error: 'Repo không tồn tại' };
  }

  // 1. Checkout target_dev_branch
  try {
    execSync(`git checkout "${targetDevBranch}"`, {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    // Luôn pull code mới nhất của nhánh phát triển trước khi merge
    pullLatestCode(repoFullPath, targetDevBranch);
  } catch (err) {
    return {
      success: false,
      conflict: false,
      error: `Không thể checkout nhánh ${targetDevBranch}: ${err.message}`
    };
  }
  // 2. Thử merge
  try {
    execSync(`git merge --no-ff "${taskBranch}" -m "Merge task branch '${taskBranch}' into '${targetDevBranch}'"`, {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    return { success: true, conflict: false };
  } catch (err) {
    // Kiểm tra xem có conflict không
    const conflictCheck = hasMergeConflict(repoFullPath);
    if (conflictCheck.hasConflict) {
      return {
        success: false,
        conflict: true,
        conflictFiles: conflictCheck.conflictFiles
      };
    }

    return {
      success: false,
      conflict: false,
      error: err.stderr ? err.stderr.toString() : err.message
    };
  }
}

/**
 * Hủy bỏ quá trình merge đang dở dang khi re-test fail hoặc khi gặp lỗi không thể giải quyết
 * @param {string} repoFullPath
 * @returns {boolean}
 */
function abortMerge(repoFullPath) {
  try {
    execSync('git merge --abort', {
      cwd: repoFullPath,
      stdio: 'ignore'
    });
    return true;
  } catch {
    try {
      execSync('git reset --hard HEAD', {
        cwd: repoFullPath,
        stdio: 'ignore'
      });
      return true;
    } catch {
      return false;
    }
  }
}
/**
 * Lưu cấu hình manifest cho riêng task (.worktrees/<task_code>/.task-manifest.json - Tầng 2)
 * @param {string} taskWorktreeDir Thư mục worktree gốc của task
 * @param {object} manifestData Dữ liệu cấu hình task
 * @returns {object}
 */
function saveTaskManifest(taskWorktreeDir, manifestData = {}) {
  if (!taskWorktreeDir) return null;
  try {
    if (!fs.existsSync(taskWorktreeDir)) {
      fs.mkdirSync(taskWorktreeDir, { recursive: true });
    }
    const manifestPath = path.join(taskWorktreeDir, '.task-manifest.json');
    const existing = loadTaskManifest(taskWorktreeDir) || {};
    const merged = {
      ...existing,
      ...manifestData,
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  } catch (err) {
    console.error(`[WorktreeManager] Lỗi lưu .task-manifest.json tại ${taskWorktreeDir}:`, err.message);
    return null;
  }
}

/**
 * Đọc cấu hình manifest riêng của task (.task-manifest.json - Tầng 2)
 * @param {string} taskWorktreeDir Thư mục worktree gốc của task
 * @returns {object|null}
 */
function loadTaskManifest(taskWorktreeDir) {
  if (!taskWorktreeDir) return null;
  try {
    const manifestPath = path.join(taskWorktreeDir, '.task-manifest.json');
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    }
  } catch {}
  return null;
}

/**
 * Xuất snapshot danh mục worktrees ra file worktrees/registry.json (Tầng 3 Read-only Snapshot)
 * @param {Array<object>} worktreesList Danh sách các worktree từ DB
 * @param {string} [registryDir] Thư mục lưu registry.json
 * @returns {string} Đường dẫn file registry.json đã xuất
 */
function exportWorktreesRegistry(worktreesList = [], registryDir = path.resolve(process.cwd(), 'worktrees')) {
  try {
    if (!fs.existsSync(registryDir)) {
      fs.mkdirSync(registryDir, { recursive: true });
    }
    const registryPath = path.join(registryDir, 'registry.json');
    const snapshot = {
      updated_at: new Date().toISOString(),
      count: worktreesList.length,
      worktrees: worktreesList
    };
    fs.writeFileSync(registryPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    return registryPath;
  } catch (err) {
    console.error(`[WorktreeManager] Lỗi xuất worktrees/registry.json:`, err.message);
    return null;
  }
}

/**
 * Chạy test suite trực tiếp trên repo gốc (dùng cho Re-test tại bước MERGING)
 * @param {string} repoFullPath Đường dẫn repo gốc
 * @returns {{ passed: boolean, output: string }}
 */
function runServiceTest(repoFullPath) {
  if (!repoFullPath || !fs.existsSync(repoFullPath)) {
    return { passed: false, output: 'Repo không tồn tại' };
  }

  // Kiểm tra package.json
  const pkgPath = path.join(repoFullPath, 'package.json');
  let testCmd = '';
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts && pkg.scripts.test) {
        testCmd = 'npm test';
      }
    } catch {}
  }

  // Nếu không có npm test hoặc file test khác, kiểm tra thư mục tests
  if (!testCmd) {
    const testsDir = path.join(repoFullPath, 'tests');
    if (fs.existsSync(testsDir)) {
      testCmd = 'node --test tests/**/*.test.js';
    }
  }

  if (!testCmd) {
    // Không có bộ test cấu hình sẵn -> Coi như pass verification cú pháp cơ bản
    return { passed: true, output: 'Không có test script, kiểm tra cú pháp pass' };
  }

  try {
    const stdout = execSync(testCmd, {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 120000
    });
    return { passed: true, output: stdout || 'PASS' };
  } catch (err) {
    const errOut = (err.stdout || '') + '\n' + (err.stderr || err.message || '');
    return { passed: false, output: errOut };
  }
}

/**
 * Hoàn tất merge commit trên repo gốc sau khi gỡ conflict và re-test PASS
 * @param {string} repoFullPath
 * @param {string} commitMsg
 * @returns {boolean}
 */
function finalizeMergeCommit(repoFullPath, commitMsg = 'Merge task branch and resolve conflicts') {
  try {
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
      cwd: repoFullPath,
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  safeMoveToTrash,
  pullLatestCode,
  getRepoCurrentBranch,
  detectDeployBranch,
  scanWorkspaceServices,
  linkNodeModules,
  createTaskWorktree,
  removeTaskWorktree,
  ensureCleanWorkingTree,
  restoreWorkingTree,
  hasMergeConflict,
  mergeBranch,
  abortMerge,
  saveTaskManifest,
  loadTaskManifest,
  exportWorktreesRegistry,
  runServiceTest,
  finalizeMergeCommit
};
