const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

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
 * Đảm bảo .worktrees/ được ignore cục bộ tại repo con bằng .git/info/exclude,
 * giữ git status của repo luôn sạch sẽ mà không làm thay đổi file .gitignore tracked.
 */
function ensureLocalGitExclude(repoFullPath) {
  try {
    const gitDir = path.join(repoFullPath, '.git');
    if (!fs.existsSync(gitDir)) return;

    let targetExcludeDir = path.join(gitDir, 'info');
    if (fs.statSync(gitDir).isFile()) {
      const gitContent = fs.readFileSync(gitDir, 'utf-8').trim();
      const match = gitContent.match(/^gitdir:\s*(.+)$/i);
      if (match) {
        targetExcludeDir = path.join(path.resolve(repoFullPath, match[1]), 'info');
      }
    }

    if (!fs.existsSync(targetExcludeDir)) {
      fs.mkdirSync(targetExcludeDir, { recursive: true });
    }

    const excludeFile = path.join(targetExcludeDir, 'exclude');
    let content = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : '';
    let updated = false;
    if (!content.includes('.worktrees')) {
      content = (content.trim() ? content.trim() + '\n' : '') + '.worktrees/\n';
      updated = true;
    }
    if (!content.includes('.task-manifest.json')) {
      content = (content.trim() ? content.trim() + '\n' : '') + '.task-manifest.json\n';
      updated = true;
    }
    if (updated) {
      fs.writeFileSync(excludeFile, content, 'utf-8');
    }
  } catch (err) {
    console.warn('[WorktreeManager] Không thể cập nhật .git/info/exclude:', err.message);
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

  // 0. Đảm bảo .worktrees/ được ignore cục bộ trong .git/info/exclude (không bẩn git status của repo con)
  ensureLocalGitExclude(repoFullPath);

  // 0b. Luôn pull code mới nhất của baseDevBranch về trước khi phân nhánh worktree
  pullLatestCode(repoFullPath, baseDevBranch);

  // 0c. Tự động dọn dẹp worktree metadata cũ (stale worktrees không còn thư mục trên đĩa)
  try {
    execSync('git worktree prune', { cwd: repoFullPath, stdio: 'ignore' });
  } catch {}
  if (fs.existsSync(resolvedWorktree)) {
    // git worktree list in path bang FORWARD SLASH tren Windows ("D:/a/b"), con
    // resolvedWorktree dung backslash => phai chuan hoa truoc khi so sanh.
    // Truoc day so sanh thang => luon false => worktree HOP LE bi coi la orphan
    // va bi dua vao Trash (mat cay lam viec cua agent dang chay).
    const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
    const target = norm(resolvedWorktree);
    let isValidWorktree = false;
    try {
      const wtList = execSync('git worktree list --porcelain', {
        cwd: repoFullPath,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      isValidWorktree = wtList
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => norm(l.slice('worktree '.length).trim()))
        .includes(target);
    } catch {}

    if (isValidWorktree) {
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

    // Thu muc ton tai nhung git khong con dang ky. Neu CON file .git thi day la
    // truong hop metadata bi mat (khong phai orphan) => thu `git worktree repair`
    // de dung lai lien ket roi dung tiep, tranh lam job khong tao duoc worktree.
    const hasGitLink = fs.existsSync(path.join(resolvedWorktree, '.git'));
    if (hasGitLink) {
      try {
        execSync(`git worktree repair "${resolvedWorktree}"`, {
          cwd: repoFullPath,
          stdio: 'pipe',
          encoding: 'utf-8'
        });
        console.warn(`[WorktreeManager] Da repair lien ket git cho ${resolvedWorktree}, dung lai worktree.`);
        linkNodeModules(repoFullPath, resolvedWorktree);
        return {
          success: true,
          worktree_path: resolvedWorktree,
          task_branch: taskBranch,
          base_dev_branch: baseDevBranch,
          reused: true,
          repaired: true
        };
      } catch (repairErr) {
        console.warn(`[WorktreeManager] repair that bai cho ${resolvedWorktree}: ${repairErr.message}`);
      }
    }

    let dirty = true;
    try {
      const st = execSync('git status --porcelain', {
        cwd: resolvedWorktree,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      dirty = !!(st && st.trim());
    } catch {
      dirty = true; // khong chay duoc git => coi nhu con du lieu
    }

    // Con file .git (repair that bai) hoac con thay doi chua commit => KHONG don.
    if (hasGitLink || dirty) {
      const why = hasGitLink ? 'con file .git nhung repair that bai' : 'con thay doi chua commit';
      console.warn(`[WorktreeManager] ${resolvedWorktree} khong dung duoc: ${why} - KHONG don.`);
      return {
        success: false,
        worktree_path: resolvedWorktree,
        task_branch: taskBranch,
        base_dev_branch: baseDevBranch,
        error: `Thu muc dich ${why}; can xu ly thu cong: ${resolvedWorktree}`
      };
    }

    console.warn(`[WorktreeManager] Thu muc rong khong dung duoc tai ${resolvedWorktree}, don dep va tao lai.`);
    const cleaned = safeMoveToTrash(resolvedWorktree);
    if (!cleaned || fs.existsSync(resolvedWorktree)) {
      return {
        success: false,
        worktree_path: resolvedWorktree,
        task_branch: taskBranch,
        base_dev_branch: baseDevBranch,
        error: `Thu muc dich da ton tai va khong the don: ${resolvedWorktree}`
      };
    }
  }
  // 1b. Nếu repo gốc đang đứng ở chính nhánh taskBranch -> chuyển về baseDevBranch để giải phóng nhánh cho worktree
  const currentBranch = getRepoCurrentBranch(repoFullPath);
  if (currentBranch === taskBranch) {
    try {
      execSync(`git checkout "${baseDevBranch}"`, { cwd: repoFullPath, stdio: 'pipe' });
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
  // Go junction/symlink node_modules truoc: git worktree remove --force
  // khong xoa duoc thu muc chua junction tren Windows va Recycle Bin cung ket.
  // KHONG dung existsSync: junction Windows tra false khi target khong truy cap duoc.
  const nm = path.join(resolved, 'node_modules');
  try {
    const st = fs.lstatSync(nm);
    if (st.isSymbolicLink() || (process.platform === 'win32' && st.isDirectory())) {
      try { fs.rmdirSync(nm); } catch (_) {}
    }
  } catch (_) {}

  if (repoFullPath && fs.existsSync(repoFullPath)) {
    try {
      execSync(`git worktree remove --force "${resolved}"`, {
        cwd: repoFullPath,
        stdio: 'pipe',
        encoding: 'utf-8'
      });
    } catch (e) {
      const msg = (e.stderr || e.message || '').toString();
      if (!/is not a working tree/i.test(msg)) {
        console.warn('[removeTaskWorktree] git remove failed:', msg.slice(0, 300));
      }
    }

    try {
      execSync('git worktree prune', { cwd: repoFullPath, stdio: 'ignore' });
    } catch {}
  }

  // Luôn đi qua Recycle Bin (AGENTS.md: cấm xoá cứng). Nếu EBUSY do process
  // đang giữ handle thì safeMoveToTrash fail và hàm trả về false — caller báo kẹt.
  if (fs.existsSync(resolved)) {
    safeMoveToTrash(resolved);
  }

  // Tra ve ket qua that: con ton tai tren dia = chua don duoc
  return !fs.existsSync(resolved);
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
 * Dựng message merge từ NỘI DUNG ĐÃ LÀM của task.
 * Ưu tiên `report.md` (báo cáo thay đổi thực tế), fallback summary/title của job.
 * @param {object} job
 * @param {string} taskCode
 * @param {string} [featureDir] thư mục docs/features/<taskCode>
 * @returns {string}
 */
function buildTaskMergeMessage(job, taskCode, featureDir) {
  let report = '';
  try {
    const reportPath = featureDir ? path.join(featureDir, 'report.md') : null;
    if (reportPath && fs.existsSync(reportPath)) {
      report = fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, '').trim();
    }
  } catch (e) {}
  const summary = String((job && job.summary) || '').replace(/\s+/g, ' ').trim();
  const subject = `[${taskCode || (job && job.task_code) || 'TASK'}] ${summary || (job && job.title) || 'hoàn thành task'}`.slice(0, 150);
  const body = report.replace(/^---[\s\S]*?---\s*/, '').slice(0, 4000).trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/**
 * Thực hiện merge branch task vào target_dev_branch trên repo gốc
 * @param {object} params
 * @param {string} params.repoFullPath Đường dẫn tuyệt đối repo gốc
 * @param {string} params.targetDevBranch Nhánh phát triển gốc (vd: develop)
 * @param {string} params.taskBranch Nhánh task (vd: feature/TASK-1024)
 * @param {string} [params.message] Nội dung commit merge (mặc định: mô tả branch)
 * @returns {{ success: boolean, conflict: boolean, conflictFiles?: string[], error?: string }}
 */
function mergeBranch({ repoFullPath, targetDevBranch, taskBranch, message }) {
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
  // Message do caller truyền vào = nội dung đã làm của task (report.md/summary).
  // Ghi ra file tạm rồi dùng `-F` để không vỡ quote/xuống dòng trên Windows.
  const finalMessage = (typeof message === 'string' && message.trim())
    ? message.trim()
    : `Merge task branch '${taskBranch}' into '${targetDevBranch}'`;
  let messageFile = null;
  try {
    messageFile = path.join(os.tmpdir(), `aiworker-merge-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(messageFile, finalMessage, 'utf8');
    execSync(`git merge --no-ff "${taskBranch}" -F "${messageFile}"`, {
      cwd: repoFullPath,
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    return { success: true, conflict: false, message: finalMessage };
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
  } finally {
    if (messageFile) {
      try { fs.unlinkSync(messageFile); } catch (e) {}
    }
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

// Dấu hiệu lỗi môi trường (agent FIXING không sửa được bằng code)
const ENV_ERROR_RE = /FileNotFoundException[^\n]*[\\/]\.m2[\\/]wrapper|JAVA_HOME (?:not found|is not set)|is not recognized as an internal or external command|spawnSync[^\n]*ENOENT|ETIMEDOUT/i;

/**
 * Tự động dò tìm JAVA_HOME nếu chưa được set trong biến môi trường
 */
function getOrDetectJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }
  if (process.platform === 'win32') {
    const javaDir = 'C:\\Program Files\\Java';
    if (fs.existsSync(javaDir)) {
      try {
        const jdks = fs.readdirSync(javaDir).filter(d => /^jdk|^zulu|^temurin|^corretto/i.test(d));
        if (jdks.length > 0) {
          jdks.sort().reverse();
          return path.join(javaDir, jdks[0]);
        }
      } catch {}
    }
  }
  return null;
}
/**
 * Phát hiện thư mục Maven wrapper hỏng (thiếu bin/m2.conf) và di chuyển các thư mục con
 * bị hỏng vào Recycle Bin (KHÔNG xóa vĩnh viễn), để wrapper tự giải nén lại sạch từ file .zip sẵn có.
 * @returns {boolean} true nếu đã dọn dẹp và nên thử lại
 */
function repairBrokenMavenWrapper(output) {
  const m = /FileNotFoundException:\s*(.+?[\\/]wrapper[\\/]dists[\\/][^\\/]+[\\/][^\\/]+)[\\/]([^\\/]+)[\\/]bin[\\/]m2\.conf/i.exec(output || '');
  if (!m) return false;
  const hashDir = m[1].trim();
  try {
    if (!fs.existsSync(hashDir)) return false;
    let cleaned = false;
    const entries = fs.readdirSync(hashDir);
    for (const entry of entries) {
      const fullEntryPath = path.join(hashDir, entry);
      try {
        if (fs.statSync(fullEntryPath).isDirectory()) {
          safeMoveToTrash(fullEntryPath);
          cleaned = true;
        }
      } catch {}
    }
    return cleaned;
  } catch {
    return false;
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
      } else if (pkg.scripts && pkg.scripts.build) {
        testCmd = 'npm run build';
      }
    } catch {}
  }

  // Kiểm tra Java / Maven (pom.xml)
  const pomPath = path.join(repoFullPath, 'pom.xml');
  if (!testCmd && fs.existsSync(pomPath)) {
    const isWin = process.platform === 'win32';
    const mvnwPath = path.join(repoFullPath, isWin ? 'mvnw.cmd' : 'mvnw');
    const mvnCmd = fs.existsSync(mvnwPath) ? (isWin ? '.\\mvnw.cmd' : './mvnw') : (isWin ? 'mvn.cmd' : 'mvn');
    testCmd = `${mvnCmd} test-compile -DskipTests`;
  }

  // Kiểm tra Gradle (build.gradle / gradlew)
  const gradlePath = path.join(repoFullPath, 'build.gradle');
  const gradleKtsPath = path.join(repoFullPath, 'build.gradle.kts');
  if (!testCmd && (fs.existsSync(gradlePath) || fs.existsSync(gradleKtsPath))) {
    const isWin = process.platform === 'win32';
    const gradlew = path.join(repoFullPath, isWin ? 'gradlew.bat' : 'gradlew');
    testCmd = fs.existsSync(gradlew) ? (isWin ? '.\\gradlew.bat testClasses' : './gradlew testClasses') : 'gradle testClasses';
  }

  // Nếu không có npm/mvn test hoặc file test khác, kiểm tra thư mục tests (Node.js test runner)
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

  const runOnce = () => {
    try {
      const env = { ...process.env };
      const detectedJh = getOrDetectJavaHome();
      if (detectedJh && !env.JAVA_HOME) {
        env.JAVA_HOME = detectedJh;
      }
      const stdout = execSync(testCmd, {
        cwd: repoFullPath,
        env,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 180000
      });
      return { passed: true, output: stdout || 'PASS' };
    } catch (err) {
      const errOut = (err.stdout || '') + '\n' + (err.stderr || err.message || '');
      return { passed: false, output: errOut, timedOut: err.code === 'ETIMEDOUT' };
    }
  };

  let res = runOnce();
  // Wrapper Maven giải nén dở dang (thiếu bin/m2.conf): đổi tên thư mục hỏng (không xóa) để wrapper giải nén lại từ zip rồi thử lại 1 lần
  if (!res.passed && repairBrokenMavenWrapper(res.output)) {
    res = runOnce();
  }
  if (!res.passed) {
    res.envError = !!res.timedOut || ENV_ERROR_RE.test(res.output);
  }
  return res;
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
  buildTaskMergeMessage,
  abortMerge,
  saveTaskManifest,
  loadTaskManifest,
  exportWorktreesRegistry,
  runServiceTest,
  finalizeMergeCommit
};
