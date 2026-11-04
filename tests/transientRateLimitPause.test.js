/**
 * tests/transientRateLimitPause.test.js
 * Bảo vệ [RATE-LIMIT-PAUSE]: 429 của provider ở bước FIXING phải là lỗi HẠ TẦNG
 * (PAUSED + chờ hồi phục), không được giết job bằng FAILED như trước.
 *
 * Bối cảnh: PHUB-679 FAILED lúc 10:21:25Z chỉ vì một dòng
 * `[Error 429: upstream returned non-stream response]` trong khi agent vẫn đang
 * làm việc (exit code 0). TESTING đã xử lý đúng, FIXING thì không.
 *
 * Kèm theo: bộ đếm `transient_retry` KHÔNG được xoá khi vòng chờ hồi phục tự
 * chạy lại — nếu xoá, job 429 sẽ lặp vô hạn mỗi 30 giây và đẩy provider vào
 * rate-limit nặng hơn.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// PHẢI set DB_PATH TRƯỚC mọi require để không ghi vào DB production.
const TMP_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'test-rate-limit-db-'));
process.env.DB_PATH = path.join(TMP_DB_DIR, 'test-rate-limit.sqlite');

const db = require('../src/storage/db');
const jobPolicy = require('../src/execution/jobPolicy');
const { pauseJobForTransient, endStepTimeline, beginStepTimeline } = require('../src/server');

const readPipe = (id) => jobPolicy.parsePipelineConfig(db.getJobById(id));

describe('RATE-LIMIT ở FIXING là lỗi hạ tầng, không phải lỗi code', () => {
  const ids = [];
  let seq = 0;

  before(() => {
    db.initDb();
  });

  after(() => {
    for (const id of ids) {
      try {
        db.updateJob(id, { status: 'CANCELLED' });
        db.deleteJob(id);
      } catch (e) {}
    }
    try { fs.rmSync(TMP_DB_DIR, { recursive: true, force: true }); } catch (e) {}
  });

  function makeJob(status, step) {
    const id = `test-rl-${Date.now()}-${++seq}`;
    ids.push(id);
    db.createJob({ id, title: 'RATE-LIMIT test', prompt: 'p', status });
    db.updateJob(id, { status, current_step: step });
    return id;
  }

  test('429 ở FIXING => PAUSED (không FAILED) và chờ hồi phục', () => {
    const id = makeJob('FIXING', 'FIXING');
    const before = Date.now();
    const res = pauseJobForTransient(id, { step: 'FIXING', reason: 'Provider rate-limit (retry-after 60s)' });

    const job = db.getJobById(id);
    assert.equal(job.status, 'PAUSED', 'job phải tạm dừng để chờ hồi phục, không chết');
    assert.equal(job.current_step, 'FIXING', 'phải giữ nguyên bước đang làm để chạy tiếp');
    assert.equal(res.status, 'PAUSED');

    const pipe = readPipe(id);
    assert.equal(pipe.last_error_kind, 'TRANSIENT');
    assert.equal(pipe.transient_retry, 1);
    assert.equal(pipe.paused_step, 'FIXING');
    assert.ok(Number(pipe.retry_at) > before, 'phải có hẹn giờ chạy lại');

    // Không được đốt ngân sách vòng sửa vì lỗi hạ tầng.
    assert.equal(pipe.fix_attempt, undefined, 'lỗi hạ tầng KHÔNG được tăng fix_attempt');
  });

  test('retry-after của provider được dùng làm thời điểm chạy lại', () => {
    const id = makeJob('FIXING', 'FIXING');
    const before = Date.now();
    pauseJobForTransient(id, { step: 'FIXING', reason: 'Provider rate-limit', retryAfterMs: 90000 });
    const pipe = readPipe(id);
    assert.ok(Number(pipe.retry_at) >= before + 89000, 'phải tôn trọng retry-after ~90s');
  });

  test('backoff leo thang khi lỗi lặp (không quay lại 30s mỗi lần)', () => {
    const id = makeJob('FIXING', 'FIXING');
    const delays = [];
    for (let i = 1; i <= 3; i += 1) {
      const before = Date.now();
      pauseJobForTransient(id, { step: 'FIXING', reason: `Provider rate-limit lần ${i}` });
      const pipe = readPipe(id);
      assert.equal(pipe.transient_retry, i, `lần ${i} phải đếm đúng`);
      delays.push(Number(pipe.retry_at) - before);
    }
    assert.ok(delays[1] > delays[0], `backoff phải tăng: ${delays.join(' -> ')}`);
    assert.ok(delays[2] > delays[1], `backoff phải tăng: ${delays.join(' -> ')}`);
    assert.deepEqual(
      delays.map((d) => Math.round(d / 1000)),
      [30, 120, 300],
      'chuỗi backoff phải là 30s -> 2m -> 5m'
    );
  });

  test('quá MAX_TRANSIENT_RETRIES thì mới FAILED', () => {
    const id = makeJob('FIXING', 'FIXING');
    for (let i = 1; i <= jobPolicy.MAX_TRANSIENT_RETRIES; i += 1) {
      pauseJobForTransient(id, { step: 'FIXING', reason: `Provider rate-limit lần ${i}` });
      assert.equal(db.getJobById(id).status, 'PAUSED', `lần ${i} vẫn phải chờ, chưa bỏ cuộc`);
    }
    pauseJobForTransient(id, { step: 'FIXING', reason: 'Provider rate-limit lần cuối' });
    const job = db.getJobById(id);
    assert.equal(job.status, 'FAILED');
    assert.match(String(job.error_message), /Lỗi hạ tầng kéo dài/);
  });

  test('một bước hoàn tất thì xoá bộ đếm (không cộng dồn suốt đời job)', () => {
    const id = makeJob('FIXING', 'FIXING');
    pauseJobForTransient(id, { step: 'FIXING', reason: 'Provider rate-limit' });
    assert.equal(readPipe(id).transient_retry, 1);

    db.updateJob(id, { status: 'FIXING', current_step: 'FIXING' });
    beginStepTimeline(id, 'FIXING', 'claude-code');
    endStepTimeline(id, { status: 'COMPLETED' });

    assert.equal(readPipe(id).transient_retry, undefined, 'bộ đếm phải được reset sau bước thành công');
  });
});

describe('Nguồn: vòng chờ hồi phục tự chạy lại phải GIỮ bộ đếm', () => {
  test('resumeJobInternal chỉ xoá transient_retry khi người dùng chủ động chạy lại', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.match(
      src,
      /if \(!auto\) delete pipe\.transient_retry;/,
      'auto=true (vòng chờ hồi phục) phải giữ transient_retry để backoff leo thang'
    );
    assert.doesNotMatch(
      src,
      /\n\s*delete pipe\.transient_retry;\n/,
      'không được còn chỗ xoá transient_retry vô điều kiện (gây lặp 429 mỗi 30s)'
    );
  });
});
