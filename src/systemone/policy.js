/**
 * src/systemone/policy.js
 * Heuristic offline thuần local cho 6 UC SYSTEMONE-01.
 * Không mạng, <50ms, không đọc file ngoài payload, confidence <= 0.4.
 */
'use strict';

const crypto = require('node:crypto');

const LOW_CONF = 0.3;

function sha16(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function norm(s) {
  return String(s || '').slice(0, 2000);
}

// Bo dau + lowercase: de regex so sanh duoc ca text co dau va khong dau
// (user hay go tieng Viet khong dau khi paste tu nguon ngoai).
function fold(s) {
  return norm(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function routerHeuristic({ preferredName = 'claude-code' } = {}) {
  return { runner: preferredName, confidence: LOW_CONF, reason: 'fallback', cached: false, fallback: true, source: 'heuristic' };
}

// Regex phan loai nhanh (tức thì, 0 network call).
// `quick` = prompt ngan + khong phai bug/sua -> task de -> plan rut gon.
// `large` = migrate/refactor/monorepo hoac prompt rat dai -> task phuc tap.
// Regex phan loai nhanh (tuc thi, 0 network call).
// THU TU QUAN TRONG: `large` check TRUOC `quick` - truoc day "migrate ..." bi
// phan loai nhầm thanh quick vi len ngan (<200) va khong chua fix|bug|error.
function triageSignals({ prompt = '' } = {}) {
  const p = fold(prompt);
  const raw = norm(prompt);
  const large = /migrate|refactor|multi-module|microservice|monorepo/.test(p) || raw.length > 4000;
  const quick = /^(kiem tra|xac minh|test|check|ping|khao sat)\s/.test(p) || (raw.length < 200 && !/fix|bug|error|sua|loi/.test(p));
  const needBrowser = /browser|screenshot|giao dien|\bui\b/.test(p);
  return { quick: !large && quick, large, needBrowser };
}

function triageHeuristic({ prompt = '' } = {}) {
  const sig = triageSignals({ prompt });
  if (sig.large) return { complexity: 'L', track: 'full', needBrowser: sig.needBrowser, confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
  if (sig.quick) return { complexity: 'S', track: 'quick', needBrowser: sig.needBrowser, confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
  return { complexity: 'M', track: 'full', needBrowser: sig.needBrowser, confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
}

function fixGateHeuristic({ attempt = 0, maxRetries = 3 } = {}) {
  return {
    retry: Number(attempt) < Number(maxRetries),
    p_success: LOW_CONF,
    fixScope: 'scoped',
    confidence: LOW_CONF,
    cached: false,
    // Heuristic offline KHONG phai model that. Khong duoc dung p_success gia de
    // quyet dinh dung retry (da gay job bd88ae0a that bai o attempt 3/3).
    fallback: true,
    source: 'heuristic'
  };
}

function preJudgeHeuristic() {
  return { pass: false, failedFields: ['ui', 'api', 'log', 'db'], confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
}

function guardHeuristic() {
  // fail-closed an toàn: scrub rồi spawn
  return { hasSecret: false, hasInjection: false, action: 'scrub', confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
}

function dedupHeuristic({ taskCode = '', prompt = '' } = {}) {
  const bucketId = sha16(`${String(taskCode).trim().toLowerCase()}\n${norm(prompt).trim().toLowerCase()}`);
  return { bucketId, confidence: LOW_CONF, cached: false, isDuplicate: false, isNoise: false, fallback: true, source: 'heuristic' };
}

module.exports = {
  LOW_CONF,
  sha16,
  routerHeuristic,
  triageHeuristic,
  triageSignals,
  fold,
  fixGateHeuristic,
  preJudgeHeuristic,
  guardHeuristic,
  dedupHeuristic
};
