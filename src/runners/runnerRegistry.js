const ClaudeCodeAdapter = require('./claudeCodeAdapter');
const OpenCodeAdapter = require('./openCodeAdapter');
const OmpAdapter = require('./ompAdapter');
const CodexCliAdapter = require('./codexCliAdapter');
const AntigravityCliAdapter = require('./antigravityCliAdapter');

class RunnerRegistry {
  constructor() {
    /** @type {Map<string, import('./baseAdapter')>} */
    this.runners = new Map();
    /** @type {Map<string, string>} */
    this.nameLookup = new Map();

    this._initDefaultRunners();
  }

  /**
   * Khởi tạo các adapter mặc định
   * @private
   */
  _initDefaultRunners() {
    this.register(new ClaudeCodeAdapter());
    this.register(new OpenCodeAdapter());
    this.register(new OmpAdapter());
    this.register(new CodexCliAdapter());
    this.register(new AntigravityCliAdapter());
  }

  /**
   * Đăng ký một runner adapter instance
   * @param {import('./baseAdapter')} runnerInstance
   * @returns {this}
   */
  register(runnerInstance) {
    if (!runnerInstance || !runnerInstance.name) {
      throw new Error('Runner instance must have a valid name');
    }

    const canonical = runnerInstance.name.toLowerCase();
    this.runners.set(canonical, runnerInstance);
    this.nameLookup.set(canonical, canonical);

    if (Array.isArray(runnerInstance.aliases)) {
      for (const alias of runnerInstance.aliases) {
        if (alias) {
          this.nameLookup.set(alias.toLowerCase(), canonical);
        }
      }
    }

    return this;
  }

  /**
   * Lấy adapter instance theo tên hoặc alias (không phân biệt chữ hoa/thường)
   * @param {string} name
   * @returns {import('./baseAdapter')|null}
   */
  getRunner(name) {
    if (!name || typeof name !== 'string') return null;
    const lower = name.trim().toLowerCase();
    const canonical = this.nameLookup.get(lower);
    if (!canonical) return null;
    return this.runners.get(canonical) || null;
  }

  /**
   * Kiểm tra khả dụng (detection) trên tất cả runners
   * @returns {Array<object>}
   */
  detectAll() {
    const results = [];
    for (const runner of this.runners.values()) {
      const detectInfo = runner.detect();
      results.push({
        name: runner.name,
        command: runner.command,
        aliases: runner.aliases,
        enabled: runner.enabled,
        installed: detectInfo.installed,
        version: detectInfo.version,
        path: detectInfo.path,
        error: detectInfo.error || null
      });
    }
    return results;
  }

  /**
   * Danh sách runner kèm trạng thái cấu hình
   * @returns {Array<object>}
   */
  listRunners() {
    const list = [];
    for (const runner of this.runners.values()) {
      list.push({
        name: runner.name,
        command: runner.command,
        aliases: runner.aliases,
        enabled: runner.enabled
      });
    }
    return list;
  }

  /**
   * Bật runner theo tên hoặc alias
   * @param {string} name
   * @returns {import('./baseAdapter')}
   */
  enableRunner(name) {
    const runner = this.getRunner(name);
    if (!runner) {
      throw new Error(`Runner not found: ${name}`);
    }
    runner.enabled = true;
    return runner;
  }

  /**
   * Tắt runner theo tên hoặc alias
   * @param {string} name
   * @returns {import('./baseAdapter')}
   */
  disableRunner(name) {
    const runner = this.getRunner(name);
    if (!runner) {
      throw new Error(`Runner not found: ${name}`);
    }
    runner.enabled = false;
    return runner;
  }

  /**
   * Lấy runner khả dụng:
   * 1. Ưu tiên preferredName nếu đã cài đặt và được bật.
   * 2. Nếu không, tìm runner đầu tiên đã cài đặt và được bật.
   * 3. Fallback: trả về preferredName (nếu tồn tại trong registry) hoặc runner đầu tiên được enable.
   * @param {string} [preferredName]
   * @returns {import('./baseAdapter')|null}
   */
  getAvailableRunner(preferredName) {
    if (preferredName) {
      const preferred = this.getRunner(preferredName);
      if (preferred && preferred.enabled) {
        const detection = preferred.detect();
        if (detection.installed) {
          return preferred;
        }
      }
    }

    // Tìm runner đầu tiên đã cài đặt và được enable
    for (const runner of this.runners.values()) {
      if (runner.enabled) {
        const detection = runner.detect();
        if (detection.installed) {
          return runner;
        }
      }
    }

    // Fallback nếu không có CLI nào được cài thực tế trên môi trường
    if (preferredName) {
      const preferred = this.getRunner(preferredName);
      if (preferred) return preferred;
    }

    for (const runner of this.runners.values()) {
      if (runner.enabled) return runner;
    }

    const first = this.runners.values().next();
    return first.done ? null : first.value;
  }
  /**
   * Tìm và giải quyết runner khả dụng nhất (fallback an toàn)
   * @param {string} [preferredName]
   * @returns {import('./baseAdapter')|null}
   */
  resolveRunner(preferredName) {
    return this.getAvailableRunner(preferredName);
  }
}

const runnerRegistry = new RunnerRegistry();

module.exports = {
  RunnerRegistry,
  runnerRegistry
};
