/**
 * src/execution/jobPolicy.js
 * Quy tắc timeout/retry cho từng job. Tách riêng khỏi server.js để test được độc lập.
 *
 * Vấn đề gốc (task bd88ae0a-da46-4d35-af4e-49252e16dade):
 * - `pipeline_config.max_retries` khai 10 nhưng server.js đọc `config.MAX_FIXING_RETRIES` (env, = 3) => dừng ở 3/3.
 * - Timeout chỉ áp dụng PER STEP, không có tổng ngân sách cho job => 5 step x N retry x 1h.
 * - Không backoff giữa các vòng retry.
 * - 429 rate-limit của provider không được nhận ra => mỗi vòng lãng phí ~1h.
 */
'use strict';

const config = require('../config');

// Ngưỡng nhận diện rate-limit từ output của agent CLI.
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate_limit_error/i,
  /ALL_TARGETS_SKIPPED/i,
  /retry-after-ms=/i,
  /too many requests/i,
  /service temporarily unavailable/i
];

/**
 * Lấy giá trị số từ object/string, trả null nếu không hợp lệ.
 */
function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse `pipeline_config` (string JSON hoặc object) thành object.
 */
function parsePipelineConfig(job) {
  if (!job || typeof job !== 'object') return {};
  let pipe = job.pipeline_config !== undefined ? job.pipeline_config : job.pipelineConfig;
  if (typeof pipe === 'string') {
    try { pipe = JSON.parse(pipe); } catch (e) { pipe = null; }
  }
  return (pipe && typeof pipe === 'object') ? pipe : {};
}

/**
 * Số lần retry tối đa cho vòng FIXING.
 * Thứ tự ưu tiên: pipeline_config.max_retries -> maxRetries -> job.max_retries -> env -> default.
 * @returns {{ value: number, source: string }}
 */
function resolveMaxRetries(job, envValue) {
  const pipe = parsePipelineConfig(job);
  const candidates = [
    ['job', pipe.max_retries],
    ['job', pipe.maxRetries],
    ['job', pipe.max_fixing_retries],
    ['job', job && job.max_retries]
  ];
  for (const [source, raw] of candidates) {
    const n = toFiniteNumber(raw);
    if (n !== null && n > 0) return { value: Math.floor(n), source };
  }
  const envRaw = envValue !== undefined ? envValue : config.MAX_FIXING_RETRIES;
  const envNum = toFiniteNumber(envRaw);
  if (envNum !== null && envNum > 0) return { value: Math.floor(envNum), source: 'env' };
  return { value: 3, source: 'default' };
}

/**
 * Tổng ngân sách thời gian cho job (ms). `job_deadline_ms` trong pipeline_config.
 * Trả null nếu job không khai => không đặt deadline (giữ hành vi cũ).
 */
function resolveJobDeadlineMs(job) {
  const pipe = parsePipelineConfig(job);
  const direct = toFiniteNumber(pipe.job_deadline_ms !== undefined ? pipe.job_deadline_ms : pipe.jobDeadlineMs);
  if (direct !== null && direct > 0) return direct;
  const minutes = toFiniteNumber(pipe.job_deadline_minutes !== undefined ? pipe.job_deadline_minutes : pipe.jobDeadlineMinutes);
  if (minutes !== null && minutes > 0) return minutes * 60 * 1000;
  const hours = toFiniteNumber(pipe.job_deadline_hours !== undefined ? pipe.job_deadline_hours : pipe.jobDeadlineHours);
  if (hours !== null && hours > 0) return hours * 60 * 60 * 1000;
  return null;
}

/**
 * Mốc thời gian hết hạn tuyệt đối của job.
 *
 * PHẢI là mốc TUYỆT ĐỐI, không tính lại mỗi lần chuyển step:
 * executeStep() chạy lại ở MỌI lần đổi trạng thái, nên nếu base = now
 * thì deadline trượt mãi ⇒ tổng ngân sách thời gian của job vô hiệu.
 *
 * Cơ chế: lần đầu tính rồi ghi `pipeline_config.deadline_at` (epoch ms).
 * Các lần sau đọc lại giá trị đã lưu ⇒ deadline cố định suốt vòng đời job.
 *
 * @returns {{ deadlineAt: number|null, isNew: boolean }}
 */
function resolveDeadlineAt(job, now) {
  const pipe = parsePipelineConfig(job);
  const stored = toFiniteNumber(pipe.deadline_at !== undefined ? pipe.deadline_at : pipe.deadlineAt);
  if (stored !== null && stored > 0) {
    return { deadlineAt: stored, isNew: false };
  }
  const deadlineMs = resolveJobDeadlineMs(job);
  if (!deadlineMs) return { deadlineAt: null, isNew: false };
  const t = now || Date.now();
  return { deadlineAt: t + deadlineMs, isNew: true };
}

/**
 * Timeout hiệu dụng cho 1 lần gọi agent = min(stepTimeout, thời gian còn lại của job).
 * @returns {{ timeoutMs: number, expired: boolean, remainingMs: number|null }}
 */
function resolveEffectiveTimeout({ stepTimeoutMs, deadlineAt, now }) {
  const t = now || Date.now();
  const step = toFiniteNumber(stepTimeoutMs);
  const base = (step !== null && step > 0) ? step : config.DEFAULT_TIMEOUT_MS;
  if (!deadlineAt) return { timeoutMs: base, expired: false, remainingMs: null };
  const remaining = deadlineAt - t;
  if (remaining <= 0) return { timeoutMs: 0, expired: true, remainingMs: 0 };
  return { timeoutMs: Math.min(base, remaining), expired: false, remainingMs: remaining };
}

/**
 * Backoff giữa các vòng retry. attempt bắt đầu từ 1 (vòng đầu không chờ).
 */
function resolveRetryBackoffMs(attempt, options) {
  const base = (options && options.baseMs) || 5000;
  const cap = (options && options.capMs) || 60000;
  const n = toFiniteNumber(attempt);
  if (n === null || n <= 1) return 0;
  // attempt=2 => 5s, attempt=3 => 10s, attempt=4 => 20s ... (cap 60s)
  const delay = base * Math.pow(2, Math.floor(n) - 2);
  return Math.min(delay, cap);
}

/**
 * Phát hiện output của agent CLI bị provider rate-limit.
 * @param {string} output
 * @returns {{ limited: boolean, retryAfterMs: number|null }}
 */
function detectRateLimit(output) {
  const text = typeof output === 'string' ? output : '';
  if (!text) return { limited: false, retryAfterMs: null };
  const hit = RATE_LIMIT_PATTERNS.some((re) => re.test(text));
  if (!hit) return { limited: false, retryAfterMs: null };
  const m = text.match(/retry-after-ms=(\d+)/i);
  return {
    limited: true,
    retryAfterMs: m ? Number(m[1]) : null
  };
}

/**
 * Gom output của agent CLI để quét rate-limit.
 * `runner.execute()` trả `{ stdout, stderr, exitCode, timedOut }` — KHÔNG có
 * field `output`. Log 429 của CLI nằm trong stderr nên phải gom cả hai.
 * @param {Object|string} result
 * @returns {string}
 */
function collectAgentOutput(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const parts = [];
  for (const key of ['stdout', 'stderr', 'output']) {
    const v = result[key];
    if (typeof v === 'string' && v) parts.push(v);
  }
  return parts.join('\n');
}

/**
 * Timeout toi da cho 1 step cua job o CHE DO NHANH (quick track).
 *
 * LY DO: muc tieu worker la thay the prompt tung buoc va uu tien TOI UU TOC DO.
 * Task nhe (S/quick) khong nen chay 15-60 phut/step - VERIFY se kiem tra lai
 * sau, nen cap thoi gian o day la an toan.
 *
 * Uu tien: pipeline_config.quick_timeout_ms -> cap mac dinh (5 phut).
 * QUAN TRONG: quick cap KHONG BAO GIO lon hon `fallbackMs` (timeout hien co) -
 * cap chi duoc cat ngan hon, khong bao gio ngan loi them.
 * @param {object} job
 * @param {number} fallbackMs Timeout step hien tai
 * @returns {number} timeout ms (luon > 0)
 */
const QUICK_STEP_DEFAULT_MS = 5 * 60 * 1000; // 5 phut
const QUICK_STEP_MIN_MS = 60 * 1000; // 1 phut - san chan duoi cho cap nhanh
function resolveQuickStepTimeoutMs(job, fallbackMs) {
  let pipe = null;
  try { pipe = parsePipelineConfig(job); } catch (e) { pipe = null; }
  let declared = null;
  if (pipe && typeof pipe === 'object') {
    const raw = toFiniteNumber(pipe.quick_timeout_ms);
    if (raw !== null && raw > 0) declared = raw;
  }
  let cap = declared !== null ? declared : QUICK_STEP_DEFAULT_MS;
  // fallbackMs hop le => quick cap KHONG duoc lon hon timeout hien co.
  const fb = toFiniteNumber(fallbackMs);
  if (fb !== null && fb > 0) cap = Math.min(cap, fb);
  if (!Number.isFinite(cap) || cap <= 0) cap = QUICK_STEP_DEFAULT_MS;
  return cap;
}

module.exports = {
  parsePipelineConfig,
  resolveMaxRetries,
  resolveJobDeadlineMs,
  resolveDeadlineAt,
  resolveEffectiveTimeout,
  resolveRetryBackoffMs,
  resolveQuickStepTimeoutMs,
  detectRateLimit,
  collectAgentOutput,
  QUICK_STEP_DEFAULT_MS,
  QUICK_STEP_MIN_MS,
  RATE_LIMIT_PATTERNS
};
