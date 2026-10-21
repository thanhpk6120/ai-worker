// Verify SystemOne chay voi model THAT (khong fallback heuristic).
// - Nap config tu .env (xuoi .env trong process.env de kiem tra).
// - Goi truc tiep 6 quyet dinh typed qua client: fallback !== true => model that tra ket qua.
// - Khong tao job, khong can server, khong de lai rac trong docs/features/.
//
// Usage: node scripts/verify-systemone-live.js
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Nap .env truc tiep (config.js chi nap khi require, nhung process.env co the da co gia tri cu).
try {
  const raw = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8');
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
    // .env la nguon chinh ly cho verify: ghi de gia tri ke thua tu shell cha.
    if (key) process.env[key] = val;
  }
} catch (e) {
  console.error('Khong doc duoc .env:', e.message);
  process.exit(1);
}

const config = require('../src/config');
const so = require('../src/systemone/client');

const EXPECTED_MODEL = 'openrouter/typesafe/jev-1.13';

// Doc ANTHROPIC_BASE_URL tu ~/.claude/settings.json (noi agent CLI lay endpoint LLM).
// Tra null neu khong doc duoc - assert tuong doi bo qua khi do.
function readLlmBaseUrl() {
  try {
    const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'settings.json');
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return (j && j.env && j.env.ANTHROPIC_BASE_URL) || null;
  } catch (e) {
    return null;
  }
}
async function main() {
  console.log('1) config:');
  console.log('   baseUrl =', config.SYSTEMONE_BASE_URL);
  console.log('   model   =', config.SYSTEMONE_MODEL);
  console.log('   key set =', !!config.SYSTEMONE_API_KEY);

  assert.equal(config.SYSTEMONE_MODEL, EXPECTED_MODEL, `model phai la ${EXPECTED_MODEL}`);
  assert.ok(config.SYSTEMONE_API_KEY, 'SYSTEMONE_API_KEY phai duoc set');
  // URL LLM that cua agent CLI nam trong ~/.claude/settings.json (ANTHROPIC_BASE_URL).
  // SystemOne phai tro toi endpoint typed-decision, khac endpoint LLM/completion.
  const llmBaseUrl = readLlmBaseUrl();
  console.log('   llmBaseUrl =', llmBaseUrl || '(khong doc duoc)');
  assert.ok(
    !llmBaseUrl || config.SYSTEMONE_BASE_URL !== llmBaseUrl,
    'URL SystemOne phai khac URL LLM'
  );
  assert.ok(
    config.SYSTEMONE_BASE_URL.includes('/systemone'),
    'URL SystemOne phai tro toi endpoint typed-decision /systemone'
  );

  const probe = await so.probe();
  console.log('2) probe:', JSON.stringify(probe));
  assert.equal(probe.live, true, 'model phai live');
  assert.equal(probe.error, null, 'probe khong duoc co loi');

  // 6 quyet dinh typed - moi quyet dinh fallback !== true => model that tra ket qua.
  const checks = [
    ['triage',   () => so.checkTriage({ taskCode: 'VERIFY-1', prompt: 'Fix a typo in README.md. No browser needed.' })],
    ['dedup',    () => so.checkDedup({ taskCode: 'VERIFY-1', prompt: 'Fix a typo in README.md.' })],
    ['guard',    () => so.checkGuard({ taskCode: 'VERIFY-1', prompt: 'login admin/admin password sk-abcdefghijklmnopqrstuvwx' })],
    ['fixgate',  () => so.checkFixGate({ jobId: 'verify-1', attempt: 1, maxRetries: 3, failures: { error: 'exit code 1' }, files: ['a.js'] })],
    ['prejudge', () => so.checkPreJudge({ jobId: 'verify-1', taskCode: 'VERIFY-1', summary: 'all tests pass' })],
    ['router',   () => so.pickRunner({ runnerRegistry: { listRunners: () => [{ name: 'claude-code' }, { name: 'omp' }] }, preferredName: 'omp', taskCode: 'VERIFY-1', step: 'implement' })]
  ];
  const results = [];
  for (const [name, fn] of checks) {
    const r = await fn();
    // checkGuard/pickRunner tra { action|promptToUse|name, decision } - co fallback
    // nằm trong object NESTED `decision`, object ngoài khong co `fallback`.
    const d = (r && r.decision) || r || {};
    const fromModel = d.fallback !== true;
    const hasConfidence = typeof d.confidence === 'number';
    results.push({ name, fromModel, hasConfidence, confidence: d.confidence });
    console.log(`3) ${name.padEnd(9)} fromModel=${fromModel} confidence=${d.confidence} fallback=${d.fallback}`);
  }

  const failed = results.filter((r) => !r.fromModel);
  const noConf = results.filter((r) => !r.hasConfidence);
  const stats = so.getStats();
  console.log('4) stats:', JSON.stringify(stats));

  assert.equal(failed.length, 0, `cac quyet dinh fallback heuristic: ${failed.map((f) => f.name).join(', ')}`);
  assert.equal(noConf.length, 0, `quyet dinh thieu confidence (khong chung minh duoc model that): ${noConf.map((f) => f.name).join(', ')}`);
  assert.ok(stats.calls >= 6, `phai co it nhat 6 calls (got ${stats.calls})`);
  assert.equal(stats.fallbacks, 0, 'khong duoc co fallback heuristic nao');
  assert.ok(stats.cost > 0, 'cost phai > 0 (da goi model that co phi)');

  console.log(`\nTAT CA PASS: model=${config.SYSTEMONE_MODEL}, live=true, calls=${stats.calls}, fallbacks=0, cost=${stats.cost}`);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
