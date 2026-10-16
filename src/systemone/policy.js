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

function routerHeuristic({ preferredName = 'claude-code' } = {}) {
  return { runner: preferredName, confidence: LOW_CONF, reason: 'fallback', cached: false };
}

function triageHeuristic({ prompt = '' } = {}) {
  const p = norm(prompt);
  const low = /^(kiểm tra|xác minh|test|check|ping|khảo sát)\s/i.test(p) || (p.length < 200 && !/fix|bug|error|sửa|lỗi/i.test(p));
  const large = /migrate|refactor|multi-module|microservice|monorepo/i.test(p) || p.length > 4000;
  if (low) return { complexity: 'S', track: 'quick', needBrowser: /browser|screenshot|ui|giao diện/i.test(p), confidence: LOW_CONF, cached: false };
  if (large) return { complexity: 'L', track: 'full', needBrowser: /browser|screenshot|ui|giao diện/i.test(p), confidence: LOW_CONF, cached: false };
  return { complexity: 'M', track: 'full', needBrowser: /browser|screenshot|ui|giao diện/i.test(p), confidence: LOW_CONF, cached: false };
}

function fixGateHeuristic({ attempt = 0, maxRetries = 3 } = {}) {
  return {
    retry: Number(attempt) < Number(maxRetries),
    p_success: LOW_CONF,
    fixScope: 'scoped',
    confidence: LOW_CONF,
    cached: false
  };
}

function preJudgeHeuristic() {
  return { pass: false, failedFields: ['ui', 'api', 'log', 'db'], confidence: LOW_CONF, cached: false };
}

function guardHeuristic() {
  // fail-closed an toàn: scrub rồi spawn
  return { hasSecret: false, hasInjection: false, action: 'scrub', confidence: LOW_CONF, cached: false };
}

function dedupHeuristic({ taskCode = '', prompt = '' } = {}) {
  const bucketId = sha16(`${String(taskCode).trim().toLowerCase()}\n${norm(prompt).trim().toLowerCase()}`);
  return { bucketId, confidence: LOW_CONF, cached: false, isDuplicate: false, isNoise: false };
}

module.exports = {
  LOW_CONF,
  sha16,
  routerHeuristic,
  triageHeuristic,
  fixGateHeuristic,
  preJudgeHeuristic,
  guardHeuristic,
  dedupHeuristic
};
