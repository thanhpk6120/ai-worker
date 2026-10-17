/**
 * tests/contextPruner.test.js
 * Kiểm thử tính năng cắt gọn previousContext và nạp đúng file theo từng step
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { defaultFileManager: storageFileManager } = require('../src/storage/fileManager');
const { defaultFileManager: utilsFileManager } = require('../src/utils/fileManager');
const { defaultPromptTemplateManager } = require('../src/runners/promptTemplateManager');

describe('Context Pruner & Step-specific Context Loading Test Suite', () => {
  let testWorkspace;
  const taskCode = 'TASK-PRUNE-101';
  let featureDir;

  before(() => {
    testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-context-test-'));
    featureDir = path.join(testWorkspace, 'docs', 'features', taskCode);
    fs.mkdirSync(featureDir, { recursive: true });

    // Tạo các file markdown mẫu
    fs.writeFileSync(path.join(featureDir, 'expect.md'), 'Nội dung expect.md nghiệp vụ');
    fs.writeFileSync(path.join(featureDir, 'context.md'), 'Nội dung context.md ngữ cảnh bổ sung');
    fs.writeFileSync(path.join(featureDir, 'dev_plan.md'), 'Nội dung dev_plan.md chi tiết kỹ thuật');
    fs.writeFileSync(path.join(featureDir, 'test_plan.md'), 'Nội dung test_plan.md kịch bản test');
    fs.writeFileSync(path.join(featureDir, 'tasks.md'), 'Nội dung tasks.md danh sách công việc');
    fs.writeFileSync(path.join(featureDir, 'memory.md'), 'Nội dung memory.md ghi chú bộ nhớ');
    fs.writeFileSync(path.join(featureDir, 'report.md'), 'Nội dung report.md kết quả test');
  });

  after(() => {
    if (testWorkspace && fs.existsSync(testWorkspace)) {
      try {
        fs.rmSync(testWorkspace, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  it('src/utils/fileManager.js re-export chính xác từ src/storage/fileManager.js', () => {
    assert.strictEqual(typeof utilsFileManager.loadPreviousContext, 'function');
    assert.strictEqual(utilsFileManager.loadPreviousContext, storageFileManager.loadPreviousContext);
  });

  it('PLANNING: Chỉ nạp expect.md và context.md, không nạp dev_plan, tasks, report...', () => {
    const ctx = storageFileManager.loadPreviousContext(testWorkspace, taskCode, 'planning');
    assert.ok(ctx.includes('expect.md'), 'Phải chứa expect.md');
    assert.ok(ctx.includes('context.md'), 'Phải chứa context.md');
    assert.ok(!ctx.includes('dev_plan.md'), 'Không được chứa dev_plan.md ở bước planning');
    assert.ok(!ctx.includes('tasks.md'), 'Không được chứa tasks.md');
    assert.ok(!ctx.includes('report.md'), 'Không được chứa report.md');
  });

  it('IMPLEMENT: Chỉ nạp dev_plan.md và test_plan.md, KHÔNG nhồi expect, tasks, memory, report, context', () => {
    const ctx = storageFileManager.loadPreviousContext(testWorkspace, taskCode, 'implement');
    assert.ok(ctx.includes('dev_plan.md'), 'Phải chứa dev_plan.md');
    assert.ok(ctx.includes('test_plan.md'), 'Phải chứa test_plan.md');
    assert.ok(!ctx.includes('expect.md'), 'Không được nhồi expect.md vào bước implement');
    assert.ok(!ctx.includes('tasks.md'), 'Không được nhồi tasks.md vào bước implement');
    assert.ok(!ctx.includes('memory.md'), 'Không được nhồi memory.md vào bước implement');
    assert.ok(!ctx.includes('report.md'), 'Không được nhồi report.md vào bước implement');
    assert.ok(!ctx.includes('context.md'), 'Không được nhồi context.md vào bước implement');
  });

  it('IMPLEMENT Fallback: Nếu không có dev_plan.md thì tự nạp plan.md', () => {
    const fallbackTaskCode = 'TASK-FALLBACK-102';
    const fallbackDir = path.join(testWorkspace, 'docs', 'features', fallbackTaskCode);
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(path.join(fallbackDir, 'plan.md'), 'Kế hoạch trong plan.md cũ');
    fs.writeFileSync(path.join(fallbackDir, 'test_plan.md'), 'Kế hoạch test trong test_plan.md');

    const ctx = storageFileManager.loadPreviousContext(testWorkspace, fallbackTaskCode, 'implement');
    assert.ok(ctx.includes('plan.md'), 'Phải nạp plan.md làm fallback');
    assert.ok(ctx.includes('test_plan.md'), 'Phải nạp test_plan.md');
  });

  it('TESTING: Nạp dev_plan.md, test_plan.md và report.md', () => {
    const ctx = storageFileManager.loadPreviousContext(testWorkspace, taskCode, 'testing');
    assert.ok(ctx.includes('dev_plan.md'), 'Phải chứa dev_plan.md');
    assert.ok(ctx.includes('test_plan.md'), 'Phải chứa test_plan.md');
    assert.ok(ctx.includes('report.md'), 'Phải chứa report.md');
  });

  it('FIXING: Nạp dev_plan.md và test_plan.md', () => {
    const ctx = storageFileManager.loadPreviousContext(testWorkspace, taskCode, 'fixing');
    assert.ok(ctx.includes('dev_plan.md'), 'Phải chứa dev_plan.md');
    assert.ok(ctx.includes('test_plan.md'), 'Phải chứa test_plan.md');
  });

  it('Giới hạn tối đa 8,000 ký tự cho mỗi phần tệp ngữ cảnh', () => {
    const hugeTaskCode = 'TASK-HUGE-103';
    const hugeDir = path.join(testWorkspace, 'docs', 'features', hugeTaskCode);
    fs.mkdirSync(hugeDir, { recursive: true });
    const hugeText = 'A'.repeat(15000);
    fs.writeFileSync(path.join(hugeDir, 'dev_plan.md'), hugeText);

    const ctx = storageFileManager.loadPreviousContext(testWorkspace, hugeTaskCode, 'implement');
    assert.ok(ctx.includes('dev_plan.md'));
    assert.ok(ctx.length < 10000, `Độ dài ngữ cảnh phải bị cắt ngắn (thực tế: ${ctx.length})`);
    assert.ok(ctx.includes('bị cắt bớt'), 'Phải có thông báo cắt bớt nội dung');
  });

  it('promptTemplateManager.buildPrompt cắt bớt nếu previousContext hoặc errorLogs quá lớn', () => {
    const hugeContext = 'C'.repeat(25000);
    const hugeErrors = 'E'.repeat(12000);

    const prompt = defaultPromptTemplateManager.buildPrompt({
      step: 'implement',
      taskCode: 'TASK-SAFE',
      userPrompt: 'Test safe prompt',
      previousContext: hugeContext,
      errorLogs: hugeErrors
    });

    assert.ok(prompt.includes('TASK-SAFE'));
    assert.ok(prompt.length < 25000, `Prompt phải được bảo vệ tránh tràn bộ đệm (thực tế: ${prompt.length})`);
    assert.ok(prompt.includes('đã bị cắt bớt'), 'Phải có thông báo cắt bớt ngữ cảnh trong prompt');
  });

  it('buildPrompt() merge prompt per-task từ prompts/implement.md khi file tồn tại', () => {
    const marker = 'MARKER-PER-TASK-IMPLEMENT-42';
    const customDir = path.join(testWorkspace, 'docs', 'features', 'TASK-CUSTOM-PROMPT');
    fs.mkdirSync(path.join(customDir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(customDir, 'prompts', 'implement.md'), `# Chi dan rieng\n${marker}\n`, 'utf8');

    const prompt = defaultPromptTemplateManager.buildPrompt({
      step: 'implement',
      taskCode: 'TASK-CUSTOM-PROMPT',
      userPrompt: 'Thuc thi theo chi dan rieng',
      workspacePath: testWorkspace,
      featureDir: customDir
    });

    assert.ok(prompt.includes(marker), 'Prompt phải chứa nội dung marker từ prompts/implement.md');
    assert.ok(!prompt.includes('{{'), 'Không được còn placeholder {{...}} chưa thay thế');
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), 'Không còn placeholder dạng {{TEN_BIEN}}');
  });

  it('buildPrompt() dùng chuỗi fallback khi thiếu prompts/testing.md, không để lại literal {{CUSTOM_STAGE_PROMPT}}', () => {
    const missingDir = path.join(testWorkspace, 'docs', 'features', 'TASK-NO-CUSTOM-PROMPT');
    fs.mkdirSync(missingDir, { recursive: true });
    assert.ok(!fs.existsSync(path.join(missingDir, 'prompts', 'testing.md')));

    const prompt = defaultPromptTemplateManager.buildPrompt({
      step: 'testing',
      taskCode: 'TASK-NO-CUSTOM-PROMPT',
      userPrompt: 'Kiem thu theo test_plan.md',
      workspacePath: testWorkspace,
      featureDir: missingDir
    });

    assert.ok(
      prompt.includes('Khong co chi dan dac thu theo scope (task khong phuc tap).'),
      'Phải chứa đúng chuỗi fallback của CUSTOM_STAGE_PROMPT'
    );
    assert.ok(!prompt.includes('{{CUSTOM_STAGE_PROMPT}}'), 'KHÔNG được còn literal {{CUSTOM_STAGE_PROMPT}}');
    assert.ok(!prompt.includes('{{'), 'Không được còn placeholder {{...}} chưa thay thế');
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), 'Không còn placeholder dạng {{TEN_BIEN}}');
  });
});
