const path = require('node:path');
const fs = require('node:fs');

// Nạp biến môi trường từ file .env ở thư mục chạy (stdlib, không thêm dep).
// Không ghi đè biến đã có sẵn trong process.env.
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) || (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch (e) {}
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'ai-worker.sqlite');
const CONCURRENCY = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 3;
const DEFAULT_TIMEOUT = process.env.DEFAULT_TIMEOUT ? parseInt(process.env.DEFAULT_TIMEOUT, 10) : 900; // 15 phút
const MAX_FIXING_RETRIES = process.env.MAX_FIXING_RETRIES ? parseInt(process.env.MAX_FIXING_RETRIES, 10) : 3;
const WORKTREE_BASE_DIR = process.env.WORKTREE_BASE_DIR || path.resolve(process.cwd(), 'worktrees');
const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.resolve(process.cwd(), 'evidence');
const SYSTEMONE_ENABLED = process.env.SYSTEMONE_ENABLED !== 'false';
const SYSTEMONE_BASE_URL = process.env.SYSTEMONE_BASE_URL || 'http://127.0.0.1:20128/v1/systemone';
const SYSTEMONE_MODEL = process.env.SYSTEMONE_MODEL || 'oc/jev-1.13-free';
const SYSTEMONE_TIMEOUT_MS = process.env.SYSTEMONE_TIMEOUT_MS ? parseInt(process.env.SYSTEMONE_TIMEOUT_MS, 10) : 8000;
const SYSTEMONE_CACHE_TTL_MS = process.env.SYSTEMONE_CACHE_TTL_MS ? parseInt(process.env.SYSTEMONE_CACHE_TTL_MS, 10) : 3600000;
const SYSTEMONE_API_KEY = process.env.SYSTEMONE_API_KEY || '';

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
  EVIDENCE_DIR,
  SYSTEMONE_ENABLED,
  SYSTEMONE_BASE_URL,
  SYSTEMONE_MODEL,
  SYSTEMONE_TIMEOUT_MS,
  SYSTEMONE_CACHE_TTL_MS,
  SYSTEMONE_API_KEY
};
