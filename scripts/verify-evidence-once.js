/**
 * scripts/verify-evidence-once.js
 * Chay verifyTaskEvidence (ham that cua server) tren MOT BAN SAO cua evidence
 * dir => KHONG mutate job dang chay, nhung van dung code VERIFY moi nhat.
 *
 * Dung: node scripts/verify-evidence-once.js <featureDir> [taskCode]
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyTaskEvidence } = require('../src/server.js');

const featureDir = process.argv[2];
const taskCode = process.argv[3] || path.basename(featureDir);
if (!featureDir) {
  console.log('Dung: node scripts/verify-evidence-once.js <featureDir> [taskCode]');
  process.exit(1);
}
const srcEvidence = path.join(featureDir, 'evidence');
if (!fs.existsSync(srcEvidence)) {
  console.log('KHONG co evidence dir:', srcEvidence);
  process.exit(1);
}

// Ban sao tam => khong dong vao evidence that cua job.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-verify-once-'));
const copyFeature = path.join(tmp, 'feature');
const copyEvidence = path.join(copyFeature, 'evidence');
fs.mkdirSync(copyEvidence, { recursive: true });
for (const f of fs.readdirSync(srcEvidence)) {
  const s = path.join(srcEvidence, f);
  const st = fs.statSync(s);
  if (st.isDirectory()) {
    fs.mkdirSync(path.join(copyEvidence, f), { recursive: true });
    for (const g of fs.readdirSync(s)) {
      fs.copyFileSync(path.join(s, g), path.join(copyEvidence, f, g));
    }
  } else {
    fs.copyFileSync(s, path.join(copyEvidence, f));
  }
}
if (fs.existsSync(path.join(featureDir, 'test_plan.md'))) {
  fs.copyFileSync(path.join(featureDir, 'test_plan.md'), path.join(copyFeature, 'test_plan.md'));
}

console.log('evidence dir :', srcEvidence);
console.log('file tren dia:', fs.readdirSync(srcEvidence).filter((f) => f !== 'metadata.json').join(', ') || '(chi metadata.json)');
console.log('');

const res = verifyTaskEvidence({
  jobId: 'verify-once',
  evidenceDir: copyEvidence,
  featureDir: copyFeature,
  taskCode,
  emit: () => {}
});

console.log('=== KET QUA VERIFY (code hien tai) ===');
console.log('failed  :', res.failed);
console.log('reasons :');
for (const r of res.reasons || []) console.log('  -', r);
console.log('');
console.log(res.failed
  ? '=> FAIL (gate bat dung, khong PASS sai)'
  : '=> PASS');
