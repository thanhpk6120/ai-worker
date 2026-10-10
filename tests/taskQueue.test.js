const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TaskQueue } = require('../src/queue/taskQueue');

// Helper tạo delay bằng Promise
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TaskQueue Test Suite', () => {
  describe('Concurrency Limit', () => {
    it('chỉ chạy tối đa số job đồng thời bằng concurrency (ví dụ: 2)', async () => {
      const concurrency = 2;
      const queue = new TaskQueue(concurrency);

      let maxConcurrentObserved = 0;
      let activeJobsCount = 0;
      const completedJobs = [];

      // Tạo resolver cho các job để kiểm soát chính xác khi nào job xong
      const jobResolvers = [];
      const createControlledJob = (id) => {
        let resolver;
        const promise = new Promise((res) => {
          resolver = res;
        });
        jobResolvers.push(resolver);

        return {
          job: { id: `job-${id}`, title: `Job ${id}` },
          runFn: async () => {
            activeJobsCount++;
            if (activeJobsCount > maxConcurrentObserved) {
              maxConcurrentObserved = activeJobsCount;
            }
            await promise;
            activeJobsCount--;
            completedJobs.push(id);
            return `result-${id}`;
          }
        };
      };

      // Enqueue 4 jobs vào hàng đợi có concurrency = 2
      const j1 = createControlledJob(1);
      const j2 = createControlledJob(2);
      const j3 = createControlledJob(3);
      const j4 = createControlledJob(4);

      queue.enqueue(j1.job, j1.runFn);
      queue.enqueue(j2.job, j2.runFn);
      queue.enqueue(j3.job, j3.runFn);
      queue.enqueue(j4.job, j4.runFn);

      // Chờ microtasks để _processNext kích hoạt
      await delay(10);

      // Tại thời điểm này, chỉ 2 jobs đầu tiên đang chạy, 2 jobs sau phải nằm trong queue
      assert.strictEqual(queue.getRunningJobs().length, 2);
      assert.strictEqual(queue.getQueuedJobs().length, 2);
      assert.strictEqual(maxConcurrentObserved, 2);
      assert.strictEqual(activeJobsCount, 2);

      // Hoàn thành job 1
      jobResolvers[0]();
      await delay(10);

      // Sau khi job 1 xong, job 3 phải được tự động lấy ra chạy tiếp
      assert.strictEqual(queue.getRunningJobs().length, 2);
      assert.strictEqual(queue.getQueuedJobs().length, 1);
      assert.strictEqual(completedJobs.includes(1), true);

      // Hoàn thành nốt các job còn lại
      jobResolvers[1]();
      jobResolvers[2]();
      jobResolvers[3]();
      await delay(20);

      assert.strictEqual(queue.getRunningJobs().length, 0);
      assert.strictEqual(queue.getQueuedJobs().length, 0);
      assert.strictEqual(completedJobs.length, 4);
      assert.strictEqual(maxConcurrentObserved, 2, 'Số lượng job chạy đồng thời không được vượt quá concurrency');
    });
  });

  describe('Priority FIFO Order', () => {
    it('job có priority cao hơn được dequeue/chạy trước; cùng priority tuân thủ FIFO', async () => {
      const queue = new TaskQueue(1); // Concurrency = 1 để kiểm tra chính xác thứ tự thực thi

      const executionOrder = [];
      let unlockFirstJob;
      const firstJobBlocker = new Promise((resolve) => {
        unlockFirstJob = resolve;
      });

      // Job 0 chiếm slot concurrency = 1
      queue.enqueue(
        { id: 'job-0' },
        async () => {
          await firstJobBlocker;
          executionOrder.push('job-0');
        },
        0
      );

      // Trong khi job-0 đang chiếm slot, thêm các job với priority khác nhau:
      // Job A (priority 1)
      // Job B (priority 10) - cao nhất
      // Job C (priority 5)  - nhì
      // Job D (priority 1)  - bằng Job A nhưng vào sau (FIFO test)
      // Job E (priority 10) - bằng Job B nhưng vào sau
      queue.enqueue({ id: 'job-A' }, async () => executionOrder.push('job-A'), 1);
      queue.enqueue({ id: 'job-B' }, async () => executionOrder.push('job-B'), 10);
      queue.enqueue({ id: 'job-C' }, async () => executionOrder.push('job-C'), 5);
      queue.enqueue({ id: 'job-D' }, async () => executionOrder.push('job-D'), 1);
      queue.enqueue({ id: 'job-E' }, async () => executionOrder.push('job-E'), 10);

      // Giải phóng Job 0 để queue xử lý các job đang đợi
      unlockFirstJob();

      // Đợi tất cả hoàn thành
      await delay(50);

      // Thứ tự kỳ vọng:
      // job-0 (chạy đầu tiên vì chiếm slot)
      // job-B (priority 10, vào trước job-E)
      // job-E (priority 10, vào sau job-B)
      // job-C (priority 5)
      // job-A (priority 1, vào trước job-D)
      // job-D (priority 1, vào sau job-A)
      assert.deepStrictEqual(executionOrder, [
        'job-0',
        'job-B',
        'job-E',
        'job-C',
        'job-A',
        'job-D'
      ]);
    });
  });

  describe('Event Emission Lifecycle', () => {
    it('emit đầy đủ sự kiện job:enqueued, job:started, job:completed theo vòng đời thành công', async () => {
      const queue = new TaskQueue(2);

      const eventsFired = [];
      queue.on('job:enqueued', (data) => eventsFired.push({ event: 'job:enqueued', data }));
      queue.on('job:started', (data) => eventsFired.push({ event: 'job:started', data }));
      queue.on('job:completed', (data) => eventsFired.push({ event: 'job:completed', data }));

      const testJob = { id: 'job-evt-1', title: 'Event Test Job' };
      queue.enqueue(testJob, async () => {
        await delay(10);
        return { success: true };
      }, 5);

      await delay(30);

      const eventNames = eventsFired.map((e) => e.event);
      assert.deepStrictEqual(eventNames, ['job:enqueued', 'job:started', 'job:completed']);

      // Kiểm tra dữ liệu payload của từng sự kiện
      assert.strictEqual(eventsFired[0].data.jobId, 'job-evt-1');
      assert.strictEqual(eventsFired[0].data.priority, 5);

      assert.strictEqual(eventsFired[1].data.jobId, 'job-evt-1');
      assert.strictEqual(eventsFired[1].data.job.id, 'job-evt-1');

      assert.strictEqual(eventsFired[2].data.jobId, 'job-evt-1');
      assert.deepStrictEqual(eventsFired[2].data.result, { success: true });
    });

    it('emit sự kiện job:failed khi job gặp lỗi trong khi thực thi', async () => {
      const queue = new TaskQueue(1);

      const failedEvents = [];
      queue.on('job:failed', (data) => failedEvents.push(data));

      const failingJob = { id: 'job-err-1' };
      queue.enqueue(failingJob, async () => {
        throw new Error('Cố ý gây lỗi giả lập');
      });

      await delay(20);

      assert.strictEqual(failedEvents.length, 1);
      assert.strictEqual(failedEvents[0].jobId, 'job-err-1');
      assert.strictEqual(failedEvents[0].error.message, 'Cố ý gây lỗi giả lập');
    });
  });

  describe('Cancel & Stats Features', () => {
    it('hủy job đang nằm trong queue chờ thành công', () => {
      const queue = new TaskQueue(1);

      // Chiếm slot đang chạy
      queue.enqueue({ id: 'job-blocking' }, () => new Promise(() => {}));

      // Job nằm chờ
      queue.enqueue({ id: 'job-to-cancel' }, async () => 'not executed');

      const cancelledEvents = [];
      queue.on('job:cancelled', (data) => cancelledEvents.push(data));

      const result = queue.cancel('job-to-cancel');

      assert.strictEqual(result.cancelled, true);
      assert.strictEqual(result.state, 'QUEUED');
      assert.strictEqual(queue.getQueuedJobs().length, 0);
      assert.strictEqual(cancelledEvents.length, 1);
      assert.strictEqual(cancelledEvents[0].jobId, 'job-to-cancel');
    });

    it('hủy job đang chạy sẽ emit job:cancel và job:cancelled', () => {
      const queue = new TaskQueue(1);

      queue.enqueue({ id: 'job-running' }, () => new Promise(() => {}));

      const cancelSignalEvents = [];
      const cancelledEvents = [];
      queue.on('job:cancel', (data) => cancelSignalEvents.push(data));
      queue.on('job:cancelled', (data) => cancelledEvents.push(data));

      const result = queue.cancel('job-running');

      assert.strictEqual(result.cancelled, true);
      assert.strictEqual(result.state, 'RUNNING');
      assert.strictEqual(cancelSignalEvents.length, 1);
      assert.strictEqual(cancelSignalEvents[0].jobId, 'job-running');
      assert.strictEqual(cancelledEvents.length, 1);
      assert.strictEqual(cancelledEvents[0].jobId, 'job-running');
    });

    it('báo cáo getStats() chính xác', () => {
      const queue = new TaskQueue(3);
      queue.enqueue({ id: 'j-stat-1' }, () => new Promise(() => {}));
      queue.enqueue({ id: 'j-stat-2' }, () => new Promise(() => {}));
      const stats = queue.getStats();

      assert.strictEqual(stats.concurrency, 3);
      assert.strictEqual(stats.runningCount, 2);
      assert.strictEqual(stats.queuedCount, 0);
    });
  });
});
