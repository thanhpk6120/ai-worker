/**
 * tests/setup-env.js
 * Cấu hình môi trường cô lập cho toàn bộ test suite.
 *
 * VẤN ĐỀ: một số file test require `src/storage/db` hoặc `src/server` mà không
 * set `DB_PATH` → mở thẳng `ai-worker.sqlite` production. Nếu chạy test trong
 * lúc worker đang chạy job thật, việc này sẽ ghi DDL/INSERT vào DB sống và có
 * thể gây SQLITE_BUSY cho pipeline.
 *
 * File này được nạp trước mọi test bằng `node --test --require ./tests/setup-env.js`.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.AIWORKER_TEST_ENV) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `aiworker-test-${process.pid}-`));
  process.env.DB_PATH = process.env.DB_PATH || path.join(baseDir, 'test.sqlite');
  process.env.LOG_DIR = process.env.LOG_DIR || path.join(baseDir, 'logs');
  process.env.EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(baseDir, 'evidence');
  process.env.WORKTREE_BASE_DIR = process.env.WORKTREE_BASE_DIR || path.join(baseDir, 'worktrees');
  process.env.AIWORKER_TEST_ENV = baseDir;
  for (const dir of [process.env.LOG_DIR, process.env.EVIDENCE_DIR, process.env.WORKTREE_BASE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Đảm bảo không bao giờ ghi vào DB production khi chạy test.
  if (path.resolve(process.env.DB_PATH).includes('ai-worker.sqlite')) {
    throw new Error('[TEST-ENV] Từ chối chạy test trên DB production ai-worker.sqlite');
  }
}
