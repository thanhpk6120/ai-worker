/**
 * tests/quickTrack.test.js
 * Che do NHANH cho task de:
 * - pipeline_config.quick_track duoc doc/ghi dung
 * - timeout step cua quick track bi gioi han (uu tien toc do)
 * - template planning-quick / implement-quick ton tai
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const jobPolicy = require('../src/execution/jobPolicy');
const { PromptTemplateManager } = require('../src/runners/promptTemplateManager');

const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates', 'prompt');

describe('quick track - pipeline_config', () => {
  it('doc quick_track=true tu pipeline_config (string JSON)', () => {
    const job = { pipeline_config: JSON.stringify({ quick_track: true, timeout: 900 }) };
    const cfg = jobPolicy.parsePipelineConfig(job);
    assert.strictEqual(cfg.quick_track, true);
  });

  it('doc quick_track=true tu pipeline_config (object)', () => {
    const job = { pipeline_config: { quick_track: true } };
    assert.strictEqual(jobPolicy.parsePipelineConfig(job).quick_track, true);
  });

  it('mac dinh khong co quick_track', () => {
    const job = { pipeline_config: { timeout: 900 } };
    assert.notStrictEqual(jobPolicy.parsePipelineConfig(job).quick_track, true);
  });
});

describe('quick track - timeout step', () => {
  it('mac dinh 5 phut khi quick track', () => {
    const job = { pipeline_config: { quick_track: true } };
    const t = jobPolicy.resolveQuickStepTimeoutMs(job, 60 * 60 * 1000);
    assert.strictEqual(t, 5 * 60 * 1000);
  });

  it('hon pipeline_config.quick_timeout_ms', () => {
    const job = { pipeline_config: { quick_track: true, quick_timeout_ms: 120000 } };
    assert.strictEqual(jobPolicy.resolveQuickStepTimeoutMs(job, 60 * 60 * 1000), 120000);
  });

  it('khong quick track => tra fallback (khong ap dung)', () => {
    const job = { pipeline_config: { timeout: 900 } };
    const t = jobPolicy.resolveQuickStepTimeoutMs(job, 60 * 60 * 1000);
    assert.strictEqual(t, 5 * 60 * 1000, 'van tra cap mac dinh, server moi so sanh de quyet dinh ap dung');
  });
});

describe('quick track - template', () => {
  const mgr = new PromptTemplateManager(TEMPLATES_DIR);

  it('co template planning-quick.md va implement-quick.md', () => {
    assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, 'planning-quick.md')));
    assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, 'implement-quick.md')));
  });

  it('getTemplate("planning-quick") tra template ngan gon', () => {
    const t = mgr.getTemplate('planning-quick');
    assert.ok(t.includes('YÊU CẦU TỐC ĐỘ'), 'phai co yeu cau toc do');
    assert.ok(t.includes('dev_plan.md'));
    assert.ok(t.length < 6000, `template qua dai: ${t.length} ky tu`);
  });

  it('getTemplate("implement-quick") co quy tac sua toi thieu', () => {
    const t = mgr.getTemplate('implement-quick');
    assert.ok(t.includes('SỬA TỐI THIỂU'));
    assert.ok(t.length < 5000, `template qua dai: ${t.length} ky tu`);
  });

  it('buildPrompt voi step planning-quick render duoc placeholder', () => {
    const p = mgr.buildPrompt({ step: 'planning-quick', taskCode: 'T-1', userPrompt: 'fix typo', workspacePath: '/tmp', featureDir: '/tmp/f' });
    assert.ok(p.includes('T-1'));
    assert.ok(p.includes('fix typo'));
    assert.ok(!p.includes('{{PROMPT}}'), 'phai thay het placeholder');
  });

  it('template chuan van dung nguyen', () => {
    const t = mgr.getTemplate('planning');
    assert.ok(t.includes('Dual Planning'), 'template planning.md chuan phai con nguyen');
    assert.ok(t.length > 6000, 'template chuan phai dai hon template quick');
  });
});
