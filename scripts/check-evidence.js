/**
 * scripts/check-evidence.js
 * Kiem tra evidence cua 1 feature dir: file co that tren dia hay khong.
 * Dung: node scripts/check-evidence.js <featureDir> [metadataPath]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2] || process.cwd();
const metaPath = process.argv[3] || path.join(dir, 'metadata.json');

if (!fs.existsSync(metaPath)) {
  console.log('KHONG co metadata.json:', metaPath);
  process.exit(0);
}
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

const files = [];
const push = (v) => {
  if (!v) return;
  if (typeof v === 'string') files.push(v);
  else if (Array.isArray(v)) v.forEach(push);
  else if (typeof v === 'object') push(v.fileName || v.filePath || v.path || v.file);
};
if (Array.isArray(meta)) meta.forEach(push);
else if (meta.tests && Array.isArray(meta.tests)) meta.tests.forEach((t) => push(t.evidence || t.files || t.screenshots));
else if (meta.evidence) push(meta.evidence);
else Object.keys(meta).forEach((k) => { if (k !== 'taskCode' && k !== 'verdict' && k !== 'evidenceStatus') push(meta[k]); });

const uniq = [...new Set(files.filter(Boolean))];
let missing = 0;
console.log('evidence khai bao:', uniq.length);
for (const f of uniq) {
  const p = path.join(dir, f);
  const ok = fs.existsSync(p);
  if (!ok) missing += 1;
  console.log(`  ${ok ? 'OK     ' : 'MISSING'} ${f}`);
}
console.log(`\n=> ${uniq.length - missing}/${uniq.length} file ton tai, ${missing} thieu`);
console.log('verdict khai bao:', meta.verdict || '(null)');
