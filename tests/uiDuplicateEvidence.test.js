const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UiEvidenceCollector, LogScanner } = require('../src/verification/multiVerificationGate');

describe('UI Duplicate Evidence Gate', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) duplicate PNG cùng md5 => ui.passed=false, reason chứa duplicate', async () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const payload = Buffer.concat([pngMagic, Buffer.from('fake-png-bytes-giong-het-nhau-1234567890')]);
    fs.writeFileSync(path.join(tmpDir, 'a.png'), payload);
    fs.writeFileSync(path.join(tmpDir, 'b.png'), payload);

    const collector = new UiEvidenceCollector();
    const result = await collector.verify({ featureName: 'dup', evidenceDir: tmpDir, testPlan: {} });

    assert.strictEqual(result.passed, false);
    const reason = JSON.stringify({ defects: result.defects, summary: result.summary }).toLowerCase();
    assert.ok(reason.includes('duplicate'), `reason phải chứa duplicate, nhận được: ${reason}`);
    assert.ok(result.defects.some((d) => (d.type || '').includes('DUPLICATE')));
  });

  it('(b) metadata.json tự chế sai fileSizeBytes => fail, reason chứa fileSize', async () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const payload = Buffer.concat([pngMagic, Buffer.from('real-png-content-abcdef')]);
    fs.writeFileSync(path.join(tmpDir, 'shot.png'), payload);
    const records = [{ fileName: 'shot.png', fileSizeBytes: payload.length + 9999, status: 'CAPTURED' }];
    fs.writeFileSync(path.join(tmpDir, 'metadata.json'), JSON.stringify(records, null, 2), 'utf8');

    const collector = new UiEvidenceCollector();
    const result = await collector.verify({ featureName: 'meta', evidenceDir: tmpDir, testPlan: {} });

    assert.strictEqual(result.passed, false);
    const reason = JSON.stringify({ defects: result.defects, summary: result.summary }).toLowerCase();
    assert.ok(reason.includes('filesize'), `reason phải chứa fileSize, nhận được: ${reason}`);
    assert.ok(result.defects.some((d) => (d.type || '').includes('FILESIZE')));
  });

  it('(c) log không có browser capture => fail, reason chứa capture', () => {
    const scanner = new LogScanner();
    const result = scanner.scanLogs('server started on port 3000\nrequest GET / OK\njob done', {
      requireBrowserCapture: true,
    });

    assert.strictEqual(result.passed, false);
    const reason = JSON.stringify({ violations: result.violations, summary: result.summary }).toLowerCase();
    assert.ok(reason.includes('capture'), `reason phải chứa capture, nhận được: ${reason}`);
  });
});
