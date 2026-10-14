/**
 * scripts/repro-rsgate-50-dup-ui.js
 * Script chứng minh evaluateAll với evidence RSGATE-50 (2 PNG cùng MD5)
 * trả về ui.passed = false, defects chứa 'duplicate' / DUPLICATE_SCREENSHOT,
 * và trả về duplicateGroups tương ứng.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { MultiVerificationGate, UiEvidenceCollector } = require('../src/verification/multiVerificationGate');

async function testRsgate50Repro() {
  console.log('=== BẮT ĐẦU TEST REPRO RSGATE-50 (2 PNG CÙNG MD5) ===');

  const tmpDir = path.join(os.tmpdir(), `rsgate50-evidence-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const VALID_PNG_BUFFER = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
    '0000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082',
    'hex'
  );

  // Tạo 2 file PNG giống hệt nhau về nội dung (cùng MD5)
  const img1 = path.join(tmpDir, 'screen1.png');
  const img2 = path.join(tmpDir, 'screen2.png');
  fs.writeFileSync(img1, VALID_PNG_BUFFER);
  fs.writeFileSync(img2, VALID_PNG_BUFFER);

  // Tạo 01_test_execution.log hợp lệ có chứa browser capture keyword
  const logFile = path.join(tmpDir, '01_test_execution.log');
  fs.writeFileSync(logFile, '[INFO] browser capture screenshot using playwright chromium runner\n', 'utf-8');

  // Tạo metadata.json khớp với đĩa
  const metaFile = path.join(tmpDir, 'metadata.json');
  fs.writeFileSync(metaFile, JSON.stringify({
    hasVisualDefects: false,
    consoleErrors: [],
    screenshots: [
      { fileName: 'screen1.png', fileSizeBytes: VALID_PNG_BUFFER.length },
      { fileName: 'screen2.png', fileSizeBytes: VALID_PNG_BUFFER.length }
    ]
  }, null, 2), 'utf-8');

  console.log(`Đã tạo thư mục test evidence tại: ${tmpDir}`);

  // Test trực tiếp UiEvidenceCollector.verify
  const collector = new UiEvidenceCollector();
  const uiResult = await collector.verify({
    featureName: 'RSGATE-50',
    evidenceDir: tmpDir
  });

  console.log('\n--- KẾT QUẢ UI COLLECTOR VERIFY ---');
  console.log('uiResult.passed:', uiResult.passed);
  console.log('uiResult.duplicateGroups:', JSON.stringify(uiResult.duplicateGroups, null, 2));
  console.log('uiResult.defects:', JSON.stringify(uiResult.defects, null, 2));

  assert.strictEqual(uiResult.passed, false, 'UI Collector phải FAILED khi phát hiện 2 PNG trùng lặp MD5');
  assert.ok(uiResult.duplicateGroups.length > 0, 'Phải trả về duplicateGroups');
  const hasDupDefect = uiResult.defects.some(d => d.type === 'DUPLICATE_SCREENSHOT' || (d.type && d.type.toLowerCase().includes('duplicate')));
  assert.ok(hasDupDefect, 'defects phải chứa defect DUPLICATE_SCREENSHOT');

  // Test qua MultiVerificationGate.evaluateAll
  const gate = new MultiVerificationGate({
    apiRunner: { runTests: async () => ({ passed: true, channel: 'api', summary: 'OK' }) },
    logScanner: { scanLogs: () => ({ passed: true, channel: 'log', summary: 'OK' }) },
    dbVerifier: { verify: async () => ({ passed: true, channel: 'db', summary: 'OK' }) }
  });

  const gateResult = await gate.evaluateAll({
    featureName: 'RSGATE-50',
    baseUrl: 'http://127.0.0.1:3000',
    testPlan: {
      evidenceDir: tmpDir
    },
    logs: '[INFO] Browser screenshot captured via playwright chromium'
  });

  console.log('\n--- KẾT QUẢ MULTI-VERIFICATION GATE EVALUATE ALL ---');
  console.log('gateResult.passed:', gateResult.passed);
  console.log('gateResult.ui.passed:', gateResult.ui?.passed);
  console.log('gateResult.channels.ui.passed:', gateResult.channels?.ui?.passed);
  console.log('gateResult.duplicateGroups:', JSON.stringify(gateResult.duplicateGroups, null, 2));
  console.log('gateResult.ui.duplicateGroups:', JSON.stringify(gateResult.ui?.duplicateGroups, null, 2));
  console.log('gateResult.channels.ui.defects:', JSON.stringify(gateResult.channels?.ui?.defects, null, 2));

  assert.strictEqual(gateResult.passed, false, 'MultiVerificationGate phải trả về passed = false');
  assert.strictEqual(gateResult.ui.passed, false, 'gateResult.ui.passed phải là false');
  assert.strictEqual(gateResult.channels.ui.passed, false, 'gateResult.channels.ui.passed phải là false');
  assert.ok(gateResult.failedChannels.includes('ui'), 'failedChannels phải chứa channel ui');

  const evalDupDefect = gateResult.channels.ui.defects.some(d =>
    d.type === 'DUPLICATE_SCREENSHOT' || (d.type && d.type.toLowerCase().includes('duplicate'))
  );
  assert.ok(evalDupDefect, 'Gate evaluateAll ui defects phải chứa duplicate defect');
  assert.ok(gateResult.ui.duplicateGroups.length > 0, 'gateResult.ui.duplicateGroups phải chứa nhóm trùng');

  console.log('\n✔ TẤT CẢ CÁC ĐIỀU KIỆN REPRO RSGATE-50 ĐỀU ĐẠT THÀNH CÔNG: KHÔNG CÒN PASS GIẢ!');
}

testRsgate50Repro().catch(err => {
  console.error('TEST REPRO THẤT BẠI:', err);
  process.exit(1);
});
