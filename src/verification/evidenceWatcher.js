/**
 * src/verification/evidenceWatcher.js
 * Theo dõi thư mục evidence của job đang chạy để đẩy evidence mới lên SSE REALTIME.
 *
 * Vấn đề gốc (task bd88ae0a): `jobEventBus.emitJobEvidence` chỉ được gọi 1 lần duy
 * nhất sau khi VERIFY pass (server.js:2465) => trong lúc agent đang chụp ảnh,
 * UI không nhận được gì cho tới khi pipeline kết thúc.
 *
 * Cơ chế: fs.watch (debounce 500ms) + fallback interval 2s (fs.watch trên Windows
 * không ổn định). Dedupe bằng mtime+size+status để không phát lại không thay đổi.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEBOUNCE_MS = 500;
const POLL_MS = 2000;

class EvidenceWatcher {
  /**
   * @param {Object} options
   * @param {string} options.evidenceDir - thư mục evidence cần theo dõi
   * @param {Function} options.onChange - callback(detail) khi có thay đổi
   * @param {Function} [options.snapshot] - hàm trả về danh sách evidence hiện tại
   */
  constructor({ evidenceDir, onChange, snapshot }) {
    this.evidenceDir = evidenceDir;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.snapshot = typeof snapshot === 'function' ? snapshot : () => [];
    this.timer = null;
    this.interval = null;
    this.watcher = null;
    this.debounceHandle = null;
    this.lastFingerprint = new Map();
    this.stopped = false;
  }

  /**
   * Fingerprint của 1 evidence: đủ để phát hiện file mới / file đổi / trạng thái đổi.
   */
  fingerprintOf(item) {
    if (!item) return null;
    return [
      item.fileName || '',
      item.mtimeMs || 0,
      item.sizeBytes || 0,
      item.status || '',
      item.order !== undefined && item.order !== null ? item.order : '',
      item.stepIndex !== undefined && item.stepIndex !== null ? item.stepIndex : ''
    ].join('|');
  }

  /**
   * So sánh snapshot mới với cũ, trả về danh sách item mới hoặc đã đổi.
   */
  diff(prev, next) {
    const changed = [];
    for (const item of next) {
      const key = String(item.fileName || '').toLowerCase();
      const fp = this.fingerprintOf(item);
      if (this.lastFingerprint.get(key) !== fp) {
        this.lastFingerprint.set(key, fp);
        changed.push(item);
      }
    }
    // Dọn fingerprint của file đã bị xoá
    const alive = new Set(next.map((i) => String(i.fileName || '').toLowerCase()));
    for (const key of Array.from(this.lastFingerprint.keys())) {
      if (!alive.has(key)) this.lastFingerprint.delete(key);
    }
    return changed;
  }

  /**
   * Quét 1 lần, phát event cho item mới/đổi.
   */
  scan() {
    if (this.stopped) return;
    let items = [];
    try { items = this.snapshot() || []; } catch (e) { return; }
    if (!Array.isArray(items) || items.length === 0) return;
    const changed = this.diff(this.lastFingerprint, items);
    if (changed.length === 0) return;
    for (const item of changed) {
      try { this.onChange(item); } catch (e) {}
    }
  }

  onFsEvent() {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      this.scan();
    }, DEBOUNCE_MS);
    if (this.debounceHandle && this.debounceHandle.unref) this.debounceHandle.unref();
  }

  start() {
    if (this.timer || this.interval) return this;
    this.stopped = false;
    try {
      if (!fs.existsSync(this.evidenceDir)) fs.mkdirSync(this.evidenceDir, { recursive: true });
      this.watcher = fs.watch(this.evidenceDir, { persistent: false }, () => this.onFsEvent());
      this.watcher.on('error', () => { try { this.watcher && this.watcher.close(); } catch (e) {} this.watcher = null; });
    } catch (e) {
      this.watcher = null;
    }
    // Fallback poll: fs.watch trên Windows hay miss event.
    this.interval = setInterval(() => this.scan(), POLL_MS);
    if (this.interval.unref) this.interval.unref();
    // Quét lần đầu để đồng bộ trạng thái ban đầu.
    this.scan();
    return this;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.debounceHandle);
    clearInterval(this.interval);
    this.debounceHandle = null;
    this.interval = null;
    if (this.watcher) { try { this.watcher.close(); } catch (e) {} this.watcher = null; }
    this.lastFingerprint.clear();
  }
}

module.exports = { EvidenceWatcher, DEBOUNCE_MS, POLL_MS };
