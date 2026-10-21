/**
 * tests/planningScopeGuard.test.js
 * PLANNING chi duoc doc trong WORKSPACE_PATH + FEATURE_DIR.
 *
 * Ly do: job RSGATE-44 PLANNING mat ~20 phut, agent grep trong
 * `ai-worker/logs` (log noi bo cua orchestrator) de truy tim lenh `trash` -
 * ngoai workspace task, ngoai pham vi lap ke hoach, lam lang phi thoi gian.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { defaultPromptTemplateManager: promptTemplateManager } = require('../src/runners/promptTemplateManager');
const path = require('node:path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'prompt');

test('template planning.md co muc PHAM VI DOC (chi workspace + feature dir)', () => {
  const t = fs.readFileSync(path.join(TEMPLATES_DIR, 'planning.md'), 'utf8');
  assert.ok(t.includes('PHẠM VI ĐỌC'), 'phai co muc pham vi doc');
  assert.ok(t.includes('{{WORKSPACE_PATH}}'), 'phai tro workspace path');
  assert.ok(t.includes('{{FEATURE_DIR}}'), 'phai tro feature dir');
  assert.ok(/KHÔNG.*(log|ai-worker)/i.test(t), 'phai cam doc log noi bo / thu muc ha tang');
});

test('template planning.md co muc 3b (dung lai plan co san)', () => {
  const t = fs.readFileSync(path.join(TEMPLATES_DIR, 'planning.md'), 'utf8');
  assert.ok(t.includes('3b.'), 'phai co muc 3b');
  assert.ok(t.includes('dev_plan.md'), 'phai nhac dev_plan.md');
  assert.ok(t.includes('test_plan.md'), 'phai nhac test_plan.md');
  assert.ok(/KHÔNG khảo sát lại từ đầu/.test(t), 'phai cam khao sat lai tu dau');
});

test('template planning.md khong bi phong mau (placeholder con lai)', () => {
  const t = fs.readFileSync(path.join(TEMPLATES_DIR, 'planning.md'), 'utf8');
  const left = t.match(/\{\{[A-Z_]+\}\}/g) || [];
  const known = new Set(['TASK_CODE', 'PROMPT', 'WORKSPACE_PATH', 'FEATURE_DIR', 'MCP_SERVERS', 'PREVIOUS_CONTEXT', 'REPORT', 'ERROR_LOGS', 'CONTEXT_FILES']);
  const unknown = left.filter((x) => !known.has(x.replace(/[{}]/g, '')));
  assert.deepEqual(unknown, [], 'placeholder la khong xac dinh: ' + unknown.join(', '));
});

test('render prompt planning: co pham vi doc + muc 3b + context tro duong dan', () => {
  const p = promptTemplateManager.buildPrompt({
    step: 'planning',
    taskCode: 'T-SCOPE-1',
    userPrompt: 'lam gi do',
    workspacePath: 'D:/ws',
    featureDir: 'D:/ws/docs/features/T-SCOPE-1',
    previousContext: '### Kế hoạch đã có sẵn (ĐỌC FILE NÀY trước khi khảo sát lại)\n- `D:/ws/docs/features/T-SCOPE-1/dev_plan.md`\n'
  });
  assert.ok(p.includes('PHẠM VI ĐỌC'), 'render phai co pham vi doc');
  assert.ok(p.includes('3b.'), 'render phai co muc 3b');
  assert.ok(p.includes('dev_plan.md'), 'render phai co duong dan plan tu previousContext');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(p), 'khong con placeholder chua thay');
});
