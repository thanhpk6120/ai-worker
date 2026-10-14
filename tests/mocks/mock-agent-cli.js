#!/usr/bin/env node

/**
 * mock-agent-cli.js
 * CLI script Node.js mô phỏng các Agent CLI thực tế (claude, opencode, codex, omp, antigravity).
 * Hỗ trợ các cờ:
 * - --version: In thông tin phiên bản và thoát 0
 * - --prompt-file <path>: Đọc nội dung tệp prompt và in ra stdout
 * - --simulate-secret: In chuỗi bí mật ra stdout/stderr để kiểm tra SecretScrubber
 * - --long-running hoặc --sleep <ms>: Chạy tiến trình lâu để kiểm tra kill/timeout
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

// 1. Kiểm tra cờ --version
if (args.includes('--version')) {
  console.log('MockAgentCLI v1.0.0');
  process.exit(0);
}

// 2. Kiểm tra cờ --prompt-file hoặc tự tìm .task_prompt.txt trong cwd
let promptContent = null;
const promptFileIdx = args.indexOf('--prompt-file');
if (promptFileIdx !== -1 && args[promptFileIdx + 1]) {
  const promptFilePath = args[promptFileIdx + 1];
  try {
    if (fs.existsSync(promptFilePath)) {
      promptContent = fs.readFileSync(promptFilePath, 'utf8');
    }
  } catch (err) {
    console.error(`[MOCK_CLI] Lỗi đọc prompt file: ${err.message}`);
  }
} else {
  const defaultPromptFile = path.join(process.cwd(), '.task_prompt.txt');
  try {
    if (fs.existsSync(defaultPromptFile)) {
      promptContent = fs.readFileSync(defaultPromptFile, 'utf8');
    }
  } catch (err) {
    // Bỏ qua lỗi đọc file mặc định
  }
}

if (promptContent !== null) {
  console.log(`[MOCK_CLI] Prompt: ${promptContent}`);
}

// 3. Kiểm tra cờ --simulate-secret
if (args.includes('--simulate-secret')) {
  console.log('SECRET_TOKEN=sk-test-secret-123456789');
  console.error('SECRET_TOKEN=sk-test-secret-123456789');
}
if (args.includes('--emit-yield')) {
  console.log('[TOOL CALL] yield ({"data": "success"})');
}
if (args.includes('--emit-done')) {
  console.log('Status: DONE');
}
if (args.includes('--emit-json-done')) {
  console.log('{"reason": "Status: DONE"}');
}

// 4. Kiểm tra cờ --long-running hoặc --sleep <ms>
const isLongRunning = args.includes('--long-running');
const sleepIdx = args.indexOf('--sleep');
let sleepMs = 0;
if (sleepIdx !== -1 && args[sleepIdx + 1]) {
  sleepMs = parseInt(args[sleepIdx + 1], 10);
  if (Number.isNaN(sleepMs)) {
    sleepMs = 10000;
  }
} else if (isLongRunning) {
  sleepMs = 10000;
}

if (sleepMs > 0 || isLongRunning) {
  const duration = sleepMs > 0 ? sleepMs : 10000;
  console.log(`[MOCK_CLI] Đang chạy với thời gian delay ${duration}ms...`);

  const timer = setTimeout(() => {
    console.log('[MOCK_CLI] Hoàn tất thực thi thành công');
    process.exit(0);
  }, duration);

  const cleanup = (signal) => {
    console.log(`[MOCK_CLI] Nhận tín hiệu ${signal}, thoát an toàn`);
    clearTimeout(timer);
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
} else {
  // Thực thi thông thường
  console.log('[MOCK_CLI] Hoàn tất thực thi thành công');
  process.exit(0);
}
