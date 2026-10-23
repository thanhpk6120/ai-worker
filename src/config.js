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
const DEFAULT_TIMEOUT = process.env.DEFAULT_TIMEOUT ? parseInt(process.env.DEFAULT_TIMEOUT, 10) : 900; // giay, giu tuong thich .env (900 giay = 15 phut)
const DEFAULT_TIMEOUT_MS = (Number.isFinite(DEFAULT_TIMEOUT) && DEFAULT_TIMEOUT > 0 ? DEFAULT_TIMEOUT : 900) * 1000;
// Chuan hoa timeout ve ms. Ho tro key tuong minh (ms/giay/phut) hoac so generic:
// >=10000 -> ms, >120 -> giay, con lai -> phut. fallbackMs=null => tra null khi thieu/sai.
function normalizeTimeoutMs(input, fallbackMs) {
  const useDefault = fallbackMs === undefined;
  const fb = useDefault ? DEFAULT_TIMEOUT_MS : fallbackMs;
  const bad = (v) => v === undefined || v === null || v === '';
  if (input !== null && typeof input === 'object') {
    const msKeys = [input.timeoutMs, input.timeout_ms, input.timeoutMS];
    for (const v of msKeys) {
      if (!bad(v)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    const secKeys = [input.timeout_seconds, input.timeoutSeconds, input.timeoutSec, input.timeout_sec];
    for (const v of secKeys) {
      if (!bad(v)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n * 1000;
      }
    }
    const minKeys = [input.timeout_minutes, input.timeoutMinutes, input.timeoutMin, input.timeout_min];
    for (const v of minKeys) {
      if (!bad(v)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n * 60 * 1000;
      }
    }
    if (!bad(input.timeout)) return normalizeTimeoutMs(input.timeout, fb);
    return fb;
  }
  if (bad(input)) return fb;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return fb;
  if (n >= 10000) return n;
  if (n > 120) return n * 1000;
  return n * 60 * 1000;
}
// Lay timeout job (ms) tu job.pipeline_config (string/object) + field job, fallback config.
function resolveJobTimeoutMs(job, fallbackMs) {
  const useDefault = fallbackMs === undefined;
  const fb = useDefault ? DEFAULT_TIMEOUT_MS : fallbackMs;
  if (!job || typeof job !== 'object') return fb;
  let pipe = job.pipeline_config !== undefined ? job.pipeline_config : job.pipelineConfig;
  if (typeof pipe === 'string') {
    try { pipe = JSON.parse(pipe); } catch (e) { pipe = null; }
  }
  if (pipe && typeof pipe === 'object') {
    const fromPipe = normalizeTimeoutMs(pipe, null);
    if (fromPipe !== null && fromPipe !== undefined) return fromPipe;
  }
  const fromJob = normalizeTimeoutMs({
    timeoutMs: job.timeoutMs !== undefined ? job.timeoutMs : job.timeout_ms,
    timeout_seconds: job.timeout_seconds !== undefined ? job.timeout_seconds : job.timeoutSeconds,
    timeout_minutes: job.timeout_minutes !== undefined ? job.timeout_minutes : job.timeoutMinutes,
    timeout: job.timeout
  }, null);
  if (fromJob !== null && fromJob !== undefined) return fromJob;
  return fb;
}
const MAX_FIXING_RETRIES = process.env.MAX_FIXING_RETRIES ? parseInt(process.env.MAX_FIXING_RETRIES, 10) : 3;
const WORKTREE_BASE_DIR = process.env.WORKTREE_BASE_DIR || path.resolve(process.cwd(), 'worktrees');
const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.resolve(process.cwd(), 'evidence');
const SYSTEMONE_ENABLED = process.env.SYSTEMONE_ENABLED !== 'false';
const SYSTEMONE_BASE_URL = process.env.SYSTEMONE_BASE_URL || 'http://127.0.0.1:20128/v1/systemone';
const SYSTEMONE_MODEL = process.env.SYSTEMONE_MODEL || 'openrouter/typesafe/jev-1.13';
const SYSTEMONE_TIMEOUT_MS = process.env.SYSTEMONE_TIMEOUT_MS ? parseInt(process.env.SYSTEMONE_TIMEOUT_MS, 10) : 8000;
const SYSTEMONE_CACHE_TTL_MS = process.env.SYSTEMONE_CACHE_TTL_MS ? parseInt(process.env.SYSTEMONE_CACHE_TTL_MS, 10) : 3600000;
const SYSTEMONE_API_KEY = process.env.SYSTEMONE_API_KEY || '';
const MCP_HANDSHAKE_TIMEOUT_MS = process.env.MCP_HANDSHAKE_TIMEOUT_MS ? parseInt(process.env.MCP_HANDSHAKE_TIMEOUT_MS, 10) : 60000;
const MCP_TOOL_SEARCH_ENABLED = process.env.MCP_TOOL_SEARCH_ENABLED === 'true';
// Model cho claude CLI: luon truyen bang flag --model de thang env.ANTHROPIC_MODEL trong
// ~/.claude/settings.json (env do Claude Code tu apply, process env khong de duoc).
// Rong = khong truyen flag, dung model mac dinh cua may.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';
// Timeout cho 1 luot goi AI headless de phan loai task (ms). Mac dinh 30s.
// Doc lap cho tung luot goi: KHONG dung chung voi timeout cua job (user khai).
const AI_TRIAGE_TIMEOUT_MS = process.env.AI_TRIAGE_TIMEOUT_MS ? parseInt(process.env.AI_TRIAGE_TIMEOUT_MS, 10) : 30000;
// Kill-switch cho nhanh AI headless triage. Doc lap voi SYSTEMONE_ENABLED
// (kill-switch cua gateway Jev) de tat rieng nhanh CLI ma van giu Jev.
// Tat => triage quay ve heuristic offline (confidence <= 0.4 => KHONG bat quick track).
const AI_TRIAGE_ENABLED = process.env.AI_TRIAGE_ENABLED !== 'false';
// TTL cache RAM cho ket qua triage (ms). Mac dinh 1 gio.
const AI_TRIAGE_CACHE_TTL_MS = process.env.AI_TRIAGE_CACHE_TTL_MS ? parseInt(process.env.AI_TRIAGE_CACHE_TTL_MS, 10) : 3600000;
// TTL cache RAM cho ket qua `detect()` cua runner CLI (ms). Mac dinh 60 giay.
// Detect chay `spawnSync` 2 lan (where + --version) -> ~1,4s LAN, chan event loop.
// Cache o `BaseAdapter.detect()` (khong phai o registry) vi detect() nam ca tren
// duong chay job (truoc moi pipeline step), khong chi tren duong UI.
const DETECT_TTL_MS = process.env.DETECT_TTL_MS ? parseInt(process.env.DETECT_TTL_MS, 10) : 60000;

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
  SYSTEMONE_API_KEY,
  MCP_HANDSHAKE_TIMEOUT_MS,
  MCP_TOOL_SEARCH_ENABLED,
  CLAUDE_MODEL,
  AI_TRIAGE_TIMEOUT_MS,
  AI_TRIAGE_ENABLED,
  AI_TRIAGE_CACHE_TTL_MS,
  DETECT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  normalizeTimeoutMs,
  resolveJobTimeoutMs
};
