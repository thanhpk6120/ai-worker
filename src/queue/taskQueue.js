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
  }

  /**
   * Trích xuất workspace key định danh cho job để khóa hàng đợi theo workspace.
   * Ưu tiên chuẩn hóa theo đường dẫn vật lý (repo_path || worktree_path) để mọi job
   * cùng thư mục dùng chung 1 lock, dù có/không có workspace_id. Chỉ fallback sang
   * ws:<workspace_id> khi job không có path. Không path và không workspace_id -> null.
   */
  _getWorkspaceKey(job) {
    if (!job) return null;
    const p = job.repo_path || job.worktree_path || job.repoPath || job.worktreePath;
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

    const wsKey = this._getWorkspaceKey(job);
    this.emit('job:enqueued', { jobId: job.id, priority: jobPriority, workspaceKey: wsKey });
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
    const { job, runFn, priority } = item;
    const jobId = job.id;
    const wsKey = this._getWorkspaceKey(job);

    if (wsKey) {
      this.activeWorkspaces.set(wsKey, jobId);
    }

    const runningInfo = {
      job,
      runFn,
      priority,
      workspaceKey: wsKey,
      startTime: Date.now()
    };
    this.runningJobs.set(jobId, runningInfo);

    this.emit('job:started', { jobId, job, workspaceKey: wsKey });

    Promise.resolve()
      .then(() => runFn(job))
      .then((result) => {
        this.runningJobs.delete(jobId);
        if (wsKey && this.activeWorkspaces.get(wsKey) === jobId) {
          this.activeWorkspaces.delete(wsKey);
        }
        this.emit('job:completed', { jobId, result, workspaceKey: wsKey });
        this._processNext();
      })
      .catch((error) => {
        this.runningJobs.delete(jobId);
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
