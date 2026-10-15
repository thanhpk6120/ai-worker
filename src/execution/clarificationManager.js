/**
 * src/execution/clarificationManager.js
 * Quản lý trạng thái PENDING (Human-in-the-Loop Clarification) ĐỘC QUYỀN trong giai đoạn PLANNING.
 * Đảm bảo các giai đoạn khác (IMPLEMENT, TESTING, VERIFY, FIXING) tự động bypass câu hỏi để tránh treo headless.
 */

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

class ClarificationManager extends EventEmitter {
  constructor() {
    super();
    /**
     * Map lưu câu hỏi đang chờ người dùng trả lời (PENDING)
     * Key: jobId (string) -> Value: ClarificationRecord
     */
    this.pendingQuestions = new Map();

    /**
     * Map lưu lịch sử các câu hỏi đã được trả lời hoặc hủy
     * Key: jobId (string) -> Value: ClarificationRecord[]
     */
    this.history = new Map();
  }

  /**
   * Chặn câu hỏi từ Agent CLI và kiểm tra điều kiện kích hoạt trạng thái PENDING
   * @param {Object} params Tham số yêu cầu làm rõ
   * @param {string} params.jobId ID của Job hiện tại
   * @param {string} params.currentStage Giai đoạn hiện tại của Job (ví dụ 'PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING')
   * @param {string} params.question Nội dung câu hỏi cần người dùng làm rõ
   * @param {string[]} [params.options=[]] Danh sách tùy chọn có sẵn (nếu là dạng trắc nghiệm/radio/checkbox)
   * @param {boolean} [params.allowCustomInput=true] Cho phép nhập văn bản tùy biến ngoài các lựa chọn có sẵn
   * @returns {{ bypassed: boolean, reason?: string, clarification?: Object }}
   */
  interceptQuestion({
    jobId,
    currentStage,
    question,
    options = [],
    allowCustomInput = true
  }) {
    if (!jobId) {
      throw new Error('Tham số jobId là bắt buộc');
    }
    if (!question) {
      throw new Error('Tham số question là bắt buộc');
    }

    const normalizedStage = (currentStage || '').toUpperCase().trim();

    // QUY TẮC BẤT BIẾN: Chỉ kích hoạt PENDING trong giai đoạn PLANNING
    if (normalizedStage !== 'PLANNING') {
      const bypassResult = {
        bypassed: true,
        jobId,
        currentStage: normalizedStage,
        reason: `Làm rõ tương tác (Clarification) chỉ được phép ở giai đoạn PLANNING. Tự động bypass ở giai đoạn ${normalizedStage} để bám sát kế hoạch đã duyệt.`
      };

      this.emit('clarification_bypassed', bypassResult);
      return bypassResult;
    }

    // Nếu đã có câu hỏi PENDING cho job này thì không ghi đè, cảnh báo và trả về câu hỏi hiện tại
    if (this.pendingQuestions.has(jobId)) {
      const existing = this.pendingQuestions.get(jobId);
      return {
        bypassed: false,
        warning: 'Job đã có một câu hỏi đang chờ xử lý',
        clarification: existing
      };
    }

    const clarificationId = `clarif_${Date.now()}_${randomUUID().substring(0, 8)}`;
    const clarificationRecord = {
      id: clarificationId,
      jobId,
      stage: normalizedStage,
      question,
      options: Array.isArray(options) ? [...options] : [],
      allowCustomInput: allowCustomInput !== false,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      answeredAt: null,
      answer: null
    };

    this.pendingQuestions.set(jobId, clarificationRecord);

    // Phát sự kiện ngắt timeout đếm ngược của Job
    this.emit('pause_timeout', {
      jobId,
      clarificationId,
      reason: 'Đang chờ người dùng phản hồi câu hỏi làm rõ'
    });

    // Phát sự kiện yêu cầu làm rõ gửi tới Web UI/SSE
    this.emit('clarification_requested', {
      jobId,
      clarification: clarificationRecord
    });

    return {
      bypassed: false,
      clarification: clarificationRecord
    };
  }

  /**
   * Tiếp nhận câu trả lời từ người dùng, đánh dấu hoàn thành và cho phép resume Job
   * @param {string} jobId ID của Job
   * @param {string|Object} answerPayload Câu trả lời người dùng gửi lên
   * @returns {Object} Bản ghi clarification sau khi đã giải quyết
   */
  submitAnswer(jobId, answerPayload) {
    if (!jobId) {
      throw new Error('Tham số jobId là bắt buộc');
    }
    if (answerPayload === undefined || answerPayload === null) {
      throw new Error('Câu trả lời (answerPayload) không được để trống');
    }

    const clarificationRecord = this.pendingQuestions.get(jobId);
    if (!clarificationRecord) {
      throw new Error(
        `Không tìm thấy câu hỏi đang ở trạng thái PENDING cho jobId: ${jobId}`
      );
    }

    // Chuẩn hóa payload trả lời
    let normalizedAnswer;
    if (typeof answerPayload === 'string') {
      normalizedAnswer = { text: answerPayload, selectedOptions: [] };
    } else if (typeof answerPayload === 'object') {
      normalizedAnswer = {
        text: answerPayload.text || '',
        selectedOptions: Array.isArray(answerPayload.selectedOptions)
          ? answerPayload.selectedOptions
          : (answerPayload.selection ? [answerPayload.selection] : [])
      };
    } else {
      normalizedAnswer = { text: String(answerPayload), selectedOptions: [] };
    }

    clarificationRecord.status = 'RESOLVED';
    clarificationRecord.answer = normalizedAnswer;
    clarificationRecord.answeredAt = new Date().toISOString();

    // Chuyển từ hàng đợi pending sang lưu trữ lịch sử
    this.pendingQuestions.delete(jobId);

    if (!this.history.has(jobId)) {
      this.history.set(jobId, []);
    }
    this.history.get(jobId).push(clarificationRecord);

    // Phát sự kiện câu hỏi đã được giải quyết
    this.emit('clarification_answered', {
      jobId,
      clarification: clarificationRecord,
      answer: normalizedAnswer
    });

    // Phát sự kiện kích hoạt tiếp tục (resume) Agent ở giai đoạn PLANNING
    this.emit('resume_agent', {
      jobId,
      resumeStage: 'PLANNING',
      clarificationId: clarificationRecord.id,
      answer: normalizedAnswer
    });

    return clarificationRecord;
  }

  /**
   * Lấy câu hỏi đang chờ xử lý của một Job (nếu có)
   * @param {string} jobId
   * @returns {Object|null}
   */
  getPendingClarification(jobId) {
    return this.pendingQuestions.get(jobId) || null;
  }

  /**
   * Kiểm tra một Job có đang có câu hỏi PENDING hay không
   * @param {string} jobId
   * @returns {boolean}
   */
  hasPendingClarification(jobId) {
    return this.pendingQuestions.has(jobId);
  }

  /**
   * Xóa câu hỏi PENDING của một Job (nếu bị hủy bỏ hoặc timeout)
   * @param {string} jobId
   * @returns {boolean} true nếu có câu hỏi bị xóa
   */
  clearPendingClarification(jobId) {
    const record = this.pendingQuestions.get(jobId);
    if (record) {
      record.status = 'CANCELLED';
      record.answeredAt = new Date().toISOString();

      if (!this.history.has(jobId)) {
        this.history.set(jobId, []);
      }
      this.history.get(jobId).push(record);
      this.pendingQuestions.delete(jobId);

      this.emit('clarification_cancelled', {
        jobId,
        clarification: record
      });

      return true;
    }
    return false;
  }

  /**
   * Lấy danh sách toàn bộ câu hỏi đang PENDING trên toàn hệ thống
   * @returns {Array<Object>}
   */
  getAllPending() {
    return Array.from(this.pendingQuestions.values());
  }

  /**
   * Lấy lịch sử tất cả các câu hỏi đã xử lý của một Job
   * @param {string} jobId
   * @returns {Array<Object>}
   */
  getClarificationHistory(jobId) {
    return this.history.get(jobId) || [];
  }
}

module.exports = {
  ClarificationManager
};
