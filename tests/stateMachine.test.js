const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  JOB_STATUSES,
  TERMINAL_STATUSES,
  VALID_TRANSITIONS,
  canTransition,
  validateTransition,
  transition
} = require('../src/state/stateMachine');

describe('StateMachine Test Suite', () => {
  describe('Constants & Definitions', () => {
    it('định nghĩa đầy đủ tất cả các trạng thái công việc cần thiết', () => {
      assert.strictEqual(JOB_STATUSES.TO_DO, 'TO DO');
      assert.strictEqual(JOB_STATUSES.PLANNING, 'PLANNING');
      assert.strictEqual(JOB_STATUSES.IMPLEMENT, 'IMPLEMENT');
      assert.strictEqual(JOB_STATUSES.TESTING, 'TESTING');
      assert.strictEqual(JOB_STATUSES.VERIFY, 'VERIFY');
      assert.strictEqual(JOB_STATUSES.FIXING, 'FIXING');
      assert.strictEqual(JOB_STATUSES.DONE, 'DONE');
      assert.strictEqual(JOB_STATUSES.PENDING, 'PENDING');
      assert.strictEqual(JOB_STATUSES.FAILED, 'FAILED');
      assert.strictEqual(JOB_STATUSES.CANCELLED, 'CANCELLED');
      assert.strictEqual(JOB_STATUSES.TIMED_OUT, 'TIMED_OUT');
    });

    it('định nghĩa tập hợp terminal statuses chính xác', () => {
      assert.ok(TERMINAL_STATUSES.has(JOB_STATUSES.DONE));
      assert.ok(TERMINAL_STATUSES.has(JOB_STATUSES.FAILED));
      assert.ok(TERMINAL_STATUSES.has(JOB_STATUSES.CANCELLED));
      assert.ok(TERMINAL_STATUSES.has(JOB_STATUSES.TIMED_OUT));
      assert.strictEqual(TERMINAL_STATUSES.size, 4);
    });
  });

  describe('Valid Lifecycle Transitions', () => {
    it('chuyển đổi tuần tự hợp lệ qua chu trình: TO DO -> PLANNING -> PENDING -> PLANNING -> IMPLEMENT -> TESTING -> VERIFY -> FIXING -> TESTING -> VERIFY -> DONE', () => {
      const lifecycle = [
        [JOB_STATUSES.TO_DO, JOB_STATUSES.PLANNING],
        [JOB_STATUSES.PLANNING, JOB_STATUSES.PENDING],
        [JOB_STATUSES.PENDING, JOB_STATUSES.PLANNING],
        [JOB_STATUSES.PLANNING, JOB_STATUSES.IMPLEMENT],
        [JOB_STATUSES.IMPLEMENT, JOB_STATUSES.TESTING],
        [JOB_STATUSES.TESTING, JOB_STATUSES.VERIFY],
        [JOB_STATUSES.VERIFY, JOB_STATUSES.FIXING],
        [JOB_STATUSES.FIXING, JOB_STATUSES.TESTING],
        [JOB_STATUSES.TESTING, JOB_STATUSES.VERIFY],
        [JOB_STATUSES.VERIFY, JOB_STATUSES.DONE]
      ];

      for (const [from, to] of lifecycle) {
        assert.strictEqual(
          canTransition(from, to),
          true,
          `canTransition(${from}, ${to}) phải là true`
        );
        assert.doesNotThrow(
          () => validateTransition(from, to),
          `validateTransition(${from}, ${to}) không được ném lỗi`
        );
      }
    });

    it('cho phép giữ nguyên trạng thái đối với các non-terminal status (idempotent)', () => {
      const idempotentStatuses = [
        JOB_STATUSES.TO_DO,
        JOB_STATUSES.PLANNING,
        JOB_STATUSES.IMPLEMENT,
        JOB_STATUSES.TESTING,
        JOB_STATUSES.VERIFY,
        JOB_STATUSES.FIXING
      ];

      for (const status of idempotentStatuses) {
        assert.strictEqual(canTransition(status, status), true);
        assert.doesNotThrow(() => validateTransition(status, status));
      }
      const cancellableStatuses = [
        JOB_STATUSES.TO_DO,
        JOB_STATUSES.PLANNING,
        JOB_STATUSES.PENDING,
        JOB_STATUSES.IMPLEMENT,
        JOB_STATUSES.TESTING,
        JOB_STATUSES.VERIFY,
        JOB_STATUSES.FIXING
      ];

      for (const status of cancellableStatuses) {
        assert.strictEqual(canTransition(status, JOB_STATUSES.CANCELLED), true);
        assert.doesNotThrow(() => validateTransition(status, JOB_STATUSES.CANCELLED));
      }
    });
  });

  describe('Invalid Transitions Guard', () => {
    it('chặn nhảy cóc từ TO DO thẳng lên DONE', () => {
      assert.strictEqual(canTransition(JOB_STATUSES.TO_DO, JOB_STATUSES.DONE), false);
      assert.throws(
        () => validateTransition(JOB_STATUSES.TO_DO, JOB_STATUSES.DONE),
        /Chuyển trạng thái không hợp lệ/
      );
    });

    it('chặn chuyển từ IMPLEMENT sang PENDING (PENDING chỉ được phép trong PLANNING)', () => {
      assert.strictEqual(canTransition(JOB_STATUSES.IMPLEMENT, JOB_STATUSES.PENDING), false);
      assert.throws(
        () => validateTransition(JOB_STATUSES.IMPLEMENT, JOB_STATUSES.PENDING),
        /Trạng thái PENDING chỉ được phép kích hoạt trong giai đoạn PLANNING/
      );
    });

    it('chặn chuyển từ TESTING sang PENDING', () => {
      assert.strictEqual(canTransition(JOB_STATUSES.TESTING, JOB_STATUSES.PENDING), false);
      assert.throws(
        () => validateTransition(JOB_STATUSES.TESTING, JOB_STATUSES.PENDING),
        /Trạng thái PENDING chỉ được phép kích hoạt trong giai đoạn PLANNING/
      );
    });

    it('chặn chuyển ngược bất hợp lệ từ TESTING về PLANNING', () => {
      assert.strictEqual(canTransition(JOB_STATUSES.TESTING, JOB_STATUSES.PLANNING), false);
      assert.throws(
        () => validateTransition(JOB_STATUSES.TESTING, JOB_STATUSES.PLANNING),
        /Chuyển trạng thái không hợp lệ/
      );
    });

    it('chặn TESTING nhảy thẳng DONE (bắt buộc qua VERIFY đối soát evidence)', () => {
      assert.strictEqual(canTransition(JOB_STATUSES.TESTING, JOB_STATUSES.DONE), false);
      assert.throws(
        () => validateTransition(JOB_STATUSES.TESTING, JOB_STATUSES.DONE),
        /Chuyển trạng thái không hợp lệ/
      );
    });

    it('chặn FIXING nhảy thẳng DONE (bắt buộc quay lại TESTING rồi VERIFY)', () => {
      assert.strictEqual(canTransition(JOB_STATUSES.FIXING, JOB_STATUSES.DONE), false);
      assert.throws(
        () => validateTransition(JOB_STATUSES.FIXING, JOB_STATUSES.DONE),
        /Chuyển trạng thái không hợp lệ/
      );
    });

    it('trả về false khi trạng thái đầu vào là null, undefined hoặc không hợp lệ', () => {
      assert.strictEqual(canTransition(null, JOB_STATUSES.PLANNING), false);
      assert.strictEqual(canTransition(JOB_STATUSES.TO_DO, null), false);
      assert.strictEqual(canTransition(undefined, undefined), false);
      assert.strictEqual(canTransition('UNKNOWN_STATUS', JOB_STATUSES.PLANNING), false);
    });
  });

  describe('Terminal Statuses Invariance', () => {
    it('không cho phép chuyển tiếp từ bất kỳ terminal status nào sang trạng thái khác', () => {
      const nonTerminalTargets = [
        JOB_STATUSES.TO_DO,
        JOB_STATUSES.PLANNING,
        JOB_STATUSES.IMPLEMENT,
        JOB_STATUSES.TESTING,
        JOB_STATUSES.FIXING,
        JOB_STATUSES.PENDING
      ];

      for (const terminal of TERMINAL_STATUSES) {
        for (const target of nonTerminalTargets) {
          assert.strictEqual(
            canTransition(terminal, target),
            false,
            `canTransition(${terminal}, ${target}) phải là false`
          );
          assert.throws(
            () => validateTransition(terminal, target),
            /Không thể chuyển trạng thái từ trạng thái kết thúc|Trạng thái PENDING chỉ được phép kích hoạt trong giai đoạn PLANNING/,
            `validateTransition(${terminal}, ${target}) phải ném lỗi`
          );
        }
      }
    });

    it('không cho phép chuyển đổi qua lại giữa các terminal status', () => {
      const terminals = Array.from(TERMINAL_STATUSES);
      for (const t1 of terminals) {
        for (const t2 of terminals) {
          if (t1 !== t2) {
            assert.strictEqual(canTransition(t1, t2), false);
            assert.throws(
              () => validateTransition(t1, t2),
              /Không thể chuyển trạng thái từ trạng thái kết thúc/
            );
          }
        }
      }
    });
  });

  describe('transition() Integration with Mock DB & Events', () => {
    it('thực hiện chuyển trạng thái thành công và emit event job:status_changed', () => {
      let currentJob = { id: 'job-1', status: JOB_STATUSES.TO_DO };
      const emittedEvents = [];

      const mockDb = {
        getJobById: (id) => (id === currentJob.id ? { ...currentJob } : null),
        updateJob: (id, updates) => {
          currentJob = { ...currentJob, ...updates };
          return currentJob;
        }
      };

      const emitEventFn = (eventName, payload) => {
        emittedEvents.push({ eventName, payload });
      };

      const updated = transition('job-1', JOB_STATUSES.PLANNING, mockDb, emitEventFn);

      assert.strictEqual(updated.status, JOB_STATUSES.PLANNING);
      assert.ok(updated.updated_at);
      assert.strictEqual(emittedEvents.length, 1);
      assert.strictEqual(emittedEvents[0].eventName, 'job:status_changed');
      assert.strictEqual(emittedEvents[0].payload.previousStatus, JOB_STATUSES.TO_DO);
      assert.strictEqual(emittedEvents[0].payload.newStatus, JOB_STATUSES.PLANNING);
    });

    it('ghi nhận completed_at khi chuyển sang terminal status', () => {
      let currentJob = { id: 'job-2', status: JOB_STATUSES.VERIFY };

      const mockDb = {
        getJobById: (id) => (id === currentJob.id ? { ...currentJob } : null),
        updateJob: (id, updates) => {
          currentJob = { ...currentJob, ...updates };
          return currentJob;
        }
      };

      const updated = transition('job-2', JOB_STATUSES.DONE, mockDb);

      assert.strictEqual(updated.status, JOB_STATUSES.DONE);
      assert.ok(updated.completed_at, 'Phải có completed_at khi đạt terminal status');
    });

    it('ném lỗi khi không tìm thấy Job ID trong DB', () => {
      const mockDb = {
        getJobById: () => null,
        updateJob: () => null
      };

      assert.throws(
        () => transition('non-existent-id', JOB_STATUSES.PLANNING, mockDb),
        /Không tìm thấy job với ID: non-existent-id/
      );
    });

    it('ném lỗi khi thực hiện chuyển đổi không hợp lệ qua transition()', () => {
      const currentJob = { id: 'job-3', status: JOB_STATUSES.TO_DO };
      const mockDb = {
        getJobById: () => ({ ...currentJob }),
        updateJob: () => null
      };

      assert.throws(
        () => transition('job-3', JOB_STATUSES.DONE, mockDb),
        /Chuyển trạng thái không hợp lệ/
      );
    });
  });
});
