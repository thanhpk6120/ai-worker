#!/usr/bin/env node
/**
 * scripts/analyze-ai-calls.js
 * Phan tich 1 job: dem so LAN goi headless AI (agent CLI) theo tung buoc pipeline.
 *
 * Nguon: file log cua job (logs/<jobId>.log). Marker spawn: "[AI-AGENT-PROCESS] $ ",
 * marker ket thuc: "[AI-AGENT-PROCESS-EXIT]". Moi cap spawn<->exit = 1 lan goi AI.
 *
 * Usage: node scripts/analyze-ai-calls.js <jobId>
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const jobId = process.argv[2];
if (!jobId) {
  console.error('Usage: node scripts/analyze-ai-calls.js <jobId>');
  process.exit(1);
}

const logPath = path.resolve('logs', `${jobId}.log`);
if (!fs.existsSync(logPath)) {
  console.error(`Khong tim thay log: ${logPath}`);
  process.exit(1);
}

// Log co ANSI escape codes (mau terminal) - bo di truoc khi match regex.
const lines = fs.readFileSync(logPath, 'utf8').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
// Log co ANSI escape codes (mau terminal) nen bo truoc khi match.
const RE_SPAWN = /^\[AI-AGENT-PROCESS\] \$ /;
const RE_EXIT = /^\[AI-AGENT-PROCESS-EXIT\]/;

const events = [];
lines.forEach((l, i) => {
  if (RE_EXIT.test(l)) events.push({ i, kind: 'EXIT', line: l });
  else if (RE_SPAWN.test(l)) events.push({ i, kind: 'SPAWN', line: l });
});
const spawns = events.filter((e) => e.kind === 'SPAWN');
const exits = events.filter((e) => e.kind === 'EXIT');

// Uoc luong thoi gian: marker "123s - Agent ..." hoac "⏱️ 123s" trong khoang spawn..exit.
function maxElapsed(a, b) {
  let best = 0;
  for (let i = a; i < b; i++) {
    const m1 = lines[i].match(/(\d+)s - /g) || [];
    for (const m of m1) { const v = parseInt(m, 10); if (Number.isFinite(v)) best = Math.max(best, v); }
    const m2 = lines[i].match(/⏱️ (\d+)s/g) || [];
    for (const m of m2) { const v = parseInt(m, 10); if (Number.isFinite(v)) best = Math.max(best, v); }
  }
  return best;
}

console.log(`Job: ${jobId}`);
console.log(`Log : ${logPath} (${(fs.statSync(logPath).size / 1024).toFixed(0)} KB)`);
console.log(`Tong so LAN goi headless AI: ${spawns.length}`);
console.log('');
console.log('  #  BUUC        AGENT    THOI GIAN  EXIT');
console.log('  ' + '-'.repeat(44));

const byStage = {};
let cur = null;
let n = 0;
for (const e of events) {
  if (e.kind === 'SPAWN') {
    cur = e.i;
    n += 1;
    const m = e.line.match(/# Template Prompt: ([A-Z\-]+) STAGE/);
    const stage = m ? m[1] : '?';
    const agent = e.line.includes('claude.exe') ? 'claude' : (e.line.includes('omp.exe') ? 'omp' : '?');
    byStage[stage] = (byStage[stage] || 0) + 1;
    process.stdout.write(`  ${String(n).padStart(2)} ${stage.padEnd(11)} ${agent.padEnd(7)}`);
  } else {
    const code = e.line.match(/m[a\u00e0]:?\s*(\d+)/);
    const dur = cur !== null ? maxElapsed(cur, e.i) : 0;
    console.log(`${String(dur).padStart(6)}s   ${code ? code[1] : '?'}`);
  }
}

console.log('  ' + '-'.repeat(44));
console.log('  Theo buoc:');
for (const [k, v] of Object.entries(byStage)) {
  console.log(`    ${k.padEnd(11)} ${v} lan`);
}
console.log('');
console.log('  Ghi chu: "thoi gian" la UOC LUONG tu marker elapsed trong log');
console.log('  (log cua task cu khong co timestamp per-dong - da fix trong feature nay).');
