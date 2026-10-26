/**
 * tests/promptFileDispatch.test.js
 * Kiểm thử cơ chế tạo tệp prompt riêng cho từng bước và dispatch prompt ngắn gọn
 * Ngăn chặn triệt để lỗi giới hạn độ dài dòng lệnh Windows (spawn ENAMETOOLONG / 32,767 ký tự).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const BaseAdapter = require('../src/runners/baseAdapter');
const ClaudeCodeAdapter = require('../src/runners/claudeCodeAdapter');
const OmpAdapter = require('../src/runners/ompAdapter');

describe('Prompt File Dispatch & ENAMETOOLONG Prevention Suite', () => {
  let testTempDir = '';

  before(() => {
    testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-prompt-dispatch-test-'));
  });

  after(() => {
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch (e) {}
  });

  it('formatDispatchPrompt() sinh prompt ngắn gọn kèm đường dẫn tuyệt đối chuẩn xác', () => {
    const adapter = new BaseAdapter('test-adapter', 'test-cmd');
    const fakePath = path.join(testTempDir, 'docs/features/TASK-1/prompt_planning.md');
    const dispatch = adapter.formatDispatchPrompt(fakePath, { step: 'PLANNING', taskCode: 'TASK-1' });

    assert.ok(dispatch.includes('Đường dẫn tuyệt đối:'));
    assert.ok(dispatch.includes(path.resolve(fakePath)));
    assert.ok(dispatch.includes('[Bước: PLANNING]'));
    assert.ok(dispatch.includes('[Task: TASK-1]'));
    assert.ok(dispatch.includes('BẮT BUỘC: Bạn phải mở và đọc toàn bộ nội dung tệp trên'));
    assert.ok(dispatch.length < 500, `Dispatch prompt phải ngắn gọn (< 500 ký tự), thực tế: ${dispatch.length}`);
  });

  it('buildCommand() tự động dùng dispatch prompt khi có featureDir hoặc promptFilePath', () => {
    const adapter = new ClaudeCodeAdapter();
    const featureDir = path.join(testTempDir, 'docs/features/TASK-2');
    fs.mkdirSync(featureDir, { recursive: true });

    const hugePrompt = 'Nội dung prompt siêu dài '.repeat(100);
    const cmdInfo = adapter.buildCommand(hugePrompt, {
      featureDir,
      step: 'FIXING',
      taskCode: 'TASK-2'
    });

    assert.strictEqual(cmdInfo.command, 'claude');
    assert.ok(Array.isArray(cmdInfo.args));
    // Tham số prompt trong args phải là dispatch prompt
    const promptArg = cmdInfo.args[1];
    assert.ok(promptArg.includes('Đường dẫn tuyệt đối:'));
    assert.ok(promptArg.includes('prompt_fixing.md'));
    assert.ok(promptArg.length < 500);
  });

  it('execute() tự động tạo tệp prompt_<step>.md trong featureDir và giữ nguyên UTF-8 tiếng Việt + emoji', async () => {
    const featureDir = path.join(testTempDir, 'docs/features/PHUB-632');
    fs.mkdirSync(featureDir, { recursive: true });

    const rawPrompt = `# Kế hoạch sửa lỗi PHUB-632 🚀
Đặc tả nghiệp vụ: Thẩm định giao dịch ngân hàng MBB, OCB, BIDV
Nội dung chi tiết tiếng Việt có dấu và ký tự đặc biệt: € ¥ ₫ 🌟
Chi tiết logs: NullPointerException tại AdminController.java:120`;

    // Giả lập runner kế thừa BaseAdapter sử dụng process.execPath (Node.js) để chạy mock CLI
    const mockCliScript = path.join(testTempDir, 'mock-cli.js');
    fs.writeFileSync(mockCliScript, `
      // CLI giả lập nhận arguments và in ra
      const args = process.argv.slice(2);
      console.log('[MOCK_CLI_RECEIVED_PROMPT_ARG_LEN] ' + (args[0] ? args[0].length : 0));
      console.log('[MOCK_CLI_RECEIVED_PROMPT_ARG] ' + (args[0] || ''));
      process.exit(0);
    `, 'utf8');

    class MockTestAdapter extends BaseAdapter {
      constructor() {
        super('mock-test-adapter', process.execPath);
      }
      buildArgs(prompt, options = {}) {
        return [mockCliScript, prompt];
      }
    }

    const runner = new MockTestAdapter();
    let stdoutBuffer = '';

    const result = await runner.execute({
      prompt: rawPrompt,
      featureDir,
      step: 'FIXING',
      taskCode: 'PHUB-632',
      cwd: testTempDir,
      onStdout: (text) => { stdoutBuffer += text; }
    });

    assert.strictEqual(result.exitCode, 0);

    // Kiểm tra tệp prompt_fixing.md đã được tạo đúng vị trí
    const expectedPromptFile = path.join(featureDir, 'prompt_fixing.md');
    assert.ok(fs.existsSync(expectedPromptFile), 'Tệp prompt_fixing.md phải được tạo trong featureDir');

    // Kiểm tra nội dung tệp lưu đúng 100% UTF-8
    const savedPrompt = fs.readFileSync(expectedPromptFile, 'utf8');
    assert.strictEqual(savedPrompt, rawPrompt);
    assert.ok(savedPrompt.includes('🚀') && savedPrompt.includes('PHUB-632') && savedPrompt.includes('€ ¥ ₫ 🌟'));

    // Kiểm tra tham số truyền vào CLI là dispatch prompt ngắn gọn, không phải prompt 40KB
    assert.ok(stdoutBuffer.includes('[PROMPT-FILE] Đã chuẩn bị tệp prompt hoàn chỉnh cho bước FIXING'));
    assert.ok(stdoutBuffer.includes('[MOCK_CLI_RECEIVED_PROMPT_ARG_LEN]'));
    assert.ok(!stdoutBuffer.includes('Chi tiết logs: NullPointerException'), 'CLI arguments không được chứa nội dung prompt thô lớn');
  });

  it('Ngăn chặn ENAMETOOLONG: Prompt > 45,000 ký tự (vượt giới hạn 32KB Windows) vẫn chạy mượt mà', async () => {
    const featureDir = path.join(testTempDir, 'docs/features/HUGE-TASK');
    fs.mkdirSync(featureDir, { recursive: true });

    // Tạo prompt 50,000 ký tự - chắc chắn gây ENAMETOOLONG nếu nhồi trực tiếp vào CLI trên Windows
    const massivePrompt = '# BÁO CÁO TOÀN DIỆN VỀ LỖI TEST VÀ EVIDENCE GATE\n' +
      'Dòng log lỗi chi tiết dài ngoằng: '.repeat(1500);
    assert.ok(massivePrompt.length > 45000, `Prompt kiểm thử phải > 45,000 ký tự (thực tế: ${massivePrompt.length})`);

    const mockCliScript = path.join(testTempDir, 'mock-huge-cli.js');
    fs.writeFileSync(mockCliScript, `
      const args = process.argv.slice(2);
      console.log('[HUGE_TEST_ARG_LEN] ' + (args[0] ? args[0].length : 0));
      process.exit(0);
    `, 'utf8');

    class MockHugeAdapter extends BaseAdapter {
      constructor() {
        super('mock-huge-adapter', process.execPath);
      }
      buildArgs(prompt, options = {}) {
        return [mockCliScript, prompt];
      }
    }

    const runner = new MockHugeAdapter();
    let stdoutBuffer = '';

    const result = await runner.execute({
      prompt: massivePrompt,
      featureDir,
      step: 'TESTING',
      taskCode: 'HUGE-TASK',
      cwd: testTempDir,
      onStdout: (text) => { stdoutBuffer += text; }
    });

    // Nếu không có cơ chế dispatch prompt file, dòng lệnh dài 50,000 ký tự sẽ quăng lỗi:
    // "spawn ENAMETOOLONG" ngay tại processManager.spawnProcess()
    assert.strictEqual(result.exitCode, 0, 'Phải kết thúc với exitCode 0 mà không bị lỗi spawn ENAMETOOLONG');

    const expectedFile = path.join(featureDir, 'prompt_testing.md');
    assert.ok(fs.existsSync(expectedFile));
    const fileSize = fs.statSync(expectedFile).size;
    assert.ok(fileSize > 45000, `File prompt lưu trên ổ đĩa phải đầy đủ > 45,000 bytes (thực tế: ${fileSize})`);

    // Tham số CLI truyền vào subprocess chỉ vài trăm ký tự
    const match = stdoutBuffer.match(/\[HUGE_TEST_ARG_LEN\]\s+(\d+)/);
    assert.ok(match, 'Subprocess phải in ra độ dài argument nhận được');
    const argLen = Number(match[1]);
    assert.ok(argLen < 1000, `Tham số CLI chỉ được < 1000 ký tự, thực tế: ${argLen}`);
  });

  it('Tương thích ngược: Prompt ngắn không có featureDir vẫn truyền trực tiếp qua args', async () => {
    const mockCliScript = path.join(testTempDir, 'mock-short-cli.js');
    fs.writeFileSync(mockCliScript, `
      const args = process.argv.slice(2);
      console.log('[SHORT_CLI_ARG] ' + (args[0] || ''));
      process.exit(0);
    `, 'utf8');

    class MockShortAdapter extends BaseAdapter {
      constructor() {
        super('mock-short-adapter', process.execPath);
      }
      buildArgs(prompt, options = {}) {
        return [mockCliScript, prompt];
      }
    }

    const runner = new MockShortAdapter();
    let stdoutBuffer = '';
    const shortPrompt = 'Kiểm tra lệnh ngắn thông thường';

    const result = await runner.execute({
      prompt: shortPrompt,
      cwd: testTempDir,
      onStdout: (text) => { stdoutBuffer += text; }
    });

    assert.strictEqual(result.exitCode, 0);
    assert.ok(stdoutBuffer.includes(`[SHORT_CLI_ARG] ${shortPrompt}`));
  });
});
