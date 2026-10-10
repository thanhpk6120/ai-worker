const EventEmitter = require('node:events');
const config = require('../config');

class TaskQueue extends EventEmitter {
  constructor(concurrency = config.CONCURRENCY) {
    super();
    this.concurrency = concurrency;
    this.runningJobs = new Map(); // jobId -> { job, runFn, priority, startTime }
    this.queue = []; // Array of { job, runFn, priority, enqueuedAt }
  }

  /**
   * Thêm job vào queue với mức độ ưu tiên (priority).
   * priority càng cao thì được ưu tiên xử lý trước. FIFO nếu cùng priority.
   */
  enqueue(job, runFn, priority = 0) {
    const jobPriority = priority !== undefined ? priority : (job.priority || 0);
    const item = {
      job,
      runFn,
      priority: jobPriority,
      enqueuedAt: Date.now()
    };

    // Chèn theo priority giảm dần, giữ FIFO với priority bằng nhau
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (item.priority > this.queue[i].priority) {
        this.queue.splice(i, 0, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.queue.push(item);
    }

    this.emit('job:enqueued', { jobId: job.id, priority: jobPriority });
    this._processNext();
    return item;
  }

  /**
   * Xử lý job tiếp theo nếu còn slot concurrency trống
   */
  _processNext() {
    if (this.runningJobs.size >= this.concurrency) {
      return;
    }

    if (this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    const { job, runFn, priority } = item;
    const jobId = job.id;

    const runningInfo = {
      job,
      runFn,
      priority,
      startTime: Date.now()
    };
    this.runningJobs.set(jobId, runningInfo);

    this.emit('job:started', { jobId, job });

    Promise.resolve()
      .then(() => runFn())
      .then((result) => {
        this.runningJobs.delete(jobId);
        this.emit('job:completed', { jobId, result });
        this._processNext();
      })
      .catch((error) => {
        this.runningJobs.delete(jobId);
        this.emit('job:failed', { jobId, error });
        this._processNext();
      });
  }

  /**
   * Hủy bỏ job:
   * Nếu đang trong queue -> gỡ bỏ khỏi queue.
   * Nếu đang chạy -> emit 'job:cancel' để runner hủy tiến trình.
   */
  cancel(jobId) {
    // 1. Kiểm tra trong queue chờ
    const queueIndex = this.queue.findIndex((item) => item.job.id === jobId);
    if (queueIndex !== -1) {
      const removed = this.queue.splice(queueIndex, 1)[0];
      this.emit('job:cancelled', { jobId, status: 'QUEUED' });
      return { cancelled: true, state: 'QUEUED', job: removed.job };
    }

    // 2. Kiểm tra trong danh sách đang chạy
    if (this.runningJobs.has(jobId)) {
      const runningInfo = this.runningJobs.get(jobId);
      this.emit('job:cancel', { jobId });
      this.emit('job:cancelled', { jobId, status: 'RUNNING' });
      return { cancelled: true, state: 'RUNNING', job: runningInfo.job };
    }

    return { cancelled: false, message: 'Job not found in queue or running map' };
  }

  /**
   * Cập nhật giới hạn concurrency
   */
  setConcurrency(newLimit) {
    if (typeof newLimit !== 'number' || newLimit < 1) {
      throw new Error('Concurrency must be a positive number');
    }
    this.concurrency = newLimit;
    while (this.runningJobs.size < this.concurrency && this.queue.length > 0) {
      this._processNext();
    }
  }

  /**
   * Danh sách các job đang chạy
   */
  getRunningJobs() {
    return Array.from(this.runningJobs.values()).map((info) => ({
      ...info.job,
      startTime: info.startTime,
      runningDurationMs: Date.now() - info.startTime
    }));
  }

  /**
   * Danh sách các job đang chờ
   */
  getQueuedJobs() {
    return this.queue.map((item) => ({
      ...item.job,
      enqueuedAt: item.enqueuedAt,
      priority: item.priority
    }));
  }

  /**
   * Thống kê trạng thái của hàng đợi
   */
  getStats() {
    return {
      runningCount: this.runningJobs.size,
      queuedCount: this.queue.length,
      concurrency: this.concurrency
    };
  }
}

// Singleton queue instance
const taskQueue = new TaskQueue();

module.exports = {
  TaskQueue,
  taskQueue
};
