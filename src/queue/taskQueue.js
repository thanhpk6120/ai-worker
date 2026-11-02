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
    this.workspaceMergeLocks = new Map(); // workspaceKey -> jobId
  }

  /**
   * Trích xuất workspace key định danh cho job để khóa hàng đợi theo workspace.
   * - Nếu job đã được cấp phát worktree riêng: dùng đường dẫn worktree để không khóa workspace mẹ.
   * - Nếu job đang ở bước PLANNING hoặc TO DO: trả về key theo task để chạy song song (Read-Only).
   * - Nếu là Single-Repo ở các bước can thiệp code: khóa theo repo_path để an toàn.
   */
  _getWorkspaceKey(job) {
    if (!job) return null;
    // 1. Đã có worktree riêng cho task -> dùng worktree path để cách ly hoàn toàn
    const wtPath = job.worktree_path || job.worktreePath;
    if (wtPath && typeof wtPath === 'string' && wtPath.trim()) {
      const resolved = path.resolve(wtPath.trim());
      return `path:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
    }
    // 2. Bước PLANNING là Read-Only (phân tích spec/code), không sửa mã nguồn service -> cho phép chạy song song
    const step = String(job.current_step || job.status || '').toUpperCase();
    if (job.is_planning || step === 'PLANNING' || step === 'TO DO') {
      return `task:${job.id}`;
    }
    // 3. Fallback cho Single-Repo chưa có worktree: khóa theo repo_path để tránh ghi đè code
    const p = job.repo_path || job.repoPath;
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
        this.releaseAllMergeLocksForJob(jobId);
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
        this.releaseAllMergeLocksForJob(jobId);
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
      this.releaseAllMergeLocksForJob(jobId);
      return { cancelled: true, state: 'RUNNING', job: runningInfo.job };
    }
    return { cancelled: false, message: 'Job not found in queue or running map' };
  }

  /**
   * Kiểm tra xem job có đang nằm trong hàng đợi chờ hay không
   * @param {string} jobId
   * @returns {boolean}
   */
  isJobQueued(jobId) {
    return this.queue.some((item) => item.job && item.job.id === jobId);
  }

  /**
   * Xóa một job khỏi hàng đợi chờ (chưa chạy)
   * @param {string} jobId
   * @returns {{ dequeued: boolean, job?: object }}
   */
  dequeue(jobId) {
    const queueIndex = this.queue.findIndex((item) => item.job && item.job.id === jobId);
    if (queueIndex !== -1) {
      const removed = this.queue.splice(queueIndex, 1)[0];
      this.emit('job:dequeued', { jobId, job: removed.job });
      return { dequeued: true, job: removed.job };
    }
    return { dequeued: false, message: 'Job không nằm trong hàng đợi chờ' };
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
   * Khóa độc quyền toàn bộ Workspace cho bước MERGING (Exclusive Workspace Merge Lock).
   * Đảm bảo chỉ duy nhất 1 task được phép merge/re-test trên repo gốc của một workspace tại một thời điểm,
   * ngăn chặn tuyệt đối tình trạng nhiều task merge song song làm hỏng git index hoặc đè bẩn code của nhau.
   */
  acquireWorkspaceMergeLock(workspaceKey, jobId) {
    if (!workspaceKey) return true;
    const resolvedKey = String(workspaceKey).trim().toLowerCase();
    const currentHolder = this.workspaceMergeLocks.get(resolvedKey);
    if (!currentHolder || currentHolder === jobId) {
      this.workspaceMergeLocks.set(resolvedKey, jobId);
      this.emit('workspace_merge_lock:acquired', { workspaceKey: resolvedKey, jobId });
      return true;
    }
    return false;
  }

  /**
   * Nhả khóa độc quyền merge của Workspace.
   */
  releaseWorkspaceMergeLock(workspaceKey, jobId) {
    if (!workspaceKey) return false;
    const resolvedKey = String(workspaceKey).trim().toLowerCase();
    if (this.workspaceMergeLocks.get(resolvedKey) === jobId) {
      this.workspaceMergeLocks.delete(resolvedKey);
      this.emit('workspace_merge_lock:released', { workspaceKey: resolvedKey, jobId });
      this._processNext();
      return true;
    }
    return false;
  }

  /**
   * Kiểm tra xem workspace có đang bị khóa bởi tiến trình MERGING của task khác không
   */
  isWorkspaceMergeLocked(workspaceKey, excludeJobId = null) {
    if (!workspaceKey) return false;
    const resolvedKey = String(workspaceKey).trim().toLowerCase();
    const holder = this.workspaceMergeLocks.get(resolvedKey);
    if (!holder) return false;
    if (excludeJobId && holder === excludeJobId) return false;
    return true;
  }

  /**
   * Chờ đến khi giành được khóa Merge độc quyền cho Workspace (hoặc timeout)
   */
  waitForWorkspaceMergeLock(workspaceKey, jobId, timeoutMs = 120000) {
    if (!workspaceKey) return Promise.resolve(true);
    const resolvedKey = String(workspaceKey).trim().toLowerCase();
    if (this.acquireWorkspaceMergeLock(resolvedKey, jobId)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let timer = null;
      const onReleased = (evt) => {
        if (evt.workspaceKey === resolvedKey) {
          if (this.acquireWorkspaceMergeLock(resolvedKey, jobId)) {
            cleanup();
            resolve(true);
          }
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.removeListener('workspace_merge_lock:released', onReleased);
      };

      this.on('workspace_merge_lock:released', onReleased);

      timer = setTimeout(() => {
        cleanup();
        resolve(this.acquireWorkspaceMergeLock(resolvedKey, jobId));
      }, timeoutMs);
    });
  }

  /**
   * Giải phóng toàn bộ merge lock do một job nắm giữ
   */
  releaseAllMergeLocksForJob(jobId) {
    let releasedCount = 0;
    for (const [wsKey, holderId] of this.workspaceMergeLocks.entries()) {
      if (holderId === jobId) {
        this.workspaceMergeLocks.delete(wsKey);
        this.emit('workspace_merge_lock:released', { workspaceKey: wsKey, jobId });
        releasedCount++;
      }
    }
    if (releasedCount > 0) {
      this._processNext();
    }
    return releasedCount;
  }

  /**
   * Kiểm tra job có đang nằm trong queue hoặc đang chạy không
   */
  isJobEnqueuedOrRunning(jobId) {
    if (this.runningJobs.has(jobId)) return true;
    return this.queue.some((item) => item.job.id === jobId);
  }

  /**
   * Kiểm tra xem một workspace có đang bị khóa bởi job nào không.
   * - Nếu job đang ở TO DO hoặc PLANNING (Read-Only), chỉ bị khóa nếu workspace đang có task khác MERGING trên repo gốc.
   * - Nếu workspace đang có task MERGING: luôn bị khóa để bảo vệ an toàn git repo.
   */
  isWorkspaceLocked(jobOrWorkspacePath) {
    let wsKey = null;
    let isPlanningOrTodo = false;
    let wsRawKey = null;

    if (typeof jobOrWorkspacePath === 'string') {
      const resolved = path.resolve(jobOrWorkspacePath.trim());
      wsKey = `path:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
      wsRawKey = wsKey;
    } else if (jobOrWorkspacePath && typeof jobOrWorkspacePath === 'object') {
      const step = String(jobOrWorkspacePath.current_step || jobOrWorkspacePath.status || '').toUpperCase();
      isPlanningOrTodo = (step === 'PLANNING' || step === 'TO DO' || jobOrWorkspacePath.is_planning === true);

      const p = jobOrWorkspacePath.repo_path || jobOrWorkspacePath.repoPath;
      if (p) {
        const resolved = path.resolve(p.trim());
        wsRawKey = `path:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
      } else if (jobOrWorkspacePath.workspace_id) {
        wsRawKey = `ws:${String(jobOrWorkspacePath.workspace_id).trim()}`;
      }

      wsKey = this._getWorkspaceKey(jobOrWorkspacePath);
    }

    // 1. Nếu workspace đang có tiến trình MERGING chạy trên repo gốc -> khóa tuyệt đối để chống xung đột git
    if (wsRawKey && this.isWorkspaceMergeLocked(wsRawKey, typeof jobOrWorkspacePath === 'object' ? jobOrWorkspacePath.id : null)) {
      return true;
    }

    // 2. Nếu task đang ở bước PLANNING hoặc TO DO (Read-Only) -> cho phép chạy song song!
    if (isPlanningOrTodo) {
      return false;
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
