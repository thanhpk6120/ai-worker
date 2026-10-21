/**
 * promptGuard.js - Scrub prompt LOCAL (khong goi mang).
 *
 * LY DO tach rieng khoi SystemOne:
 * - `SecretScrubber` local nhanh, MIEN PHI, dung duoc 100% noi dung prompt
 *   (khong cat bo du lieu de "tiet kiem context").
 * - SystemOne chi nen duoc goi o noi can QUYET DINH NHANH co dap an co san
 *   va input it. Prompt 10-14KB la input LON => goi model de kiem tra "co secret
 *   hay khong" la lam dung, ton 1 network call moi step, va lam chay lau.
 * - Phan detect prompt-injection (noi dung user) giu lai: day la quyet dinh
 *   can nhanh, input nho.
 *
 * Keo duong: ham nay KHONG cat nội dung ngoai muc chua secret.
 */
'use strict';

const { maskSecrets } = require('../execution/secretScrubber');

// dau hieu prompt injection: user co the yeu cau agent bo qua quy tac.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  // Tieng Viet co dau va khong dau (user co the bo dau khi chat).
  /b[oỏ]\s+qua\s+(m[oọ]i|t[aấ]t\s+c[aả]|to[aà]n\s+b[oộ])\s+(quy\s*t[aắ]c|ch[iỉ]\s*d[aâ]n|h[uư][oơ]ng\s+d[aâ]n)/i,
  /you\s+are\s+now\s+(a|an|in)\s+/i,
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /print\s+(your|the)\s+system\s+prompt/i,
  /executed?\s+on\s+all\s+outputs/i,
  /developer\s+mode/i
];

/**
 * Kiem tra prompt co dau hieu injection khong.
 * @param {string} prompt
 * @returns {{detected: boolean, pattern: string|null}}
 */
function detectInjection(prompt) {
  const text = String(prompt || '');
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) return { detected: true, pattern: re.source };
  }
  return { detected: false, pattern: null };
}

/**
 * Scrub prompt local: che secret + phat hien injection.
 * KHONG cat nội dung (chi thay secret bang placeholder).
 *
 * @param {string} prompt
 * @returns {{promptToUse: string, action: 'allow'|'scrub'|'warn'|'block', hasSecret: boolean, injection: boolean, injectionPattern: string|null, scrubbed: boolean}}
 */
function guardPrompt(prompt) {
  const original = String(prompt || '');
  const scrubbed = maskSecrets(original);
  const hasSecret = scrubbed !== original;
  const inj = detectInjection(original);

  let action = 'allow';
  if (hasSecret) action = 'scrub';
  if (inj.detected) action = 'block';

  return {
    promptToUse: scrubbed,
    action,
    hasSecret,
    injection: inj.detected,
    injectionPattern: inj.pattern,
    scrubbed: hasSecret,
    // Tuong thich voi shape cua systemone.checkGuard de server.js doi chit nhat.
    decision: { action, hasSecret, hasInjection: inj.detected, confidence: 1, cached: false, fallback: false, source: 'local-scrubber' },
    blocked: false,
    warned: hasSecret || inj.detected
  };
}

module.exports = { guardPrompt, detectInjection };
