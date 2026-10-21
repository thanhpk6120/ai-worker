/**
 * src/execution/aiTriage.js
 * Phan loai do phuc tap cua task bang AI headless: DUNG 1 LUOT goi `claude` CLI,
 * nhan ve JSON thuan roi chuan hoa. Thay the quyet dinh quick/large bang regex heuristic.
 *
 * Vi sao khong dung heuristic: job bd88ae0a (RSGATE-44) bi phan loai sai, tu bat
 * `quick_track` -> cat ngan sach thoi gian cua user. Heuristic regex khong phai
 * quyet dinh cua model that, nen khong duoc dung de bat che do nhanh.
 *
 * Fail-safe: loi / timeout / output rac / JSON sai shape -> tra M/full (KHONG tu bat
 * quick mode). Chi ket qua that tu model moi duoc dung de bat quick track.
 *
 * Do tre: `claude -p --output-format json` da cho `thinking_tokens: 0` mac dinh o model
 * hien tai (claude-sonnet-5), nen KHONG can truyen flag thinking de giam do tre.
 */
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const config = require('../config');
const { maskSecrets } = require('./secretScrubber');
const { runnerRegistry } = require('../runners/runnerRegistry');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CACHE_TTL_MS = 3600000;
const MAX_REASON_CHARS = 200;
const MAX_PROMPT_CHARS = 4000;
const MAX_TITLE_CHARS = 200;

// Cache RAM: key -> { expiresAt, value }. CHI cache ket qua thanh cong (model that).
// Ket qua fallback KHONG cache: loi CLI/timeout la loi tam thoi, cache 1 gio se khong
// bao gio thu lai duoc model.
const cache = new Map();
const stats = { calls: 0, hits: 0, misses: 0, fallbacks: 0 };

/**
 * Timeout cho 1 luot goi AI headless (ms).
 * baseAdapter chuan hoa timeout theo he (>=10000 -> ms, >120 -> giay, con lai -> phut)
 * nen ep toi thieu 10000ms de don vi ms luon dung. Mot luot goi nhanh hon 10s deu fail.
 * @param {number|null} explicit Gia tri truyen tu caller (uu tien).
 * @returns {number}
 */
function resolveTimeoutMs(explicit) {
  const raw = (explicit !== undefined && explicit !== null && explicit !== '') ? explicit : config.AI_TRIAGE_TIMEOUT_MS;
  const n = Number(raw);
  const base = Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
  return Math.max(10000, base);
}

/**
 * TTL cache triage (ms).
 * @returns {number}
 */
function resolveCacheTtlMs() {
  const n = Number(config.AI_TRIAGE_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_MS;
}

/**
 * Key cache: hash prompt + title + timeoutMs (timeout anh huong quyet dinh nen phai
 * nam trong key).
 * @param {{prompt: string, title: string, timeoutMs: number}} input
 * @returns {string}
 */
function cacheKey({ prompt, title, timeoutMs }) {
  const raw = [String(prompt || ''), String(title || ''), String(timeoutMs)].join('\u0000');
  return 'triage:' + crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * @param {string} key
 * @returns {object|null}
 */
function getCache(key) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    stats.hits += 1;
    return { ...hit.value, cached: true };
  }
  if (hit) cache.delete(key);
  stats.misses += 1;
  return null;
}

/**
 * @param {string} key
 * @param {object} value
 */
function setCache(key, value) {
  cache.set(key, { expiresAt: Date.now() + resolveCacheTtlMs(), value });
}

// `maskSecrets` khong bat duoc dang "tai khoan login: admin/admin" (khong co key
// password/token/api_key) - ma task that cua repo dung dang nay. Scrub rieng tai day.
// Model thuong viet lai credential (vd "dang nhap web admin/admin") nen can bat ca
// cap `user/pass` trong context dang nhap, khong chi khi co dau `:` hay `=`.
// Keyword nhiet dang co dau - model tra ve tieng Viet co dau.
const CREDENTIAL_KEYWORD = '(?:tai\\s*khoan|tài\\s*khoản|tk|account|username|dang\\s*nhap|đăng\\s*nhập|dang\\s*ky|đăng\\s*ký|mat\\s*khau|mật\\s*khẩu|login|password|pass)';
// Cap co dau `:` hoac `=`: "tai khoan login: admin/admin".
const LOGIN_CREDENTIAL_REGEX = new RegExp('(' + CREDENTIAL_KEYWORD + '\\s*(?:login|web|he\\s*thong)?\\s*[:=]\\s*)([^\\s,;"\']{1,64}\\/[^\\s,;"\']{1,64})', 'gi');
// Cap trong context dang nhap, model bo dau cau: "dang nhap web admin/admin".
// Loai truong hop khong phai credential: cap `user/pass` ma phan sau co phu mo
// rong file (.js/.ts/.java/...) - do la duong dan, khong phai mat khau.
const BARE_CREDENTIAL_REGEX = new RegExp('(' + CREDENTIAL_KEYWORD + '[^\\n]{0,80}?)([A-Za-z0-9._-]{1,64}\\/[A-Za-z0-9._-]{1,64}(?!\\.[a-z]{1,8}\\b))', 'gi');

/**
 * Scrub output cua model: `maskSecrets` + che credential dang `user/pass`.
 * @param {string} text
 * @returns {string}
 */
function scrubOutput(text) {
  let s = maskSecrets(String(text || ''));
  s = s.replace(LOGIN_CREDENTIAL_REGEX, '$1***MASKED***');
  s = s.replace(BARE_CREDENTIAL_REGEX, '$1***MASKED***');
  return s;
}

/**
 * Prompt yeu cau model tra JSON thuan (khong markdown, khong y huong gi).
 * KHONG scrub prompt truoc khi gui: task co the chua credential (login JIRA) ma agent
 * can dung. Chi output cua model moi duoc scrub.
 * @param {{prompt: string, title: string}} input
 * @returns {string}
 */
function buildPrompt({ prompt, title }) {
  const p = String(prompt || '').slice(0, MAX_PROMPT_CHARS);
  const t = String(title || '').slice(0, MAX_TITLE_CHARS);
  return [
    'Phan loai do phuc tap cua task sau. Chi tra ve JSON thuan, KHONG markdown, KHONG code fence, KHONG y huong gi.',
    '{"complexity":"S|M|L","track":"quick|full","needBrowser":true|false,"confidence":0.0-1.0,"reason":"<ngan gon toi da 120 ky tu>"}',
    'Quy tac: complexity S = task nho, sua 1 file, cuc bo. M = task vua, nhieu file, can ke hoach. L = migrate/refactor/da module.',
    'track=quick CHI dung khi complexity=S. needBrowser=true neu can thao tac web/giao dien/screenshot. confidence = do tin cay 0.0-1.0.',
    'Tieu de: ' + t,
    'Task: ' + p
  ].join('\n');
}

/**
 * Parse mot object JSON dau tien doc duoc trong text (model co the boc them text).
 * @param {string} text
 * @returns {object|null}
 */
function parseJsonLoose(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (e) {}
  // Doan {...} dau tien (regex theo yeu cau: \{[\s\S]*\}).
  const greedy = s.match(/\{[\s\S]*\}/);
  if (greedy) {
    try {
      const obj = JSON.parse(greedy[0]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (e) {}
  }
  // Thu tung doan nho lao (model boc text xen ke) - doan nao parse duoc thi dung.
  const re = /\{[\s\S]*?\}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (e) {}
  }
  return null;
}

/**
 * @param {object} obj
 * @returns {boolean} Co phai object quyet dinh (co `complexity` hoac `track`) hay khong.
 */
function looksLikeDecision(obj) {
  return !!(obj && typeof obj === 'object' && ('complexity' in obj || 'track' in obj));
}

/**
 * Lay object quyet dinh tu stdout cua CLI. Ho tro 3 dang:
 * 1) `claude --output-format json` -> 1 object JSON co field `result` (string).
 * 2) stdout nhieu dong JSONL -> dong `message_end`/`assistant`/`result` cuoi cung.
 * 3) text thuong (model boc them text) -> tim doan `{...}` dau tien.
 * @param {string} stdout
 * @returns {object|null}
 */
function parseModelOutput(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  const candidates = [];

  // 1) stdout la 1 object JSON duy nhat.
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (typeof obj.result === 'string' && obj.result.trim()) {
        const inner = parseJsonLoose(obj.result);
        if (inner) candidates.push(inner);
      } else {
        candidates.push(obj);
      }
    }
  } catch (e) {}

  // 2) stdout nhieu dong JSONL.
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1) {
    let lastText = null;
    for (const line of lines) {
      let o = null;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o || typeof o !== 'object') continue;
      if (typeof o.result === 'string' && o.result.trim()) {
        lastText = o.result;
        continue;
      }
      const isAssistant = (o.type === 'message_end' || o.type === 'assistant') &&
        o.message && o.message.role === 'assistant';
      if (!isAssistant) continue;
      const content = o.message.content;
      const text = Array.isArray(content)
        ? content.map((c) => (c && c.text ? c.text : '')).join('\n')
        : String(content || '');
      if (text.trim()) lastText = text;
    }
    if (lastText) {
      const inner = parseJsonLoose(lastText);
      if (inner) candidates.push(inner);
    }
  }

  // 3) text thuong boc quanh JSON.
  const loose = parseJsonLoose(s);
  if (loose) candidates.push(loose);

  for (const c of candidates) {
    if (looksLikeDecision(c)) return c;
  }
  return candidates.length ? candidates[0] : null;
}

/**
 * Chuan hoa ket qua model: chi chap nhan complexity S|M|L, track quick|full,
 * needBrowser boolean, confidence trong [0,1]. Track=quick => complexity phai la S.
 * @param {object} raw
 * @returns {{complexity: string, track: string, needBrowser: boolean, confidence: number, reason: string}}
 */
function normalizeDecision(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cRaw = String(src.complexity || '').toUpperCase();
  let complexity = ['S', 'M', 'L'].indexOf(cRaw) >= 0 ? cRaw : 'M';
  const track = src.track === 'quick' ? 'quick' : 'full';
  const needBrowser = src.needBrowser === true || src.needBrowser === 'true';
  let confidence = Number(src.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));
  // Nhat quan: track=quick chi hop le khi complexity=S.
  if (track === 'quick' && complexity !== 'S') complexity = 'S';
  const reason = String(src.reason || '').trim().slice(0, MAX_REASON_CHARS) || 'AI khong tra ve ly do';
  return { complexity, track, needBrowser, confidence, reason };
}

/**
 * Ket qua fallback: luon M/full (fail-safe - KHONG tu bat quick mode).
 * @param {string} taskLabel
 * @param {string} reason
 * @returns {object}
 */
function fallbackResult(taskLabel, reason) {
  stats.fallbacks += 1;
  const out = {
    complexity: 'M',
    track: 'full',
    needBrowser: false,
    confidence: 0.3,
    source: 'fallback',
    reason: String(reason || 'AI triage khong phan hoi').slice(0, MAX_REASON_CHARS),
    cached: false,
    fallback: true
  };
  console.log(`[AI-TRIAGE] fallback (task=${taskLabel}): ${out.reason}`);
  return out;
}

/**
 * Phan loai task bang 1 luot goi AI headless (claude CLI).
 *
 * @param {object} input
 * @param {string} [input.prompt] Noi dung task (co the chua credential -> KHONG scrub truoc khi gui).
 * @param {string} [input.title] Tieu de task (du dung cho phan loai).
 * @param {string} [input.taskCode] Ma task (chi dung de log).
 * @param {number} [input.timeoutMs] Timeout rieng cho luot goi nay (ms).
 * @returns {Promise<{complexity: 'S'|'M'|'L', track: 'quick'|'full', needBrowser: boolean,
 *   confidence: number, source: string, reason: string, cached: boolean}>}
 */
async function classifyTask({ prompt = '', title = '', taskCode = '', timeoutMs = null } = {}) {
  const effTimeout = resolveTimeoutMs(timeoutMs);
  const taskLabel = String(taskCode || '').trim() || 'unknown';
  const key = cacheKey({ prompt, title, timeoutMs: effTimeout });

  const hit = getCache(key);
  if (hit) return hit;

  let runner = null;
  try {
    runner = runnerRegistry.getAvailableRunner('claude-code');
  } catch (e) { runner = null; }
  // `getAvailableRunner` co the tra runner KHAC (opencode/codex/...) khi claude-code
  // khong duoc cai. Chi dung adapter claude-code: cac flag lean (--tools "", --output-format
  // json) la flag cua claude CLI, adapter khac se fail -> fallback.
  if (!runner || runner.name !== 'claude-code') {
    return fallbackResult(taskLabel, 'khong tim thay runner AI headless (claude-code)');
  }
  let detection = null;
  try { detection = runner.detect(); } catch (e) { detection = null; }
  if (!detection || !detection.installed) {
    return fallbackResult(taskLabel, 'CLI claude khong co tren may');
  }

  let res = null;
  try {
    stats.calls += 1;
    res = await runner.execute({
      prompt: buildPrompt({ prompt, title }),
      timeoutMs: effTimeout,
      // cwd trung tinh: khong nap context repo (AGENTS.md...) va khong mao hieu
      // model phai doc file -> giam do tre + chi phi cua 1 luot goi triage.
      cwd: os.tmpdir(),
      // Flags "lean" cho 1 luot goi triage (do tre + chi phi):
      // - `--output-format json`: stdout la 1 object JSON co field `result` (text cua model).
      // - `--tools ""`: TAT tool -> model chi tra ve text, khong goi tool. Giup context
      //   input giam tu ~62.8k xuong ~16.8k token (do tre ~8-26s thay vi ~17s+).
      // - `--strict-mcp-config`: bo qua MCP server cua may (chi can model tra JSON).
      // - `--disable-slash-commands`: bo skill/slash command, giam context.
      // - `--no-session-persistence`: khong ghi session log cho 1 luot goi doc lap.
      // KHONG dung `--setting-sources ""`: settings.json chua ANTHROPIC_AUTH_TOKEN ->
      // bo di se mat xac thuc (CLI fail).
      extraArgs: ['--output-format', 'json', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']
    });
  } catch (e) {
    return fallbackResult(taskLabel, 'loi khi goi CLI: ' + ((e && e.message) || String(e)));
  }

  if (res && res.timedOut) {
    return fallbackResult(taskLabel, `timeout sau ${effTimeout}ms`);
  }

  // Scrub output TRUOC khi log/parse: prompt co the chua credential (vi du tai khoan
  // login JIRA) va model co the echo lai trong `reason`.
  const stdout = scrubOutput(String((res && res.stdout) || ''));
  const stderr = scrubOutput(String((res && res.stderr) || '')).slice(0, 300);

  const parsed = parseModelOutput(stdout);
  if (!looksLikeDecision(parsed)) {
    const exitCode = res && res.exitCode !== undefined && res.exitCode !== null ? res.exitCode : 'null';
    return fallbackResult(taskLabel, `output khong parse duoc (exitCode=${exitCode}) ${stderr}`);
  }

  const decision = normalizeDecision(parsed);
  const out = {
    complexity: decision.complexity,
    track: decision.track,
    needBrowser: decision.needBrowser,
    confidence: decision.confidence,
    source: 'ai-headless',
    reason: decision.reason,
    cached: false
  };
  setCache(key, out);
  console.log(`[AI-TRIAGE] ai-headless (task=${taskLabel}): complexity=${out.complexity} track=${out.track} needBrowser=${out.needBrowser} confidence=${out.confidence} reason=${out.reason}`);
  return { ...out };
}

module.exports = {
  classifyTask,
  getStats: () => ({ ...stats, cacheSize: cache.size })
};
