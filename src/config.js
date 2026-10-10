const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'ai-worker.sqlite');
const CONCURRENCY = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 3;
const DEFAULT_TIMEOUT = process.env.DEFAULT_TIMEOUT ? parseInt(process.env.DEFAULT_TIMEOUT, 10) : 900; // 15 phút
const MAX_FIXING_RETRIES = process.env.MAX_FIXING_RETRIES ? parseInt(process.env.MAX_FIXING_RETRIES, 10) : 3;
const WORKTREE_BASE_DIR = process.env.WORKTREE_BASE_DIR || path.resolve(process.cwd(), 'worktrees');
const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.resolve(process.cwd(), 'evidence');

// Tự động tạo thư mục nếu chưa có
[WORKTREE_BASE_DIR, LOG_DIR, EVIDENCE_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

module.exports = {
  PORT,
  DB_PATH,
  CONCURRENCY,
  DEFAULT_TIMEOUT,
  MAX_FIXING_RETRIES,
  WORKTREE_BASE_DIR,
  LOG_DIR,
  EVIDENCE_DIR
};
