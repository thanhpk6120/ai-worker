const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Đảm bảo workspace là một Git repo, có README.md và đã được commit (không push)
 * @param {string} workspacePath Đường dẫn tuyệt đối của workspace
 * @param {string} [workspaceName] Tên workspace
 * @returns {object} { isGitInit: boolean, readmeCreated: boolean, committed: boolean, logs: string[] }
 */
function ensureGitWorkspace(workspacePath, workspaceName = '') {
  const logs = [];
  const result = {
    isGitInit: false,
    readmeCreated: false,
    committed: false,
    logs
  };

  if (!workspacePath || !fs.existsSync(workspacePath)) {
    logs.push(`Thư mục workspace không tồn tại: ${workspacePath}`);
    return result;
  }

  const gitDir = path.join(workspacePath, '.git');
  const isAlreadyGit = fs.existsSync(gitDir);

  // 1. Kiểm tra git repo, nếu chưa thì git init
  if (!isAlreadyGit) {
    try {
      execSync('git init', { cwd: workspacePath, stdio: 'pipe', encoding: 'utf-8' });
      result.isGitInit = true;
      logs.push('Đã khởi tạo Git repository (git init)');
    } catch (err) {
      logs.push(`Lỗi khi git init: ${err.message}`);
    }
  } else {
    logs.push('Thư mục đã là Git repository');
  }

  // Cấu hình git user local nếu chưa có để tránh lỗi Author identity unknown khi commit
  try {
    execSync('git config user.name', { cwd: workspacePath, stdio: 'pipe' });
  } catch {
    try {
      execSync('git config user.name "AI Worker"', { cwd: workspacePath, stdio: 'pipe' });
      execSync('git config user.email "ai-worker@local.dev"', { cwd: workspacePath, stdio: 'pipe' });
    } catch (cfgErr) {
      logs.push(`Cảnh báo git config: ${cfgErr.message}`);
    }
  }

  // 2. Kiểm tra file README.md (case-insensitive)
  let readmeEntry = null;
  try {
    const entries = fs.readdirSync(workspacePath);
    readmeEntry = entries.find(f => f.toLowerCase() === 'readme.md');
  } catch (readErr) {
    logs.push(`Không thể đọc danh sách file: ${readErr.message}`);
  }

  const readmePath = path.join(workspacePath, readmeEntry || 'README.md');
  const hasReadme = !!readmeEntry;

  if (!hasReadme) {
    // Chưa có file README.md -> Tạo 1 file README.md với nội dung là đường dẫn của workspace
    const normalizedPath = workspacePath.replace(/\\/g, '/');
    const content = `# ${workspaceName || path.basename(workspacePath) || 'Workspace'}\n\nWorkspace Path: \`${normalizedPath}\`\n\nKhởi tạo tự động bởi AI Worker.\n`;
    try {
      fs.writeFileSync(readmePath, content, 'utf-8');
      result.readmeCreated = true;
      logs.push(`Đã tạo file README.md với nội dung đường dẫn: ${normalizedPath}`);
    } catch (writeErr) {
      logs.push(`Lỗi tạo file README.md: ${writeErr.message}`);
    }
  } else {
    logs.push(`File README.md đã tồn tại tại: ${readmePath}`);
  }

  // 3. Commit file README.md (không push)
  try {
    execSync('git add README.md', { cwd: workspacePath, stdio: 'pipe' });
    const statusOut = execSync('git status --porcelain README.md', { cwd: workspacePath, stdio: 'pipe', encoding: 'utf-8' });
    if (statusOut && statusOut.trim()) {
      const commitMsg = result.readmeCreated
        ? `chore: initial commit README.md with workspace path`
        : `chore: commit README.md for workspace`;
      execSync(`git commit -m "${commitMsg}"`, { cwd: workspacePath, stdio: 'pipe', encoding: 'utf-8' });
      result.committed = true;
      logs.push(`Đã commit file README.md: "${commitMsg}"`);
    } else {
      logs.push('README.md không có thay đổi mới để commit (đã sạch)');
    }
  } catch (commitErr) {
    logs.push(`Ghi chú commit: ${commitErr.message}`);
  }

  return result;
}

module.exports = {
  ensureGitWorkspace
};
