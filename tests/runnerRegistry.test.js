/**
 * tests/runnerRegistry.test.js
 * Kiểm thử tự động RunnerRegistry và PromptTemplateManager.
 * Tuân thủ chuẩn Node.js 22+ (node:test, node:assert/strict).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { RunnerRegistry, runnerRegistry } = require('../src/runners/runnerRegistry');
const BaseAdapter = require('../src/runners/baseAdapter');
const { PromptTemplateManager, defaultPromptTemplateManager } = require('../src/runners/promptTemplateManager');

describe('RunnerRegistry & PromptTemplateManager Test Suite', () => {
  let testTempDir;

  before(() => {
    testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-runner-test-'));
  });

  after(() => {
    if (testTempDir && fs.existsSync(testTempDir)) {
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (err) {
        // Bỏ qua lỗi dọn dẹp nếu có file lock tạm thời
      }
    }
  });

  describe('RunnerRegistry', () => {
    it('Khởi tạo mặc định có đủ các runner tiêu chuẩn', () => {
      const standardRunners = ['claude-code', 'opencode', 'omp', 'codex-cli', 'antigravity'];
      for (const name of standardRunners) {
        const runner = runnerRegistry.getRunner(name);
        assert.ok(runner, `Runner ${name} phải tồn tại trong runnerRegistry`);
        assert.strictEqual(typeof runner.detect, 'function');
        assert.strictEqual(typeof runner.buildCommand, 'function');
      }
    });

    it('Đăng ký và tra cứu runner theo canonical name và alias (case-insensitive)', () => {
      const customRegistry = new RunnerRegistry();

      class MockCustomRunner extends BaseAdapter {
        constructor() {
          super('Custom-Agent', 'custom-cli', {
            aliases: ['custom', 'my-agent', 'c-agent'],
            enabled: true
          });
        }
        detect() {
          return { installed: true, version: '1.2.3', path: '/usr/bin/custom-cli' };
        }
      }

      const mockRunner = new MockCustomRunner();
      customRegistry.register(mockRunner);

      // Tra cứu theo canonical name với các dạng hoa thường khác nhau
      assert.strictEqual(customRegistry.getRunner('custom-agent'), mockRunner);
      assert.strictEqual(customRegistry.getRunner('Custom-Agent'), mockRunner);
      assert.strictEqual(customRegistry.getRunner('CUSTOM-AGENT'), mockRunner);

      // Tra cứu theo alias với các dạng hoa thường khác nhau
      assert.strictEqual(customRegistry.getRunner('custom'), mockRunner);
      assert.strictEqual(customRegistry.getRunner('CUSTOM'), mockRunner);
      assert.strictEqual(customRegistry.getRunner('my-agent'), mockRunner);
      assert.strictEqual(customRegistry.getRunner('MY-AGENT'), mockRunner);
      assert.strictEqual(customRegistry.getRunner('c-agent'), mockRunner);

      // Tra cứu runner không tồn tại trả về null
      assert.strictEqual(customRegistry.getRunner('non-existent-runner'), null);
      assert.strictEqual(customRegistry.getRunner(''), null);
      assert.strictEqual(customRegistry.getRunner(null), null);
    });

    it('resolveRunner() fallback chính xác khi ưu tiên runner hoặc chọn runner khả dụng', () => {
      const customRegistry = new RunnerRegistry();
      // Xóa các runner mặc định để kiểm thử fallback hoàn toàn cô lập
      customRegistry.runners.clear();
      customRegistry.nameLookup.clear();

      // Giả lập runner 1: Đã cài đặt và enabled
      class InstalledRunner extends BaseAdapter {
        constructor() {
          super('installed-cli', 'installed-cli', { enabled: true });
        }
        detect() {
          return { installed: true, version: '1.0.0', path: '/bin/installed-cli' };
        }
      }

      // Giả lập runner 2: Chưa cài đặt
      class UninstalledRunner extends BaseAdapter {
        constructor() {
          super('uninstalled-cli', 'uninstalled-cli', { enabled: true });
        }
        detect() {
          return { installed: false, version: null, path: null };
        }
      }

      const installed = new InstalledRunner();
      const uninstalled = new UninstalledRunner();

      customRegistry.register(installed);
      customRegistry.register(uninstalled);

      // 1. Khi chỉ định runner đã cài đặt -> trả về runner đó
      const resolvedPreferred = customRegistry.resolveRunner('installed-cli');
      assert.strictEqual(resolvedPreferred.name, 'installed-cli');

      // 2. Khi chỉ định runner chưa cài đặt -> fallback về runner đầu tiên khả dụng đã cài đặt
      const fallbackFromUninstalled = customRegistry.resolveRunner('uninstalled-cli');
      assert.strictEqual(fallbackFromUninstalled.name, 'installed-cli');

      // 3. Khi chỉ định runner không tồn tại -> fallback về runner khả dụng
      const fallbackFromUnknown = customRegistry.resolveRunner('unknown-cli');
      assert.strictEqual(fallbackFromUnknown.name, 'installed-cli');

      // 4. Khi không truyền preferredName -> tự động chọn runner khả dụng
      const defaultResolved = customRegistry.resolveRunner();
      assert.ok(defaultResolved, 'Phải giải quyết được ít nhất một runner');
      assert.strictEqual(defaultResolved.name, 'installed-cli');
    });

    it('findLatestSessionFile() chỉ trả về .jsonl cấp gốc, bỏ qua log/__advisor trong thư mục con', () => {
      const adapter = new BaseAdapter('Probe', 'claude');
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-session-scan-'));
      try {
        const mainSession = path.join(sessionDir, 'a.jsonl');
        fs.writeFileSync(mainSession, '{"type":"session"}\n');

        const subDir = path.join(sessionDir, 'sub');
        fs.mkdirSync(subDir, { recursive: true });
        const decoys = [
          path.join(subDir, '12.bash-original.log'),
          path.join(subDir, '26.bash.log'),
          path.join(subDir, '__advisor.jsonl')
        ];
        for (const decoy of decoys) {
          fs.writeFileSync(decoy, 'noise\n');
        }
        // Ép mtime các file nhiễu mới hơn hẳn file session chính để chắc chắn không thắng theo mtime
        const future = (Date.now() + 60000) / 1000;
        for (const decoy of decoys) {
          fs.utimesSync(decoy, future, future);
        }

        const latest = adapter.findLatestSessionFile(sessionDir);

        assert.strictEqual(latest, mainSession, 'Chỉ được trả về file .jsonl cấp sessionDir');
        assert.strictEqual(path.basename(latest), 'a.jsonl');
        assert.ok(!latest.endsWith('.log'), 'KHÔNG bao giờ trả về file .log');
        assert.ok(!path.basename(latest).startsWith('__'), 'KHÔNG bao giờ trả về __advisor.jsonl');
      } finally {
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    });

    it('findLatestSessionFile() với nhiều .jsonl cấp gốc thì trả về file có mtime mới nhất', () => {
      const adapter = new BaseAdapter('Probe', 'claude');
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-session-latest-'));
      try {
        const older = path.join(sessionDir, 'old.jsonl');
        const newer = path.join(sessionDir, 'new.jsonl');
        fs.writeFileSync(older, '{"n":1}\n');
        fs.writeFileSync(newer, '{"n":2}\n');

        const base = Date.now() / 1000;
        fs.utimesSync(older, base - 3600, base - 3600);
        fs.utimesSync(newer, base, base);

        assert.strictEqual(adapter.findLatestSessionFile(sessionDir), newer);

        // Đảo ngược mtime -> kết quả phải đổi theo
        fs.utimesSync(newer, base - 7200, base - 7200);
        assert.strictEqual(adapter.findLatestSessionFile(sessionDir), older);
      } finally {
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    });

    it('findLatestSessionFile() trả về null khi thư mục không có file .jsonl hợp lệ', () => {
      const adapter = new BaseAdapter('Probe', 'claude');
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-session-empty-'));
      try {
        fs.writeFileSync(path.join(sessionDir, '__advisor.jsonl'), 'x\n');
        fs.writeFileSync(path.join(sessionDir, 'run.log'), 'x\n');
        assert.strictEqual(adapter.findLatestSessionFile(sessionDir), null);
      } finally {
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    });

    it('enableRunner() và disableRunner() cập nhật cờ enabled', () => {
      const reg = new RunnerRegistry();
      const runner = reg.getRunner('claude-code');
      assert.ok(runner);

      reg.disableRunner('claude-code');
      assert.strictEqual(runner.enabled, false);

      reg.enableRunner('claude-code');
      assert.strictEqual(runner.enabled, true);
    });
  });

  describe('PromptTemplateManager', () => {
    it('loadTemplate() nạp được template của các bước hoặc fallback', () => {
      const manager = new PromptTemplateManager();

      const planningTpl = manager.loadTemplate('planning');
      assert.ok(typeof planningTpl === 'string' && planningTpl.length > 0);
      assert.ok(planningTpl.includes('{{TASK_CODE}}'));

      const implementTpl = manager.loadTemplate('implement');
      assert.ok(typeof implementTpl === 'string' && implementTpl.length > 0);
      assert.ok(implementTpl.includes('{{WORKSPACE_PATH}}'));

      const testingTpl = manager.loadTemplate('testing');
      assert.ok(typeof testingTpl === 'string' && testingTpl.length > 0);

      const fixingTpl = manager.loadTemplate('fixing');
      assert.ok(typeof fixingTpl === 'string' && fixingTpl.length > 0);
    });

    it('renderTemplate() thay thế chính xác các placeholders', () => {
      const manager = new PromptTemplateManager();
      const template = 'Task: {{TASK_CODE}} | User: {{USER_NAME}} | Step: {{STEP}}';
      const rendered = manager.renderTemplate(template, {
        TASK_CODE: 'TASK-1234',
        USER_NAME: 'Nguyễn Văn A',
        STEP: 'IMPLEMENT'
      });

      assert.strictEqual(rendered, 'Task: TASK-1234 | User: Nguyễn Văn A | Step: IMPLEMENT');
    });

    it('buildPrompt() render đầy đủ và lưu tệp prompt.md trong feature dir (UTF-8)', () => {
      const manager = new PromptTemplateManager();
      const featureDir = path.join(testTempDir, 'docs/features/TASK-E2E-TEST');
      const promptFilePath = path.join(featureDir, 'prompt.md');
      const builtPrompt = manager.buildPrompt({
        step: 'fixing',
        taskCode: 'TASK-E2E-TEST',
        userPrompt: 'Triển khai kiểm thử tự động với tiếng Việt: Xin chào Thế Giới 🚀',
        workspacePath: testTempDir,
        featureDir,
        previousContext: 'Tài liệu kiến trúc hệ thống phiên bản 1.0',
        errorLogs: 'Chi tiết lỗi kiểm thử: Không thể kết nối DB',
        saveToFile: true,
        outputFile: promptFilePath
      });

      // Thẩm định nội dung prompt trả về
      assert.ok(builtPrompt.includes('TASK-E2E-TEST'));
      assert.ok(builtPrompt.includes('Triển khai kiểm thử tự động với tiếng Việt: Xin chào Thế Giới 🚀'));
      assert.ok(builtPrompt.includes('Tài liệu kiến trúc hệ thống phiên bản 1.0'));
      assert.ok(builtPrompt.includes('Chi tiết lỗi kiểm thử: Không thể kết nối DB'));

      // Thẩm định tệp prompt.md đã được tạo trong feature dir
      assert.ok(fs.existsSync(promptFilePath), 'Tệp prompt.md phải được lưu vào feature dir');

      // Đọc lại nội dung tệp bằng UTF-8 và so sánh
      const savedContent = fs.readFileSync(promptFilePath, 'utf8');
      assert.strictEqual(savedContent, builtPrompt, 'Nội dung tệp lưu phải trùng khớp hoàn toàn với prompt đã sinh');
      assert.ok(savedContent.includes('Xin chào Thế Giới 🚀'), 'Ký tự tiếng Việt và emoji phải được bảo toàn nguyên vẹn UTF-8');
    });

    it('buildPrompt() từ chối ghi prompt ra ngoài feature dir', () => {
      const manager = new PromptTemplateManager();
      assert.throws(() => manager.buildPrompt({
        step: 'fixing',
        taskCode: 'TASK-X',
        userPrompt: 'x',
        workspacePath: testTempDir,
        featureDir: path.join(testTempDir, 'docs/features/TASK-X'),
        saveToFile: true,
        outputFile: path.join(testTempDir, '.task_prompt.txt')
      }), /ngoài feature dir/);
    });

    it('buildPrompt() step testing yêu cầu đọc test_plan.md, chạy test thật và không chứa lệnh fetch giả / bypass URL', () => {
      const manager = new PromptTemplateManager();
      const builtPrompt = manager.buildPrompt({
        step: 'testing',
        taskCode: 'TASK-TEST-123',
        userPrompt: 'Hãy test cái này.',
        workspacePath: testTempDir,
        featureDir: path.join(testTempDir, 'docs/features/TASK-TEST-123')
      });

      assert.ok(builtPrompt.includes('TASK-TEST-123'), 'Phải chứa TASK_CODE');
      assert.ok(builtPrompt.includes('test_plan.md'), 'Phải yêu cầu đọc test_plan.md');
      assert.ok(builtPrompt.includes('TUYỆT ĐỐI KHÔNG BYPASS'), 'Phải cấm bypass mock server');
      assert.ok(builtPrompt.includes('CHẠY KIỂM THỬ THẬT'), 'Phải yêu cầu chạy lệnh test chuẩn của repository');
      assert.ok(!/curl\s+-.*http/i.test(builtPrompt), 'Không chứa lệnh curl fetch bypass URL');
    });

    it('savePromptFile() lưu tệp prompt.md trong feature dir và bảo toàn UTF-8', () => {
      const manager = new PromptTemplateManager();
      const featureDir = path.join(testTempDir, 'docs/features/TASK-X');
      fs.mkdirSync(featureDir, { recursive: true });

      const content = '# Tiêu đề prompt UTF-8\nNội dung chi tiết kiểm thử tiến trình con';
      const targetPath = manager.savePromptFile(content, featureDir, featureDir);

      assert.ok(fs.existsSync(targetPath));
      assert.ok(targetPath.endsWith('prompt.md'));

      const readBack = fs.readFileSync(targetPath, 'utf8');
      assert.strictEqual(readBack, content);
    });

    it('savePromptFile() từ chối ghi ra ngoài feature dir', () => {
      const manager = new PromptTemplateManager();
      assert.throws(() => manager.savePromptFile('x', testTempDir, path.join(testTempDir, 'docs/features/TASK-X')), /ngoài feature dir/);
    });
  });
});
