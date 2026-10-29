const defaultDb = require('../storage/db');

const JOB_STATUSES = {
  TO_DO: 'TO DO',
  PLANNING: 'PLANNING',
  IMPLEMENT: 'IMPLEMENT',
  TESTING: 'TESTING',
  VERIFY: 'VERIFY',
  MERGING: 'MERGING',
  FIXING: 'FIXING',
  PAUSED: 'PAUSED',
  DONE: 'DONE',
  PENDING: 'PENDING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT'
};

const TERMINAL_STATUSES = new Set([
  JOB_STATUSES.DONE,
  JOB_STATUSES.FAILED,
  JOB_STATUSES.CANCELLED,
  JOB_STATUSES.TIMED_OUT
]);

const VALID_TRANSITIONS = {
  [JOB_STATUSES.TO_DO]: [JOB_STATUSES.PLANNING, JOB_STATUSES.CANCELLED],
  [JOB_STATUSES.PLANNING]: [
    JOB_STATUSES.PENDING,
    JOB_STATUSES.IMPLEMENT,
    JOB_STATUSES.PAUSED,
    JOB_STATUSES.FAILED,
    JOB_STATUSES.CANCELLED,
    JOB_STATUSES.TIMED_OUT
  ],
  [JOB_STATUSES.PENDING]: [
    JOB_STATUSES.PLANNING,
    JOB_STATUSES.PAUSED,
    JOB_STATUSES.CANCELLED,
    JOB_STATUSES.TIMED_OUT
  ],
  [JOB_STATUSES.IMPLEMENT]: [
    JOB_STATUSES.TESTING,
    JOB_STATUSES.PAUSED,
    JOB_STATUSES.FAILED,
    JOB_STATUSES.CANCELLED,
    JOB_STATUSES.TIMED_OUT
  ],
  [JOB_STATUSES.TESTING]: [
    JOB_STATUSES.VERIFY,
    JOB_STATUSES.PAUSED,
    JOB_STATUSES.FAILED,
    JOB_STATUSES.CANCELLED,
    JOB_STATUSES.TIMED_OUT
  ],
  [JOB_STATUSES.VERIFY]: [
    JOB_STATUSES.MERGING,
    JOB_STATUSES.DONE,
    JOB_STATUSES.FIXING,
    JOB_STATUSES.PAUSED,
    JOB_STATUSES.FAILED,
    JOB_STATUSES.CANCELLED,
    JOB_STATUSES.TIMED_OUT
  ],
  [JOB_STATUSES.MERGING]: [
    JOB_STATUSES.DONE,
    JOB_STATUSES.FIXING,
    JOB_STATUSES.PAUSED,
    JOB_STATUSES.FAILED,
    JOB_STATUSES.CANCELLED,
    JOB_STATUSES.TIMED_OUT
  ],
  [JOB_STATUSES.FIXING]: [
    JOB_STATUSES.VERIFY,
    JOB_STATUSES.MERGING,
    JOB_STATUSES.TESTING,
    JOB_STATUSES.PAUSED,
    JOB_STATUSES.FAILED,
    JOB_STATUSES.CANCELLED,
    JOB_STATUSES.TIMED_OUT
  ],
  [JOB_STATUSES.PAUSED]: [
    JOB_STATUSES.PLANNING,
    JOB_STATUSES.IMPLEMENT,
    JOB_STATUSES.TESTING,
    JOB_STATUSES.VERIFY,
    JOB_STATUSES.MERGING,
    JOB_STATUSES.FIXING,
    JOB_STATUSES.CANCELLED
  ],
  // Terminal states không có transition nào đi ra
  [JOB_STATUSES.DONE]: [],
  [JOB_STATUSES.FAILED]: [],
  [JOB_STATUSES.CANCELLED]: [],
  [JOB_STATUSES.TIMED_OUT]: []
};

/**
 * Kiểm tra xem có thể chuyển trạng thái hay không (boolean).
 */
function canTransition(currentStatus, targetStatus) {
  if (!currentStatus || !targetStatus) {
    return false;
  }
  if (currentStatus === targetStatus) {
    return true;
  }
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed) {
    return false;
  }
  return allowed.includes(targetStatus);
}

/**
 * Kiểm tra tính hợp lệ của việc chuyển trạng thái. Ném Error nếu vi phạm.
 */
function validateTransition(currentStatus, targetStatus) {
  if (targetStatus === JOB_STATUSES.PENDING && currentStatus !== JOB_STATUSES.PLANNING) {
    throw new Error('Trạng thái PENDING chỉ được phép kích hoạt trong giai đoạn PLANNING');
  }

  if (TERMINAL_STATUSES.has(currentStatus)) {
    throw new Error(`Không thể chuyển trạng thái từ trạng thái kết thúc: ${currentStatus}`);
  }

  if (currentStatus === targetStatus) {
    return true;
  }

  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new Error(
      `Chuyển trạng thái không hợp lệ: từ "${currentStatus}" sang "${targetStatus}". Các trạng thái được phép: [${(allowed || []).join(', ')}]`
    );
  }

  return true;
}

/**
 * Thực hiện chuyển trạng thái cho một Job, lưu DB và emit event.
 * @param {string} jobId ID của job
 * @param {string} targetStatus Trạng thái đích
 * @param {object} [db] Module database (nếu null thì dùng defaultDb)
 * @param {function} [emitEventFn] Callback để emit event khi trạng thái thay đổi
 * @returns {object} Job sau khi cập nhật
 */
function transition(jobId, targetStatus, db = defaultDb, emitEventFn = null) {
  const currentDb = db || defaultDb;
  const job = currentDb.getJobById(jobId);

  if (!job) {
    throw new Error(`Không tìm thấy job với ID: ${jobId}`);
  }

  const currentStatus = job.status;

  // Validate chuyển đổi trạng thái
  validateTransition(currentStatus, targetStatus);

  const updates = {
    status: targetStatus,
    updated_at: new Date().toISOString()
  };

  // Nếu chuyển sang trạng thái kết thúc thì ghi nhận completed_at
  if (TERMINAL_STATUSES.has(targetStatus)) {
    updates.completed_at = new Date().toISOString();
  }

  const updatedJob = currentDb.updateJob(jobId, updates);

  if (typeof emitEventFn === 'function') {
    try {
      emitEventFn('job:status_changed', {
        jobId,
        previousStatus: currentStatus,
        newStatus: targetStatus,
        job: updatedJob
      });
    } catch (err) {
      // Bắt lỗi callback emit để không làm gãy luồng transition
      console.error(`Lỗi khi gọi emitEventFn trong transition: ${err.message}`);
    }
  }

  return updatedJob;
}

module.exports = {
  JOB_STATUSES,
  TERMINAL_STATUSES,
  VALID_TRANSITIONS,
  canTransition,
  validateTransition,
  transition
};
