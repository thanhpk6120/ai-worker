const EventEmitter = require('node:events');
const path = require('node:path');
const config = require('../config');

class TaskQueue extends EventEmitter {
  constructor(concurrency = config.CONCURRENCY) {
    super();
    this.concurrency = concurrency;
    this.runningJobs = new Map(); // jobId -> { job, runFn, priority, workspaceKey, startTime }
    this.queue = []; // Array of { job, runFn, priority, enqueuedAt }
    this.activeWorkspaces = new Map(); // workspaceKey -> jobId
    this.devBranchLocks = new Map(); // "${workspaceId}:${serviceKey}" -> jobId
  }

  /**
   * Trích xuất workspace key định danh cho job để khóa hàng đợi theo workspace.
   * Ưu tiên chuẩn hóa theo đường dẫn vật lý (repo_path || worktree_path) để mọi job
   * cùng thư mục dùng chung 1 lock, dù có/không có workspace_id. Chỉ fallback sang
   * ws:<workspace_id> khi job không có path. Không path và không workspace_id -> null.
   */
  _getWorkspaceKey(job) {
    if (!job) return null;
    const p = job.worktree_path || job.worktreePath || job.repo_path || job.repoPath;
    if (p && typeof p === 'string' && p.trim()) {
      const resolved = path.resolve(p.trim());
      return `path:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
    }
    const wsId = job.workspace_id || job.workspaceId;
    if (wsId !== undefined && wsId !== null && String(wsId).trim()) return `ws:${String(wsId).trim()}`;
    return null;
  }

  /**
   * Thêm job vào queue với mức độ ưu tiên (priority).
   * priority càng cao thì được ưu tiên xử lý trước. FIFO nếu cùng priority.
   */
  enqueue(job, runFn, priority = 0) {
    const jobPriority = priority !== undefined ? priority : (job.priority || 0);
    const timeoutMs = (config && typeof config.resolveJobTimeoutMs === 'function')
      ? config.resolveJobTimeoutMs(job, config.DEFAULT_TIMEOUT_MS)
      : undefined;
    const item = {
      job,
      runFn,
      priority: jobPriority,
      timeoutMs,
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

    const wsKey = this._getWorkspaceKey(job);
    this.emit('job:enqueued', { jobId: job.id, priority: jobPriority, timeoutMs, workspaceKey: wsKey });
    this._processNext();
    return item;
  }

  /**
   * Xử lý job tiếp theo nếu còn slot concurrency trống và workspace không bị khóa
   */
  _processNext() {
    if (this.runningJobs.size >= this.concurrency) {
      return;
    }

    if (this.queue.length === 0) {
      return;
    }

    // Tìm job đầu tiên trong queue có workspace không bị khóa bởi job đang chạy khác
    const candidateIndex = this.queue.findIndex((item) => {
      const wsKey = this._getWorkspaceKey(item.job);
      if (!wsKey) return true; // Job không gắn workspace -> sẵn sàng chạy nếu slot còn
      return !this.activeWorkspaces.has(wsKey);
    });

    if (candidateIndex === -1) {
      // Mọi job trong queue đều thuộc workspace đang bận
      return;
    }

    const [item] = this.queue.splice(candidateIndex, 1);
    const { job, runFn, priority, timeoutMs } = item;
    const jobId = job.id;
    const wsKey = this._getWorkspaceKey(job);

    if (wsKey) {
      this.activeWorkspaces.set(wsKey, jobId);
    }

    const runningInfo = {
      job,
      runFn,
      priority,
      timeoutMs,
      workspaceKey: wsKey,
      startTime: Date.now()
    };
    this.runningJobs.set(jobId, runningInfo);

    this.emit('job:started', { jobId, job, timeoutMs, workspaceKey: wsKey });

    Promise.resolve()
      .then(() => runFn(job, { timeoutMs }))
      .then((result) => {
        this.runningJobs.delete(jobId);
        this.releaseAllDevLocksForJob(jobId);
        if (wsKey && this.activeWorkspaces.get(wsKey) === jobId) {
          this.activeWorkspaces.delete(wsKey);
        }
        const failedByResult = result && typeof result === 'object' && String(result.status || '').toUpperCase() === 'FAILED';
        if (failedByResult) {
          const err = result.error instanceof Error ? result.error : new Error((result.error && result.error.message) || result.error || 'Job FAILED');
          this.emit('job:failed', { jobId, error: err, result, workspaceKey: wsKey });
        } else {
          this.emit('job:completed', { jobId, result, workspaceKey: wsKey });
        }
        this._processNext();
      })
      .catch((error) => {
        this.runningJobs.delete(jobId);
        this.releaseAllDevLocksForJob(jobId);
        if (wsKey && this.activeWorkspaces.get(wsKey) === jobId) {
          this.activeWorkspaces.delete(wsKey);
        }
        this.emit('job:failed', { jobId, error, workspaceKey: wsKey });
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
      this.runningJobs.delete(jobId);
      this.releaseWorkspaceLock(jobId);
      this.releaseAllDevLocksForJob(jobId);
      return { cancelled: true, state: 'RUNNING', job: runningInfo.job };
    }

    return { cancelled: false, message: 'Job not found in queue or running map' };
  }

  /**
   * Giải phóng workspace lock cho một job cụ thể (khi job hủy hoặc kết thúc sớm)
   */
  releaseWorkspaceLock(jobId) {
    for (const [wsKey, activeJobId] of this.activeWorkspaces.entries()) {
      if (activeJobId === jobId) {
        this.activeWorkspaces.delete(wsKey);
        this._processNext();
        return true;
      }
    }
    return false;
  }
  /**
   * Khóa độc quyền nhánh phát triển (Exclusive Dev Lock) cho bước MERGING trên repo gốc.
   * Đảm bảo chỉ 1 job được phép merge/re-test trên repo gốc của 1 service tại 1 thời điểm.
   * @param {string} serviceKey Tên service
   * @param {string} jobId ID của job
   * @param {string} [workspaceId='default'] ID workspace
   * @returns {boolean} true nếu giành được lock
   */
  acquireDevLock(serviceKey, jobId, workspaceId = 'default') {
    const lockKey = `${workspaceId}:${serviceKey}`;
    const currentHolder = this.devBranchLocks.get(lockKey);
    if (!currentHolder || currentHolder === jobId) {
      this.devBranchLocks.set(lockKey, jobId);
      this.emit('dev_lock:acquired', { workspaceId, serviceKey, jobId });
      return true;
    }
    return false;
  }

  /**
   * Nhả khóa độc quyền nhánh phát triển của service.
   * @param {string} serviceKey Tên service
   * @param {string} jobId ID của job
   * @param {string} [workspaceId='default'] ID workspace
   * @returns {boolean} true nếu nhả thành công
   */
  releaseDevLock(serviceKey, jobId, workspaceId = 'default') {
    const lockKey = `${workspaceId}:${serviceKey}`;
    if (this.devBranchLocks.get(lockKey) === jobId) {
      this.devBranchLocks.delete(lockKey);
      this.emit('dev_lock:released', { workspaceId, serviceKey, jobId });
      this._processNext();
      return true;
    }
    return false;
  }

  /**
   * Kiểm tra xem service có đang bị khóa bởi job khác không
   */
  isDevLocked(serviceKey, workspaceId = 'default', excludeJobId = null) {
    const lockKey = `${workspaceId}:${serviceKey}`;
    const holder = this.devBranchLocks.get(lockKey);
    if (!holder) return false;
    if (excludeJobId && holder === excludeJobId) return false;
    return true;
  }

  /**
   * Giải phóng toàn bộ dev lock do một job nắm giữ (khi hoàn tất, fail hoặc cancel)
   */
  releaseAllDevLocksForJob(jobId) {
    let releasedCount = 0;
    for (const [lockKey, holderId] of this.devBranchLocks.entries()) {
      if (holderId === jobId) {
        this.devBranchLocks.delete(lockKey);
        const [wsId, svcKey] = lockKey.split(':');
        this.emit('dev_lock:released', { workspaceId: wsId, serviceKey: svcKey, jobId });
        releasedCount++;
      }
    }
    if (releasedCount > 0) {
      this._processNext();
    }
    return releasedCount;
  }

  /**
   * Chờ đến khi giành được dev lock cho service (hoặc timeout)
   */
  waitForDevLock(serviceKey, jobId, workspaceId = 'default', timeoutMs = 60000) {
    if (this.acquireDevLock(serviceKey, jobId, workspaceId)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let timer = null;
      const onReleased = (evt) => {
        if (evt.serviceKey === serviceKey && evt.workspaceId === workspaceId) {
          if (this.acquireDevLock(serviceKey, jobId, workspaceId)) {
            cleanup();
            resolve(true);
          }
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.removeListener('dev_lock:released', onReleased);
      };

      this.on('dev_lock:released', onReleased);

      timer = setTimeout(() => {
        cleanup();
        resolve(this.acquireDevLock(serviceKey, jobId, workspaceId));
      }, timeoutMs);
    });
  }

  /**
   * Kiểm tra job có đang nằm trong queue hoặc đang chạy không
   */
  isJobEnqueuedOrRunning(jobId) {
    if (this.runningJobs.has(jobId)) return true;
    return this.queue.some((item) => item.job.id === jobId);
  }

  /**
   * Kiểm tra xem một workspace có đang bị khóa bởi job nào không
   */
  isWorkspaceLocked(jobOrWorkspacePath) {
    let wsKey = null;
    if (typeof jobOrWorkspacePath === 'string') {
      const resolved = path.resolve(jobOrWorkspacePath.trim());
      wsKey = `path:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
    } else {
      wsKey = this._getWorkspaceKey(jobOrWorkspacePath);
    }
    if (!wsKey) return false;
    return this.activeWorkspaces.has(wsKey);
  }

  /**
   * Lấy job đang chạy trên workspace
   */
  getActiveJobForWorkspace(jobOrWorkspacePath) {
    let wsKey = null;
    if (typeof jobOrWorkspacePath === 'string') {
      const resolved = path.resolve(jobOrWorkspacePath.trim());
      wsKey = `path:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
    } else {
      wsKey = this._getWorkspaceKey(jobOrWorkspacePath);
    }
    if (!wsKey) return null;
    const jobId = this.activeWorkspaces.get(wsKey);
    return jobId ? (this.runningJobs.get(jobId)?.job || null) : null;
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
      const prevSize = this.runningJobs.size;
      this._processNext();
      if (this.runningJobs.size === prevSize) {
        break;
      }
    }
  }

  /**
   * Danh sách các job đang chạy
   */
  getRunningJobs() {
    return Array.from(this.runningJobs.values()).map((info) => ({
      ...info.job,
      startedAt: info.startTime,
      workspaceKey: info.workspaceKey
    }));
  }

  /**
   * Danh sách các job đang chờ
   */
  getQueuedJobs() {
    return this.queue.map((item) => ({
      ...item.job,
      priority: item.priority,
      enqueuedAt: item.enqueuedAt,
      workspaceKey: this._getWorkspaceKey(item.job)
    }));
  }

  /**
   * Thống kê trạng thái của hàng đợi
   */
  getStats() {
    return {
      concurrency: this.concurrency,
      runningCount: this.runningJobs.size,
      queuedCount: this.queue.length,
      activeWorkspaces: Array.from(this.activeWorkspaces.entries()).map(([workspaceKey, jobId]) => ({
        workspaceKey,
        jobId
      }))
    };
  }
}

// Singleton queue instance
const taskQueue = new TaskQueue();

module.exports = {
  TaskQueue,
  taskQueue
};
