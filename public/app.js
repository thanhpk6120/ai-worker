/**
 * AI Worker - Autonomous Multi-Agent Pipeline & Verification Dashboard
 * Frontend Application Logic (SPA)
 */

(function () {
  'use strict';

  // =========================================================================
  // APPLICATION STATE
  // =========================================================================
  const state = {
    jobs: [],
    activeJobId: null,
    activeJob: null,
    evidences: [],
    dualPlan: null,
    currentQuestion: null,
    // true khi job đang chờ port (SSE waiting), dùng để không ẩn banner oan.
    portWaiting: false,
    autoScroll: true,
    statusFilter: 'ALL',
    searchQuery: '',
    activeTab: 'terminal',
    activeEvidenceSubTab: 'ui',
    term: null,
    fitAddon: null,
    eventSource: null,
    ignoreHistoricalLogs: false,
    terminalClearMarker: null,
    systemStatus: {
      online: true,
      uptimeSeconds: 0,
      activeWorkers: 0,
      maxConcurrency: 3
    },
    workspaces: [],
    timerInterval: null,
    logOffset: 0,
    oldestLogOffset: 0,
    hasOlderLogs: false,
    jobCardMap: new Map(),
    planCache: new Map(),
    searchDebounceTimer: null,
    fetchJobsAbortController: null,
    fetchStatusAbortController: null,
    jobsFetchSeq: 0,           // B5: đếm request để bỏ qua response cũ
    lastDetailFetchAt: {},     // C2: dedupe fetchJobDetails theo jobId
    activeJobRenderRaf: null,  // C2: cờ gộp render trong 1 frame
    stepperGeom: null,         // C4: cache toạ độ node stepper
    stepperPathMap: null,      // C4: cache các path SVG để cập nhật thay vì xoá
    rerunInFlight: false       // B3: đang gửi yêu cầu chạy lại
  };

  // Pipeline standard steps
  const PIPELINE_STEPS = ['TO DO', 'PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'DONE'];

  // Status CSS mappings
  const STATUS_CLASSES = {
    'TO DO': 'status-todo',
    'QUEUED': 'status-queued',
    'PLANNING': 'status-planning',
    'IMPLEMENT': 'status-implement',
    'TESTING': 'status-testing',
    'VERIFY': 'status-verify',
    'FIXING': 'status-fixing',
    'PENDING': 'status-pending bg-amber-500/20 text-amber-300 border border-amber-500/40',
    'PAUSED': 'status-pending bg-amber-500/20 text-amber-300 border border-amber-500/40',
    'DONE': 'status-done',
    // B6: bổ sung FAILED (trước đây rơi về màu xám status-todo)
    'FAILED': 'status-failed',
    'CANCELLED': 'status-cancelled',
    'TIMED_OUT': 'status-failed',
    'ARCHIVED': 'status-archived'
  };

  // Icon đi kèm badge trạng thái (badge này cũng là nút mở chi tiết thông báo).
  const STATUS_ICONS = {
    'DONE': '<i class="fa-solid fa-circle-check mr-1"></i>',
    'FAILED': '<i class="fa-solid fa-triangle-exclamation mr-1"></i>',
    'TIMED_OUT': '<i class="fa-solid fa-clock mr-1"></i>',
    'CANCELLED': '<i class="fa-solid fa-ban mr-1"></i>',
    'PAUSED': '<i class="fa-solid fa-circle-pause mr-1"></i>',
    'PENDING': '<i class="fa-solid fa-circle-question mr-1"></i>'
  };

  // B8: các trạng thái job đang chạy -> chặn thao tác nguy hiểm (lưu trữ / xoá / đổi status)
  const RUNNING_STATUSES = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING'];
  // B10: một nguồn sự thật duy nhất cho danh sách trạng thái được phép xoá task.
  // Giữ 'DONE'/'TODO' như hành vi cũ (trước đây task DONE vẫn xoá được ở cả card
  // và chi tiết); bổ sung TIMED_OUT/ARCHIVED để 2 nơi không còn lệch nhau.
  const DELETABLE_STATUSES = ['TO DO', 'TODO', 'DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ARCHIVED'];
  // B3: các trạng thái được phép hiện nút "Chạy lại"
  const RERUNNABLE_STATUSES = ['FAILED', 'TIMED_OUT', 'CANCELLED', 'PAUSED'];

  // =========================================================================
  // INITIALIZATION ON DOM READY
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    initTerminal();
    initEventListeners();
    fetchSystemStatus();
    fetchJobsList();
    loadSettings();
    loadWorkspaces();

    // Routing theo task: người dùng sửa URL / bấm back-forward thì mở đúng task.
    window.addEventListener('hashchange', () => {
      const id = jobIdFromHash();
      if (id && id !== state.activeJobId && state.jobs.some((j) => j.id === id)) {
        selectJob(id);
      }
    });

    // Badge trạng thái (ngay cạnh job id) đóng vai trò nút thông báo:
    // hover => tooltip lý do, bấm => mở modal chi tiết (không chiếm thêm chỗ).
    const statusBadgeEl = document.getElementById('activeJobStatusBadge');
    if (statusBadgeEl) {
      statusBadgeEl.addEventListener('click', () => openTaskAlertModal());
    }
    const btnCloseAlert = document.getElementById('btnCloseTaskAlertModal');
    if (btnCloseAlert) btnCloseAlert.addEventListener('click', closeTaskAlertModal);
    const alertModal = document.getElementById('taskAlertModal');
    if (alertModal) {
      alertModal.addEventListener('click', (ev) => {
        if (ev.target === alertModal) closeTaskAlertModal();
      });
    }
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeTaskAlertModal();
    });

    // C6: SSE đã realtime -> poll chậm lại (15s) và bỏ qua khi tab đang ẩn
    setInterval(() => {
      if (document.hidden) return;
      fetchJobsListSilently();
    }, 15000);

    // C6: trạng thái hệ thống không cần cập nhật mỗi 15s
    setInterval(() => {
      fetchSystemStatus();
    }, 30000);

    setInterval(() => {
      if (document.hidden) return; // Chỉ tạm dừng thay đổi UI tick giây
      updateDurationTick();
    }, 1000);
  });

  // Cơ chế gom log (Batched Terminal Buffer) giúp XTerm render ở 60fps, không bao giờ nghẽn UI thread
  let terminalBuffer = [];
  let terminalFlushRaf = null;
  let termIsNewLine = true; // Trạng thái con trỏ đang ở đầu dòng mới

  // Hàm nối liền các dòng text bị CLI ngắt cứng ở ~75-85 cột (un-wrap hard-breaks)
  function reflowCliText(text) {
    if (!text) return '';
    const rawLines = text.split('\n');
    const resultLines = [];

    for (let i = 0; i < rawLines.length; i++) {
      let cur = rawLines[i];
      const cleanCur = cur.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');

      if (i < rawLines.length - 1) {
        const next = rawLines[i + 1];
        const cleanNext = next.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');

        const nextIsBulletOrHeader = /^(\s*[-*#+>]|\s*\d+\.|\s*={3,}|\s*-{3,}|\s*\[)/.test(cleanNext);
        const endsWithStop = /[:.!?;>]$/.test(cleanCur.trim());

        // Nếu dòng hiện tại dài ~68-88 ký tự, không kết thúc bằng dấu ngắt câu, và dòng kế không phải bullet/header
        if (!endsWithStop && !nextIsBulletOrHeader && cleanCur.length >= 68 && cleanCur.length <= 88 && cleanNext.trim().length > 0) {
          let glue = ' ';
          if (cleanCur.endsWith('tư') && cleanNext.trim().startsWith('ơng')) {
            glue = '';
          } else if (cleanCur.endsWith(' ') || cleanNext.startsWith(' ')) {
            glue = '';
          }

          rawLines[i + 1] = cur.replace(/\r$/, '') + glue + next.trimStart();
          continue;
        }
      }
      resultLines.push(cur);
    }
    return resultLines.join('\n');
  }

  // Hàm ngắt dòng theo từ (Word-Wrap) đảm bảo xuống dòng nguyên vẹn theo từ, không bao giờ chém đôi chữ
  function wordWrapToCols(text, maxCols) {
    if (!text || maxCols <= 30) return text;
    const lines = text.split('\n');
    const wrapped = [];

    for (const line of lines) {
      // Nhánh nhanh: dòng thuần ASCII không ANSI, ngắn hơn giới hạn -> giữ nguyên
      if (line.indexOf('\x1b') === -1 && line.indexOf('\r') === -1 && line.length <= maxCols) {
        wrapped.push(line);
        continue;
      }

      // C1: quét MỘT lần để lấy độ dài visible + vị trí thật của từng ký tự visible
      const visReal = [];    // visReal[k] = index thật trong line của ký tự visible thứ k
      const visIsSpace = []; // visIsSpace[k] = ký tự visible thứ k có phải khoảng trắng
      let inAnsi = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\x1b') { inAnsi = true; continue; }
        if (inAnsi) { if (ch === 'm') inAnsi = false; continue; }
        if (ch === '\r') continue;
        visReal.push(i);
        visIsSpace.push(ch === ' ');
      }

      const totalVisible = visReal.length;
      if (totalVisible <= maxCols) {
        wrapped.push(line);
        continue;
      }

      // C1: cắt theo chỉ số đã quét sẵn, mỗi vòng chỉ quét ngược tối đa maxCols -> O(L)
      let vs = 0;
      while (vs < totalVisible) {
        if (totalVisible - vs <= maxCols) {
          wrapped.push(line.substring(visReal[vs]));
          break;
        }
        const windowEnd = vs + maxCols; // index visible kết thúc (exclusive)
        let breakVis = -1;
        for (let k = windowEnd - 1; k > vs; k--) {
          if (visIsSpace[k]) { breakVis = k; break; }
        }
        if (breakVis > vs) {
          wrapped.push(line.substring(visReal[vs], visReal[breakVis]));
          vs = breakVis + 1; // bỏ khoảng trắng dùng để ngắt dòng
        } else {
          const endReal = windowEnd < totalVisible ? visReal[windowEnd] : line.length;
          wrapped.push(line.substring(visReal[vs], endReal));
          vs = windowEnd;
        }
      }
    }
    return wrapped.join('\n');
  }

  function formatLogWithTimestamp(text, timestamp) {
    if (!text) return '';
    if (text.match(/^(\x1b\[\d+m)?\[\d{4}-\d{2}-\d{2}/) || text.includes('────────────────────────────────────────────────────────────────────────────────')) {
      return text;
    }
    const d = new Date(timestamp || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const prefix = `\x1b[90m[${timeStr}]\x1b[0m `;

    let result = '';
    let i = 0;
    while (i < text.length) {
      if (text[i] === '\x1b' && text[i+1] === '[') {
        let ansi = '';
        while (i < text.length && text[i] !== 'm') {
          ansi += text[i];
          i++;
        }
        if (i < text.length) {
          ansi += text[i];
          i++;
        }
        result += ansi;
        continue;
      }

      const ch = text[i];
      if (termIsNewLine && ch !== '\r' && ch !== '\n') {
        result += prefix;
        termIsNewLine = false;
      }
      result += ch;
      if (ch === '\n') {
        termIsNewLine = true;
      }
      i++;
    }
    return result;
  }

  function scheduleTerminalWrite(chunk, isWriteln = false, timestamp = null) {
    if (!state.term || !chunk) return;
    // C1: chỉ đẩy RAW text vào buffer; reflow + wrap + format chạy MỘT lần cho cả khối trong rAF
    terminalBuffer.push({ text: chunk, isWriteln, timestamp });

    if (!terminalFlushRaf) {
      terminalFlushRaf = requestAnimationFrame(() => {
        terminalFlushRaf = null;
        const pending = terminalBuffer;
        terminalBuffer = [];
        if (!state.term || pending.length === 0) return;

        const targetCols = state.term.cols || 120;
        const rawCombined = pending
          .map((item) => (item.isWriteln ? item.text + '\n' : item.text))
          .join('');
        const reflowed = reflowCliText(rawCombined);
        const wrapped = wordWrapToCols(reflowed, targetCols);
        const formatted = formatLogWithTimestamp(wrapped, pending[0].timestamp);
        state.term.write(formatted);
        if (state.autoScroll) {
          state.term.scrollToBottom();
        }
      });
    }
  }

  // C7: debounce fit terminal + chỉ resize khi số cột thực sự đổi
  let fitTerminalTimer = null;
  let lastFitCols = 0;

  // Hàm đảm bảo xterm luôn nở full 100% khung hiển thị
  function fitTerminal() {
    if (!state.term) return;
    const container = document.getElementById('xtermContainer');
    if (!container) return;
    const width = container.clientWidth;
    if (width <= 0) return;

    if (state.fitAddon) {
      try {
        state.fitAddon.fit();
      } catch (e) {}
    }

    const availableWidth = width - 24;
    const calculatedCols = Math.max(80, Math.floor(availableWidth / 7.55));
    // C7: chỉ resize khi cols thực sự thay đổi (tránh reflow terminal mỗi lần gọi)
    if (calculatedCols !== lastFitCols && calculatedCols !== state.term.cols) {
      lastFitCols = calculatedCols;
      try {
        state.term.resize(calculatedCols, state.term.rows || 25);
      } catch (e) {}
    }
  }

  // C7: gộp các lần cần fit vào 1 lần debounce 150ms
  function scheduleFitTerminal() {
    if (fitTerminalTimer) clearTimeout(fitTerminalTimer);
    fitTerminalTimer = setTimeout(() => {
      fitTerminalTimer = null;
      fitTerminal();
    }, 150);
  }

  function clearTerminalScreen(options = {}) {
    if (terminalFlushRaf) {
      cancelAnimationFrame(terminalFlushRaf);
      terminalFlushRaf = null;
    }
    terminalBuffer = [];
    termIsNewLine = true;

    if (state.term) {
      state.term.clear();
      state.term.write('\x1b[2J\x1b[3J\x1b[H');
    }

    if (options.ignoreHistory) {
      state.ignoreHistoricalLogs = true;
      state.terminalClearMarker = options.marker || Date.now();
    } else if (options.resetMarker) {
      state.ignoreHistoricalLogs = false;
      state.terminalClearMarker = null;
    }
  }

  // =========================================================================
  // 1. TERMINAL INITIALIZATION (xterm.js + fitAddon)
  // =========================================================================
  function initTerminal() {
    const container = document.getElementById('xtermContainer');
    if (!container || !window.Terminal) return;

    state.term = new window.Terminal({
      theme: {
        background: '#080d1a',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        cursorAccent: '#080d1a',
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
        black: '#0f172a',
        red: '#f43f5e',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#f8fafc',
        brightBlack: '#475569',
        brightRed: '#fb7185',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff'
      },
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      convertEol: true,
      windowsMode: true,
      scrollback: 10000,
      disableStdin: true
    });

    if (window.FitAddon && window.FitAddon.FitAddon) {
      state.fitAddon = new window.FitAddon.FitAddon();
      state.term.loadAddon(state.fitAddon);
    }

    state.term.open(container);

    // Gọi fitTerminal nhiều lần để đảm bảo bắt đúng kích thước container sau khi CSS và fonts đã load
    requestAnimationFrame(fitTerminal);
    scheduleFitTerminal();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => scheduleFitTerminal());
    }

    // Dùng ResizeObserver để tự động tính toán lại số cột (cols) tràn full chiều rộng khung log
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        scheduleFitTerminal();
      });
      ro.observe(container);
    }

    window.addEventListener('resize', () => {
      if (state.activeTab === 'terminal') {
        scheduleFitTerminal();
      }
    });
    writeTerminalBanner('AI Worker Live Terminal Sẵn Sàng.\nChọn một Job để xem streaming logs.');
  }

  function writeTerminalBanner(message) {
    if (!state.term) return;
    clearTerminalScreen({ resetMarker: true });
    const dateStr = new Date().toLocaleTimeString();
    state.term.writeln('\x1b[38;5;39m' + '┌────────────────────────────────────────────────────────────┐' + '\x1b[0m');
    state.term.writeln('\x1b[38;5;39m│\x1b[0m \x1b[1;37mAI WORKER PIPELINE LOG STREAM\x1b[0m \x1b[90m[' + dateStr + ']\x1b[0m');
    state.term.writeln('\x1b[38;5;39m└────────────────────────────────────────────────────────────┘' + '\x1b[0m');
    state.term.writeln('\x1b[90m' + message + '\x1b[0m\r\n');
  }

  // =========================================================================
  // 2. EVENT LISTENERS SETUP
  // =========================================================================
  function initEventListeners() {
    // Header & Global Buttons
    document.getElementById('btnRefreshJobs')?.addEventListener('click', () => {
      fetchJobsList();
      if (state.activeJobId) {
        fetchJobDetails(state.activeJobId);
      }
    });

    document.getElementById('btnOpenCreateModal')?.addEventListener('click', openCreateJobModal);
    document.getElementById('btnEmptyCreateJob')?.addEventListener('click', openCreateJobModal);
    document.getElementById('btnCloseCreateModal')?.addEventListener('click', closeCreateJobModal);
    document.getElementById('btnCancelCreateModal')?.addEventListener('click', closeCreateJobModal);

    // Job Search & Status Filter
    // Job Search & Status Filter (Debounce 200ms de tranh render vo ich moi ky tu - T2.5)
    document.getElementById('jobSearchInput')?.addEventListener('input', (e) => {
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        state.searchQuery = e.target.value.toLowerCase().trim();
        renderJobsList();
      }, 200);
    });

    document.getElementById('statusFilterSelect')?.addEventListener('change', (e) => {
      state.statusFilter = e.target.value;
      renderJobsList();
    });
    document.getElementById('statusFilter')?.addEventListener('change', (e) => {
      state.statusFilter = e.target.value;
      renderJobsList();
    });

    // Settings Modal
    document.getElementById('btnOpenSettingsModal')?.addEventListener('click', openSettingsModal);
    document.getElementById('btnCloseSettingsModal')?.addEventListener('click', closeSettingsModal);
    document.getElementById('btnCancelSettingsModal')?.addEventListener('click', closeSettingsModal);
    document.getElementById('btnSaveSettings')?.addEventListener('click', saveSettings);

    // Workspace Modal
    // Workspace Modal & Workspace Manager
    document.getElementById('btnOpenWorkspaceManagerModal')?.addEventListener('click', openWorkspaceManagerModal);
    document.getElementById('btnCloseWorkspaceManager')?.addEventListener('click', closeWorkspaceManagerModal);
    document.getElementById('btnCloseWorkspaceManagerModal')?.addEventListener('click', closeWorkspaceManagerModal);
    document.getElementById('btnCancelEditWs')?.addEventListener('click', resetWorkspaceForm);
    document.getElementById('wsManagerForm')?.addEventListener('submit', handleSaveWorkspaceForm);
    document.getElementById('btnOpenNewWorkspaceModal')?.addEventListener('click', openWorkspaceModal);
    document.getElementById('btnCloseWorkspaceModal')?.addEventListener('click', closeWorkspaceModal);
    document.getElementById('btnCancelWorkspaceModal')?.addEventListener('click', closeWorkspaceModal);
    // Workspace Services Modal
    document.getElementById('btnCloseWorkspaceServicesModal')?.addEventListener('click', closeWorkspaceServicesModal);
    document.getElementById('btnScanWorkspaceServices')?.addEventListener('click', handleScanWorkspaceServices);
    document.getElementById('btnToggleAddServiceForm')?.addEventListener('click', () => {
      const form = document.getElementById("wsServiceForm");
      if (form) form.classList.toggle("hidden");
    });
    document.getElementById('btnCancelEditService')?.addEventListener('click', resetServiceForm);
    document.getElementById('wsServiceForm')?.addEventListener('submit', handleSaveServiceForm);

    // Feature Path Preview
    const updateFeaturePathPreview = () => {
      const previewEl = document.getElementById('featurePathPreview');
      if (!previewEl) return;
      const taskCodeInput = document.getElementById('createTaskCode');
      const taskCode = taskCodeInput ? taskCodeInput.value.trim() : '';
      const workspaceSelect = document.getElementById('createTaskWorkspace');
      const selectedWsId = workspaceSelect ? workspaceSelect.value.trim() : '';
      const wsList = state.workspaces || [];
      const selectedWsObj = wsList.find(w => w.id === selectedWsId || w.path === selectedWsId) || (wsList.length > 0 ? wsList[0] : null);

      if (selectedWsObj && taskCode) {
        const fDir = selectedWsObj.features_dir || 'docs/features';
        const fullExpectedPath = `${selectedWsObj.path.replace(/[\\/]$/, '')}/${fDir}/${taskCode}`;
        previewEl.innerHTML = `<span class="text-slate-400">Thư mục tính năng:</span> <span class="text-brand-300 font-bold">${escapeHtml(fullExpectedPath)}</span>`;
        previewEl.classList.remove('hidden');
      } else if (selectedWsObj) {
        const fDir = selectedWsObj.features_dir || 'docs/features';
        previewEl.innerHTML = `<span class="text-slate-400">Thư mục features cấu hình:</span> <span class="text-brand-300">${escapeHtml(selectedWsObj.path)}/${escapeHtml(fDir)}/[mã-task]</span>`;
        previewEl.classList.remove('hidden');
      } else {
        previewEl.classList.add('hidden');
      }
    };
    const updateEditFeaturePathPreview = () => {
      const previewEl = document.getElementById('editFeaturePathPreview');
      if (!previewEl) return;
      const taskCode = document.getElementById('editTaskCode')?.value.trim() || '';
      const selectedWsId = document.getElementById('editTaskWorkspace')?.value.trim() || '';
      const wsList = state.workspaces || [];
      const selectedWsObj = wsList.find(w => w.id === selectedWsId || w.path === selectedWsId) || null;
      if (selectedWsObj && taskCode) {
        const fDir = selectedWsObj.features_dir || 'docs/features';
        const fullExpectedPath = `${String(selectedWsObj.path).replace(/[\\/]$/, '')}/${fDir}/${taskCode}`;
        previewEl.innerHTML = `<span class="text-slate-400">Thư mục tính năng:</span> <span class="text-indigo-300 font-bold">${escapeHtml(fullExpectedPath)}</span>`;
        previewEl.classList.remove('hidden');
      } else if (selectedWsObj) {
        const fDir = selectedWsObj.features_dir || 'docs/features';
        previewEl.innerHTML = `<span class="text-slate-400">Thư mục features cấu hình:</span> <span class="text-indigo-300">${escapeHtml(selectedWsObj.path)}/${escapeHtml(fDir)}/[mã-task]</span>`;
        previewEl.classList.remove('hidden');
      } else {
        previewEl.classList.add('hidden');
      }
    };

    document.getElementById('createTaskCode')?.addEventListener('input', updateFeaturePathPreview);
    document.getElementById('createTaskWorkspace')?.addEventListener('change', updateFeaturePathPreview);
    document.getElementById('editTaskCode')?.addEventListener('input', updateEditFeaturePathPreview);
    document.getElementById('editTaskWorkspace')?.addEventListener('change', updateEditFeaturePathPreview);
    document.getElementById('btnStartTask')?.addEventListener('click', handleStartTask);
    document.getElementById('btnDequeueTask')?.addEventListener('click', () => dequeueTask(state.activeJobId));
    document.getElementById('btnPauseTask')?.addEventListener('click', handlePauseTask);
    document.getElementById('btnResumeTask')?.addEventListener('click', handleResumeTask);
    document.getElementById('btnCancelTask')?.addEventListener('click', handleCancelActiveJob);
    document.getElementById('btnDeleteTask')?.addEventListener('click', handleDeleteTask);
    document.getElementById('btnUpdateStatus')?.addEventListener('click', handleUpdateTaskStatus);

    // PENDING Action Buttons
    document.getElementById('btnOpenPendingQuestion')?.addEventListener('click', () => {
      if (typeof openQuestionModal === 'function') openQuestionModal();
    });
    document.getElementById('btnApproveDualPlan')?.addEventListener('click', async () => {
      if (!state.activeJobId) return;
      if (!confirm("Bạn xác nhận Duyệt kế hoạch (Dual Plan) này và tiếp tục chạy IMPLEMENT?")) return;
      const btn = document.getElementById('btnApproveDualPlan');
      const oldHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang duyệt...';
      try {
        const res = await fetch('/api/v1/jobs/' + state.activeJobId + '/approve', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Duyệt thất bại');

        if (state.activeJob && state.activeJob.id === state.activeJobId) {
          state.activeJob.status = 'IMPLEMENT';
          state.activeJob.current_step = 'IMPLEMENT';
          renderActiveJobDetail();
        }
        const targetJob = state.jobs.find((j) => j.id === state.activeJobId);
        if (targetJob) {
          targetJob.status = 'IMPLEMENT';
          targetJob.current_step = 'IMPLEMENT';
          targetJob.updated_at = new Date().toISOString();
        }
        renderJobsList();

        showToast(data.message, 'success');
        fetchJobDetails(state.activeJobId);
        fetchJobsListSilently();
      } catch (err) {
        showToast(err.message || 'Lỗi duyệt kế hoạch', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    });

    // Lightbox Modal
    document.getElementById('btnCloseLightbox')?.addEventListener('click', closeLightboxModal);
    document.getElementById('lightboxModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'lightboxModal') closeLightboxModal();
    });

    // Evidence Detail Modal Inspector
    document.getElementById('btnCloseEvidenceDetail')?.addEventListener('click', closeEvidenceDetailModal);
    document.getElementById('btnCloseEvidenceDetailFooter')?.addEventListener('click', closeEvidenceDetailModal);
    document.getElementById('btnCopyEvidenceDetail')?.addEventListener('click', copyEvidenceDetailContent);
    document.getElementById('evidenceDetailModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'evidenceDetailModal') closeEvidenceDetailModal();
    });

    // Global Escape key to close modals + Left/Right to switch evidence image
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeLightboxModal();
        closeEvidenceDetailModal();
        return;
      }
      // Chuyen anh trong modal evidence (UI channel) bang phim <- / ->
      const modalEl = document.getElementById('evidenceDetailModal');
      if (!modalEl || modalEl.classList.contains('hidden')) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const list = (state._evidenceCache && state._evidenceCache.ui) ? state._evidenceCache.ui : [];
      if (list.length < 2) return;
      const cur = state._evidenceModalIndex;
      const base = (typeof cur === 'number' && cur >= 0) ? cur : 0;
      const next = (e.key === 'ArrowRight')
        ? (base + 1) % list.length
        : (base - 1 + list.length) % list.length;
      e.preventDefault();
      showEvidenceDetailModal('ui', next);
    });

    // Window Resize for Terminal
    window.addEventListener('resize', () => {
      if (state.fitAddon && state.activeTab === 'terminal') {
        scheduleFitTerminal();
      }
    });

    // Create Job Form
    document.getElementById('createJobForm')?.addEventListener('submit', handleCreateJobSubmit);
    document.getElementById('toggleCustomPipeline')?.addEventListener('change', (e) => {
      const isCustom = e.target.checked;
      const singleContainer = document.getElementById('singleAgentContainer');
      const customContainer = document.getElementById('customPipelineContainer');
      if (isCustom) {
        singleContainer?.classList.add('hidden');
        customContainer?.classList.remove('hidden');
      } else {
        singleContainer?.classList.remove('hidden');
        customContainer?.classList.add('hidden');
      }
    });

    // Active Job Actions
    document.getElementById('btnCancelJob')?.addEventListener('click', handleCancelActiveJob);
    document.getElementById('btnRerunJob')?.addEventListener('click', handleRerunActiveJob);
    // B3: "Thử lại ngay" trên banner chờ hồi phục (PAUSED + lỗi TRANSIENT)
    document.getElementById('btnRetryRecovery')?.addEventListener('click', retryRecoveryNow);
    document.getElementById('btnRetryPortWait')?.addEventListener('click', retryPortWaitNow);
    // B15: làm mới nhanh job đang xem + danh sách job
    document.getElementById('btnRefreshActiveJob')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn && btn.disabled) return;
      if (btn) btn.disabled = true;
      try {
        let detailOk = true;
        if (state.activeJobId) {
          // Bỏ qua dedupe C2 cho thao tác làm mới chủ động của người dùng
          state.lastDetailFetchAt[state.activeJobId] = 0;
          detailOk = await fetchJobDetails(state.activeJobId, false);
        }
        await fetchJobsListSilently();
        // B18: chỉ báo thành công khi thật sự lấy được dữ liệu
        showToast(
          detailOk ? 'Đã làm mới trạng thái task.' : 'Không thể làm mới trạng thái task (kiểm tra kết nối).',
          detailOk ? 'success' : 'error'
        );
      } catch (err) {
        showToast('Không thể làm mới trạng thái task: ' + (err.message || 'lỗi kết nối'), 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    document.getElementById('btnViewRawJson')?.addEventListener('click', openRawJsonModal);
    document.getElementById('btnCloseRawJson')?.addEventListener('click', closeRawJsonModal);
    document.getElementById('btnCopyRawJson')?.addEventListener('click', copyRawJsonContent);

    // Terminal Toolbar Actions
    document.getElementById('btnToggleAutoScroll')?.addEventListener('click', toggleAutoScroll);
    document.getElementById('btnClearTerminal')?.addEventListener('click', async () => {
      const jobId = state.activeJobId;
      if (!jobId) {
        clearTerminalScreen({ resetMarker: true });
        return;
      }
      if (!confirm('Bạn có chắc muốn xóa sạch toàn bộ file log của task này trên máy chủ không? Hành động này sẽ giải phóng dung lượng đĩa và không thể hoàn tác.')) {
        return;
      }
      clearTerminalScreen({ resetMarker: true });
      try {
        const res = await fetch(`/api/v1/jobs/${jobId}/logs`, { method: 'DELETE' });
        if (res.ok) {
          state.logOffset = 0;
          state.oldestLogOffset = 0;
          state.hasOlderLogs = false;
          const btnOlder = document.getElementById('btnLoadOlderLogs');
          if (btnOlder) btnOlder.classList.add('hidden');
          showToast('Đã xóa sạch toàn bộ log của task trên máy chủ.', 'success');
        }
      } catch (e) {
        console.warn('Lỗi xóa log server:', e);
      }
    });
    document.getElementById('btnCopyTerminalLog')?.addEventListener('click', copyTerminalLog);
    // Terminal: Tai lich su log cu hon (T1.4, T1.5)
    document.getElementById('btnLoadOlderLogs')?.addEventListener('click', loadOlderLogs);

    // Event Delegation tren #jobsListContainer (1 listener duy nhat, tranh ro ri DOM - T2.2)
    const jobsListContainer = document.getElementById('jobsListContainer');
    if (jobsListContainer) {
      jobsListContainer.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn) {
          e.stopPropagation();
          const action = actionBtn.getAttribute('data-action');
          const jobId = actionBtn.getAttribute('data-job-id');
          if (action === 'archive') {
            window.aiWorker.archiveTask(jobId, actionBtn);
          } else if (action === 'delete') {
            window.aiWorker.deleteTask(jobId, actionBtn);
          } else if (action === 'dequeue') {
            window.aiWorker.dequeueTask(jobId, actionBtn);
          }
          return;
        }
        const card = e.target.closest('.job-card');
        if (card) {
          const jobId = card.getAttribute('data-job-id');
          if (jobId && jobId !== state.activeJobId) {
            selectJob(jobId);
          }
        }
      });
    }
    // Navigation Tabs (Terminal vs Dev Plan vs Test Plan)
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        switchMainTab(tab);
      });
    });

    // Evidence Sub-Tabs
    document.querySelectorAll('.evidence-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const subtab = btn.getAttribute('data-subtab');
        switchEvidenceSubTab(subtab);
      });
    });

    // Question Modal (Human-in-the-Loop)
    document.getElementById('btnOpenPendingModal')?.addEventListener('click', openQuestionModal);
    document.getElementById('btnCloseQuestionModal')?.addEventListener('click', closeQuestionModal);
    document.getElementById('btnDismissQuestion')?.addEventListener('click', closeQuestionModal);
    document.getElementById('btnSubmitAnswer')?.addEventListener('click', handleSubmitQuestionAnswer);
    document.getElementById('btnAnswerQuestion')?.addEventListener('click', handleSubmitQuestionAnswer);
    // Edit Task Modal & Button
    document.getElementById('btnEditTask')?.addEventListener('click', () => {
      if (state.activeJobId) {
        openEditTaskModal(state.activeJobId);
      } else {
        showToast('Vui lòng chọn một Task để sửa', 'warning');
      }
    });
    document.getElementById('btnCloseEditModal')?.addEventListener('click', closeEditTaskModal);
    document.getElementById('btnCancelEditModal')?.addEventListener('click', closeEditTaskModal);
    document.getElementById('editTaskForm')?.addEventListener('submit', handleEditTaskSubmit);
    document.getElementById('btnCloneTask')?.addEventListener('click', () => openCloneTaskModal());

    // Lightbox modal close
    document.getElementById('btnCloseLightbox')?.addEventListener('click', closeLightboxModal);
    document.getElementById('lightboxModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'lightboxModal') closeLightboxModal();
    });
  }

  // =========================================================================
  // 3. API FETCH & DATA HANDLING
  // =========================================================================
  // B5: giữ bản job mới hơn khi response chứa updated_at cũ hơn state đang có
  function mergeJobsPreferNewer(incomingJobs) {
    if (!Array.isArray(incomingJobs)) return [];
    const existingById = new Map(state.jobs.map((j) => [j.id, j]));
    return incomingJobs.map((job) => {
      const old = existingById.get(job.id);
      if (!old) return job;
      const oldTime = Date.parse(old.updated_at || '') || 0;
      const newTime = Date.parse(job.updated_at || '') || 0;
      return newTime < oldTime ? old : job;
    });
  }

  // B18: fetch có timeout để spinner không quay mãi khi server treo
  async function fetchWithTimeout(url, options = {}, ms = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJobsList() {
    const listContainer = document.getElementById('jobsListContainer');
    const seq = ++state.jobsFetchSeq; // B5
    try {
      const res = await fetch('/api/v1/jobs');
      if (!res.ok) throw new Error('Failed to fetch jobs list: ' + res.statusText);
      const data = await res.json();
      if (seq !== state.jobsFetchSeq) return; // B5: response của request cũ -> bỏ qua
      state.jobs = mergeJobsPreferNewer(Array.isArray(data) ? data : (data.jobs || []));
      renderJobsList();
      updateJobsCountBadge();
    } catch (err) {
      console.error('Error fetching jobs:', err);
      if (listContainer && state.jobs.length === 0) {
        listContainer.innerHTML = `
          <div class="text-center py-8 text-rose-400 text-xs px-3">
            <i class="fa-solid fa-triangle-exclamation text-xl mb-1.5"></i>
            <p>Không thể kết nối đến máy chủ API.</p>
            <p class="text-[11px] text-slate-500 mt-1">Đang thử lại...</p>
          </div>
        `;
      }
    }
  }

  async function fetchJobsListSilently() {
    const seq = ++state.jobsFetchSeq; // B5
    try {
      const res = await fetch('/api/v1/jobs');
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== state.jobsFetchSeq) return; // B5: response của request cũ -> bỏ qua
      const newJobs = mergeJobsPreferNewer(Array.isArray(data) ? data : (data.jobs || []));
      state.jobs = newJobs;
      renderJobsList();
      updateJobsCountBadge();

      // Cập nhật job đang active nếu có
      if (state.activeJobId) {
        const updated = state.jobs.find((j) => j.id === state.activeJobId);
        if (updated && updated.status !== state.activeJob?.status) {
          fetchJobDetails(state.activeJobId, false);
        }
      }
    } catch (e) {
      // ignore in silent poll
    }
  }

  async function fetchJobDetails(jobId, clearTerm = true) {
    // C2: dedupe - cùng jobId mà lần gọi trước chưa quá 500ms thì bỏ qua
    const now = Date.now();
    if (now - (state.lastDetailFetchAt[jobId] || 0) < 500) return false;
    state.lastDetailFetchAt[jobId] = now;
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}`);
      if (!res.ok) throw new Error('Failed to load job details');
      const data = await res.json();
      // B2: response về muộn của job cũ không được ghi đè job đang xem
      if (jobId !== state.activeJobId) return false;
      const job = data.job || data;

      state.activeJob = job;
      state.evidences = (data.job && (data.job.evidence || data.job.evidences)) || data.evidence || data.evidences || [];
      state.dualPlan = (data.job && (data.job.dual_plan || data.job.dualPlan)) || data.dual_plan || data.dualPlan || null;
      state.currentQuestion = (data.job && (data.job.question || data.job.pending_question)) || data.question || null;

      // Invalidate planCache nếu dualPlan có dữ liệu mới từ backend
      if (state.dualPlan && (state.dualPlan.dev_plan || state.dualPlan.test_plan)) {
        state.planCache.delete(jobId);
      }

      renderActiveJobDetail();

      // Kết nối Realtime Log Stream SSE nếu chưa có hoặc đổi job
      if (!state.eventSource || state.connectedJobId !== jobId) {
        state.connectedJobId = jobId;
        connectLogStream(jobId, clearTerm);
      }
      return true;
    } catch (err) {
      console.error('Error fetching job details:', err);
      return false;
    }
  }

  async function fetchSystemStatus() {
    try {
      const res = await fetch('/api/v1/status');
      if (!res.ok) throw new Error('Status endpoint unavailable');
      const data = await res.json();
      state.systemStatus = {
        online: true,
        uptimeSeconds: data.uptime || data.uptimeSeconds || 0,
        activeWorkers: data.activeWorkers !== undefined ? data.activeWorkers : (data.runningJobs || 0),
        maxConcurrency: data.concurrency || data.maxConcurrency || 3,
        // Trang thai model SystemOne: live / fallback / disabled.
        systemoneStatus: data.systemoneStatus || null
      };
      renderSystemStatus();
    } catch (err) {
      // Fallback status (T2P.1: hien thi dung Server Offline khi mat ket noi)
      state.systemStatus.online = false;
      renderSystemStatus();
    }
  }

  // =========================================================================
  // 4. SSE (SERVER-SENT EVENTS) REALTIME STREAM
  // =========================================================================
  function connectLogStream(jobId, clearTerm = true) {
    // Đóng SSE cũ nếu đang mở
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    if (clearTerm) {
      state.logOffset = 0;
      state.oldestLogOffset = 0;
      state.hasOlderLogs = false;
      const btnOlder = document.getElementById('btnLoadOlderLogs');
      if (btnOlder) btnOlder.classList.add('hidden');
      if (state.term) {
        writeTerminalBanner(`Bắt đầu kết nối log stream cho Job #${jobId}...`);
      }
    }

    // Reconnect tai theo offset (T1.5)
    const sseUrl = (state.logOffset > 0 && !clearTerm)
      ? `/api/v1/jobs/${jobId}/logs/stream?from=${state.logOffset}`
      : `/api/v1/jobs/${jobId}/logs/stream`;
    state.eventSource = new EventSource(sseUrl);

    state.eventSource.onopen = () => {
      const dot = document.getElementById('termPulseDot');
      if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-1 inline-block';
    };

    // Generic message listener
    state.eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleSsePayload(payload);
      } catch (e) {
        if (event.data && !state.ignoreHistoricalLogs) {
          scheduleTerminalWrite(event.data, true);
        }
      }
    };

    // Custom Named Event: log
    state.eventSource.addEventListener('log', (event) => {
      try {
        const payload = JSON.parse(event.data);
        // Cap nhat byte offset tu Last-Event-ID hoac payload.offset (T1.5)
        if (event.lastEventId) {
          const parsedId = parseInt(event.lastEventId, 10);
          if (Number.isFinite(parsedId) && parsedId > state.logOffset) {
            state.logOffset = parsedId;
          }
        }
        if (payload.offset && payload.offset > state.logOffset) {
          state.logOffset = payload.offset;
        }
        // Bat nut tai them log cu neu la tail snapshot (T1.4)
        if (payload.tailOnly && payload.totalBytes) {
          state.oldestLogOffset = Math.max(0, payload.totalBytes - 256 * 1024);
          state.hasOlderLogs = state.oldestLogOffset > 0;
          const btnOlder = document.getElementById('btnLoadOlderLogs');
          if (btnOlder && state.hasOlderLogs) {
            btnOlder.classList.remove('hidden');
            const totalKb = Math.round(payload.totalBytes / 1024);
            const lbl = document.getElementById('loadOlderLogsLabel');
            if (lbl) lbl.textContent = `Tải log cũ (${totalKb} KB)`;
          }
        }

        const isHistoryChunk = !payload.timestamp;
        if (isHistoryChunk && state.ignoreHistoricalLogs) {
          return;
        }
        if (state.terminalClearMarker && payload.timestamp) {
          const logTime = new Date(payload.timestamp).getTime();
          if (!isNaN(logTime) && logTime < state.terminalClearMarker) {
            return;
          }
        }
        const text = payload.text || payload.message || payload.log || '';
        if (text) {
          scheduleTerminalWrite(text, false, payload.timestamp);
        }
      } catch (e) {
        if (event.data && !state.ignoreHistoricalLogs) scheduleTerminalWrite(event.data, true);
      }
    });

    // Custom Named Event: step
    state.eventSource.addEventListener('step', (event) => {
      try {
        const payload = JSON.parse(event.data);
        const targetJobId = payload.jobId || jobId;
        const newStep = payload.step || payload.current_step;

        const targetJob = state.jobs.find((j) => j.id === targetJobId);
        if (targetJob && newStep) {
          targetJob.current_step = newStep;
          if (payload.runner) targetJob.runner = payload.runner;
          targetJob.updated_at = payload.timestamp || new Date().toISOString();
        }

        // Xóa cache plan khi chuyển bước để luôn nạp plan mới nhất
        state.planCache.delete(targetJobId);

        if (state.activeJob && (state.activeJob.id === targetJobId || !payload.jobId)) {
          if (newStep) state.activeJob.current_step = newStep;
          if (payload.runner) state.activeJob.runner = payload.runner;
          // C2: gộp render detail + stepper vào 1 frame
          scheduleActiveJobRender();
          loadPlanFiles(targetJobId);
          fetchJobDetails(targetJobId, false);
        }
        renderJobsList();
      } catch (e) {
        console.warn('Step event error:', e);
      }
    });

    // Custom Named Event: status
    state.eventSource.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse(event.data);
        const newStatus = payload.status;
        const targetJobId = payload.jobId || jobId;

        // Trạng thái phụ "đang chờ port": chỉ cập nhật banner, KHÔNG fetch lại
        // chi tiết job (tránh tải payload lớn mỗi 15s trong lúc chờ).
        if (payload.waiting === true) {
          if (targetJobId === state.activeJobId || !state.activeJobId) {
            showPortWaitBanner({
              waiting: true,
              waitedMs: Number(payload.waiting_ms) || 0,
              holders: payload.waiting_holders || null,
              phase: newStatus
            });
          }
          return;
        }
        if (payload.waiting === false) {
          hidePortWaitBanner();
          return;
        }

        const targetJob = state.jobs.find((j) => j.id === targetJobId);
        if (targetJob) {
          targetJob.status = newStatus;
          if (payload.current_step) targetJob.current_step = payload.current_step;
          if (payload.runner) targetJob.runner = payload.runner;
          if (payload.is_queued !== undefined) targetJob.is_queued = !!payload.is_queued;
          targetJob.updated_at = payload.timestamp || new Date().toISOString();
        }

        // Xóa cache plan khi status thay đổi để hiển thị ngay Dev/Test plan mới
        state.planCache.delete(targetJobId);

        if (state.activeJob && (state.activeJob.id === targetJobId || !payload.jobId)) {
          state.activeJob.status = newStatus;
          if (payload.current_step) state.activeJob.current_step = payload.current_step;
          if (payload.runner) state.activeJob.runner = payload.runner;
          if (payload.is_queued !== undefined) state.activeJob.is_queued = !!payload.is_queued;
          if (newStatus === 'PENDING') state.activeJob.had_pending = 1;
          if (newStatus === 'FIXING') state.activeJob.fix_attempt = 1;
          // C2: gộp render detail + stepper vào 1 frame
          scheduleActiveJobRender();
          loadPlanFiles(targetJobId);
        }
        // B2: chỉ đồng bộ chi tiết khi status thuộc job đang xem
        if (targetJobId === state.activeJobId) {
          fetchJobDetails(targetJobId, false);
        }
        renderJobsList();
        fetchSystemStatus();
      } catch (e) {
        console.warn('Status event error:', e);
      }
    });

    // Custom Named Event: runtime (thoi luong worker thuc su chay task)
    state.eventSource.addEventListener('runtime', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload || !payload.jobId) return;
        if (state.activeJob && state.activeJob.id === payload.jobId) {
          state.activeJob.runtime_ms = Number(payload.runtime_ms) || 0;
          if (payload.status) state.activeJob.status = payload.status;
          renderActiveJobDuration();
        }
      } catch (e) {
        console.warn('Runtime event error:', e);
      }
    });

    // Custom Named Event: systemone (trang thai SystemOne CUA TASK NAY)
    state.eventSource.addEventListener('systemone', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload || !payload.jobId) return;
        // Cap nhat ca job dang xem va job trong danh sach (badge per-task).
        const st = {
          live: payload.live === true ? true : (payload.live === false ? false : null),
          calls: Number(payload.calls) || 0,
          fallbacks: Number(payload.fallbacks) || 0,
          lastError: payload.lastError || null,
          lastDecision: payload.lastDecision || null,
          decisions: Array.isArray(payload.decisions) ? payload.decisions : [],
          model: payload.model || null,
          updatedAt: payload.updatedAt || null
        };
        const inList = state.jobs.find((j) => j.id === payload.jobId);
        if (inList) {
          inList.systemone_state = st;
        }
        if (state.activeJob && state.activeJob.id === payload.jobId) {
          state.activeJob.systemone_state = st;
          renderActiveJobDetail();
        }
        renderJobsList();
      } catch (e) {
        console.warn('SystemOne event error:', e);
      }
    });

    // Custom Named Event: question (Human-in-the-Loop Clarification)
    state.eventSource.addEventListener('question', (event) => {
      try {
        const questionData = JSON.parse(event.data);
        // B1: câu hỏi của job khác đang xem thì bỏ qua (tránh mở modal sai job)
        if (questionData.jobId && state.activeJobId && questionData.jobId !== state.activeJobId) return;
        // Lưu jobId ngay trên câu hỏi để lúc submit trả lời đúng job
        questionData.jobId = questionData.jobId || jobId || state.activeJobId || null;
        state.currentQuestion = questionData;
        if (state.activeJob) {
          state.activeJob.status = 'PENDING';
          state.activeJob.had_pending = 1;
          renderActiveJobDetail();
        }
        openQuestionModal();
      } catch (e) {
        console.warn('Question event parse error:', e);
      }
    });

    // Custom Named Event: evidence
    state.eventSource.addEventListener('evidence', (event) => {
      try {
        const raw = JSON.parse(event.data);
        const evidenceData = (raw && raw.evidence) ? raw.evidence : raw;
        if (!evidenceData) return;
        // UPSERT theo filename: watcher realtime gui lai file da co (doi trang thai)
        // => push se tao ban trung. Chi them neu chua co.
        const key = String(evidenceData.filename || evidenceData.fileName || evidenceData.id || '').toLowerCase();
        if (key) {
          const existingIdx = state.evidences.findIndex((e) =>
            String(e.filename || e.fileName || e.id || '').toLowerCase() === key);
          if (existingIdx >= 0) {
            state.evidences[existingIdx] = { ...state.evidences[existingIdx], ...evidenceData };
          } else {
            state.evidences.push(evidenceData);
          }
        } else {
          state.evidences.push(evidenceData);
        }
        renderEvidenceHub();
      } catch (e) {
        console.warn('Evidence event parse error:', e);
      }
    });

    state.eventSource.onerror = () => {
      const dot = document.getElementById('termPulseDot');
      if (dot) dot.className = 'w-1.5 h-1.5 rounded-full bg-rose-500 ml-1 inline-block';
    };
  }

  /**
   * Tai lich su log cu hon theo phan trang byte offset (T1.4, T1.5)
   */
  async function loadOlderLogs() {
    if (!state.activeJobId || state.oldestLogOffset <= 0) return;
    const btnOlder = document.getElementById('btnLoadOlderLogs');
    const lbl = document.getElementById('loadOlderLogsLabel');
    if (btnOlder) btnOlder.disabled = true;
    if (lbl) lbl.textContent = 'Đang tải...';
    try {
      const readChunk = 64 * 1024; // 64 KB moi lan cuon nguoc
      const targetOffset = Math.max(0, state.oldestLogOffset - readChunk);
      const limit = state.oldestLogOffset - targetOffset;
      const res = await fetch(`/api/v1/jobs/${state.activeJobId}/logs?offset=${targetOffset}&limit=${limit}`);
      const data = await res.json();
      if (data.success && data.text) {
        state.oldestLogOffset = targetOffset;
        if (state.term) {
          writeTerminalBanner(`--- ĐÃ TẢI ${Math.round(limit / 1024)} KB LOG CŨ ---`);
          scheduleTerminalWrite(data.text, false);
        }
        if (state.oldestLogOffset <= 0) {
          state.hasOlderLogs = false;
          if (btnOlder) btnOlder.classList.add('hidden');
        } else if (lbl) {
          lbl.textContent = `Tải tiếp (${Math.round(state.oldestLogOffset / 1024)} KB còn lại)`;
        }
      }
    } catch (e) {
      showToast('Không thể tải log cũ: ' + e.message, 'error');
    } finally {
      if (btnOlder) btnOlder.disabled = false;
    }
  }

  function handleSsePayload(payload) {
    if (!payload) return;

    if (payload.type === 'log' || payload.text) {
      const isHistoryChunk = !payload.timestamp;
      if (isHistoryChunk && state.ignoreHistoricalLogs) {
        return;
      }
      if (state.terminalClearMarker && payload.timestamp) {
        const logTime = new Date(payload.timestamp).getTime();
        if (!isNaN(logTime) && logTime < state.terminalClearMarker) {
          return;
        }
      }
      scheduleTerminalWrite(payload.text || payload.message || '', false, payload.timestamp);
    } else if (payload.type === 'status' && payload.status) {
      const targetJobId = payload.jobId || (state.activeJob && state.activeJob.id);
      const targetJob = state.jobs.find((j) => j.id === targetJobId);
      if (targetJob) {
        targetJob.status = payload.status;
        if (payload.current_step) targetJob.current_step = payload.current_step;
        if (payload.runner) targetJob.runner = payload.runner;
        if (payload.is_queued !== undefined) targetJob.is_queued = !!payload.is_queued;
        targetJob.updated_at = payload.timestamp || new Date().toISOString();
      }
      if (state.activeJob && (!payload.jobId || state.activeJob.id === payload.jobId)) {
        state.activeJob.status = payload.status;
        if (payload.current_step) state.activeJob.current_step = payload.current_step;
        if (payload.runner) state.activeJob.runner = payload.runner;
        if (payload.is_queued !== undefined) state.activeJob.is_queued = !!payload.is_queued;
        if (payload.status === 'PENDING') state.activeJob.had_pending = 1;
        if (payload.status === 'FIXING') state.activeJob.fix_attempt = 1;
        renderActiveJobDetail();
      }
      renderJobsList();
    } else if (payload.type === 'step' && payload.step) {
      const targetJobId = payload.jobId || (state.activeJob && state.activeJob.id);
      const targetJob = state.jobs.find((j) => j.id === targetJobId);
      if (targetJob) {
        targetJob.current_step = payload.step;
        if (payload.runner) targetJob.runner = payload.runner;
        targetJob.updated_at = payload.timestamp || new Date().toISOString();
      }
      if (state.activeJob && (!payload.jobId || state.activeJob.id === payload.jobId)) {
        state.activeJob.current_step = payload.step;
        if (payload.runner) state.activeJob.runner = payload.runner;
        renderActiveJobDetail();
        updateStepper(state.activeJob);
      }
      renderJobsList();
    }
  }

  // =========================================================================
  // 5. UI RENDERERS
  // =========================================================================

  // --- Render Jobs List in Left Sidebar với Smart Signature Caching ---
  let lastJobsRenderSignature = '';

  /**
   * Render badge SystemOne cho MOT TASK (du lieu trong job.systemone_state).
   * - null / chua goi  -> "CHƯA GỌI"
   * - live === true    -> "LIVE"       (da goi model that)
   * - live === false   -> "FALLBACK"   (roi ve heuristic offline)
   * @param {object|null} soState Trang thai SystemOne cua task (khong dung ten `state` - tranh nham voi state toan cuc)
   * @returns {string} HTML
   */
  function renderSystemOneBadge() {
    // Không hiển thị 'CHƯA GỌI/LIVE' ở thẻ task/job theo yêu cầu người dùng
    return '';
  }
  /**
   * Xay dung noi dung HTML cho mot job card (T2.1, T2.2).
   * Su dung data-action thay cho inline onclick de ho tro event delegation.
   */
  function buildJobCardHtml(job, isActive) {
    const isQueued = job.is_queued === true;
    const status = (job.status || 'TO DO').toUpperCase();
    let statusClass = STATUS_CLASSES[status] || 'status-todo';
    let statusText = status === 'PENDING' ? 'Chờ giải đáp' : status;
    if (isQueued) {
      statusClass = 'status-queued';
      statusText = 'TO DO (QUEUED)';
    }
    const title = escapeHtml(job.title || job.prompt || 'Untitled Job');
    const repo = escapeHtml(job.repo_path || './');
    const timeAgo = formatTimeAgo(job.created_at);
    const taskCodeDisplay = job.task_code
      ? `<span class="px-1.5 py-0.5 rounded bg-slate-800 text-brand-300 border border-brand-500/25 text-[10px] font-mono font-medium tracking-tight truncate max-w-[110px] inline-block mr-1 align-middle" title="${escapeHtml(job.task_code)}">${escapeHtml(job.task_code)}</span>`
      : '';
    const isArchived = status === 'ARCHIVED';
    // B10: dùng chung DELETABLE_STATUSES; B8: chặn thao tác khi job đang chạy
    const isRunning = RUNNING_STATUSES.includes(status);
    const canDelete = DELETABLE_STATUSES.includes(status) && !isRunning;
    const archiveDisabledClass = isRunning ? 'opacity-30 cursor-not-allowed pointer-events-none' : '';
    const archiveTitle = isRunning
      ? 'Không thể lưu trữ khi Task đang chạy'
      : (isArchived ? 'Bỏ lưu trữ' : 'Lưu trữ Task');
    return `
      <div class="flex items-center justify-between gap-1.5 mb-1.5">
        <div class="flex items-center gap-1 min-w-0">
          ${taskCodeDisplay}
          <span class="font-mono text-[11px] text-slate-400 truncate">#${job.id.substring(0, 8)}</span>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <span class="status-badge ${statusClass}">${statusText}</span>
          ${isQueued ? `
          <!-- Nút Xóa khỏi hàng đợi -->
          <button class="p-1 rounded hover:bg-amber-500/20 text-emerald-400 hover:text-amber-300 transition" title="Xóa task khỏi hàng đợi chờ" data-action="dequeue" data-job-id="${job.id}">
            <i class="fa-solid fa-clock-rotate-left text-[11px]"></i>
          </button>` : ''}
          <button class="p-1 rounded hover:bg-amber-500/20 text-slate-400 hover:text-amber-300 transition ${archiveDisabledClass}" title="${archiveTitle}" data-action="archive" data-job-id="${job.id}" ${isRunning ? 'disabled' : ''}>
            <i class="fa-solid fa-box-archive text-[11px] ${isArchived ? 'text-amber-400' : ''}"></i>
          </button>
          <!-- Nút Xóa Task (B8: ẩn khi job đang chạy) -->
          <button class="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition ${canDelete ? '' : 'hidden'}" title="Xóa Task" data-action="delete" data-job-id="${job.id}" ${canDelete ? '' : 'disabled'}>
            <i class="fa-solid fa-trash-can text-[11px]"></i>
          </button>
        </div>
      </div>
      <h4 class="text-xs font-semibold text-slate-200 line-clamp-2 mb-1.5 leading-snug">${title}</h4>
      <div class="flex items-center justify-between text-[11px] text-slate-400 font-mono">
        <span class="truncate max-w-[150px]"><i class="fa-regular fa-folder mr-1 text-slate-500"></i>${repo}</span>
        <span class="text-slate-500 shrink-0">${timeAgo}</span>
      </div>
    `;
  }

  function renderJobsList(force = false) {
    const container = document.getElementById('jobsListContainer');
    if (!container) return;

    let filtered = state.jobs;

    // Kiểm tra nhanh chữ ký dữ liệu để tránh phá hủy và render lại DOM vô ích
    const currentSignature = `${state.activeJobId}_${state.statusFilter}_${state.searchQuery}_` +
      // systemone_state phai vao chu ky: badge per-task doi khi chi trang thai SystemOne thay doi.
      filtered.map(j => `${j.id}:${j.status}:${j.is_queued ? '1' : '0'}:${j.updated_at || ''}:${(j.systemone_state && j.systemone_state.updatedAt) || ''}`).join('|');
    if (!force && currentSignature === lastJobsRenderSignature) {
      return; // Dữ liệu không thay đổi -> Giữ nguyên DOM, CPU 0%
    }
    lastJobsRenderSignature = currentSignature;
    // Filter by Status: task lưu trữ phải ẩn khỏi danh sách, chỉ khi filter là ARCHIVED thì mới hiện
    if (state.statusFilter === 'ARCHIVED') {
      filtered = filtered.filter((j) => (j.status || '').toUpperCase() === 'ARCHIVED');
    } else if (state.statusFilter !== 'ALL') {
      filtered = filtered.filter((j) => (j.status || '').toUpperCase() === state.statusFilter);
    } else {
      // Mặc định 'ALL': ẨN tất cả task đã lưu trữ
      filtered = filtered.filter((j) => (j.status || '').toUpperCase() !== 'ARCHIVED');
    }
    // Filter by Search Query
    if (state.searchQuery) {
      filtered = filtered.filter((j) => {
        const idMatch = (j.id || '').toLowerCase().includes(state.searchQuery);
        // Ho tro prompt_search alias (P-4, T3.3) de tim duoc tu khoa nam sau 200 ky tu
        const titleMatch = (j.title || j.prompt_search || j.prompt || '').toLowerCase().includes(state.searchQuery);
        const repoMatch = (j.repo_path || '').toLowerCase().includes(state.searchQuery);
        return idMatch || titleMatch || repoMatch;
      });
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="text-center py-10 text-slate-500 text-xs">
          <i class="fa-regular fa-folder-open text-2xl mb-2 text-slate-600"></i>
          <p>Không tìm thấy công việc phù hợp.</p>
        </div>
      `;
      state.jobCardMap.clear();
      updateJobsCountBadge(0);
      return;
    }

    // Nếu container đang chứa placeholder rỗng hoặc loading spinner -> dọn sạch (Issue 2)
    if (container.querySelector('.fa-folder-open') || container.querySelector('.fa-spinner') || state.jobCardMap.size === 0) {
      container.innerHTML = '';
      state.jobCardMap.clear();
    }

    const currentFilteredIds = new Set(filtered.map(j => j.id));

    // 1. Xoá các node không còn trong filtered (khác status, archived, bị xóa...)
    for (const [id, entry] of state.jobCardMap.entries()) {
      if (!currentFilteredIds.has(id)) {
        if (entry.el && entry.el.parentNode === container) {
          entry.el.remove();
        }
        state.jobCardMap.delete(id);
      }
    }

    // 2a. Tạo trước các card còn thiếu để có đủ node cho việc sắp xếp thứ tự
    for (const job of filtered) {
      if (state.jobCardMap.has(job.id)) continue;
      const isActive = job.id === state.activeJobId;
      const el = document.createElement('div');
      el.className = `job-card ${isActive ? 'active' : ''} p-2.5 rounded-lg border transition cursor-pointer relative group`;
      el.setAttribute('data-job-id', job.id);
      el.innerHTML = buildJobCardHtml(job, isActive);
      state.jobCardMap.set(job.id, {
        el,
        lastStatus: job.status,
        lastIsActive: isActive,
        lastIsQueued: !!job.is_queued,
        lastSoState: JSON.stringify(job.systemone_state)
      });
      container.appendChild(el);
    }

    // 2b. Tính trước card kế tiếp (C8) để chỉ can thiệp DOM khi vị trí đã sai
    const expectedNextEls = new Array(filtered.length).fill(null);
    let upcomingEl = null;
    for (let idx = filtered.length - 1; idx >= 0; idx--) {
      expectedNextEls[idx] = upcomingEl;
      const entry = state.jobCardMap.get(filtered[idx].id);
      if (entry && entry.el.parentNode === container) upcomingEl = entry.el;
    }

    // 2c. Cập nhật nội dung từng card + giữ đúng thứ tự DOM (T2.1 incremental render)
    filtered.forEach((job, idx) => {
      const entry = state.jobCardMap.get(job.id);
      if (!entry) return;
      const el = entry.el;
      const isActive = job.id === state.activeJobId;

      if (entry.lastIsActive !== isActive) {
        if (isActive) el.classList.add('active');
        else el.classList.remove('active');
        entry.lastIsActive = isActive;
      }

      const soStateStr = JSON.stringify(job.systemone_state);
      const isQueued = !!job.is_queued;
      if (entry.lastStatus !== job.status || entry.lastIsQueued !== isQueued || entry.lastSoState !== soStateStr) {
        el.innerHTML = buildJobCardHtml(job, isActive);
        entry.lastStatus = job.status;
        entry.lastIsQueued = isQueued;
        entry.lastSoState = soStateStr;
      }

      // C8: chỉ move node khi nextElementSibling hiện tại khác vị trí mong đợi
      const expectedNext = expectedNextEls[idx];
      if (el.nextElementSibling !== expectedNext) {
        container.insertBefore(el, expectedNext);
      }
    });

    // Tự động chọn task: ưu tiên task trên URL (#/task/<id>) để reload vẫn đứng đúng task
    if (!state.activeJobId && filtered.length > 0) {
      const hashId = jobIdFromHash();
      const hashedJob = hashId ? filtered.find((j) => j.id === hashId) : null;
      selectJob(hashedJob ? hashedJob.id : filtered[0].id);
    }

    // B3: đồng bộ nút "Chạy lại" theo job đang xem
    const activeInList = filtered.find((j) => j.id === state.activeJobId);
    if (activeInList) updateRerunButton(activeInList);

    updateJobsCountBadge(filtered.length);
  }

  function selectJob(jobId) {
    state.activeJobId = jobId;
    // Routing: giữ URL dạng #/task/<id> để F5 / copy link vẫn đứng đúng task.
    writeJobHash(jobId);
    // B1: đổi job -> đóng modal câu hỏi và xoá câu hỏi của job cũ
    closeQuestionModal();
    state.currentQuestion = null;
    // Đổi job -> banner chờ port của job cũ không còn đúng.
    hidePortWaitBanner();
    renderJobsList();

    const emptyState = document.getElementById('emptyJobState');
    const activeContainer = document.getElementById('activeJobContainer');
    if (emptyState) emptyState.classList.add('hidden');
    if (activeContainer) activeContainer.classList.remove('hidden');

    // Bỏ qua dedupe C2: đổi job thì luôn nạp chi tiết mới
    state.lastDetailFetchAt[jobId] = 0;
    fetchJobDetails(jobId, true);
    // C7: gộp mọi lần fit vào 1 debounce thay vì chuỗi setTimeout
    scheduleFitTerminal();
  }

  // --- Render Active Job Detail Dashboard ---
  function renderActiveJobDetail() {
    const job = state.activeJob;
    if (!job) return;

    // "Thoi luong" = thoi gian worker thuc su chay (runtime_ms tu server).
    renderActiveJobDuration();

    // Header info
    const idBadge = document.getElementById('activeJobIdBadge');
    if (idBadge) idBadge.textContent = `#${job.id}`;

    const isQueued = job.is_queued === true;
    const statusBadge = document.getElementById('activeJobStatusBadge');
    if (statusBadge) {
      const status = (job.status || 'TO DO').toUpperCase();
      const statusIcon = STATUS_ICONS[status] || '';
      if (isQueued) {
        statusBadge.innerHTML = `${statusIcon}<span>TO DO (CHỜ CHẠY)</span>`;
        statusBadge.className = 'status-badge status-queued status-badge-clickable';
      } else {
        const statusLabel = status === 'PENDING' ? 'Chờ giải đáp' : (status === 'PAUSED' ? 'Tạm dừng' : status);
        statusBadge.innerHTML = `${statusIcon}<span>${escapeHtml(statusLabel)}</span>`;
        statusBadge.className = `status-badge ${STATUS_CLASSES[status] || 'status-todo'} status-badge-clickable`;
      }
      // Bỏ box lỗi inline (gây xô bố cục): lý do nằm trong modal thông báo,
      // header chỉ còn nút màu đỏ để bấm xem chi tiết.
      renderTaskAlertSections(job);
    }


    const runnerBadge = document.getElementById('activeJobRunnerBadge');
    if (runnerBadge) {
      const currentRunner = getEffectiveAgentForJob(job);
      runnerBadge.innerHTML = `<i class="fa-solid fa-robot text-sky-400 mr-1.5"></i><span>${escapeHtml(currentRunner)}</span>`;
      runnerBadge.title = `Agent hiện tại: ${currentRunner} (cho bước ${job.status || 'TO DO'})`;
    }

    // Badge SystemOne CUA TASK NAY (du lieu job.systemone_state, khong phai global).
    const soBadgeEl = document.getElementById('activeJobSystemOneBadge');
    if (soBadgeEl) {
      let st = job.systemone_state;
      if (typeof st === 'string') {
        try { st = JSON.parse(st); } catch (e) { st = null; }
      }
      const hasUsedSystemOne = Boolean(st && typeof st === 'object' && ((st.calls && st.calls > 0) || st.lastDecision || (Array.isArray(st.decisions) && st.decisions.length > 0)));
      if (hasUsedSystemOne) {
        soBadgeEl.classList.remove('hidden');
        const decisionText = st.lastDecision || (st.live ? 'Đã quyết định' : 'Offline Heuristic');
        soBadgeEl.textContent = `SystemOne: ${decisionText}`;
        soBadgeEl.className = 'text-xs px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-mono font-medium';
        const decisionList = Array.isArray(st.decisions) && st.decisions.length > 0
          ? '\n\nLịch sử quyết định:\n' + st.decisions.map(d => `• ${d.summary || d.route}`).join('\n')
          : '';
        soBadgeEl.title = `SystemOne cho task này:\nQuyết định: ${decisionText}\nModel: ${st.model || '—'}\nSố lần gọi: ${st.calls || 1}${decisionList}`;
      } else {
        soBadgeEl.classList.add('hidden');
      }
    }

    const titleEl = document.getElementById('activeJobTitle');
    if (titleEl) {
      titleEl.textContent = job.title || job.prompt || 'Untitled Job';
    }

    const repoEl = document.getElementById('activeJobRepo');
    if (repoEl) repoEl.textContent = job.repo_path || './';

    const branchEl = document.getElementById('activeJobBranch');
    if (branchEl) branchEl.textContent = job.base_branch || 'main';

    const createdEl = document.getElementById('activeJobCreatedAt');
    if (createdEl) {
      createdEl.textContent = job.created_at ? new Date(job.created_at).toLocaleString('vi-VN') : '--';
    }

    const isPipelineRunning = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'].includes((job.status || '').toUpperCase());
    const isPaused = (job.status || '').toUpperCase() === 'PAUSED';

    // Dequeue Button State: Chỉ hiện khi task đang nằm trong hàng đợi chờ
    const dequeueBtn = document.getElementById('btnDequeueTask');
    if (dequeueBtn) {
      if (isQueued) {
        dequeueBtn.classList.remove('hidden');
        dequeueBtn.disabled = false;
      } else {
        dequeueBtn.classList.add('hidden');
      }
    }

    // Start Button State: Disable khi task đang chạy, tạm dừng hoặc đã nằm trong hàng đợi
    const startBtn = document.getElementById('btnStartTask');
    if (startBtn) {
      startBtn.classList.remove('hidden');
      if (isQueued) {
        startBtn.disabled = true;
        startBtn.title = 'Task đã nằm trong hàng đợi chờ tới lượt';
        startBtn.classList.add('opacity-40', 'cursor-not-allowed');
      } else if (isPipelineRunning || isPaused) {
        startBtn.disabled = true;
        startBtn.title = isPaused ? 'Task đang tạm dừng, hãy nhấn Tiếp tục' : 'Task đang chạy Pipeline (đã vô hiệu hóa)';
        startBtn.classList.add('opacity-40', 'cursor-not-allowed');
      } else {
        startBtn.disabled = false;
        startBtn.title = 'Kích hoạt chạy Pipeline';
        startBtn.classList.remove('opacity-40', 'cursor-not-allowed');
      }
    }
    // Pause & Resume Buttons: Dừng ngay tại bước đang làm hoặc tiếp tục
    const pauseBtn = document.getElementById('btnPauseTask');
    if (pauseBtn) {
      if (isPipelineRunning) {
        pauseBtn.classList.remove('hidden');
        pauseBtn.disabled = false;
        pauseBtn.title = `Tạm dừng ngay tại bước ${job.status}`;
      } else {
        pauseBtn.classList.add('hidden');
      }
    }

    const resumeBtn = document.getElementById('btnResumeTask');
    if (resumeBtn) {
      if (isPaused) {
        resumeBtn.classList.remove('hidden');
        resumeBtn.disabled = false;
        resumeBtn.title = `Tiếp tục thực thi tại bước ${job.current_step || 'PLANNING'}`;
      } else {
        resumeBtn.classList.add('hidden');
      }
    }

    const cancelTaskBtn = document.getElementById('btnCancelTask');
    if (cancelTaskBtn) {
      cancelTaskBtn.disabled = !(isPipelineRunning || isPaused);
    }
    
    // Edit Button State: chỉ hiện khi task ở TO DO
    // Edit Button State: hiển thị trên thanh điều khiển chi tiết task
    const editBtn = document.getElementById('btnEditTask');
    if (editBtn) {
      editBtn.classList.remove('hidden');
      const isPipelineRunning = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'].includes((job.status || '').toUpperCase());
      editBtn.disabled = isPipelineRunning;
      if (isPipelineRunning) {
        editBtn.title = 'Không thể chỉnh sửa khi Task đang chạy Pipeline';
        editBtn.classList.add('opacity-40', 'cursor-not-allowed');
      } else {
        editBtn.title = 'Chỉnh sửa thông tin Task';
        editBtn.classList.remove('opacity-40', 'cursor-not-allowed');
      }
    }

    const cancelBtn = document.getElementById('btnCancelJob');
    if (cancelBtn) {
      const isTerminal = ['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes((job.status || '').toUpperCase());
      cancelBtn.disabled = isTerminal;
    }

    // Fixing Counter Badge
    const fixingBadge = document.getElementById('activeJobFixingBadge');
    if (fixingBadge) {
      if (job.status === 'FIXING') {
        const retryCount = job.fixing_retries !== undefined ? job.fixing_retries : 1;
        // job.max_retries KHONG ton tai trong schema jobs -> phai doc tu pipeline_config.
        let pipeCfg = job.pipeline_config;
        if (typeof pipeCfg === 'string') { try { pipeCfg = JSON.parse(pipeCfg); } catch (e) { pipeCfg = {}; } }
        pipeCfg = (pipeCfg && typeof pipeCfg === 'object') ? pipeCfg : {};
        const rawMax = pipeCfg.max_retries !== undefined ? pipeCfg.max_retries
          : pipeCfg.maxRetries !== undefined ? pipeCfg.maxRetries
          : pipeCfg.max_fixing_retries !== undefined ? pipeCfg.max_fixing_retries
          : job.max_retries;
        const maxRetries = Number(rawMax) || 3;
        const fixAttempt = (pipeCfg.fix_attempt !== undefined ? pipeCfg.fix_attempt
          : pipeCfg.fixAttempt !== undefined ? pipeCfg.fixAttempt : 0) || 0;
        fixingBadge.textContent = `Fixing: ${fixAttempt}/${maxRetries}`;
        fixingBadge.classList.remove('hidden');
      } else {
        fixingBadge.classList.add('hidden');
      }
    }

    // Update Pipeline Stepper
    updateStepper(job);

    // Banner chờ port: đang chờ (SSE) hoặc đã PAUSED vì hết thời gian chờ.
    try {
      let portPipe = job.pipeline_config;
      if (typeof portPipe === 'string') { try { portPipe = JSON.parse(portPipe); } catch (e) { portPipe = {}; } }
      if (job.status === 'PAUSED' && portPipe && portPipe.pause_kind === 'PORT_WAIT') {
        showPortWaitBanner({
          waiting: false,
          reason: portPipe.waiting_reason || job.error_message || '',
          nextAt: Number(portPipe.next_auto_resume_at) || 0
        });
      } else if (!state.portWaiting) {
        hidePortWaitBanner();
      }
    } catch (e) {}

    // Pending Alert Banner
    const pendingBanner = document.getElementById('pendingAlertBanner');
    const pendingText = document.getElementById('pendingAlertText');
    if (pendingBanner) {
      if (job.status === 'PENDING') {
        pendingBanner.classList.remove('hidden');
        if (pendingText) {
          if (state.currentQuestion) {
            let qText = state.currentQuestion.question;
            try {
              if (typeof qText === 'string' && qText.trim().startsWith('[')) {
                const parsed = JSON.parse(qText);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  qText = parsed.map((item, i) => `${i + 1}. ${item.question || item.title}`).join(' | ');
                }
              }
            } catch (e) {}
            pendingText.textContent = qText || 'Agent đang yêu cầu bạn làm rõ một số quyết định.';
          } else {
            // B16: không giữ lại text của job trước khi chưa có câu hỏi mới
            pendingText.textContent = 'Task đang chờ bạn phản hồi...';
          }
        }
      } else {
        pendingBanner.classList.add('hidden');
      }
      syncTaskAlertBar();
    }

    // B3: banner chờ hồi phục khi job PAUSED do lỗi tạm thời (TRANSIENT)
    const recoveryBanner = document.getElementById('recoveryAlertBanner');
    if (recoveryBanner) {
      let recoveryCfg = job.pipeline_config;
      if (typeof recoveryCfg === 'string') { try { recoveryCfg = JSON.parse(recoveryCfg); } catch (e) { recoveryCfg = null; } }
      const lastErrorKind = (recoveryCfg && typeof recoveryCfg === 'object')
        ? String(recoveryCfg.last_error_kind || '').toUpperCase()
        : '';
      const isWaitingRecovery = (job.status || '').toUpperCase() === 'PAUSED' && lastErrorKind === 'TRANSIENT';
      recoveryBanner.classList.toggle('hidden', !isWaitingRecovery);
      if (!isWaitingRecovery) {
        const recText = document.getElementById('recoveryAlertText');
        if (recText) recText.textContent = 'Task đang tạm dừng (PAUSED) do lỗi tạm thời. Bạn có thể thử lại ngay hoặc chờ hệ thống tự phục hồi.';
      } else if (job.error_message) {
        const recText = document.getElementById('recoveryAlertText');
        if (recText) recText.textContent = String(job.error_message);
      }
      syncTaskAlertBar();
    }

    // Populate Task Status Select & Setup Delete Task Button
    const statusSelect = document.getElementById('taskStatusSelect');
    const statusLocked = RUNNING_STATUSES.includes((job.status || '').toUpperCase());
    if (statusSelect) {
      const curStatus = (job.status || 'TO DO').toUpperCase();
      // B7: trạng thái chưa có trong danh sách tĩnh -> thêm option động, không để value rỗng
      let hasOption = Array.from(statusSelect.options).some((o) => o.value === curStatus);
      if (!hasOption && curStatus) {
        const opt = document.createElement('option');
        opt.value = curStatus;
        opt.textContent = curStatus;
        statusSelect.appendChild(opt);
        hasOption = true;
      }
      statusSelect.value = hasOption ? curStatus : 'TO DO';
      // B8: khoá đổi trạng thái khi job đang chạy
      statusSelect.disabled = statusLocked;
      statusSelect.title = statusLocked ? 'Không thể đổi trạng thái khi Task đang chạy Pipeline' : '';
    }

    const updateStatusBtn = document.getElementById('btnUpdateStatus');
    if (updateStatusBtn) {
      updateStatusBtn.disabled = statusLocked;
      updateStatusBtn.title = statusLocked ? 'Không thể đổi trạng thái khi Task đang chạy Pipeline' : 'Lưu Status';
    }

    const deleteBtn = document.getElementById('btnDeleteTask');
    if (deleteBtn) {
      // B10: dùng chung DELETABLE_STATUSES; B8: job đang chạy không được xoá
      const curStatus = (job.status || '').toUpperCase().trim();
      if (DELETABLE_STATUSES.includes(curStatus) && !statusLocked) {
        deleteBtn.classList.remove('hidden');
        deleteBtn.disabled = false;
      } else {
        deleteBtn.classList.add('hidden');
        deleteBtn.disabled = true;
      }
    }

    // B3: cập nhật nút "Chạy lại" theo trạng thái job
    updateRerunButton(job);

    // Dual Plans & Evidence Hub
    renderDualPlan();
    renderEvidenceHub();
    loadPlanFiles(job.id);
  }

  // --- Render Pipeline Stepper với Dynamic Connecting Lines & SVG Bridges ---
  
  // --- Helper đọc fix_attempt từ pipeline_config (backend chỉ có fix_attempt, không có fixing_retries) ---
  function getFixAttemptFromJob(job) {
    try {
      let cfg = job && job.pipeline_config;
      if (typeof cfg === 'string') cfg = JSON.parse(cfg);
      const v = cfg && (cfg.fix_attempt ?? cfg.fixAttempt ?? job.fix_attempt ?? job.fixing_retries ?? 0);
      return Number(v) || 0;
    } catch (e) {
      return Number((job && (job.fix_attempt ?? job.fixing_retries)) || 0) || 0;
    }
  }

  // --- Hàm vẽ đường nối SVG xuyên tâm và vòng lên khi bypass ---
  function drawSvgStepperPaths(job) {
    const svg = document.getElementById('stepperSvgOverlay');
    const container = document.getElementById('stepperNodesContainer');
    if (!svg || !container) return;

    const status = (job.status || 'TO DO').toUpperCase();
    const currentStep = (job.current_step || status).toUpperCase();

    const ALL_AFTER_PLANNING = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING', 'DONE'];
    const ALL_AFTER_IMPLEMENT = ['IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING', 'DONE'];
    const ALL_AFTER_TESTING = ['TESTING', 'VERIFY', 'FIXING', 'MERGING', 'DONE'];
    const ALL_AFTER_VERIFY = ['VERIFY', 'FIXING', 'MERGING', 'DONE'];

    const hasReachedPlanning = ALL_AFTER_PLANNING.includes(status) || ALL_AFTER_PLANNING.includes(currentStep);
    const hasReachedImplement = ALL_AFTER_IMPLEMENT.includes(status) || ALL_AFTER_IMPLEMENT.includes(currentStep);
    const hasReachedTesting = ALL_AFTER_TESTING.includes(status) || ALL_AFTER_TESTING.includes(currentStep);
    const hasReachedMerging = status === 'MERGING' || currentStep === 'MERGING' || status === 'DONE' || currentStep === 'DONE';
    const isDone = status === 'DONE' || currentStep === 'DONE';

    const hasTouchedPending = status === 'PENDING' || currentStep === 'PENDING' || Boolean(Number(job.had_pending)) || Boolean(job.had_pending) || (Array.isArray(job.questions) && job.questions.length > 0);
    const hasTouchedFixing = status === 'FIXING' || currentStep === 'FIXING' || Boolean(Number(job.had_fixing)) || Boolean(job.had_fixing) || getFixAttemptFromJob(job) > 0;
    // B12: đã chạm FIXING thì cũng coi như đã qua VERIFY (đồng bộ với updateStepper)
    const hasReachedVerify = ALL_AFTER_VERIFY.includes(status) || ALL_AFTER_VERIFY.includes(currentStep) || hasTouchedFixing;

    // C4: cache toạ độ node theo kích thước container, chỉ đo lại khi kích thước đổi
    const geomKey = `${container.clientWidth}x${container.clientHeight}`;
    let points = (state.stepperGeom && state.stepperGeom.key === geomKey) ? state.stepperGeom.points : null;
    if (!points) {
      // Lấy toạ độ tâm các node (y luôn là 17px - tâm của vòng tròn 34px)
      const getNodeCenter = (id) => {
        const el = document.getElementById(id);
        if (!el) return { x: 0, y: 17 };
        const circle = el.querySelector('.stepper-circle') || el;
        return {
          x: el.offsetLeft + (circle.offsetLeft || 0) + (circle.offsetWidth / 2 || 17),
          y: 17
        };
      };
      points = {
        todo: getNodeCenter('stepNode_TODO'),
        plan: getNodeCenter('stepNode_PLANNING'),
        pend: getNodeCenter('stepNode_PENDING'),
        imp: getNodeCenter('stepNode_IMPLEMENT'),
        test: getNodeCenter('stepNode_TESTING'),
        verify: getNodeCenter('stepNode_VERIFY'),
        fix: getNodeCenter('stepNode_FIXING'),
        merge: getNodeCenter('stepNode_MERGING'),
        done: getNodeCenter('stepNode_DONE')
      };
      state.stepperGeom = { key: geomKey, points };
    }

    const pTodo = points.todo;
    const pPlan = points.plan;
    const pPend = points.pend;
    const pImp = points.imp;
    const pTest = points.test;
    const pVerify = points.verify;
    const pFix = points.fix;
    const pMerge = points.merge;
    const pDone = points.done;

    // C4: không xoá svg.innerHTML mỗi lần vẽ; cập nhật path đã có theo id
    if (!state.stepperPathMap) state.stepperPathMap = new Map();
    const pathMap = state.stepperPathMap;
    const usedIds = new Set();
    const setPath = (id, d, className) => {
      usedIds.add(id);
      let pathEl = pathMap.get(id);
      if (!pathEl) {
        pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        svg.appendChild(pathEl);
        pathMap.set(id, pathEl);
      }
      if (pathEl.getAttribute('d') !== d) pathEl.setAttribute('d', d);
      if (pathEl.getAttribute('class') !== className) pathEl.setAttribute('class', className);
    };

    // 1. Đường nối TO DO -> PLANNING (chỉ chạm mép ngoài hình tròn, không chạy xuyên qua)
    setPath(
      'todo-plan',
      `M ${pTodo.x + 17} 17 L ${pPlan.x - 17} 17`,
      hasReachedPlanning ? 'stepper-svg-path active' : 'stepper-svg-path'
    );

    // 2. Đường chính PLANNING -> PENDING -> IMPLEMENT (xuyên tâm PENDING, không bypass)
    if (hasTouchedPending) {
      const isPastPending = hasReachedImplement;
      const pendingInClass = isPastPending
        ? 'stepper-svg-path active stroke-emerald-400'
        : 'stepper-svg-path pending stroke-amber-400';
      const pendingOutClass = isPastPending
        ? 'stepper-svg-path active stroke-emerald-400'
        : 'stepper-svg-path';
      // Đường chính đi xuyên qua node PENDING
      setPath('plan-pending', `M ${pPlan.x + 17} 17 L ${pPend.x - 17} 17`, pendingInClass);
      setPath('pending-implement', `M ${pPend.x + 17} 17 L ${pImp.x - 17} 17`, pendingOutClass);
    } else {
      // KHÔNG chạm PENDING: ĐƯỜNG NỐI VÒNG LÊN TRÊN ĐẦU PENDING RỒI VÒNG XUỐNG IMPLEMENT!
      setPath(
        'plan-implement-bridge',
        `M ${pPlan.x + 15} 9 Q ${pPend.x} -14 ${pImp.x - 15} 9`,
        hasReachedImplement ? 'stepper-svg-path stepper-svg-bridge' : 'stepper-svg-path'
      );
    }
    // 3. Đường nối IMPLEMENT -> TESTING (chỉ chạm mép ngoài hình tròn)
    setPath(
      'implement-testing',
      `M ${pImp.x + 17} 17 L ${pTest.x - 17} 17`,
      hasReachedTesting ? 'stepper-svg-path active' : 'stepper-svg-path'
    );
    // 4. Đường chính TESTING -> VERIFY -> FIXING -> DONE (xuyên tâm FIXING, không bypass)
    setPath(
      'testing-verify',
      `M ${pTest.x + 17} 17 L ${pVerify.x - 17} 17`,
      hasReachedVerify ? 'stepper-svg-path active' : 'stepper-svg-path'
    );
    if (hasTouchedFixing) {
      // Đường chính đi xuyên qua node FIXING: vàng khi active, xanh khi xong
      setPath(
        'verify-fixing',
        `M ${pVerify.x + 17} 17 L ${pFix.x - 17} 17`,
        status === 'FIXING' ? 'stepper-svg-path pending stroke-amber-400' : 'stepper-svg-path active'
      );
      setPath(
        'fixing-merging',
        `M ${pFix.x + 17} 17 L ${pMerge.x - 17} 17`,
        hasReachedMerging ? (status === 'MERGING' ? 'stepper-svg-path pending stroke-amber-400' : 'stepper-svg-path active') : 'stepper-svg-path'
      );
    } else {
      // KHÔNG chạm FIXING: ĐƯỜNG NỐI VÒNG LÊN TRÊN ĐẦU FIXING RỒI VÒNG XUỐNG MERGING!
      setPath(
        'verify-merging-bridge',
        `M ${pVerify.x + 15} 9 Q ${pFix.x} -14 ${pMerge.x - 15} 9`,
        hasReachedMerging ? 'stepper-svg-path stepper-svg-bridge' : 'stepper-svg-path'
      );
    }

    // 5. Đường nối MERGING -> DONE
    setPath(
      'merging-done',
      `M ${pMerge.x + 17} 17 L ${pDone.x - 17} 17`,
      isDone ? 'stepper-svg-path active' : 'stepper-svg-path'
    );

    // C4: dọn các path không còn dùng (khi đổi nhánh PENDING/FIXING)
    for (const [id, pathEl] of pathMap.entries()) {
      if (!usedIds.has(id)) {
        pathEl.remove();
        pathMap.delete(id);
      }
    }
  }


  function updateStepper(job) {
    const currentStepNameEl = document.getElementById('currentStepName');
    const status = (job.status || 'TO DO').toUpperCase();
    const currentStep = (job.current_step || status).toUpperCase();

    if (currentStepNameEl) {
      // B12: khi DONE phải hiển thị 'DONE' (backend có thể trả current_step = 'COMPLETED')
      const displayStep = (status === 'DONE' || currentStep === 'COMPLETED') ? 'DONE' : currentStep;
      currentStepNameEl.textContent = status === 'PENDING' ? 'PENDING (Chờ làm rõ Q&A)' : displayStep;
    }

    const nodeTodo = document.getElementById('stepNode_TODO');
    const nodePlanning = document.getElementById('stepNode_PLANNING');
    const nodePending = document.getElementById('stepNode_PENDING');
    const nodeImplement = document.getElementById('stepNode_IMPLEMENT');
    const nodeTesting = document.getElementById('stepNode_TESTING');
    const nodeVerify = document.getElementById('stepNode_VERIFY');
    const nodeFixing = document.getElementById('stepNode_FIXING');
    const nodeMerging = document.getElementById('stepNode_MERGING');
    const nodeDone = document.getElementById('stepNode_DONE');

    [nodeTodo, nodePlanning, nodePending, nodeImplement, nodeTesting, nodeVerify, nodeFixing, nodeMerging, nodeDone].forEach(n => {
      if (!n) return;
      n.classList.remove('completed', 'active', 'pending', 'failed', 'untouched');
      n.classList.add('untouched');
    });

    const STEP_ORDER = ['TO DO', 'PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'MERGING', 'DONE'];
    const normCurStep = currentStep === 'TODO' ? 'TO DO' : currentStep;
    const normStatus = status === 'TODO' ? 'TO DO' : status;
    const curStepIdx = STEP_ORDER.indexOf(normCurStep);
    const statusIdx = STEP_ORDER.indexOf(normStatus);
    const maxIdx = Math.max(curStepIdx, statusIdx);
    const hasReachedPlanning = maxIdx >= 1 || ['PENDING', 'FIXING'].includes(status) || ['PENDING', 'FIXING'].includes(currentStep);
    const hasReachedImplement = maxIdx >= 2 || ['FIXING'].includes(status) || ['FIXING'].includes(currentStep);
    const hasReachedTesting = maxIdx >= 3 || ['FIXING'].includes(status) || ['FIXING'].includes(currentStep);
    const hasTouchedPending = status === 'PENDING' || Boolean(Number(job.had_pending)) || Boolean(job.had_pending) || (Array.isArray(job.questions) && job.questions.length > 0);
    const hasTouchedFixing = status === 'FIXING' || currentStep === 'FIXING' || Boolean(Number(job.had_fixing)) || Boolean(job.had_fixing) || getFixAttemptFromJob(job) > 0;
    // B12: đã chạm FIXING cũng coi như đã qua VERIFY
    const hasReachedVerify = maxIdx >= 4 || hasTouchedFixing;
    const isDone = status === 'DONE' || currentStep === 'DONE';

    if (nodeTodo) {
      nodeTodo.classList.remove('untouched');
      if (hasReachedPlanning) nodeTodo.classList.add('completed');
      else nodeTodo.classList.add('active');
    }

    if (nodePlanning && hasReachedPlanning) {
      nodePlanning.classList.remove('untouched');
      if (status === 'PLANNING') nodePlanning.classList.add('active');
      else nodePlanning.classList.add('completed');
    }

    if (nodePending) {
      if (hasTouchedPending) {
        nodePending.classList.remove('untouched');
        if (status === 'PENDING') nodePending.classList.add('pending');
        else nodePending.classList.add('completed');
      } else {
        nodePending.classList.add('untouched');
      }
    }

    if (nodeImplement && hasReachedImplement) {
      nodeImplement.classList.remove('untouched');
      if (status === 'IMPLEMENT') nodeImplement.classList.add('active');
      else nodeImplement.classList.add('completed');
    }

    if (nodeTesting && hasReachedTesting) {
      nodeTesting.classList.remove('untouched');
      if (status === 'TESTING') nodeTesting.classList.add('active');
      else nodeTesting.classList.add('completed');
    }

    if (nodeVerify && hasReachedVerify) {
      nodeVerify.classList.remove('untouched');
      if (status === 'VERIFY') nodeVerify.classList.add('active');
      else nodeVerify.classList.add('completed');
    }

    if (nodeFixing) {
      if (hasTouchedFixing) {
        nodeFixing.classList.remove('untouched');
        if (status === 'FIXING') nodeFixing.classList.add('active');
        else nodeFixing.classList.add('completed');
      } else {
        nodeFixing.classList.add('untouched');
      }
    }
    if (nodeMerging) {
      if (status === 'MERGING' || currentStep === 'MERGING') {
        nodeMerging.classList.remove('untouched');
        nodeMerging.classList.add('active');
      } else if (isDone) {
        nodeMerging.classList.remove('untouched');
        nodeMerging.classList.add('completed');
      } else {
        nodeMerging.classList.add('untouched');
      }
    }

    if (nodeDone && isDone) {
      nodeDone.classList.remove('untouched');
      nodeDone.classList.add('completed');
    }

    // Vẽ đường nối SVG sau khi DOM đã ổn định
    requestAnimationFrame(() => {
      drawSvgStepperPaths(job);
    });
  }

  // C2: gộp render detail + stepper vào 1 frame, chống gọi trùng
  // (renderActiveJobDetail đã gọi updateStepper bên trong nên không gọi lặp)
  function scheduleActiveJobRender() {
    if (state.activeJobRenderRaf) return;
    state.activeJobRenderRaf = requestAnimationFrame(() => {
      state.activeJobRenderRaf = null;
      if (!state.activeJob) return;
      renderActiveJobDetail();
    });
  }

  // B3: chỉ hiện nút "Chạy lại" với job đã dừng/lỗi; disable khi đang gửi
  function updateRerunButton(job) {
    const btn = document.getElementById('btnRerunJob');
    if (!btn) return;
    const status = ((job && job.status) || '').toUpperCase();
    if (!job || !RERUNNABLE_STATUSES.includes(status)) {
      btn.classList.add('hidden');
      btn.disabled = state.rerunInFlight;
      return;
    }
    btn.classList.remove('hidden');
    btn.disabled = state.rerunInFlight;
  }

  // B3: "Thử lại ngay" cho banner chờ hồi phục (mode resume, không hỏi lại)
  async function retryRecoveryNow() {
    const jobId = state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!jobId) return;
    const btn = document.getElementById('btnRetryRecovery');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'resume' })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Thử lại thất bại', 'error');
        return;
      }
      showToast(data.message || 'Đã gửi yêu cầu thử lại task.', 'success');
      state.lastDetailFetchAt[jobId] = 0;
      fetchJobsListSilently();
      fetchJobDetails(jobId, false);
    } catch (err) {
      showToast('Thử lại thất bại: ' + (err.message || 'lỗi kết nối'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- Banner "đang chờ port" (TESTING/FIXING cần service của workspace) ---
  function showPortWaitBanner(info = {}) {
    const banner = document.getElementById('portWaitBanner');
    const text = document.getElementById('portWaitText');
    if (!banner) return;
    state.portWaiting = Boolean(info.waiting);
    let msg;
    if (info.waiting) {
      const secs = Math.round((Number(info.waitedMs) || 0) / 1000);
      msg = `Đang chờ port cho bước ${info.phase || 'TESTING'} — đã chờ ${secs}s.`
        + (info.holders ? ` Port đang bị giữ: ${info.holders}.` : '')
        + ' Task sẽ tự chạy tiếp ngay khi port được nhả.';
    } else {
      msg = `Đã tạm dừng vì hết thời gian chờ port. ${info.reason || ''}`.trim();
      if (info.nextAt) {
        const mins = Math.max(0, Math.round((Number(info.nextAt) - Date.now()) / 60000));
        msg += ` Hệ thống sẽ tự thử lại sau ~${mins} phút.`;
      }
    }
    if (text) text.textContent = msg;
    banner.classList.remove('hidden');
    syncTaskAlertBar();
  }

  function hidePortWaitBanner() {
    state.portWaiting = false;
    const banner = document.getElementById('portWaitBanner');
    if (banner) banner.classList.add('hidden');
    syncTaskAlertBar();
  }

  // Job đang được đổ vào modal thông báo (badge trạng thái dùng lại dữ liệu này).
  let lastAlertJob = null;

  // ===== Badge trạng thái = nút thông báo + modal chi tiết =====
  // Bố cục panel luôn cố định: thông báo KHÔNG đẩy/che nội dung bên dưới,
  // người dùng bấm nút màu để mở modal xem chi tiết.
  function renderTaskAlertSections(job) {
    const j = job || {};
    lastAlertJob = j;
    const status = (j.status || '').toUpperCase();
    const errSection = document.getElementById('taskAlertErrorSection');
    const errText = document.getElementById('taskAlertErrorText');
    const hasError = Boolean(j.error_message && String(j.error_message).trim());
    if (errSection && errText) {
      if (hasError) {
        let gateErr = '';
        try {
          const gate = j.gate_result
            ? (typeof j.gate_result === 'string' ? JSON.parse(j.gate_result) : j.gate_result)
            : null;
          if (gate && gate.error && gate.error !== j.error_message) gateErr = `\n\n[Đối soát] ${gate.error}`;
        } catch (e) {}
        errSection.classList.remove('hidden');
        errText.textContent = `${j.error_message}${gateErr}`;
      } else {
        errSection.classList.add('hidden');
        errText.textContent = '';
      }
    }
    const sumSection = document.getElementById('taskAlertSummarySection');
    const sumText = document.getElementById('taskAlertSummaryText');
    if (sumSection && sumText) {
      const summary = (j.summary && String(j.summary).trim())
        || (status === 'DONE' ? 'Task đã hoàn tất (DONE).' : '');
      if (status === 'DONE') {
        sumSection.classList.remove('hidden');
        sumText.textContent = summary;
      } else {
        sumSection.classList.add('hidden');
        sumText.textContent = '';
      }
    }
    syncTaskAlertBar();
  }

  function isAlertSectionVisible(id) {
    const el = document.getElementById(id);
    return Boolean(el && !el.classList.contains('hidden'));
  }

  function collectTaskAlerts() {
    const alerts = [];
    if (isAlertSectionVisible('taskAlertErrorSection')) {
      alerts.push({ kind: 'error', level: 'danger', icon: 'fa-triangle-exclamation', label: 'Lỗi' });
    }
    if (isAlertSectionVisible('pendingAlertBanner')) {
      alerts.push({ kind: 'pending', level: 'warn', icon: 'fa-circle-question', label: 'Chờ trả lời' });
    }
    if (isAlertSectionVisible('recoveryAlertBanner')) {
      alerts.push({ kind: 'recovery', level: 'warn', icon: 'fa-arrows-rotate', label: 'Chờ hồi phục' });
    }
    if (isAlertSectionVisible('portWaitBanner')) {
      alerts.push({ kind: 'portWait', level: 'warn', icon: 'fa-plug-circle-bolt', label: 'Chờ port' });
    }
    if (isAlertSectionVisible('taskAlertSummarySection')) {
      alerts.push({ kind: 'summary', level: 'ok', icon: 'fa-circle-check', label: 'Hoàn tất' });
    }
    return alerts;
  }

  function syncTaskAlertBar() {
    // KHÔNG còn thanh thông báo riêng (trước đây chiếm 38px làm cắt log/evidence).
    // Trạng thái + thông báo hiển thị NGAY trên badge cạnh job id:
    //  - hover => tooltip tóm tắt lý do
    //  - bấm  => mở modal chi tiết
    const badge = document.getElementById('activeJobStatusBadge');
    if (!badge) return;
    const job = lastAlertJob || state.activeJob || {};
    const parts = [];
    if (job.error_message) parts.push(String(job.error_message).trim());
    const pendingText = document.getElementById('pendingAlertText');
    if (isAlertSectionVisible('pendingAlertBanner') && pendingText) parts.push(pendingText.textContent.trim());
    const portText = document.getElementById('portWaitText');
    if (isAlertSectionVisible('portWaitBanner') && portText) parts.push(portText.textContent.trim());
    const recText = document.getElementById('recoveryAlertText');
    if (isAlertSectionVisible('recoveryAlertBanner') && recText) parts.push(recText.textContent.trim());

    const detail = parts.filter(Boolean).join('\n\n');
    badge.title = detail ? `${detail}\n\n(Bấm để xem chi tiết)` : 'Bấm để xem chi tiết trạng thái task';
    // Tooltip hiện NGAY khi hover (CSS ::after đọc data-tip), không phải chờ native title.
    if (detail) {
      badge.dataset.tip = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
    } else {
      delete badge.dataset.tip;
    }
    badge.classList.toggle('status-badge-has-alert', Boolean(detail));
  }

  function openTaskAlertModal() {
    const modal = document.getElementById('taskAlertModal');
    if (!modal) return;
    modal.classList.remove('hidden');
  }

  function closeTaskAlertModal() {
    const modal = document.getElementById('taskAlertModal');
    if (modal) modal.classList.add('hidden');
  }

  // ===== Routing theo task: #/task/<jobId> để F5 vẫn đứng đúng task =====
  function jobIdFromHash() {
    const matched = String(location.hash || '').match(/^#\/?task\/([^/?#]+)/i);
    return matched ? decodeURIComponent(matched[1]) : '';
  }

  function writeJobHash(jobId) {
    const next = jobId ? `#/task/${encodeURIComponent(jobId)}` : '';
    if (next === (location.hash || '')) return;
    try {
      history.replaceState(null, '', next || (location.pathname + location.search));
    } catch (e) {}
  }

  async function retryPortWaitNow() {
    const jobId = state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!jobId) return;
    const btn = document.getElementById('btnRetryPortWait');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'resume' })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Thử lại thất bại', 'error');
        return;
      }
      showToast(data.message || 'Đã gửi yêu cầu thử lại.', 'success');
      state.lastDetailFetchAt[jobId] = 0;
      fetchJobsListSilently();
      fetchJobDetails(jobId, false);
    } catch (err) {
      showToast('Thử lại thất bại: ' + (err.message || 'lỗi kết nối'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- Render Dual Plan (Dev Plan & Test Plan) ---
  function renderDualPlan() {
    const devContainer = document.getElementById('devPlanContent');
    const testContainer = document.getElementById('testPlanContent');
    const dual = state.dualPlan;

    if (!dual) {
      if (devContainer) {
        devContainer.innerHTML = `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-file-circle-question text-3xl mb-2 text-slate-600"></i>
            <p class="font-medium">Chưa có Dev Plan cho công việc này.</p>
            <p class="text-[11px] text-slate-600 mt-1">Dev Plan sẽ được sinh ra ở bước PLANNING bởi Planning Agent.</p>
          </div>
        `;
      }
      if (testContainer) {
        testContainer.innerHTML = `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-vial-circle-check text-3xl mb-2 text-slate-600"></i>
            <p class="font-medium">Chưa có Test Plan cho công việc này.</p>
            <p class="text-[11px] text-slate-600 mt-1">Test Plan mô tả kịch bản CloakBrowser, mock test data, API assertions.</p>
          </div>
        `;
      }
      return;
    }

    // Dung ket qua cache neu da parse Markdown roi (T2.4)
    // Dùng kết quả cache nếu có nội dung thực sự đã parse Markdown
    const cached = state.activeJobId ? state.planCache.get(state.activeJobId) : null;
    if (cached && cached.hasRealPlan && cached.devHtml) {
      if (devContainer) devContainer.innerHTML = cached.devHtml;
      if (testContainer) testContainer.innerHTML = cached.testHtml;
      return;
    }

    if (devContainer && dual.dev_plan) {
      devContainer.innerHTML = formatMarkdownContent(dual.dev_plan);
    }
    if (testContainer && dual.test_plan) {
      testContainer.innerHTML = formatMarkdownContent(dual.test_plan);
    }
  }

  // --- Helper: HTTP Method Badges ---
  function getMethodBadgeClass(method) {
    const m = (method || 'GET').toUpperCase();
    if (m === 'GET') return 'badge-method badge-get';
    if (m === 'POST') return 'badge-method badge-post';
    if (m === 'PUT') return 'badge-method badge-put';
    if (m === 'PATCH') return 'badge-method badge-patch';
    if (m === 'DELETE') return 'badge-method badge-delete';
    return 'badge-method bg-surface-800 text-slate-300 border border-slate-700';
  }

  // C3: gán nội dung pane qua DocumentFragment (một lần chèn DOM, không nối innerHTML nhiều lần)
  function setPaneHtml(pane, html) {
    if (!pane) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    pane.replaceChildren(tpl.content);
  }

  // --- Render Multi-Verification Evidence Hub ---
  function renderEvidenceHub() {
    const countBadge = document.getElementById('evidenceCountBadge');
    if (countBadge) {
      countBadge.textContent = `${state.evidences.length} mục`;
    }

    // C3: chỉ lấy pane đang hiển thị -> các pane khác không bị dựng lại (lazy khi switch tab)
    const activeSubTab = state.activeEvidenceSubTab || 'ui';
    const uiGallery = activeSubTab === 'ui' ? document.getElementById('uiEvidenceGallery') : null;
    const apiList = activeSubTab === 'api' ? document.getElementById('apiEvidenceList') : null;
    const logsList = activeSubTab === 'logs' ? document.getElementById('logsEvidenceList') : null;
    const dbList = activeSubTab === 'db' ? document.getElementById('dbEvidenceList') : null;

    const evFilename = (e) => String(e.filename || e.fileName || (e.file_path ? e.file_path.split('/').pop().split('?')[0] : '') || '').toLowerCase();
    const evExplicitChannel = (e) => {
      const c = String(e.channel || '').toLowerCase();
      if (c === 'ui' || c === 'api' || c === 'log' || c === 'logs' || c === 'db') return c === 'logs' ? 'log' : c;
      const t = String(e.evidence_type || e.type || '').toUpperCase();
      if (t === 'UI_SCREENSHOT' || t === 'UI') return 'ui';
      if (t === 'API_TEST' || t === 'API') return 'api';
      if (t === 'DB_QUERY' || t === 'DB_ASSERT' || t === 'DB') return 'db';
      if (t === 'LOG_TRACE' || t === 'SERVICE_LOG' || t === 'LOGS') return 'log';
      return null;
    };
    const evChannel = (e) => {
      const fn = evFilename(e);
      // Quy tắc cứng theo đuôi file (Issue 4: không lẫn giữa API .json và Log .log):
      if (/(\.png|\.webp|\.jpg|\.jpeg|\.svg)$/.test(fn)) return 'ui';
      if (/(\.log|\.txt)$/.test(fn)) return 'log';
      if (fn.endsWith('.sql')) return 'db';
      if (fn.endsWith('.json')) {
        if (fn.includes('db') || fn.includes('assert')) return 'db';
        return 'api';
      }
      const explicit = evExplicitChannel(e);
      if (explicit) return explicit;
      return 'log';
    };
    const uiEvidences = state.evidences.filter((e) => evChannel(e) === 'ui');
    const apiEvidences = state.evidences.filter((e) => evChannel(e) === 'api');
    const logEvidences = state.evidences.filter((e) => evChannel(e) === 'log');
    const dbEvidences = state.evidences.filter((e) => evChannel(e) === 'db');

    // Cache filtered arrays for quick lookup by index in showEvidenceDetailModal
    state._evidenceCache = {
      ui: uiEvidences,
      api: apiEvidences,
      logs: logEvidences,
      db: dbEvidences
    };

    // 1. UI Screenshots
    if (uiGallery) {
      if (uiEvidences.length === 0) {
        setPaneHtml(uiGallery, `
          <div class="col-span-2 text-center py-12 text-slate-500 text-xs">
            <i class="fa-regular fa-images text-2xl mb-2 text-slate-600 block"></i>
            <p>Chưa có ảnh chụp màn hình kiểm thử UI.</p>
            <p class="text-[11px] text-slate-600 mt-1">Ảnh chụp CloakBrowser sẽ xuất hiện tại bước TESTING.</p>
          </div>
        `);
      } else {
        setPaneHtml(uiGallery, uiEvidences
          .map((item, idx) => {
            const imgSrc = item.url || item.file_path || '';
            const status = evidenceStatus(item);
            const badge = evidenceStatusBadge(status);
            const isPass = status === EVIDENCE_STATUS.PASS;
            // Ten evidence (khong phai ten file) + mo ta.
            const nameText = escapeHtml(item.name || item.title || item.stepName || item.filename || `Bằng chứng UI #${idx + 1}`);
            const descText = item.description ? escapeHtml(item.description) : '';
            const caption = descText || nameText;
            const filename = item.filename ? escapeHtml(item.filename) : (item.file_path ? escapeHtml(item.file_path.split('/').pop()) : 'Verified');
            const stepLabel = (item.order !== null && item.order !== undefined)
              ? `Bước ${escapeHtml(String(item.order))}`
              : (item.stepIndex !== null && item.stepIndex !== undefined ? `Bước ${escapeHtml(String(item.stepIndex))}` : '');
            return `
              <div class="evidence-card cursor-pointer group flex flex-col relative aspect-video bg-surface-950 rounded-xl overflow-hidden border border-slate-800 hover:border-sky-500/60 transition shadow-sm"
                   onclick="window.aiWorker.showEvidenceDetailModal('ui', ${idx})"
                   data-src="${escapeHtml(imgSrc)}"
                   data-caption="${caption}">
                <img src="${escapeHtml(imgSrc)}" alt="${nameText}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" loading="lazy" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden');" />
                <div class="hidden absolute inset-0 flex flex-col items-center justify-center p-4 text-center text-slate-500 text-[11px] bg-surface-950">
                  <i class="fa-regular fa-image text-slate-600 text-xl mb-1"></i>
                  <span>Ảnh chưa sẵn sàng</span>
                </div>

                <!-- Controls: Delete, Toggle & Magnify -->
                <div class="absolute top-2 left-2 flex gap-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onclick="event.stopPropagation(); window.aiWorker.deleteEvidence('${escapeHtml(item.filename)}')" class="bg-slate-900/80 hover:bg-rose-500 text-white w-6 h-6 rounded flex items-center justify-center backdrop-blur-sm transition shadow" title="Xóa ảnh">
                    <i class="fa-solid fa-trash-can text-[10px]"></i>
                  </button>
                  <button onclick="event.stopPropagation(); window.aiWorker.toggleEvidenceStatus('${escapeHtml(item.filename)}', '${status}')" class="bg-slate-900/80 hover:bg-brand-500 text-white w-6 h-6 rounded flex items-center justify-center backdrop-blur-sm transition shadow" title="Đổi trạng thái evidence">
                    <i class="fa-solid fa-retweet text-[10px]"></i>
                  </button>
                  <button onclick="event.stopPropagation(); window.aiWorker.showEvidenceDetailModal('ui', ${idx})" class="bg-slate-900/80 hover:bg-sky-500 text-white w-6 h-6 rounded flex items-center justify-center backdrop-blur-sm transition shadow" title="Phóng to xem chi tiết">
                    <i class="fa-solid fa-magnifying-glass-plus text-[10px]"></i>
                  </button>
                </div>

                <!-- Status Badge: NOT VERIFY | PASS | FAILED -->
                <span class="absolute top-2 right-2 z-10 text-[10px] font-bold px-2 py-0.5 rounded shadow ${badge.cls}">${badge.text}</span>

                <!-- Bottom overlay with title & filename neatly enclosed -->
                <div class="absolute bottom-0 left-0 right-0 p-2.5 bg-gradient-to-t from-black/90 via-black/60 to-transparent z-10 pointer-events-none">
                  <p class="text-xs font-semibold text-white truncate drop-shadow" title="${nameText}">${nameText}</p>
                  <div class="flex items-center justify-between mt-0.5">
                    <span class="text-[10px] text-slate-300 font-mono truncate max-w-[70%]">${filename}</span>
                    <span class="text-[10px] text-sky-300 flex items-center gap-1 group-hover:underline">${stepLabel ? escapeHtml(stepLabel) + ' · ' : ''}<i class="fa-solid fa-expand text-[9px]"></i> Phóng to</span>
                  </div>
                </div>
              </div>
            `;
          })
          .join(''));
      }
    }

    // 2. API Test Results
    if (apiList) {
      if (apiEvidences.length === 0) {
        setPaneHtml(apiList, `
          <div class="text-center py-12 text-slate-500 text-xs">
            <i class="fa-solid fa-server text-2xl mb-2 text-slate-600 block"></i>
            <p>Chưa có kết quả API Test.</p>
            <p class="text-[11px] text-slate-600 mt-1">Các kiểm thử HTTP assertions sẽ hiển thị tại đây.</p>
          </div>
        `);
      } else {
        setPaneHtml(apiList, apiEvidences
          .map((api, idx) => {
            const method = ((api.method || (api.request && api.request.method)) || 'GET').toUpperCase();
            const endpoint = api.endpoint || api.path || (api.request && api.request.path) || '/';
            // KHONG doc `api.status` o day: sau khi chuan hoa 3 trang thai, `status` la
            // 'PASS'/'NOT VERIFY'/'FAILED' - KHONG phai HTTP status code.
            const statusCode = api.statusCode || api.status_code || api.actualStatus || (api.response && api.response.status) || 200;
            const latency = api.duration_ms || api.durationMs || api.latency_ms || api.latency || 12;
            const hasExplicitStatus = (api.status !== undefined && api.status !== null && api.status !== '') || (api.verdict !== undefined && api.verdict !== null && api.verdict !== '');
            const apiStatus = hasExplicitStatus ? evidenceStatus(api) : ((api.verdict === 'PASS' || api.status === 'PASSED' || api.passed === true || (statusCode >= 200 && statusCode < 400 && !api.error)) ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAILED);
            const apiBadge = evidenceStatusBadge(apiStatus);
            const isPass = apiStatus === EVIDENCE_STATUS.PASS;
            const methodClass = getMethodBadgeClass(method);
            const apiFilename = api.filename || (api.file_path ? String(api.file_path).split('/').pop() : '') || '';
            const apiStep = api.stepName || api.step || api.stepId || '';
            const apiCase = api.caseName || api.testCase || api.testcase || (typeof api.case === 'string' ? api.case : '') || '';
            const apiDesc = api.description || api.displayName || api.title || '';
            const apiCapturedAt = api.capturedAt || api.timestamp || api.created_at || api.time || '';

            return `
              <div class="p-3 rounded-xl bg-surface-900 border border-slate-800 hover:border-slate-700 transition shadow-sm space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="${methodClass}">${escapeHtml(method)}</span>
                    <span class="text-xs font-mono text-slate-200 font-medium truncate" title="${escapeHtml(endpoint)}">${escapeHtml(endpoint)}</span>
                  </div>
                  <span class="evidence-badge shrink-0 ${apiStatus === EVIDENCE_STATUS.PASS ? 'evidence-pass' : (apiStatus === EVIDENCE_STATUS.FAILED ? 'evidence-fail' : 'bg-slate-700 text-slate-100')}">${apiBadge.text}</span>
                </div>
                <div class="min-w-0 space-y-0.5">
                  <p class="text-xs font-semibold text-slate-100 truncate" title="${escapeHtml(apiDesc || apiFilename || endpoint)}">${escapeHtml(apiDesc || endpoint)}</p>
                  <p class="text-[10px] font-mono text-slate-400 truncate" title="${escapeHtml(apiFilename)}">${escapeHtml(apiFilename)}${apiStep ? ` · Step: ${escapeHtml(apiStep)}` : ''}${apiCase ? ` · Case: ${escapeHtml(apiCase)}` : ''}${apiCapturedAt ? ` · ${escapeHtml(apiCapturedAt)}` : ''}</p>
                </div>

                <div class="flex items-center justify-between text-[11px] font-mono bg-surface-950/70 px-2.5 py-1.5 rounded-lg border border-slate-800/80">
                  <div class="flex items-center gap-3">
                    <div>Status: <span class="${statusCode < 400 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}">${statusCode}</span></div>
                    <div class="text-slate-400 flex items-center gap-1"><i class="fa-regular fa-clock text-[10px]"></i> <span>${latency}ms</span></div>
                  </div>
                  <div class="flex items-center gap-1.5">
                    <button onclick="window.aiWorker.showEvidenceDetailModal('api', ${idx})" class="text-[10px] font-sans font-medium text-brand-400 hover:text-brand-300 hover:bg-brand-500/10 px-2 py-1 rounded transition flex items-center gap-1 border border-brand-500/20 shadow-xs">
                      <i class="fa-solid fa-code"></i>
                      <span>Chi tiết</span>
                    </button>
                    <button onclick="window.aiWorker.deleteEvidenceItem('api', ${idx})" class="text-[10px] font-sans font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-2 py-1 rounded transition flex items-center gap-1 border border-rose-500/20 shadow-xs" title="Xóa vĩnh viễn bằng chứng này">
                      <i class="fa-solid fa-trash-can"></i>
                      <span>Xóa</span>
                    </button>
                  </div>
                </div>
              </div>
            `;
          })
          .join(''));
      }
    }

    // 3. Service Logs Results
    if (logsList) {
      if (logEvidences.length === 0) {
        setPaneHtml(logsList, `
          <div class="text-center py-12 text-slate-500 text-xs">
            <i class="fa-solid fa-shield-virus text-2xl mb-2 text-slate-600 block"></i>
            <p>Không phát hiện lỗi Runtime nào từ Service Logs.</p>
            <p class="text-[11px] text-slate-600 mt-1">Dấu vết log và Exception sẽ hiển thị tại đây.</p>
          </div>
        `);
      } else {
        setPaneHtml(logsList, logEvidences
          .map((item, idx) => {
            const serviceName = item.service_name || item.service || 'Service App';
            const level = ((item.level || (item.error || item.stack_trace ? 'ERROR' : (item.warn ? 'WARN' : 'INFO')))).toUpperCase();
            const timestamp = item.capturedAt || item.timestamp || item.time || item.created_at || '';
            const logFilename = item.filename || (item.file_path ? String(item.file_path).split('/').pop() : '') || '';
            // File binary (.xlsx/.pdf/...): khong co excerpt doc duoc -> hien badge
            // "File nhi phan" thay vi rac mojibake.
            const isBinaryFile = item.downloadable === true;
            const logExcerpt = isBinaryFile
              ? `File nhị phân (${escapeHtml(logFilename || 'binary')}) — tải file để xem nội dung`
              : (item.log_excerpt || item.excerpt || item.message || (item.stack_trace ? item.stack_trace.split('\n')[0] : '') || 'Ghi nhận log hệ thống');
            const logStep = item.stepName || item.step || item.stepId || '';
            const logCase = item.caseName || item.testCase || item.testcase || (typeof item.case === 'string' ? item.case : '') || '';
            const logDesc = item.description || item.displayName || item.title || '';
            const isError = level === 'ERROR' || level === 'FATAL';
            const isWarn = level === 'WARN' || level === 'WARNING';
            const levelClass = isError
              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
              : isWarn
              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
              : 'bg-sky-500/20 text-sky-400 border border-sky-500/30';
            // Badge trang thai verify 3 gia tri (NOT VERIFY | PASS | FAILED)
            const logStatus = evidenceStatus(item);
            const logBadge = evidenceStatusBadge(logStatus);

            return `
              <div class="p-3 rounded-xl bg-surface-900 border ${isError ? 'border-rose-500/30 bg-rose-500/5' : isWarn ? 'border-amber-500/30 bg-amber-500/5' : 'border-slate-800'} transition shadow-sm space-y-2">
                <div class="flex items-center justify-between text-xs">
                  <div class="flex items-center gap-2">
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${levelClass}">${level}</span>
                    <span class="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                      <i class="fa-solid ${isError ? 'fa-triangle-exclamation text-rose-400' : isWarn ? 'fa-circle-exclamation text-amber-400' : 'fa-circle-info text-sky-400'}"></i>
                      <span>${escapeHtml(serviceName)}</span>
                    </span>
                    <span class="text-[10px] font-bold px-2 py-0.5 rounded shadow ${logBadge.cls}">${logBadge.text}</span>
                  </div>
                  <span class="text-[10px] font-mono text-slate-400">${escapeHtml(timestamp)}</span>
                </div>

                <div class="min-w-0 space-y-0.5">
                  <p class="text-xs font-semibold text-slate-100 truncate" title="${escapeHtml(logDesc || logFilename || serviceName)}">${escapeHtml(logDesc || logFilename || serviceName)}</p>
                  <p class="text-[10px] font-mono text-slate-400 truncate" title="${escapeHtml(logFilename)}">${escapeHtml(logFilename)}${logStep ? ` · Step: ${escapeHtml(logStep)}` : ''}${logCase ? ` · Case: ${escapeHtml(logCase)}` : ''}</p>
                </div>
                <div class="bg-surface-950 p-2 rounded-lg border border-slate-800/80 font-mono text-[11px] text-slate-300 max-h-16 overflow-hidden line-clamp-2 leading-relaxed">
                  ${escapeHtml(logExcerpt)}
                </div>

                <div class="flex justify-end items-center gap-1.5 pt-0.5">
                  <button onclick="window.aiWorker.showEvidenceDetailModal('logs', ${idx})" class="text-[10px] font-medium text-slate-300 hover:text-white bg-surface-800 hover:bg-surface-750 border border-slate-700 px-2.5 py-1 rounded transition flex items-center gap-1.5 shadow-sm">
                    <i class="fa-solid fa-terminal text-brand-400"></i>
                    <span>Xem log</span>
                  </button>
                  <button onclick="window.aiWorker.deleteEvidenceItem('logs', ${idx})" class="text-[10px] font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 border border-rose-500/20 px-2 py-1 rounded transition flex items-center gap-1 shadow-sm" title="Xóa vĩnh viễn log này">
                    <i class="fa-solid fa-trash-can"></i>
                    <span>Xóa</span>
                  </button>
                </div>
              </div>
            `;
          })
          .join(''));
      }
    }

    // 4. Database Query Results
    if (dbList) {
      if (dbEvidences.length === 0) {
        setPaneHtml(dbList, `
          <div class="text-center py-12 text-slate-500 text-xs">
            <i class="fa-solid fa-table-list text-2xl mb-2 text-slate-600 block"></i>
            <p>Chưa có dữ liệu đối soát Database.</p>
            <p class="text-[11px] text-slate-600 mt-1">Kết quả so khớp dữ liệu SQL assertions sẽ hiển thị tại đây.</p>
          </div>
        `);
      } else {
        setPaneHtml(dbList, dbEvidences
          .map((db, idx) => {
            const tableName = db.table || db.tableName || db.target || 'Database Table';
            const query = db.query || db.sql || 'SELECT * FROM ...';
            // `db.status` la trang thai evidence 3 gia tri. NOT VERIFY => CHUA biet
            // ket qua => KHONG coi la MATCH.
            const hasDbStatus = (db.status !== undefined && db.status !== null && db.status !== '') || (db.verdict !== undefined && db.verdict !== null && db.verdict !== '');
            const dbStatus = hasDbStatus ? evidenceStatus(db) : (db.matched === true || db.passed === true || db.verdict === 'PASS' || (!db.error && db.status !== 'FAILED') ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAILED);
            const isMatch = dbStatus === EVIDENCE_STATUS.PASS;
            const dbBadgeText = dbStatus === EVIDENCE_STATUS.NOT_VERIFY ? 'NOT VERIFY' : (isMatch ? 'MATCH' : 'DIFF');
            const dbBadgeCls = dbStatus === EVIDENCE_STATUS.NOT_VERIFY ? 'bg-slate-700 text-slate-100' : (isMatch ? 'evidence-match' : 'evidence-diff');
            const expectedStr = db.expected !== undefined ? (typeof db.expected === 'object' ? JSON.stringify(db.expected) : String(db.expected)) : (db.expectedValues ? JSON.stringify(db.expectedValues) : 'Khớp tiêu chí');
            const actualStr = db.actual !== undefined ? (typeof db.actual === 'object' ? JSON.stringify(db.actual) : String(db.actual)) : (db.rowCount !== undefined ? `${db.rowCount} rows` : (db.rows ? `${db.rows.length} rows` : 'Khớp thực tế'));

            return `
              <div class="p-3 rounded-xl bg-surface-900 border border-slate-800 hover:border-slate-700 transition shadow-sm space-y-2.5">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-xs">
                      <i class="fa-solid fa-database"></i>
                    </div>
                    <span class="font-semibold text-xs text-slate-200">${escapeHtml(tableName)}</span>
                  </div>
                  <span class="evidence-badge ${dbBadgeCls} font-bold">
                    ${dbBadgeText}
                  </span>
                </div>

                <!-- Query preview -->
                <div class="bg-surface-950 p-2 rounded-lg border border-slate-800/80 font-mono text-[11px] text-slate-300 truncate" title="${escapeHtml(query)}">
                  <span class="text-indigo-400 font-semibold">SQL:</span> ${escapeHtml(query)}
                </div>

                <!-- Expected vs Actual mini-table -->
                <div class="grid grid-cols-2 gap-2 text-[11px] font-mono bg-surface-950/60 p-2 rounded-lg border border-slate-800/60">
                  <div class="space-y-0.5">
                    <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-sans">Expected:</span>
                    <span class="text-slate-300 font-medium truncate block" title="${escapeHtml(expectedStr)}">${escapeHtml(expectedStr)}</span>
                  </div>
                  <div class="space-y-0.5">
                    <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-sans">Actual:</span>
                    <span class="${isMatch ? 'text-emerald-400' : 'text-rose-400'} font-medium truncate block" title="${escapeHtml(actualStr)}">${escapeHtml(actualStr)}</span>
                  </div>
                </div>

                <div class="flex justify-end items-center gap-1.5 pt-0.5">
                  <button onclick="window.aiWorker.showEvidenceDetailModal('db', ${idx})" class="text-[10px] font-medium text-brand-400 hover:text-brand-300 hover:bg-brand-500/10 px-2.5 py-1 rounded transition flex items-center gap-1.5 border border-brand-500/20 shadow-xs">
                    <i class="fa-solid fa-table"></i>
                    <span>Chi tiết</span>
                  </button>
                  <button onclick="window.aiWorker.deleteEvidenceItem('db', ${idx})" class="text-[10px] font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-2 py-1 rounded transition flex items-center gap-1 border border-rose-500/20 shadow-xs" title="Xóa vĩnh viễn kết quả này">
                    <i class="fa-solid fa-trash-can"></i>
                    <span>Xóa</span>
                  </button>
                </div>
              </div>
            `;
          })
          .join(''));
      }
    }
  }

  // --- Render System Status Header Bar ---
  function renderSystemStatus() {
    const dot = document.getElementById('systemStatusDot');
    const text = document.getElementById('systemStatusText');
    const uptime = document.getElementById('systemUptime');
    const workers = document.getElementById('activeWorkersCount');
    const maxConc = document.getElementById('maxConcurrency');

    if (dot) {
      dot.className = state.systemStatus.online
        ? 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse'
        : 'w-2.5 h-2.5 rounded-full bg-rose-500';
    }

    if (text) {
      text.textContent = state.systemStatus.online ? 'Server Online' : 'Server Offline';
      text.className = state.systemStatus.online ? 'font-medium text-emerald-400' : 'font-medium text-rose-400';
    }

    if (uptime) {
      uptime.textContent = formatDuration(state.systemStatus.uptimeSeconds);
    }

    if (workers) {
      workers.textContent = state.systemStatus.activeWorkers;
    }

    if (maxConc) {
      maxConc.textContent = state.systemStatus.maxConcurrency;
    }

    // Đã bỏ phần "SystemOne: CHƯA GỌI" của cả worker chung theo yêu cầu
  }

  function updateJobsCountBadge(visibleCount) {
    const badge = document.getElementById('jobsCountBadge');
    if (!badge) return;
    if (typeof visibleCount !== 'number') {
      let filtered = state.jobs;
      if (state.statusFilter === 'ARCHIVED') {
        filtered = filtered.filter((j) => (j.status || '').toUpperCase() === 'ARCHIVED');
      } else if (state.statusFilter !== 'ALL') {
        filtered = filtered.filter((j) => (j.status || '').toUpperCase() === state.statusFilter);
      } else {
        filtered = filtered.filter((j) => (j.status || '').toUpperCase() !== 'ARCHIVED');
      }
      if (state.searchQuery) {
        filtered = filtered.filter((j) => {
          const idMatch = (j.id || '').toLowerCase().includes(state.searchQuery);
          const titleMatch = (j.title || j.prompt_search || j.prompt || '').toLowerCase().includes(state.searchQuery);
          const repoMatch = (j.repo_path || '').toLowerCase().includes(state.searchQuery);
          return idMatch || titleMatch || repoMatch;
        });
      }
      visibleCount = filtered.length;
    }
    if (state.statusFilter === 'ARCHIVED') {
      badge.textContent = `${visibleCount} archived`;
    } else {
      badge.textContent = `${visibleCount} jobs`;
    }
  }

  function updateDurationTick() {
    state.systemStatus.uptimeSeconds++;
    const uptimeEl = document.getElementById('systemUptime');
    if (uptimeEl) {
      uptimeEl.textContent = formatDuration(state.systemStatus.uptimeSeconds);
    }
    // B11: KHÔNG cộng dồn runtime_ms ở client; server (event runtime / job details) là nguồn sự thật
    renderActiveJobDuration();
  }

  // Render "Thoi luong" cua job dang xem:
  // "Thoi luong" = tong thoi gian worker THUC SU chay task qua tat ca cac step (ke ca chay lai).
  // Tuyet doi khong tinh wall-clock tu created_at de khong dem thoi gian nam cho.
  function renderActiveJobDuration() {
    if (!state.activeJob) return;
    const durationEl = document.getElementById('activeJobDuration');
    if (!durationEl) return;

    const runtimeMs = Number(state.activeJob.runtime_ms);
    const hasRuntime = state.activeJob.runtime_ms !== null
      && state.activeJob.runtime_ms !== undefined
      && Number.isFinite(runtimeMs)
      && runtimeMs >= 0;
    if (hasRuntime) {
      durationEl.textContent = formatDuration(Math.floor(runtimeMs / 1000));
      return;
    }
    // B11: chưa có runtime_ms từ server -> hiển thị '—' thay vì số liệu tự bịa
    durationEl.textContent = '—';
  }

  // =========================================================================
  // 6. MODAL DIALOGS MANAGEMENT
  // =========================================================================

  // --- Create Job Modal ---
  async function openCreateJobModal() {
    const modal = document.getElementById('createJobModal');
    if (modal) modal.classList.remove('hidden');
    await loadWorkspaces();
    document.getElementById('createJobPrompt')?.focus();
  }
  function closeCreateJobModal() {
    const modal = document.getElementById('createJobModal');
    if (modal) modal.classList.add('hidden');
  }

  async function handleCreateJobSubmit(e) {
    e.preventDefault();

    const taskCodeInput = document.getElementById('createTaskCode');
    const taskCode = taskCodeInput ? taskCodeInput.value.trim() : '';
    if (taskCodeInput && !taskCode) {
      showToast('Vui lòng nhập Mã Task!', 'warning');
      taskCodeInput.focus();
      return;
    }

    const prompt = document.getElementById('createJobPrompt')?.value.trim();
    if (!prompt) {
      showToast('Vui lòng nhập mô tả yêu cầu / prompt!', 'warning');
      document.getElementById('createJobPrompt')?.focus();
      return;
    }

    const workspaceSelect = document.getElementById('createTaskWorkspace');
    const selectedWsId = workspaceSelect ? workspaceSelect.value.trim() : '';
    const wsList = state.workspaces || [];
    const selectedWsObj = wsList.find(w => w.id === selectedWsId || w.path === selectedWsId);
    const repo_path = selectedWsObj ? selectedWsObj.path : (document.getElementById('createJobRepo')?.value.trim() || selectedWsId || './');
    const workspace_id = selectedWsObj ? selectedWsObj.id : selectedWsId;
    const base_branch = document.getElementById('createJobBranch')?.value.trim() || 'main';
    const timeout_minutes = parseInt(document.getElementById('createJobTimeout')?.value, 10) || 15;
    const max_fixing_retries = parseInt(document.getElementById('createJobMaxRetries')?.value, 10) || 3;

    const allowExisting = taskCodeInput?.dataset?.allowExisting === 'true';
    if (taskCodeInput) delete taskCodeInput.dataset.allowExisting;

    // Payload theo đặc tả mới: task_code, workspace_id, prompt (runner do backend tự điều phối theo settings)
    const payload = {
      task_code: taskCode,
      workspace_id: workspace_id,
      prompt,
      title: taskCode ? `[${taskCode}] ${prompt.substring(0, 50)}` : prompt.substring(0, 60),
      repo_path,
      base_branch,
      timeout_seconds: timeout_minutes * 60,
      max_fixing_retries,
      allow_existing: allowExisting
    };
    const errAlert = document.getElementById('createJobErrorAlert');
    if (errAlert) {
      errAlert.classList.add('hidden');
      errAlert.innerHTML = '';
    }

    const submitBtn = document.getElementById('btnSubmitCreateJob');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Đang tạo...';
    }

    try {
      let res = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok && res.status === 404) {
        res = await fetch('/api/v1/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData.error || errData.message || 'Không thể tạo task mới';
        const suggestedCode = errData.suggested_task_code;

        if (errAlert) {
          if (suggestedCode) {
            errAlert.innerHTML = `
              <div class="flex items-start gap-2.5">
                <i class="fa-solid fa-triangle-exclamation text-amber-400 text-sm mt-0.5"></i>
                <div class="flex-1">
                  <strong class="text-amber-300">Thư mục Task đã tồn tại trên workspace:</strong>
                  <div class="mt-1 text-slate-200 text-xs">${escapeHtml(errMsg)}</div>
                  <div class="mt-2.5 pt-2 border-t border-slate-700/60 flex items-center justify-between flex-wrap gap-2">
                    <span class="text-[11px] text-slate-300">Gợi ý mã: <strong class="text-brand-400 font-mono text-xs">${escapeHtml(suggestedCode)}</strong></span>
                    <div class="flex items-center gap-2">
                      <button type="button" id="btnForceUseExistingDir" class="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium transition flex items-center gap-1.5 shadow" title="Dùng lại thư mục hiện tại và ghi đè expect.md">
                        <i class="fa-solid fa-folder-open text-sky-400"></i>
                        <span>Dùng tiếp thư mục này</span>
                      </button>
                      <button type="button" id="btnUseSuggestedTaskCode" class="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold transition flex items-center gap-1.5 shadow">
                        <i class="fa-solid fa-wand-magic-sparkles text-amber-300"></i>
                        <span>Tạo với mã: ${escapeHtml(suggestedCode)}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            `;
            // Nút 1: Sử dụng tiếp thư mục hiện tại
            document.getElementById('btnForceUseExistingDir')?.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const codeInp = document.getElementById('createTaskCode');
              if (codeInp) {
                codeInp.dataset.allowExisting = 'true';
              }
              errAlert.classList.add('hidden');
              document.getElementById('createJobForm')?.requestSubmit();
            });

            // Nút 2: Đổi sang mã gợi ý có hậu tố và submit
            document.getElementById('btnUseSuggestedTaskCode')?.addEventListener('click', (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const codeInp = document.getElementById('createTaskCode');
              if (codeInp) {
                codeInp.value = suggestedCode;
                codeInp.dispatchEvent(new Event('input'));
              }
              errAlert.classList.add('hidden');
              setTimeout(() => {
                document.getElementById('createJobForm')?.requestSubmit();
              }, 50);
            });
            return; // Đã hiển thị hộp thoại tương tác trong modal, không throw ra toast ngoài
          } else {
            errAlert.innerHTML = `<div class="flex items-start gap-2"><i class="fa-solid fa-triangle-exclamation text-rose-400 mt-0.5"></i><div><strong>Lỗi tạo thư mục / Task:</strong><div class="mt-1 text-slate-200">${escapeHtml(errMsg)}</div></div></div>`;
          }
        }
        throw new Error(errMsg);
      }
      const data = await res.json();
      const newJobId = data.job?.id || data.task?.id || data.id;

      showToast('Đã khởi tạo task thành công!', 'success');
      closeCreateJobModal();
      document.getElementById('createJobForm')?.reset();
      if (errAlert) errAlert.classList.add('hidden');

      await fetchJobsList();
      if (newJobId) {
        selectJob(newJobId);
      }
    } catch (err) {
      showToast(err.message, 'error', 7000);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-rocket mr-1"></i> Khởi chạy Job';
      }
    }
  }

  // --- Kích hoạt Task (Chạy Pipeline) ---
  async function handleStartTask() {
    if (!state.activeJobId) {
      alert('Vui lòng chọn một Task để kích hoạt');
      return;
    }
    const btn = document.getElementById('btnStartTask');
    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> <span>Đang khởi động...</span>';
      }
      clearTerminalScreen({ ignoreHistory: true, marker: Date.now() - 500 });
      const res = await fetch(`/api/v1/tasks/${state.activeJobId}/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Lỗi khi kích hoạt task');
      }
      showToast(data.message || 'Đã kích hoạt task thành công!', data.queued ? 'info' : 'success');
      await fetchJobDetails(state.activeJobId, false);
      await fetchJobsList();
      fetchSystemStatus();
    } catch (err) {
      showToast('Lỗi kích hoạt task: ' + err.message, 'error');
    } finally {
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-play mr-1"></i> <span>Chạy Pipeline</span>';
      }
      renderActiveJobDetail();
    }
  }

  // --- Active Job Control Actions (Cancel & Rerun) ---
  async function handleCancelActiveJob() {
    if (!state.activeJobId) return;
    // B17: chống double-submit
    const btn = document.getElementById('btnCancelTask') || document.getElementById('btnCancelJob');
    if (btn && btn.disabled) return;
    if (!confirm('Bạn có chắc chắn muốn hủy Job #' + state.activeJobId + '?')) return;
    if (btn) btn.disabled = true;

    try {
      const res = await fetch(`/api/v1/jobs/${state.activeJobId}/cancel`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Hủy Job thất bại');
      await fetchJobDetails(state.activeJobId);
      fetchJobsList();
      fetchSystemStatus();
    } catch (err) {
      showToast('Lỗi hủy Job: ' + (err.message || 'không xác định'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  async function handlePauseTask() {
    if (!state.activeJobId) return;
    const btn = document.getElementById('btnPauseTask');
    if (btn && btn.disabled) return;
    const oldHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> <span>Đang dừng...</span>';
    }
    try {
      const res = await fetch(`/api/v1/jobs/${state.activeJobId}/pause`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Tạm dừng task thất bại');
      }
      showToast(data.message || 'Đã tạm dừng task thành công!', 'info');
      await fetchJobDetails(state.activeJobId, false);
      await fetchJobsListSilently();
      fetchSystemStatus();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      // B4: luôn khôi phục nút (kể cả thành công) để không kẹt chữ "Đang dừng..."
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    }
  }

  async function handleResumeTask() {
    if (!state.activeJobId) return;
    const btn = document.getElementById('btnResumeTask');
    if (btn && btn.disabled) return;
    const oldHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> <span>Đang tiếp tục...</span>';
    }
    try {
      const res = await fetch(`/api/v1/jobs/${state.activeJobId}/resume`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Tiếp tục task thất bại');
      }
      showToast(data.message || 'Đã tiếp tục chạy task!', 'success');
      await fetchJobDetails(state.activeJobId, false);
      await fetchJobsListSilently();
      fetchSystemStatus();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      // B4: luôn khôi phục nút (kể cả thành công) để không kẹt chữ "Đang tiếp tục..."
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    }
  }

  // B3: chạy lại job qua route mới POST /api/v1/jobs/:id/rerun với body { mode }
  async function handleRerunActiveJob() {
    const jobId = state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!jobId) return;
    const btn = document.getElementById('btnRerunJob');
    // B17: chống double-submit
    if (btn && btn.disabled) return;

    // Mặc định resume (tiếp tục từ bước lỗi); Cancel = chạy lại từ đầu
    const mode = confirm('Tiếp tục từ bước lỗi? OK = tiếp tục, Cancel = chạy lại từ đầu') ? 'resume' : 'restart';

    state.rerunInFlight = true;
    updateRerunButton(state.activeJob);
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Chạy lại thất bại', 'error');
        return;
      }
      showToast(
        data.message || (mode === 'resume' ? 'Đã yêu cầu tiếp tục chạy lại Task.' : 'Đã yêu cầu chạy lại Task từ đầu.'),
        'success'
      );
      state.lastDetailFetchAt[jobId] = 0;
      fetchJobsListSilently();
      fetchJobDetails(jobId);
    } catch (err) {
      showToast('Chạy lại thất bại: ' + (err.message || 'lỗi kết nối'), 'error');
    } finally {
      state.rerunInFlight = false;
      if (btn) btn.disabled = false;
      updateRerunButton(state.activeJob);
    }
  }

  // --- Interactive Question Modal (Human-in-the-Loop Clarification) ---
  function openQuestionModal() {
    const modal = document.getElementById('questionModal');
    if (!modal) return;

    const listContainer = document.getElementById('questionListContainer');
    if (!listContainer) return;

    let questions = [];
    
    // Parse currentQuestion to an array of questions
    if (state.currentQuestion) {
      if (Array.isArray(state.currentQuestion)) {
        questions = state.currentQuestion;
      } else if (Array.isArray(state.currentQuestion.questions)) {
        questions = state.currentQuestion.questions;
      } else if (Array.isArray(state.currentQuestion.parsedQuestions)) {
        questions = state.currentQuestion.parsedQuestions;
      } else if (typeof state.currentQuestion.question === 'string' && state.currentQuestion.question.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(state.currentQuestion.question);
          if (Array.isArray(parsed)) questions = parsed;
          else questions = [state.currentQuestion];
        } catch (e) {
          questions = [state.currentQuestion];
        }
      } else {
        questions = [state.currentQuestion];
      }
    } else {
      questions = [{
        id: 'q1',
        title: 'Làm rõ yêu cầu kiến trúc',
        question: 'Agent cần bạn xác nhận hướng xử lý tiếp theo trước khi hoàn thiện Kế hoạch.',
        context: 'Tại bước PLANNING, agent phát hiện một số lựa chọn kỹ thuật cần quyết định.',
        options: ['Phương án 1: Triển khai theo REST API chuẩn', 'Phương án 2: Sử dụng WebSocket kết hợp', 'Phương án 3: Giữ nguyên cấu trúc hiện tại']
      }];
    }

    if (questions.length === 0) {
      listContainer.innerHTML = '<p class="text-slate-400 text-sm text-center py-4">Không có câu hỏi nào.</p>';
    } else {
      listContainer.innerHTML = questions.map((q, idx) => {
        const qId = q.id || ('q_' + (idx + 1));
        const opts = Array.isArray(q.options) ? q.options : [];
        let optsHtml = '';
        
        if (opts.length > 0) {
          optsHtml = '<div class="space-y-1.5 mt-2">' + opts.map((opt, i) => {
            const optText = typeof opt === 'string' ? opt : (opt.label || opt.text || JSON.stringify(opt));
            return `
              <label class="flex items-start gap-2.5 p-2 rounded-lg bg-surface-800 hover:bg-surface-750 border border-slate-700/80 cursor-pointer text-xs text-slate-200 transition">
                <input type="radio" name="questionOption_${qId}" value="${escapeHtml(optText)}" class="mt-0.5 text-amber-500 focus:ring-amber-500" ${i === 0 ? 'checked' : ''}>
                <span>${escapeHtml(optText)}</span>
              </label>
            `;
          }).join('') + '</div>';
        }

        return `
          <div class="p-3.5 rounded-xl bg-surface-850 border border-slate-800 space-y-2.5 question-item" data-question-id="${escapeHtml(qId)}">
            <div>
              <div class="flex items-center gap-2">
                <span class="px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">#${idx + 1}</span>
                <h4 class="text-sm font-semibold text-slate-100">${escapeHtml(q.question || q.title || 'Câu hỏi từ Agent')}</h4>
              </div>
              ${q.context ? `<p class="text-xs text-slate-400 mt-1 pl-6">${escapeHtml(q.context)}</p>` : ''}
            </div>
            ${optsHtml}
            <div class="mt-2">
              <input type="text" class="question-custom-text w-full px-3 py-1.5 rounded-lg bg-surface-900 border border-slate-700/80 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500 transition" placeholder="Hoặc nhập câu trả lời / ghi chú bổ sung..." />
            </div>
          </div>
        `;
      }).join('');
    }

    modal.classList.remove('hidden');
  }

  function closeQuestionModal() {
    const modal = document.getElementById('questionModal');
    if (modal) modal.classList.add('hidden');
  }

  async function handleSubmitQuestionAnswer() {
    if (!state.activeJobId) return;
    // B1: gửi câu trả lời tới đúng job đã phát sinh câu hỏi
    const questionJobId = (state.currentQuestion && state.currentQuestion.jobId) || state.activeJobId;

    const listContainer = document.getElementById('questionListContainer');
    if (!listContainer) return;

    const answers = {};
    const items = listContainer.querySelectorAll('.question-item');
    items.forEach(item => {
      const qId = item.dataset.questionId;
      const selectedOption = item.querySelector(`input[name="questionOption_${qId}"]:checked`)?.value || '';
      const customText = item.querySelector('.question-custom-text')?.value.trim() || '';

      const combined = customText ? (selectedOption ? `${selectedOption} - Ghi chú: ${customText}` : customText) : selectedOption;
      if (combined) {
        answers[qId] = combined;
      }
    });

    if (Object.keys(answers).length === 0) {
      alert('Vui lòng chọn một phương án hoặc nhập câu trả lời cho ít nhất một câu hỏi!');
      return;
    }

    const submitBtn = document.getElementById('btnAnswerQuestion') || document.getElementById('btnSubmitAnswer');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Đang gửi...';
    }

    try {
      const res = await fetch(`/api/v1/jobs/${questionJobId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers,
          answer: JSON.stringify(answers), // fallback format
          question_id: state.currentQuestion?.id || null
        })
      });

      if (!res.ok) throw new Error('Gửi câu trả lời thất bại: ' + res.statusText);

      closeQuestionModal();
      state.currentQuestion = null;

      // Reload job details to show PLANNING status resumption
      await fetchJobDetails(state.activeJobId, false);
      fetchJobsList();
    } catch (err) {
      alert('Lỗi: ' + err.message);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane mr-1"></i> Gửi Trả Lời & Tiếp Tục Chạy';
      }
    }
  }

  // --- Raw JSON Modal ---
  function openRawJsonModal() {
    const modal = document.getElementById('rawJsonModal');
    const content = document.getElementById('rawJsonContent');
    if (content && state.activeJob) {
      content.textContent = JSON.stringify(
        {
          job: state.activeJob,
          dual_plan: state.dualPlan,
          evidence_count: state.evidences.length,
          evidences: state.evidences
        },
        null,
        2
      );
    }
    if (modal) modal.classList.remove('hidden');
  }

  function closeRawJsonModal() {
    const modal = document.getElementById('rawJsonModal');
    if (modal) modal.classList.add('hidden');
  }

  function copyRawJsonContent() {
    const content = document.getElementById('rawJsonContent')?.textContent;
    if (content) {
      navigator.clipboard.writeText(content).then(() => {
        alert('Đã sao chép Raw JSON vào clipboard!');
      });
    }
  }

  // --- Lightbox & Evidence Detail Modal Inspector ---
  function openLightboxModal(src, caption) {
    // Prefer opening Evidence Detail Modal if found in UI cache
    if (state._evidenceCache && state._evidenceCache.ui) {
      const idx = state._evidenceCache.ui.findIndex((e) => (e.url === src || e.file_path === src));
      if (idx !== -1) {
        showEvidenceDetailModal('ui', idx);
        return;
      }
    }
    // Fallback to legacy lightbox modal
    const modal = document.getElementById('lightboxModal');
    const img = document.getElementById('lightboxImage');
    const cap = document.getElementById('lightboxCaption');
    if (img) img.src = src;
    if (cap) cap.textContent = caption;
    if (modal) modal.classList.remove('hidden');
  }

  function closeLightboxModal() {
    const modal = document.getElementById('lightboxModal');
    if (modal) modal.classList.add('hidden');
  }

  function showEvidenceDetailModal(type, index) {
    const cache = state._evidenceCache || {};
    let item = cache[type] ? cache[type][index] : null;

    // Fallback if item is passed as object or found directly
    if (!item && typeof type === 'object') {
      item = type;
      type = (item.type || item.evidence_type || 'ui').toLowerCase();
    }
    if (!item) return;
    // Luu index hien tai de phim <- / -> chuyen anh dung thu tu.
    state._evidenceModalIndex = (typeof index === 'number' && index >= 0) ? index : 0;

    const modal = document.getElementById('evidenceDetailModal');
    const typeIcon = document.getElementById('evidenceModalTypeIcon');
    const typeBadge = document.getElementById('evidenceModalTypeBadge');
    const statusBadge = document.getElementById('evidenceModalStatusBadge');
    const titleElem = document.getElementById('evidenceModalTitle');
    const bodyElem = document.getElementById('evidenceModalBody');
    const metaInfo = document.getElementById('evidenceModalMetaInfo');
    const btnOpenFile = document.getElementById('btnOpenEvidenceFile');
    const copyBtnText = document.getElementById('btnCopyEvidenceDetailText');

    if (!modal || !bodyElem) return;

    if (btnOpenFile) btnOpenFile.classList.add('hidden');
    if (copyBtnText) copyBtnText.textContent = 'Sao chép dữ liệu';

    // 1. UI Screenshot Channel
    if (type === 'ui' || type === 'ui_screenshot') {
      const imgSrc = item.url || item.file_path || '';
      const dupReason = item.duplicateReason || item.reason || item.error || item.note || '';
      const isDuplicate = item.duplicate === true || /duplicate|md5|trùng/i.test(String(dupReason || ''));
      const status = evidenceStatus(item);
      const badge = evidenceStatusBadge(status);
      let isPass = status === EVIDENCE_STATUS.PASS;
      if (isDuplicate) isPass = false;
      const nameText = item.name || item.title || item.stepName || item.filename || 'Ảnh chụp màn hình kiểm thử UI';
      const caption = item.description || nameText;
      const filename = item.filename || (item.file_path ? item.file_path.split('/').pop() : 'screenshot.png');
      const passCriteria = item.passCriteria || item.pass_criteria || item.criteria || item.expected || null;
      const stepLabel = (item.order !== null && item.order !== undefined)
        ? `Bước ${item.order}`
        : (item.stepIndex !== null && item.stepIndex !== undefined ? `Bước ${item.stepIndex}` : (item.stepName || '—'));
      const testCaseText = item.testCase || item.caseName || item.case || null;
      const uiList = (state._evidenceCache && state._evidenceCache.ui) ? state._evidenceCache.ui : [];
      const uiIndex = uiList.findIndex((e) => String(e.filename || '') === String(item.filename || ''));
      const uiTotal = uiList.length;

      if (typeIcon) typeIcon.innerHTML = '<i class="fa-regular fa-image text-sky-400"></i>';
      if (typeBadge) typeBadge.textContent = 'UI Screenshot';
      if (statusBadge) {
        statusBadge.textContent = badge.text;
        statusBadge.className = `text-[10px] font-bold px-2 py-0.5 rounded shadow ${badge.cls}`;
      }
      if (titleElem) titleElem.textContent = nameText;
      if (metaInfo) metaInfo.textContent = `Tệp: ${filename} | Trạng thái: ${badge.text}`;

      if (btnOpenFile && imgSrc) {
        btnOpenFile.classList.remove('hidden');
        btnOpenFile.href = imgSrc;
      }
      if (copyBtnText) copyBtnText.textContent = 'Sao chép liên kết ảnh';
      state.currentEvidenceModalData = imgSrc;

      bodyElem.innerHTML = `
        <div class="flex flex-col space-y-4">
          <div class="bg-black/90 rounded-xl p-2 sm:p-3 border border-slate-800 flex items-center justify-center max-h-[58vh] overflow-hidden group relative shadow-inner">
            <img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(nameText)}" class="max-w-full max-h-[54vh] object-contain rounded-lg shadow-2xl transition duration-200" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden');" />
            <div class="hidden text-center py-16 text-slate-500 text-xs">
              <i class="fa-regular fa-image text-4xl mb-2 text-slate-600 block"></i>
              <span>Không thể tải trước hình ảnh (${escapeHtml(filename)})</span>
            </div>
            ${uiTotal > 1 ? `
              <button onclick="event.stopPropagation(); window.aiWorker.showEvidenceDetailModal('ui', ${uiIndex - 1})" class="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-slate-900/85 hover:bg-brand-500 text-white flex items-center justify-center backdrop-blur-sm transition shadow" title="Ảnh trước (←)">
                <i class="fa-solid fa-chevron-left text-xs"></i>
              </button>
              <button onclick="event.stopPropagation(); window.aiWorker.showEvidenceDetailModal('ui', ${uiIndex + 1})" class="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-slate-900/85 hover:bg-brand-500 text-white flex items-center justify-center backdrop-blur-sm transition shadow" title="Ảnh tiếp theo (→)">
                <i class="fa-solid fa-chevron-right text-xs"></i>
              </button>
              <div class="absolute bottom-2 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-slate-900/85 text-slate-200 text-[10px] font-mono backdrop-blur-sm">
                ${uiIndex + 1} / ${uiTotal}
              </div>
            ` : ''}
          </div>

          <div class="p-3 rounded-lg bg-surface-900 border border-slate-800/80 text-xs">
            <span class="text-[10px] text-slate-500 uppercase tracking-wider block mb-1 font-semibold">Tên evidence</span>
            <p class="text-slate-200 font-semibold">${escapeHtml(nameText)}</p>
            ${caption && caption !== nameText ? `
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block mt-2 mb-1 font-semibold">Mô tả evidence này là gì</span>
              <p class="text-slate-300">${escapeHtml(caption)}</p>
            ` : ''}
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Bước kiểm thử</span>
              <span class="text-slate-200 font-semibold truncate block mt-0.5" title="${escapeHtml(String(stepLabel))}">${escapeHtml(String(stepLabel))}</span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Test case</span>
              <span class="text-slate-200 font-semibold truncate block mt-0.5" title="${escapeHtml(String(testCaseText || '—'))}">${escapeHtml(String(testCaseText || '—'))}</span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Trạng thái</span>
              <span class="font-semibold block mt-0.5 ${status === EVIDENCE_STATUS.PASS ? 'text-emerald-400' : (status === EVIDENCE_STATUS.FAILED ? 'text-rose-400' : 'text-slate-300')}">${badge.text}</span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Tên tệp</span>
              <span class="font-mono text-slate-200 font-semibold truncate block mt-0.5" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
            </div>
          </div>

          <div class="p-3 rounded-lg border text-xs ${status === EVIDENCE_STATUS.PASS ? 'bg-emerald-500/10 border-emerald-500/30' : (status === EVIDENCE_STATUS.FAILED ? 'bg-rose-500/10 border-rose-500/30' : 'bg-slate-500/10 border-slate-500/30')}">
            <span class="text-[10px] text-slate-400 uppercase tracking-wider block mb-1 font-semibold">Ảnh này được coi là PASS khi nào</span>
            <p class="text-slate-300">${passCriteria ? escapeHtml(passCriteria) : 'Chưa khai báo tiêu chí PASS. Ảnh chỉ đạt khi verify xác nhận nội dung khớp yêu cầu của test case tương ứng.'}</p>
          </div>

          ${isDuplicate ? `
            <div class="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 font-mono text-xs">
              <div class="font-bold flex items-center gap-1.5 mb-1"><i class="fa-solid fa-triangle-exclamation"></i> Ảnh trùng lặp (DUPLICATE):</div>
              <div>${escapeHtml(String(dupReason || 'Ảnh trùng (duplicate/md5) — không tính là bằng chứng PASS.'))}</div>
            </div>
          ` : ''}
        </div>
      `;
    }

    // 2. API Test Channel
    else if (type === 'api' || type === 'api_test') {
      const method = ((item.method || (item.request && item.request.method)) || 'GET').toUpperCase();
      const endpoint = item.endpoint || item.path || (item.request && item.request.path) || '/';
      // `item.status` la trang thai evidence 3 gia tri, KHONG phai HTTP status code.
      const statusCode = item.statusCode || item.status_code || item.actualStatus || (item.response && item.response.status) || 200;
      const expectedStatus = item.expectedStatus || item.expected_status || 200;
      const latency = item.duration_ms || item.durationMs || item.latency_ms || item.latency || 12;
      const hasExplicitStatus = (item.status !== undefined && item.status !== null && item.status !== '') || (item.verdict !== undefined && item.verdict !== null && item.verdict !== '');
      const apiStatus = hasExplicitStatus ? evidenceStatus(item) : ((item.verdict === 'PASS' || item.status === 'PASSED' || item.passed === true || (statusCode >= 200 && statusCode < 400 && !item.error)) ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAILED);
      const apiBadge = evidenceStatusBadge(apiStatus);
      const isPass = apiStatus === EVIDENCE_STATUS.PASS;

      if (typeIcon) typeIcon.innerHTML = '<i class="fa-solid fa-network-wired text-indigo-400"></i>';
      if (typeBadge) typeBadge.textContent = 'API Test';
      if (statusBadge) {
        statusBadge.textContent = apiBadge.text;
        statusBadge.className = `text-[10px] font-bold px-2 py-0.5 rounded shadow ${apiBadge.cls}`;
      }
      if (titleElem) titleElem.textContent = `${method} ${endpoint}`;
      if (metaInfo) metaInfo.textContent = `Status: ${statusCode} | Độ trễ: ${latency}ms | Kết quả: ${apiBadge.text}`;
      if (copyBtnText) copyBtnText.textContent = 'Sao chép JSON';

      // Không tự bịa dummy data nếu file chưa có dữ liệu thật
      const requestPayload = item.request || item.req || (item.parsedData && item.parsedData.request) || null;
      const responsePayload = item.response || item.res || (item.parsedData && item.parsedData.response) || (item.content ? item.content : null);

      // Nếu chưa có content chi tiết, thử fetch trực tiếp từ server
      if (!requestPayload && !responsePayload && (item.url || item.file_path)) {
        fetch(item.url || item.file_path)
          .then(res => res.json())
          .then(data => {
            item.request = data.request || { method, endpoint, headers: data.headers, body: data.body };
            item.response = data.response || { status: statusCode, body: data.responseBody || data };
            showEvidenceDetailModal('api', index);
          })
          .catch(() => {});
      }
      state.currentEvidenceModalData = {
        testCase: item.name || `${method} ${endpoint}`,
        verdict: apiStatus === EVIDENCE_STATUS.NOT_VERIFY ? null : (isPass ? 'PASS' : 'FAIL'),
        request: requestPayload,
        response: responsePayload,
        error: item.error || null
      };

      const requestJsonStr = JSON.stringify(requestPayload, null, 2);
      const responseJsonStr = JSON.stringify(responsePayload, null, 2);

      bodyElem.innerHTML = `
        <div class="space-y-4 text-xs">
          <!-- Overview Bar -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">HTTP Method</span>
              <span class="font-mono font-bold text-slate-200 mt-0.5 block">${escapeHtml(method)}</span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Status Code</span>
              <span class="font-mono font-bold mt-0.5 block ${statusCode < 400 ? 'text-emerald-400' : 'text-rose-400'}">${statusCode} <span class="text-slate-500 text-[10px] font-normal">(Kỳ vọng: ${expectedStatus})</span></span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Độ trễ (Latency)</span>
              <span class="font-mono text-slate-200 mt-0.5 block">${latency} ms</span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Kết quả đối soát</span>
              <span class="font-bold mt-0.5 block ${apiStatus === EVIDENCE_STATUS.PASS ? 'text-emerald-400' : (apiStatus === EVIDENCE_STATUS.FAILED ? 'text-rose-400' : 'text-slate-300')}">${apiStatus === EVIDENCE_STATUS.PASS ? `PASSED (${statusCode} PASS)` : (apiStatus === EVIDENCE_STATUS.NOT_VERIFY ? 'NOT VERIFY (chưa verify)' : 'FAILED')}</span>
            </div>
          </div>

          ${item.error ? `
            <div class="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 font-mono text-xs">
              <div class="font-bold flex items-center gap-1.5 mb-1"><i class="fa-solid fa-triangle-exclamation"></i> Lỗi kiểm thử API:</div>
              <div>${escapeHtml(item.error)}</div>
            </div>
          ` : ''}

          <!-- Request Details -->
          <div class="space-y-1.5">
            <span class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <i class="fa-solid fa-arrow-up-right-from-square text-sky-400 text-[10px]"></i>
              <span>HTTP Request (Payload & Headers)</span>
            </span>
            <pre class="evidence-detail-code p-3 custom-scrollbar max-h-48 overflow-y-auto text-sky-300">${escapeHtml(requestJsonStr)}</pre>
          </div>

          <!-- Response Details -->
          <div class="space-y-1.5">
            <span class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <i class="fa-solid fa-arrow-down-left-and-up-right-to-center text-emerald-400 text-[10px]"></i>
              <span>HTTP Response (Body & Headers)</span>
            </span>
            <pre class="evidence-detail-code p-3 custom-scrollbar max-h-64 overflow-y-auto text-emerald-300">${escapeHtml(responseJsonStr)}</pre>
          </div>
        </div>
      `;
    }

    // 3. Service Logs Channel
    else if (type === 'logs' || type === 'service_log' || type === 'log_trace') {
      const serviceName = item.service_name || item.service || 'Service App';
      const level = ((item.level || (item.error || item.stack_trace ? 'ERROR' : (item.warn ? 'WARN' : 'INFO')))).toUpperCase();
      let fullLogText = item.content || item.rawLogs || item.logs || item.scrubbedLogs || item.stack_trace || item.message || item.log_excerpt || '';

      // File binary (.xlsx/.pdf/...): server khong gui noi dung de tranh rac
      // mojibake. Khong fetch thanh text - nguoi dung tai file qua link.
      const isDownloadable = item.downloadable === true;

      // Neu chua co noi dung nhung co file_path/url, fetch ngay tu server
      if (!fullLogText && !isDownloadable && (item.url || item.file_path)) {
        fetch(item.url || item.file_path)
          .then(res => res.text())
          .then(text => {
            if (text && text.trim()) {
              item.content = text;
              item.rawLogs = text;
              showEvidenceDetailModal('logs', index);
            }
          })
          .catch(() => {});
      }


      // File binary: hien nut tai file (client bo qua `content`).
      if (isDownloadable && btnOpenFile) {
        const fileHref = item.url || item.file_path || '';
        if (fileHref) {
          btnOpenFile.classList.remove('hidden');
          btnOpenFile.href = fileHref;
          btnOpenFile.setAttribute('download', item.filename || '');
        }
      }

      if (!fullLogText) {
        fullLogText = isDownloadable
          ? 'Đây là file nhị phân — nội dung không hiển thị được dưới dạng văn bản. Dùng nút tải file bên dưới.'
          : 'Đang tải nội dung file log từ server...';
      }

      const isError = level === 'ERROR' || level === 'FATAL';
      const isWarn = level === 'WARN' || level === 'WARNING';
      const timestamp = item.timestamp || item.time || item.created_at || '';
      const lineCount = (fullLogText.match(/\n/g) || []).length + 1;

      if (typeIcon) typeIcon.innerHTML = '<i class="fa-regular fa-file-lines text-amber-400"></i>';
      if (typeBadge) typeBadge.textContent = 'Log Trace';
      if (statusBadge) {
        statusBadge.textContent = level;
        statusBadge.className = isError
          ? 'text-[10px] font-bold px-2 py-0.5 rounded shadow bg-rose-500 text-white'
          : isWarn
          ? 'text-[10px] font-bold px-2 py-0.5 rounded shadow bg-amber-500 text-slate-950'
          : 'text-[10px] font-bold px-2 py-0.5 rounded shadow bg-sky-500 text-slate-950';
      }
      if (titleElem) titleElem.textContent = `Log Trace - ${serviceName}`;
      if (metaInfo) metaInfo.textContent = `Service: ${serviceName} | Mức: ${level} | Tổng: ${lineCount} dòng log`;
      if (copyBtnText) copyBtnText.textContent = 'Sao chép toàn bộ Log';
      state.currentEvidenceModalData = fullLogText;

      bodyElem.innerHTML = `
        <div class="space-y-3 text-xs">
          <!-- Meta row -->
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Service Name</span>
              <span class="font-semibold text-slate-200 mt-0.5 block">${escapeHtml(serviceName)}</span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Mức độ Log</span>
              <span class="font-bold mt-0.5 block ${isError ? 'text-rose-400' : isWarn ? 'text-amber-400' : 'text-sky-400'}">${level}</span>
            </div>
            <div class="p-2.5 rounded-lg bg-surface-900 border border-slate-800/80 col-span-2 sm:col-span-1">
              <span class="text-[10px] text-slate-500 uppercase tracking-wider block font-medium">Thời gian ghi nhận</span>
              <span class="font-mono text-slate-300 mt-0.5 block">${escapeHtml(timestamp || 'Realtime')}</span>
            </div>
          </div>

          <!-- Terminal Container -->
          <div class="rounded-xl border border-slate-800 bg-[#090d16] overflow-hidden shadow-2xl">
            <div class="bg-surface-850 px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
              <div class="flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-full bg-rose-500/80"></span>
                <span class="w-2.5 h-2.5 rounded-full bg-amber-500/80"></span>
                <span class="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></span>
                <span class="ml-2 font-mono text-[11px] text-slate-300">Terminal Log Viewer</span>
              </div>
              <span class="text-[10px] font-mono text-slate-500">${lineCount} dòng</span>
            </div>
            <pre class="p-4 font-mono text-xs text-slate-200 max-h-[50vh] overflow-y-auto overflow-x-auto custom-scrollbar whitespace-pre-wrap select-text leading-relaxed bg-black/40">${escapeHtml(fullLogText)}</pre>
          </div>
        </div>
      `;
    }

    // 4. Database Assert Channel
    else if (type === 'db' || type === 'db_query' || type === 'db_assert') {
      const tableName = item.table || item.tableName || item.target || 'Database Table';
      const query = item.query || item.sql || 'SELECT * FROM ...';
      const hasExplicitStatus = (item.status !== undefined && item.status !== null && item.status !== '') || (item.verdict !== undefined && item.verdict !== null && item.verdict !== '');
      const dbStatus = hasExplicitStatus ? evidenceStatus(item) : (item.matched === true || item.passed === true || item.verdict === 'PASS' || (!item.error && item.status !== 'FAILED') ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.FAILED);
      const dbBadge = evidenceStatusBadge(dbStatus);
      const isMatch = dbStatus === EVIDENCE_STATUS.PASS;
      const diffReason = item.error || item.diffReason || item.diff || null;

      if (typeIcon) typeIcon.innerHTML = '<i class="fa-solid fa-database text-purple-400"></i>';
      if (typeBadge) typeBadge.textContent = 'Database Assertion';
      if (statusBadge) {
        statusBadge.textContent = dbStatus === EVIDENCE_STATUS.NOT_VERIFY ? dbBadge.text : (isMatch ? 'MATCH' : 'DIFF');
        statusBadge.className = `text-[10px] font-bold px-2 py-0.5 rounded shadow ${dbBadge.cls}`;
      }
      if (titleElem) titleElem.textContent = `DB Assertion - ${tableName}`;
      if (metaInfo) metaInfo.textContent = `Bảng: ${tableName} | Trạng thái: ${dbStatus === EVIDENCE_STATUS.NOT_VERIFY ? 'Chưa verify' : (isMatch ? 'Khớp (MATCH)' : 'Lệch (DIFF)')}`;
      if (copyBtnText) copyBtnText.textContent = 'Sao chép dữ liệu SQL';

      state.currentEvidenceModalData = {
        table: tableName,
        query,
        matched: isMatch,
        error: diffReason,
        expected: item.expected || item.expectedValues || null,
        actual: item.actual || item.rows || null
      };

      bodyElem.innerHTML = `
        <div class="space-y-4 text-xs">
          <!-- Query card -->
          <div class="space-y-1.5">
            <span class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <i class="fa-solid fa-terminal text-indigo-400 text-[10px]"></i>
              <span>SQL Query Assertion</span>
            </span>
            <div class="bg-[#090d16] p-3 rounded-lg border border-slate-800 font-mono text-xs text-indigo-300 select-text overflow-x-auto shadow-inner">
              ${escapeHtml(query)}
            </div>
          </div>

          <!-- Error or diff reason if any -->
          ${diffReason ? `
            <div class="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 font-mono text-xs">
              <div class="font-bold flex items-center gap-1.5 mb-1"><i class="fa-solid fa-triangle-exclamation"></i> Lệch đối soát dữ liệu (DIFF):</div>
              <div>${escapeHtml(diffReason)}</div>
            </div>
          ` : ''}

          <!-- Comparison Table: Expected vs Actual -->
          <div class="space-y-1.5">
            <span class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
              <i class="fa-solid fa-table-columns text-brand-400 text-[10px]"></i>
              <span>Bảng đối soát Expected vs Actual</span>
            </span>
            <div class="border border-slate-800 rounded-lg overflow-hidden bg-surface-900">
              <table class="evidence-detail-table">
                <thead>
                  <tr>
                    <th class="w-1/4">Thuộc tính / Cột</th>
                    <th class="w-1/3">Kỳ vọng (Expected)</th>
                    <th class="w-1/3">Thực tế (Actual)</th>
                    <th class="text-right">Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  ${renderComparisonRows(item)}
                </tbody>
              </table>
            </div>
          </div>

          ${renderActualRowsPreview(item)}
        </div>
      `;
    }

    modal.classList.remove('hidden');
  }

  function closeEvidenceDetailModal() {
    const modal = document.getElementById('evidenceDetailModal');
    if (modal) modal.classList.add('hidden');
  }

  function copyEvidenceDetailContent() {
    if (!state.currentEvidenceModalData) return;
    const content = typeof state.currentEvidenceModalData === 'string'
      ? state.currentEvidenceModalData
      : JSON.stringify(state.currentEvidenceModalData, null, 2);

    navigator.clipboard.writeText(content).then(() => {
      const copyBtnText = document.getElementById('btnCopyEvidenceDetailText');
      if (copyBtnText) {
        const orig = copyBtnText.textContent;
        copyBtnText.textContent = 'Đã sao chép!';
        setTimeout(() => { copyBtnText.textContent = orig; }, 2000);
      }
    }).catch((err) => {
      console.warn('Copy failed:', err);
    });
  }

  function renderComparisonRows(item) {
    if (item.expectedValues && typeof item.expectedValues === 'object') {
      const firstRow = item.firstRow || (item.rows && item.rows[0]) || (item.actual && typeof item.actual === 'object' ? item.actual : {});
      return Object.entries(item.expectedValues).map(([col, expVal]) => {
        const actVal = firstRow ? firstRow[col] : undefined;
        const matched = JSON.stringify(expVal) === JSON.stringify(actVal);
        return `
          <tr>
            <td class="font-mono text-slate-200">${escapeHtml(col)}</td>
            <td class="font-mono text-slate-300">${escapeHtml(JSON.stringify(expVal))}</td>
            <td class="font-mono ${matched ? 'text-emerald-400' : 'text-rose-400'}">${escapeHtml(JSON.stringify(actVal))}</td>
            <td class="text-right">
              <span class="evidence-badge ${matched ? 'evidence-match' : 'evidence-diff'} font-bold">${matched ? 'MATCH' : 'DIFF'}</span>
            </td>
          </tr>
        `;
      }).join('');
    }

    const expectedStr = item.expected !== undefined ? (typeof item.expected === 'object' ? JSON.stringify(item.expected) : String(item.expected)) : (item.expectedRowCount !== undefined ? `${item.expectedRowCount} rows` : 'Khớp tiêu chí');
    const actualStr = item.actual !== undefined ? (typeof item.actual === 'object' ? JSON.stringify(item.actual) : String(item.actual)) : (item.rowCount !== undefined ? `${item.rowCount} rows` : (item.rows ? `${item.rows.length} rows` : 'Khớp thực tế'));
    // `item.status` la trang thai evidence 3 gia tri: NOT VERIFY => chua co ket qua.
    const isMatch = evidenceStatus(item) === EVIDENCE_STATUS.PASS
      || (item.matched === true || item.passed === true || item.verdict === 'PASS');

    return `
      <tr>
        <td class="font-mono text-slate-200">Dữ liệu kết quả</td>
        <td class="font-mono text-slate-300">${escapeHtml(expectedStr)}</td>
        <td class="font-mono ${isMatch ? 'text-emerald-400' : 'text-rose-400'}">${escapeHtml(actualStr)}</td>
        <td class="text-right">
          <span class="evidence-badge ${isMatch ? 'evidence-match' : 'evidence-diff'} font-bold">${isMatch ? 'MATCH' : 'DIFF'}</span>
        </td>
      </tr>
    `;
  }

  function renderActualRowsPreview(item) {
    const rows = Array.isArray(item.rows) ? item.rows : (Array.isArray(item.actual) ? item.actual : null);
    if (!rows || rows.length === 0) return '';

    const cols = Object.keys(rows[0] || {});
    if (cols.length === 0) return '';

    return `
      <div class="space-y-1.5 pt-2">
        <span class="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
          <i class="fa-solid fa-list text-purple-400 text-[10px]"></i>
          <span>Bản ghi dữ liệu thực tế từ DB (${rows.length} bản ghi)</span>
        </span>
        <div class="border border-slate-800 rounded-lg overflow-x-auto bg-surface-900 max-h-48 custom-scrollbar">
          <table class="evidence-detail-table">
            <thead>
              <tr>
                ${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 10).map(r => `
                <tr>
                  ${cols.map(c => `<td class="text-slate-300">${escapeHtml(typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]))}</td>`).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // Nap lai danh sach evidence sau khi xoa. Chi lay evidence -> khong reconnect
  // SSE log stream (fetchJobDetails se mo connection moi, gay reconnect thua).
  async function refreshEvidences(jobId) {
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/evidence`);
      if (res.ok) {
        const data = await res.json();
        state.evidences = data.evidence || data.evidences || [];
        renderEvidenceHub();
        return;
      }
    } catch (e) {}
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}`);
      if (!res.ok) throw new Error(`Failed to load job details (HTTP ${res.status})`);
      const data = await res.json();
      state.evidences = (data.job && (data.job.evidence || data.job.evidences)) || data.evidence || data.evidences || [];
      renderEvidenceHub();
    } catch (err) {
      console.warn('refreshEvidences error:', err);
    }
  }
  // --- Evidence Toggle & Delete ---
  async function toggleEvidenceStatus(filename, currentStatus) {
    const jobId = state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!jobId || !filename) return;

    // Vong doi 3 gia tri: NOT VERIFY -> PASS -> FAILED -> NOT VERIFY.
    // currentStatus co the la chuoi ('PASS'/'FAILED'/'NOT VERIFY') hoac boolean (cu).
    const cur = (typeof currentStatus === 'string')
      ? evidenceStatus({ status: currentStatus })
      : (currentStatus ? EVIDENCE_STATUS.PASS : EVIDENCE_STATUS.NOT_VERIFY);
    const nextStatus = (cur === EVIDENCE_STATUS.NOT_VERIFY) ? EVIDENCE_STATUS.PASS
      : (cur === EVIDENCE_STATUS.PASS ? EVIDENCE_STATUS.FAILED : EVIDENCE_STATUS.NOT_VERIFY);
    const newVerdict = nextStatus === EVIDENCE_STATUS.PASS ? 'PASS' : (nextStatus === EVIDENCE_STATUS.FAILED ? 'FAIL' : null);
    const newStatus = nextStatus;
    
    // 1. Cập nhật local state tạm thời để UI phản hồi ngay, nhưng giữ snapshot để rollback (B9)
    const evidenceIdx = state.evidences.findIndex(e => e.filename === filename || (e.file_path && e.file_path.includes(filename)));
    const snapshot = evidenceIdx !== -1 ? { ...state.evidences[evidenceIdx] } : null;
    const metaKey = `evidence_meta_${jobId}_${filename}`;
    let prevMeta = null;
    try { prevMeta = localStorage.getItem(metaKey); } catch (e) {}
    if (evidenceIdx !== -1) {
      state.evidences[evidenceIdx].verdict = newVerdict;
      state.evidences[evidenceIdx].status = newStatus;
      try {
        localStorage.setItem(metaKey, JSON.stringify({ verdict: newVerdict, status: newStatus }));
      } catch(e){}
    }

    // Re-render quickly
    renderEvidenceHub();

    // 2. Background API call - B9: kiểm tra res.ok, lỗi thì rollback
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(filename)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: newVerdict, status: newStatus })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch(err) {
      console.warn('Failed to persist evidence status to backend', err);
      // B9: rollback về bản snapshot trước khi sửa
      if (evidenceIdx !== -1 && snapshot) {
        state.evidences[evidenceIdx] = snapshot;
        try {
          if (prevMeta === null) localStorage.removeItem(metaKey);
          else localStorage.setItem(metaKey, prevMeta);
        } catch (e) {}
      }
      renderEvidenceHub();
      showToast('Không thể lưu trạng thái evidence lên server, đã hoàn tác.', 'error');
    }
  }

  async function deleteEvidence(filename) {
    if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn bằng chứng '${filename}' khỏi Database và thư mục evidence không?`)) return;

    const jobId = state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!jobId || !filename) return;

    // B9: giữ snapshot, chỉ xoá khỏi state khi server trả ok
    const snapshot = state.evidences.slice();

    // 1. Call backend DELETE
    let deleted = false;
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        deleted = true;
        state.evidences = state.evidences.filter(e => !(e.filename === filename || e.fileName === filename || (e.file_path && e.file_path.includes(filename))));
        renderEvidenceHub();
        showToast(`Đã xóa vĩnh viễn bằng chứng ${filename}`, 'success');
      } else {
        // B9: rollback khi server từ chối
        state.evidences = snapshot;
        renderEvidenceHub();
        showToast(data.error || 'Lỗi khi xóa bằng chứng trên server', 'error');
      }
    } catch(err) {
      console.error('Delete evidence failed:', err);
      // B9: rollback khi mất kết nối
      state.evidences = snapshot;
      renderEvidenceHub();
      showToast('Không thể kết nối đến server để xóa bằng chứng.', 'error');
    }

    // 3. Nap lai danh sach evidence. Loi refresh KHONG duoc bao nham "that bai xoa".
    if (deleted) {
      try {
        await refreshEvidences(jobId);
      } catch (refreshErr) {
        console.warn('Refresh evidence sau khi xoa that bai:', refreshErr);
        showToast('Đã xóa bằng chứng, nhưng không tải lại được danh sách. Vui lòng F5.', 'warning');
      }
    }
  }

  async function deleteEvidenceItem(type, idx) {
    const item = state._evidenceCache && state._evidenceCache[type] ? state._evidenceCache[type][idx] : null;
    if (!item) return;

    const filename = item.fileName || item.filename || (item.file_path ? item.file_path.split(/[\\/]/).pop() : null) || item.name || item.id;
    if (!filename) return;

    if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn bằng chứng '${filename}' khỏi Database và thư mục evidence không?`)) {
      return;
    }

    const jobId = state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!jobId) return;

    // B9: giữ snapshot, chỉ xoá khỏi state khi server trả ok
    const snapshot = state.evidences.slice();

    // 1. Call backend DELETE
    let deleted = false;
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        deleted = true;
        state.evidences = state.evidences.filter(e => e !== item && !(e.fileName === filename || e.filename === filename || (e.file_path && e.file_path.includes(filename))));
        renderEvidenceHub();
        showToast(`Đã xóa vĩnh viễn bằng chứng ${filename}`, 'success');
      } else {
        // B9: rollback khi server từ chối
        state.evidences = snapshot;
        renderEvidenceHub();
        showToast(data.error || 'Lỗi khi xóa bằng chứng trên server', 'error');
      }
    } catch(err) {
      console.error('Delete evidence item failed:', err);
      // B9: rollback khi mất kết nối
      state.evidences = snapshot;
      renderEvidenceHub();
      showToast('Không thể kết nối đến server để xóa bằng chứng.', 'error');
    }

    // 3. Nap lai danh sach evidence. Loi refresh KHONG duoc bao nham "that bai xoa".
    if (deleted) {
      try {
        await refreshEvidences(jobId);
      } catch (refreshErr) {
        console.warn('Refresh evidence sau khi xoa that bai:', refreshErr);
        showToast('Đã xóa bằng chứng, nhưng không tải lại được danh sách. Vui lòng F5.', 'warning');
      }
    }
  }

  // =========================================================================
  // 7. TAB NAVIGATION & TOOLBAR HELPERS
  // =========================================================================
  function switchMainTab(tab) {
    state.activeTab = tab;

    // Update buttons
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });

    // Toggle Content Views
    const terminalPane = document.getElementById('terminalTabContent');
    const devPane = document.getElementById('devPlanTabContent');
    const testPane = document.getElementById('testPlanTabContent');
    const terminalToolbar = document.getElementById('terminalToolbar');

    if (terminalPane) terminalPane.classList.toggle('hidden', tab !== 'terminal');
    if (devPane) devPane.classList.toggle('hidden', tab !== 'dev-plan');
    if (testPane) testPane.classList.toggle('hidden', tab !== 'test-plan');
    if (terminalToolbar) terminalToolbar.classList.toggle('hidden', tab !== 'terminal');

    if (tab === 'terminal') {
      // C7: 1 lần debounce thay cho chuỗi setTimeout fitTerminal
      scheduleFitTerminal();
    }

    if ((tab === 'dev-plan' || tab === 'test-plan' || tab === 'devPlan' || tab === 'testPlan') && state.activeJobId) {
      loadPlanFiles(state.activeJobId);
    }
  }

  function switchEvidenceSubTab(subtab) {
    state.activeEvidenceSubTab = subtab;

    document.querySelectorAll('.evidence-tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-subtab') === subtab);
    });

    const panes = {
      ui: document.getElementById('subtabUiEvidence'),
      api: document.getElementById('subtabApiEvidence'),
      logs: document.getElementById('subtabLogsEvidence'),
      db: document.getElementById('subtabDbEvidence')
    };

    Object.keys(panes).forEach((key) => {
      if (panes[key]) {
        panes[key].classList.toggle('hidden', key !== subtab);
      }
    });

    // C3: pane vừa chuyển sang được dựng lazy tại đây
    renderEvidenceHub();
  }

  function toggleAutoScroll() {
    state.autoScroll = !state.autoScroll;
    const label = document.getElementById('autoScrollState');
    if (label) {
      label.textContent = state.autoScroll ? 'ON' : 'OFF';
      label.parentElement.className = state.autoScroll
        ? 'px-2 py-1 rounded text-[11px] bg-surface-800 text-emerald-400 border border-slate-700 hover:bg-surface-750 transition'
        : 'px-2 py-1 rounded text-[11px] bg-surface-800 text-slate-500 border border-slate-700 hover:bg-surface-750 transition';
    }
    if (state.autoScroll && state.term) {
      state.term.scrollToBottom();
    }
  }

  function copyTerminalLog() {
    if (!state.term) return;
    state.term.selectAll();
    const selection = state.term.getSelection();
    state.term.clearSelection();

    if (selection) {
      navigator.clipboard.writeText(selection).then(() => {
        alert('Đã sao chép log vào clipboard!');
      });
    } else {
      alert('Không có nội dung log để sao chép.');
    }
  }

  // =========================================================================
  // 8. FORMATTERS & UTILITIES
  // =========================================================================
  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00:00';
    const totalSecs = Math.floor(seconds);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }

  function pad(num) {
    return num.toString().padStart(2, '0');
  }

  function formatTimeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 60) return `${diff}s trước`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m trước`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h trước`;
    return `${Math.floor(diff / 86400)}d trước`;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined || str === '') return '';
    // Chuoi hoa ve String truoc: number/boolean/object deu phai hoat dong.
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Vong doi trang thai evidence: NOT VERIFY (chua verify) | PASS | FAILED.
  // Server da chuan hoa; ham nay la fallback cho du lieu cu.
  const EVIDENCE_STATUS = { NOT_VERIFY: 'NOT VERIFY', PASS: 'PASS', FAILED: 'FAILED' };

  function evidenceStatus(item) {
    if (!item) return EVIDENCE_STATUS.NOT_VERIFY;
    const raw = item.status !== undefined && item.status !== null && item.status !== ''
      ? item.status
      : item.verdict;
    if (raw === undefined || raw === null || raw === '') return EVIDENCE_STATUS.NOT_VERIFY;
    const v = String(raw).trim().toUpperCase();
    if (v === 'PASS' || v === 'PASSED' || v === 'OK' || v === 'SUCCESS') return EVIDENCE_STATUS.PASS;
    if (v === 'FAIL' || v === 'FAILED' || v === 'ERROR') return EVIDENCE_STATUS.FAILED;
    return EVIDENCE_STATUS.NOT_VERIFY;
  }

  function evidenceStatusBadge(status) {
    if (status === EVIDENCE_STATUS.PASS) {
      return { text: 'PASS', cls: 'bg-emerald-500 text-slate-950' };
    }
    if (status === EVIDENCE_STATUS.FAILED) {
      return { text: 'FAILED', cls: 'bg-rose-500 text-white' };
    }
    return { text: 'NOT VERIFY', cls: 'bg-slate-600 text-slate-100' };
  }

  function getEffectiveAgentForJob(job) {
    if (!job) return 'claude-code';
    const status = (job.status || '').toUpperCase();
    const mapping = state.agentMapping || {};
    if (status === 'PLANNING') return mapping.PLANNING || 'claude-code';
    if (status === 'IMPLEMENT') return mapping.IMPLEMENT || 'omp';
    if (status === 'TESTING') return mapping.TESTING || 'test-runner'; if (status === 'VERIFY') return mapping.VERIFY || 'verify-gate';
    if (status === 'FIXING') return mapping.FIXING || 'omp';
    if (status === 'DONE') {
      return job.runner || mapping.IMPLEMENT || mapping.PLANNING || 'claude-code';
    }
    return job.runner || mapping.PLANNING || 'claude-code';
  }
  function formatMarkdownContent(markdownText) {
    if (!markdownText) return '';
    if (window.marked && typeof window.marked.parse === 'function') {
      try {
        return window.marked.parse(markdownText);
      } catch (err) {
        console.warn('Marked parse error, using fallback:', err);
      }
    }
    return fallbackMarkdownHtml(markdownText);
  }

  function fallbackMarkdownHtml(markdownText) {
    if (!markdownText) return '';
    let html = escapeHtml(markdownText);

    // Code blocks
    html = html.replace(/```([a-zA-Z0-9]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre class="code-block my-2"><code>${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="bg-surface-800 text-brand-300 px-1 py-0.5 rounded font-mono text-[11px]">$1</code>');

    // Headings
    html = html.replace(/^### (.*$)/gim, '<h5 class="text-xs font-bold text-slate-200 mt-3 mb-1">$1</h5>');
    html = html.replace(/^## (.*$)/gim, '<h4 class="text-sm font-bold text-brand-400 mt-4 mb-2 border-b border-slate-800 pb-1">$1</h4>');
    html = html.replace(/^# (.*$)/gim, '<h3 class="text-base font-bold text-white mt-4 mb-2">$1</h3>');

    // Bold & Italic
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-slate-100">$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em class="text-slate-400">$1</em>');

    // List items
    html = html.replace(/^\- (.*$)/gim, '<li class="ml-4 list-disc text-slate-300 my-0.5">$1</li>');

    // Line breaks
    html = html.replace(/\n\n/g, '<div class="h-2"></div>');

    return html;
  }

  // Expose global helper for inline HTML events
  window.aiWorker = {
    openLightbox: openLightboxModal,
    showEvidenceDetailModal,
    toggleEvidenceStatus,
    deleteEvidence,
    deleteEvidenceItem
  };


  // =========================================================================
  // TOAST NOTIFICATION SYSTEM
  // =========================================================================
  function showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none';
      document.body.appendChild(container);
    }
    if (type === 'success') {
      // Khi thành công, dọn dẹp các toast cảnh báo/lỗi cũ để không gây hiểu nhầm
      container.innerHTML = '';
    }
    const colorClasses = type === 'error' ? 'bg-rose-950/90 border-rose-500/50 text-rose-200' :
                         type === 'success' ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200' :
                         type === 'warning' ? 'bg-amber-950/90 border-amber-500/50 text-amber-200' :
                         'bg-slate-900/90 border-slate-700 text-slate-200';
    const toast = document.createElement('div');
    toast.className = `px-4 py-2.5 rounded-lg border shadow-xl text-xs flex items-center gap-2 backdrop-blur-md transition-all duration-300 pointer-events-auto transform translate-y-2 opacity-0 ${colorClasses}`;
    const icon = type === 'error' ? 'fa-circle-exclamation text-rose-400' :
                 type === 'success' ? 'fa-circle-check text-emerald-400' :
                 type === 'warning' ? 'fa-triangle-exclamation text-amber-400' :
                 'fa-circle-info text-brand-400';
    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-2', 'opacity-0');
    });
    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // =========================================================================
  // SETTINGS MANAGEMENT (RUNNERS PER STEP)
  // =========================================================================
  async function loadSettings() {
    try {
      // B18: timeout để không treo khi server không phản hồi
      const res = await fetchWithTimeout('/api/v1/settings', {}, 10000);
      let data = null;
      if (res.ok) {
        data = await res.json();
      }
      let mapping = null;
      if (data) {
        mapping = (data.settings && data.settings.agent_mapping) || data.agent_mapping || data;
      }
      if (!mapping) {
        const cached = localStorage.getItem('ai_worker_settings');
        if (cached) {
          const parsed = JSON.parse(cached);
          mapping = parsed.agent_mapping || parsed;
        }
      }
      if (mapping) {
        state.agentMapping = mapping;
        const planEl = document.getElementById('settingPlanningRunner');
        const impEl = document.getElementById('settingImplementRunner');
        const testEl = document.getElementById('settingTestingRunner');
        const fixEl = document.getElementById('settingFixingRunner');
        if (planEl) planEl.value = mapping.PLANNING || mapping.planning_runner || 'claude-code';
        if (impEl) impEl.value = mapping.IMPLEMENT || mapping.implement_runner || 'claude-code';
        if (testEl) testEl.value = mapping.TESTING || mapping.testing_runner || 'claude-code';
        if (fixEl) fixEl.value = mapping.FIXING || mapping.fixing_runner || 'claude-code';
      } else {
        // B18: không có dữ liệu từ server lẫn cache -> báo lỗi thay vì im lặng
        showToast('Không tải được cài đặt runner từ máy chủ.', 'warning');
      }
    } catch (err) {
      console.warn('loadSettings fallback to localStorage:', err);
      try {
        const cached = localStorage.getItem('ai_worker_settings');
        if (cached) {
          const parsed = JSON.parse(cached);
          const mapping = parsed.agent_mapping || parsed;
          state.agentMapping = mapping;
          const planEl = document.getElementById('settingPlanningRunner');
          const impEl = document.getElementById('settingImplementRunner');
          const testEl = document.getElementById('settingTestingRunner');
          const fixEl = document.getElementById('settingFixingRunner');
          if (planEl) planEl.value = mapping.PLANNING || mapping.planning_runner || 'claude-code';
          if (impEl) impEl.value = mapping.IMPLEMENT || mapping.implement_runner || 'claude-code';
          if (testEl) testEl.value = mapping.TESTING || mapping.testing_runner || 'claude-code';
          if (fixEl) fixEl.value = mapping.FIXING || mapping.fixing_runner || 'claude-code';
        } else {
          // B18: cả API lẫn cache đều lỗi -> hiển thị trạng thái lỗi
          showToast('Không tải được cài đặt runner từ máy chủ.', 'warning');
        }
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function saveSettings() {
    const planEl = document.getElementById('settingPlanningRunner');
    const impEl = document.getElementById('settingImplementRunner');
    const testEl = document.getElementById('settingTestingRunner');
    const fixEl = document.getElementById('settingFixingRunner');

    const agent_mapping = {
      PLANNING: planEl ? planEl.value : 'claude-code',
      IMPLEMENT: impEl ? impEl.value : 'claude-code',
      TESTING: testEl ? testEl.value : 'claude-code',
      FIXING: fixEl ? fixEl.value : 'claude-code'
    };

    const payload = {
      agent_mapping,
      planning_runner: agent_mapping.PLANNING,
      implement_runner: agent_mapping.IMPLEMENT,
      testing_runner: agent_mapping.TESTING,
      fixing_runner: agent_mapping.FIXING
    };

    try {
      // B18: timeout để nút Lưu không treo vô hạn
      const res = await fetchWithTimeout('/api/v1/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, 10000);
      if (!res.ok) throw new Error('Không thể lưu cài đặt trên máy chủ (HTTP ' + res.status + ')');
      localStorage.setItem('ai_worker_settings', JSON.stringify(payload));
      showToast('Lưu cài đặt runner thành công!', 'success');
      closeSettingsModal();
    } catch (err) {
      console.warn('Lỗi saveSettings API, lưu tạm vào localStorage:', err);
      localStorage.setItem('ai_worker_settings', JSON.stringify(payload));
      // B18: request thất bại thì KHÔNG báo "thành công"
      showToast('Không lưu được cài đặt lên máy chủ, đã lưu tạm cục bộ: ' + (err.message || 'lỗi kết nối'), 'warning');
      closeSettingsModal();
    }
  }

  function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.remove('hidden');
    loadSettings();
  }

  function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.add('hidden');
  }

  // =========================================================================
  // WORKSPACE MANAGEMENT
  // =========================================================================
  async function loadWorkspaces() {
    try {
      const res = await fetch('/api/v1/workspaces');
      let workspaces = [];
      if (res.ok) {
        const data = await res.json();
        workspaces = Array.isArray(data) ? data : (data.workspaces || []);
        state.workspaces = workspaces;
      }
      const select = document.getElementById('createTaskWorkspace');
      if (select) {
        const currentVal = select.value;
        select.innerHTML = '<option value="">-- Chọn Workspace --</option>' +
          workspaces.map(ws => `<option value="${escapeHtml(ws.id || ws.path)}">${escapeHtml(ws.name || ws.path)} (${escapeHtml(ws.path)})</option>`).join('');
        if (currentVal) {
          select.value = currentVal;
        } else {
          const defaultWs = workspaces.find(w => w.is_default);
          if (defaultWs) select.value = defaultWs.id || defaultWs.path;
          else if (workspaces.length > 0) select.selectedIndex = 1;
        }
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const editSelect = document.getElementById('editTaskWorkspace');
      if (editSelect) {
        const currentEditVal = editSelect.value;
        editSelect.innerHTML = '<option value="" disabled>-- Chọn Workspace --</option>' +
          workspaces.map(ws => `<option value="${escapeHtml(ws.id || ws.path)}">${escapeHtml(ws.name || ws.path)} (${escapeHtml(ws.path)})</option>`).join('');
        if (currentEditVal) editSelect.value = currentEditVal;
        editSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (err) {
      console.warn('Lỗi loadWorkspaces:', err);
    }
  }

  async function browseFolder(browsePath) {
    const listContainer = document.getElementById('workspaceBrowseList');
    if (listContainer) {
      listContainer.innerHTML = '<div class="text-xs text-slate-400 py-2"><i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Đang tải danh sách thư mục...</div>';
    }
    try {
      let res;
      try {
        // B18: timeout 10s, tránh spinner quay mãi khi server treo
        res = await fetchWithTimeout('/api/v1/workspaces/browse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPath: browsePath || '' })
        });
      } catch (netErr) {
        res = null;
      }
      if (!res || !res.ok) {
        res = await fetchWithTimeout('/api/v1/workspaces/browse?path=' + encodeURIComponent(browsePath || ''));
      }
      if (!res.ok) throw new Error('Không thể duyệt thư mục (HTTP ' + res.status + ')');
      const data = await res.json();
      const items = data.folders || data.items || data.directories || (Array.isArray(data) ? data : []);

      const pathInput = document.getElementById('workspacePathInput');
      if (pathInput && data.currentPath && !browsePath) {
        pathInput.value = data.currentPath;
      }

      if (listContainer) {
        let html = '';
        if (data.parentPath) {
          html += `
            <div class="folder-browse-item flex items-center justify-between p-1.5 px-2.5 rounded hover:bg-surface-700/80 cursor-pointer text-xs text-amber-300 hover:text-white transition group border border-transparent hover:border-slate-700 mb-1" data-path="${escapeHtml(data.parentPath)}">
              <span class="flex items-center gap-2 truncate">
                <i class="fa-solid fa-arrow-turn-up text-amber-400"></i>
                <span class="truncate font-semibold">.. (Thư mục cha: ${escapeHtml(data.parentPath)})</span>
              </span>
              <span class="text-[10px] text-slate-500 font-mono group-hover:text-slate-400">Lên trên</span>
            </div>
          `;
        }
        if (items.length === 0 && !data.parentPath) {
          html += '<div class="text-xs text-slate-500 py-2">Không có thư mục con nào.</div>';
        } else {
          html += items.map(item => {
            const itemPath = typeof item === 'string' ? item : (item.path || item.name);
            const itemName = typeof item === 'string' ? item.split(/[\\/]/).pop() || item : (item.name || itemPath);
            return `
              <div class="folder-browse-item flex items-center justify-between p-1.5 px-2.5 rounded hover:bg-surface-700/80 cursor-pointer text-xs text-slate-300 hover:text-white transition group border border-transparent hover:border-slate-700" data-path="${escapeHtml(itemPath)}">
                <span class="flex items-center gap-2 truncate">
                  <i class="fa-regular fa-folder text-brand-400 group-hover:text-brand-300"></i>
                  <span class="truncate">${escapeHtml(itemName)}</span>
                </span>
                <span class="text-[10px] text-slate-500 font-mono group-hover:text-slate-400">Chọn</span>
              </div>
            `;
          }).join('');
        }
        listContainer.innerHTML = html;

        listContainer.querySelectorAll('.folder-browse-item').forEach(el => {
          el.addEventListener('click', () => {
            const p = el.getAttribute('data-path');
            if (p) {
              const inp = document.getElementById('workspacePathInput');
              if (inp) inp.value = p;
              browseFolder(p);
            }
          });
        });
      }
    } catch (err) {
      console.error('Lỗi duyệt thư mục:', err);
      if (listContainer) {
        listContainer.innerHTML = `<div class="text-xs text-red-400 py-2"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${escapeHtml(err.message || 'Lỗi khi tải thư mục')}</div>`;
      }
    }
  }

  async function submitWorkspace() {
    const nameInput = document.getElementById('workspaceNameInput');
    const pathInput = document.getElementById('workspacePathInput');
    const name = nameInput?.value.trim();
    const path = pathInput?.value.trim();

    if (!name || !path) {
      showToast('Vui lòng nhập đầy đủ Tên và Đường dẫn workspace!', 'warning');
      return;
    }

    // B17: chống double-submit
    const btn = document.getElementById('btnSaveWorkspace');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/v1/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path })
      });
      if (!res.ok) throw new Error('Không thể thêm workspace mới');
      const created = await res.json();
      showToast('Thêm workspace thành công!', 'success');
      closeWorkspaceModal();
      if (nameInput) nameInput.value = '';
      if (pathInput) pathInput.value = '';
      await loadWorkspaces();
      const select = document.getElementById('createTaskWorkspace');
      if (select && created && (created.id || created.path)) {
        select.value = created.id || created.path;
      }
    } catch (err) {
      showToast(err.message || 'Lỗi thêm workspace', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function openWorkspaceModal() {
    const modal = document.getElementById('workspaceModal');
    if (modal) modal.classList.remove('hidden');
    const pathInput = document.getElementById('workspacePathInput');
    browseFolder(pathInput ? pathInput.value.trim() : '');
  }

  function closeWorkspaceModal() {
    const modal = document.getElementById('workspaceModal');
    if (modal) modal.classList.add('hidden');
  }

  // =========================================================================
  // MARKDOWN PREVIEW DEV PLAN & TEST PLAN
  // =========================================================================
  async function loadPlanFiles(jobId) {
    if (!jobId) return;
    const devContainer = document.getElementById('devPlanMarkdownContainer') || document.getElementById('devPlanContent');
    const testContainer = document.getElementById('testPlanMarkdownContainer') || document.getElementById('testPlanContent');

    // Kiểm tra cache (chỉ nhận cache nếu có nội dung thật)
    const cached = state.planCache.get(jobId);
    if (cached && cached.hasRealPlan && cached.devHtml !== undefined) {
      if (devContainer) devContainer.innerHTML = cached.devHtml;
      if (testContainer) testContainer.innerHTML = cached.testHtml;
      return;
    }
    if (cached && cached.promise) {
      await cached.promise;
      const updated = state.planCache.get(jobId);
      if (updated && state.activeJobId === jobId && updated.hasRealPlan) {
        if (devContainer) devContainer.innerHTML = updated.devHtml;
        if (testContainer) testContainer.innerHTML = updated.testHtml;
      }
      return;
    }
    let devContent = state.dualPlan?.dev_plan || '';
    let testContent = state.dualPlan?.test_plan || '';

    const fetchPromise = (async () => {
      try {
        let res = await fetch(`/api/v1/tasks/${jobId}/plan-files`);
        if (!res.ok) {
          res = await fetch(`/api/v1/jobs/${jobId}/plan-files`);
        }
        if (res.ok) {
          const data = await res.json();
          if (data.dev_plan || data.devPlan) devContent = data.dev_plan || data.devPlan;
          if (data.test_plan || data.testPlan) testContent = data.test_plan || data.testPlan;
        }
      } catch (err) {
        console.warn('loadPlanFiles API error, using dual_plan fallback:', err);
      }

      const devHtml = devContent
        ? `<div class="prose prose-invert max-w-none text-xs leading-relaxed">${formatMarkdownContent(devContent)}</div>`
        : `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-file-code text-2xl mb-2 opacity-50 block"></i>
            Chưa có Dev Plan cho task này
          </div>
        `;

      const testHtml = testContent
        ? `<div class="prose prose-invert max-w-none text-xs leading-relaxed">${formatMarkdownContent(testContent)}</div>`
        : `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-vial text-2xl mb-2 opacity-50 block"></i>
            Chưa có Test Plan cho task này
          </div>
        `;

      const hasRealPlan = Boolean((devContent && devContent.trim().length > 30) || (testContent && testContent.trim().length > 30));
      if (hasRealPlan) {
        state.planCache.set(jobId, { devHtml, testHtml, hasRealPlan: true });
      } else {
        // Không cache chuỗi rỗng/chưa có plan để lần sau gọi lại sẽ nạp từ server
        state.planCache.delete(jobId);
      }
      return { devHtml, testHtml };
    })();
    state.planCache.set(jobId, { promise: fetchPromise });
    const result = await fetchPromise;

    if (state.activeJobId === jobId) {
      if (devContainer) devContainer.innerHTML = result.devHtml;
      if (testContainer) testContainer.innerHTML = result.testHtml;
    }
  }
  // =========================================================================
  // TASK LIFECYCLE MANAGEMENT (DELETE TASK, UPDATE STATUS)
  // =========================================================================
  async function handleDeleteTask() {
    if (!state.activeJobId) return;
    const confirmDelete = window.confirm('Bạn có chắc chắn muốn xóa task này không? Thao tác này không thể hoàn tác.');
    if (!confirmDelete) return;

    try {
      let res = await fetch(`/api/v1/jobs/${state.activeJobId}`, { method: 'DELETE' });
      if (!res.ok) {
        res = await fetch(`/api/v1/tasks/${state.activeJobId}`, { method: 'DELETE' });
      }
      if (!res.ok) throw new Error('Không thể xóa task');
      showToast('Đã xóa task thành công!', 'success');
      state.activeJobId = null;
      state.activeJob = null;
      document.getElementById('emptyJobState')?.classList.remove('hidden');
      document.getElementById('activeJobContainer')?.classList.add('hidden');
      fetchJobsList();
    } catch (err) {
      showToast(err.message || 'Lỗi khi xóa task', 'error');
    }
  }

  async function handleUpdateTaskStatus() {
    if (!state.activeJobId) return;
    const statusSelect = document.getElementById('taskStatusSelect');
    if (!statusSelect) return;
    const newStatus = (statusSelect.value || '').trim();
    // B7: không gửi status rỗng
    if (!newStatus) {
      showToast('Vui lòng chọn trạng thái trước khi lưu.', 'warning');
      return;
    }
    // B17: chống double-submit
    const btn = document.getElementById('btnUpdateStatus');
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;

    try {
      let res = await fetch(`/api/v1/jobs/${state.activeJobId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (!res.ok) {
        res = await fetch(`/api/v1/tasks/${state.activeJobId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus })
        });
      }
      if (!res.ok) throw new Error('Không thể cập nhật trạng thái');
      const data = await res.json().catch(() => ({}));
      const updatedJob = data && data.job;

      // Đồng bộ state cục bộ ngay lập tức để UI cập nhật không có độ trễ
      if (state.activeJob && state.activeJob.id === state.activeJobId) {
        state.activeJob.status = newStatus;
        if (['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'].includes(newStatus)) {
          state.activeJob.current_step = newStatus;
        }
        if (updatedJob) Object.assign(state.activeJob, updatedJob);
        renderActiveJobDetail();
      }
      const targetJob = state.jobs.find((j) => j.id === state.activeJobId);
      if (targetJob) {
        targetJob.status = newStatus;
        if (['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'].includes(newStatus)) {
          targetJob.current_step = newStatus;
        }
        targetJob.updated_at = new Date().toISOString();
        if (updatedJob) Object.assign(targetJob, updatedJob);
      }
      renderJobsList();

      showToast('Cập nhật trạng thái thành công!', 'success');
      fetchJobDetails(state.activeJobId, false);
      fetchJobsListSilently();
    } catch (err) {
      showToast(err.message || 'Lỗi cập nhật trạng thái', 'error');
    } finally {
      // B17: khôi phục nút, nhưng vẫn khoá nếu job đang chạy (B8)
      if (btn) {
        btn.disabled = false;
        const curStatus = ((state.activeJob && state.activeJob.status) || '').toUpperCase();
        if (RUNNING_STATUSES.includes(curStatus)) btn.disabled = true;
      }
    }
  }



  // --- Chỉnh sửa thông tin Task (Modal) ---
  let editingTaskId = null;

  async function openEditTaskModal(jobId) {
    const targetId = jobId || state.activeJobId;
    if (!targetId) {
      showToast('Vui lòng chọn một Task để sửa', 'warning');
      return;
    }
    const job = state.jobs.find(j => j.id === targetId) || state.activeJob;
    if (!job) {
      showToast('Không tìm thấy thông tin Task', 'error');
      return;
    }
    const isRunning = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'FIXING'].includes((job.status || '').toUpperCase());
    if (isRunning) {
      showToast('Không thể chỉnh sửa khi Task đang chạy Pipeline (' + job.status + ')', 'warning');
      return;
    }
    editingTaskId = targetId;
    const modal = document.getElementById('editTaskModal');
    const codeInput = document.getElementById('editTaskCode');
    const titleInput = document.getElementById('editTaskTitle');
    const promptInput = document.getElementById('editTaskPrompt');
    const wsSelect = document.getElementById('editTaskWorkspace');
    const branchInput = document.getElementById('editTaskBranch');
    const timeoutInput = document.getElementById('editTaskTimeout');
    const retryInput = document.getElementById('editTaskMaxRetries');
    const quickTrackInput = document.getElementById('editTaskQuickTrack');
    if (codeInput) codeInput.value = job.task_code || ('TASK-' + job.id.substring(0, 8).toUpperCase());
    if (titleInput) titleInput.value = job.title || '';
    if (promptInput) {
      promptInput.value = job.prompt || '';
      // Lay prompt day du tu API chi tiet vi state.jobs chi chua preview 200 ky tu (T3.3)
      fetch(`/api/v1/jobs/${job.id}`).then(r => r.json()).then(d => {
        const full = d.job || d;
        if (full && full.prompt && editingTaskId === targetId && promptInput) {
          promptInput.value = full.prompt;
        }
      }).catch(() => {});
    }
    try {
      if ((!state.workspaces || state.workspaces.length === 0) && typeof loadWorkspaces === 'function') await loadWorkspaces();
      else if (wsSelect && wsSelect.options.length <= 1 && typeof loadWorkspaces === 'function') await loadWorkspaces();
    } catch (e) { console.warn('Lỗi nạp workspaces cho modal Sửa:', e); }
    try {
      const wsList = state.workspaces || [];
      if (wsSelect && wsList.length > 0) {
        const jobWsId = job.workspace_id || job.workspaceId || '';
        const jobRepo = job.repo_path || job.repoPath || job.workspace_path || '';
        let matched = null;
        if (jobWsId) matched = wsList.find(w => w.id === jobWsId || w.path === jobWsId);
        if (!matched && jobRepo) matched = wsList.find(w => w.path === jobRepo || w.id === jobRepo);
        if (matched) wsSelect.value = matched.id || matched.path;
        else if (jobWsId) wsSelect.value = jobWsId;
        else if (jobRepo && Array.from(wsSelect.options).some(o => o.value === jobRepo)) wsSelect.value = jobRepo;
        if (!wsSelect.value) {
          const defaultWs = wsList.find(w => w.is_default);
          if (defaultWs) wsSelect.value = defaultWs.id || defaultWs.path;
        }
      }
    } catch (e) { console.warn('Lỗi preselect workspace Sửa:', e); }
    if (branchInput) branchInput.value = job.base_branch || job.branch || 'main';
    try {
      let pipe = job.pipeline_config !== undefined ? job.pipeline_config : job.pipelineConfig;
      if (typeof pipe === 'string') { try { pipe = JSON.parse(pipe); } catch (e) { pipe = {}; } }
      if (!pipe || typeof pipe !== 'object') pipe = {};
      let rawTimeout = pipe.timeout !== undefined ? pipe.timeout : pipe.timeoutMs !== undefined ? pipe.timeoutMs : pipe.timeout_ms !== undefined ? pipe.timeout_ms : pipe.timeout_seconds !== undefined ? pipe.timeout_seconds : job.timeout !== undefined ? job.timeout : job.timeout_seconds !== undefined ? job.timeout_seconds : 15;
      let tNum = Number(rawTimeout);
      if (!Number.isFinite(tNum)) tNum = 15;
      const timeoutMinutes = tNum >= 10000 ? Math.round(tNum / 60000) : tNum > 120 ? Math.round(tNum / 60) : Math.round(tNum);
      if (timeoutInput) timeoutInput.value = String(timeoutMinutes);
      let rawRetry = pipe.max_retries !== undefined ? pipe.max_retries : pipe.maxRetries !== undefined ? pipe.maxRetries : pipe.max_fixing_retries !== undefined ? pipe.max_fixing_retries : job.max_retries !== undefined ? job.max_retries : 3;
      let rNum = Number(rawRetry);
      if (!Number.isFinite(rNum)) rNum = 3;
      if (retryInput) retryInput.value = String(rNum);
      // Che do NHANH: 3 trang thai - auto (chua quyet dinh) / true / false.
      if (quickTrackInput) {
        quickTrackInput.value = pipe.quick_track === true ? 'on' : (pipe.quick_track === false ? 'off' : 'auto');
        // Luu trang thai hien tai de biet user co THAY DOI gi khi submit hay khong.
        quickTrackInput.dataset.prevMode = quickTrackInput.value;
      }
    } catch (e) { console.warn('Lỗi điền timeout/retry Sửa:', e); }
    if (modal) modal.classList.remove('hidden');
    try {
      wsSelect?.dispatchEvent(new Event('change', { bubbles: true }));
      codeInput?.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {}
  }

  function closeEditTaskModal() {
    const modal = document.getElementById('editTaskModal');
    if (modal) modal.classList.add('hidden');
    editingTaskId = null;
  }

  async function handleEditTaskSubmit(e) {
    e.preventDefault();
    if (!editingTaskId) return;
    const errAlert = document.getElementById('editTaskErrorAlert');
    if (errAlert) {
      errAlert.classList.add('hidden');
      errAlert.innerHTML = '';
    }

    const submitBtn = document.getElementById('btnSubmitEditTask');
    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Đang lưu...';
      }
      const task_code = document.getElementById('editTaskCode')?.value.trim() || '';
      const title = document.getElementById('editTaskTitle')?.value.trim() || '';
      const prompt = document.getElementById('editTaskPrompt')?.value.trim() || '';
      const wsSelect = document.getElementById('editTaskWorkspace');
      const workspace_id = wsSelect ? wsSelect.value.trim() : '';
      const base_branch = document.getElementById('editTaskBranch')?.value.trim() || 'main';
      const timeoutRaw = document.getElementById('editTaskTimeout')?.value;
      const retryRaw = document.getElementById('editTaskMaxRetries')?.value;
      const timeout = timeoutRaw !== undefined && String(timeoutRaw).trim() !== '' ? Number(timeoutRaw) : 15;
      const retryVal = retryRaw !== undefined && String(retryRaw).trim() !== '' ? Number(retryRaw) : 3;
      if (!task_code) {
        showToast('Vui lòng nhập Mã Task!', 'warning');
        document.getElementById('editTaskCode')?.focus();
        return;
      }
      if (!prompt) {
        showToast('Vui lòng nhập mô tả yêu cầu / prompt!', 'warning');
        document.getElementById('editTaskPrompt')?.focus();
        return;
      }
      if (!workspace_id) {
        showToast('Vui lòng chọn Workspace!', 'warning');
        wsSelect?.focus();
        return;
      }
      if (!base_branch) {
        showToast('Vui lòng nhập Git Base Branch!', 'warning');
        document.getElementById('editTaskBranch')?.focus();
        return;
      }
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) {
        showToast('Timeout phải từ 1 đến 120 phút!', 'warning');
        document.getElementById('editTaskTimeout')?.focus();
        return;
      }
      const wsList = state.workspaces || [];
      const selectedWsObj = wsList.find(w => w.id === workspace_id || w.path === workspace_id);
      const resolved_workspace_id = selectedWsObj ? (selectedWsObj.id || workspace_id) : workspace_id;
      const res = await fetch(`/api/v1/jobs/${editingTaskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_code, title, prompt, workspace_id: resolved_workspace_id, base_branch, timeout, max_retries: retryVal })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        const errMsg = data.error || data.message || 'Cập nhật Task thất bại';
        const suggestedCode = data.suggested_task_code;
        if (errAlert) {
          if (suggestedCode) {
            errAlert.innerHTML = `
              <div class="flex items-start gap-2.5">
                <i class="fa-solid fa-triangle-exclamation text-amber-400 text-sm mt-0.5"></i>
                <div class="flex-1">
                  <strong class="text-amber-300">Thư mục Task đã tồn tại trên workspace:</strong>
                  <div class="mt-1 text-slate-200 text-xs">${escapeHtml(errMsg)}</div>
                  <div class="mt-2.5 pt-2 border-t border-slate-700/60 flex items-center justify-between flex-wrap gap-2">
                    <span class="text-[11px] text-slate-300">Gợi ý mã có hậu tố: <strong class="text-indigo-400 font-mono text-xs">${escapeHtml(suggestedCode)}</strong></span>
                    <button type="button" id="btnUseSuggestedEditTaskCode" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition flex items-center gap-1.5 shadow">
                      <i class="fa-solid fa-wand-magic-sparkles text-amber-300"></i>
                      <span>Đổi sang: ${escapeHtml(suggestedCode)} & Lưu</span>
                    </button>
                  </div>
                </div>
              </div>
            `;
            document.getElementById('btnUseSuggestedEditTaskCode')?.addEventListener('click', () => {
              const codeInp = document.getElementById('editTaskCode');
              if (codeInp) {
                codeInp.value = suggestedCode;
              }
              errAlert.classList.add('hidden');
              setTimeout(() => {
                document.getElementById('btnSubmitEditTask')?.click();
              }, 50);
            });
          } else {
            errAlert.innerHTML = `<div class="flex items-start gap-2"><i class="fa-solid fa-triangle-exclamation text-rose-400 mt-0.5"></i><div><strong>Lỗi cập nhật:</strong><div class="mt-1 text-slate-200">${escapeHtml(errMsg)}</div></div></div>`;
          }
          errAlert.classList.remove('hidden');
        }
        throw new Error(errMsg);
      }

      // Luu che do NHANH (quick_track) qua endpoint chuyen biet.
      // 'auto' => xoa co (he thong tu quyet dinh) | 'on' => true | 'off' => false.
      // Chi gui khi trang thai THAT su doi => mo modal Edit roi bam Luu khong
      // lam job bi ghi quick_track=false tuong minh (khong mong doi).
      try {
        const quickSel = document.getElementById('editTaskQuickTrack');
        if (quickSel) {
          const mode = quickSel.value;
          const prevMode = quickSel.dataset.prevMode || 'auto';
          if (mode !== prevMode) {
            const qr = await fetch(`/api/v1/jobs/${editingTaskId}/quick-track`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode })
            });
            if (!qr.ok) {
              const qd = await qr.json().catch(() => ({}));
              showToast('Cập nhật chế độ NHANH thất bại: ' + (qd.error || 'lỗi không xác định'), 'warning');
            } else {
              quickSel.dataset.prevMode = mode;
            }
          }
        }
      } catch (e) { console.warn('Lỗi lưu chế độ NHANH:', e); }
      const targetId = editingTaskId;
      showToast('Đã cập nhật thông tin Task thành công!', 'success');
      closeEditTaskModal();

      // Cập nhật ngay lập tức dữ liệu mới vào state local để hiển thị thông tin mới ngay
      if (data && data.job) {
        const idx = state.jobs.findIndex(j => j.id === targetId);
        if (idx >= 0) state.jobs[idx] = { ...state.jobs[idx], ...data.job };
        if (state.activeJobId === targetId) {
          state.activeJob = { ...state.activeJob, ...data.job };
          renderActiveJobDetail();
        }
      }

      await fetchJobsListSilently();
      if (state.activeJobId === targetId) {
        await fetchJobDetails(targetId, false);
      }
    } catch (err) {
      // B13: trước đây gọi showToast(err...) trong try -> ReferenceError; nay báo lỗi thật ở catch
      showToast(err.message || 'Lỗi cập nhật thông tin Task', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i> Lưu thay đổi';
      }
    }
  }

  // --- Thao tác Lưu trữ và Xóa Task ---
  async function archiveTask(jobId, btn) {
    const targetId = jobId || state.activeJobId;
    if (!targetId) return;

    // B17: chống double-submit (ưu tiên nút được bấm từ event delegation)
    const actionBtn = btn || document.querySelector(`[data-action="archive"][data-job-id="${targetId}"]`);
    if (actionBtn && actionBtn.disabled) return;

    // B8: chặn lưu trữ khi job đang chạy
    const job = state.jobs.find((j) => j.id === targetId) || (state.activeJob && state.activeJob.id === targetId ? state.activeJob : null);
    if (job && RUNNING_STATUSES.includes((job.status || '').toUpperCase())) {
      showToast('Task đang chạy Pipeline, không thể lưu trữ.', 'warning');
      return;
    }
    if (actionBtn) actionBtn.disabled = true;

    try {
      const res = await fetch(`/api/v1/jobs/${targetId}/archive`, {
        method: 'POST'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        showToast(data.error || 'Thao tác lưu trữ thất bại', 'error');
        return;
      }
      showToast(data.message || 'Thao tác lưu trữ thành công', 'success');
      await fetchJobsListSilently();
      if (state.activeJobId === targetId) {
        await fetchJobDetails(targetId, false);
      }
    } catch (err) {
      showToast('Lỗi kết nối khi lưu trữ: ' + err.message, 'error');
    } finally {
      if (actionBtn) actionBtn.disabled = false;
    }
  }

  async function deleteTask(jobId, btn) {
    const targetId = jobId || state.activeJobId;
    if (!targetId) return;

    // B17: chống double-submit
    const actionBtn = btn || document.querySelector(`[data-action="delete"][data-job-id="${targetId}"]`);
    if (actionBtn && actionBtn.disabled) return;

    // B8 + B10: chỉ xoá khi trạng thái nằm trong danh sách cho phép
    const job = state.jobs.find((j) => j.id === targetId) || (state.activeJob && state.activeJob.id === targetId ? state.activeJob : null);
    if (job && !DELETABLE_STATUSES.includes((job.status || '').toUpperCase().trim())) {
      showToast('Không thể xóa Task ở trạng thái hiện tại. Hãy lưu trữ hoặc dừng task trước.', 'warning');
      return;
    }

    if (!confirm('Bạn có chắc chắn muốn xóa tác vụ này không?')) return;
    if (actionBtn) actionBtn.disabled = true;

    try {
      const res = await fetch(`/api/v1/jobs/${targetId}`, {
        method: 'DELETE'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        showToast(data.error || 'Không thể xóa task', 'error');
        return;
      }
      showToast('Đã xóa task thành công!', 'success');
      if (state.activeJobId === targetId) {
        state.activeJobId = null;
        const emptyState = document.getElementById('emptyJobState');
        const activeContainer = document.getElementById('activeJobContainer');
        if (emptyState) emptyState.classList.remove('hidden');
        if (activeContainer) activeContainer.classList.add('hidden');
      }
      await fetchJobsList();
    } catch (err) {
      showToast('Lỗi kết nối khi xóa: ' + err.message, 'error');
    } finally {
      if (actionBtn) actionBtn.disabled = false;
    }
  }

  // Export global cho templates và inline onclick
  window.aiWorker = window.aiWorker || {};
  window.aiWorker.archiveTask = archiveTask;
  window.aiWorker.deleteTask = deleteTask;
  window.aiWorker.openEditModal = openEditTaskModal;
  async function dequeueTask(jobId, btn) {
    if (!jobId) return;
    // B17: chống double-submit
    const actionBtn = btn || document.querySelector(`[data-action="dequeue"][data-job-id="${jobId}"]`);
    if (actionBtn && actionBtn.disabled) return;
    if (actionBtn) actionBtn.disabled = true;
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/dequeue`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        showToast(data.error || 'Không thể xóa task khỏi hàng đợi', 'error');
        return;
      }
      showToast(data.message || 'Đã xóa task khỏi hàng đợi thành công', 'success');
      const target = state.jobs.find(j => j.id === jobId);
      if (target) {
        target.is_queued = false;
      }
      if (state.activeJob && state.activeJob.id === jobId) {
        state.activeJob.is_queued = false;
        renderActiveJobDetail();
      }
      renderJobsList(true);
      fetchSystemStatus();
    } catch (err) {
      showToast('Lỗi khi xóa khỏi hàng đợi: ' + err.message, 'error');
    } finally {
      if (actionBtn) actionBtn.disabled = false;
    }
  }

  window.aiWorker = window.aiWorker || {};
  window.aiWorker.dequeueTask = dequeueTask;
  window.aiWorker.openFolderBrowser = openFolderBrowser;
  window.aiWorker.closeFolderBrowser = closeFolderBrowser;
  window.aiWorker.selectFolderBrowser = selectFolderBrowser;
  window.aiWorker.folderBrowserBack = folderBrowserBack;
  async function openWorkspaceManagerModal() {
    const modal = document.getElementById("modalWorkspaceManager");
    if (modal) modal.classList.remove("hidden");
    await loadWorkspaces();
    renderWorkspaceTable();
  }

  function closeWorkspaceManagerModal() {
    const modal = document.getElementById("modalWorkspaceManager");
    if (modal) modal.classList.add("hidden");
    resetWorkspaceForm();
  }

  function resetWorkspaceForm() {
    const idEl = document.getElementById("wsEditId");
    if (idEl) idEl.value = "";
    const nameEl = document.getElementById("wsFormName");
    if (nameEl) nameEl.value = "";
    const pathEl = document.getElementById("wsFormPath");
    if (pathEl) pathEl.value = "";
    const fdirEl = document.getElementById("wsFormFeaturesDir");
    if (fdirEl) fdirEl.value = "docs/features";
    const defEl = document.getElementById("wsFormIsDefault");
    if (defEl) defEl.checked = false;
    
    const titleEl = document.getElementById("wsFormTitle");
    if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-plus-circle"></i> Thêm Workspace Mới';
    const submitBtnEl = document.getElementById("wsSubmitBtnText");
    if (submitBtnEl) submitBtnEl.innerText = "Lưu Workspace";
    const cancelBtn = document.getElementById("btnCancelEditWs");
    if (cancelBtn) cancelBtn.classList.add("hidden");
  }

  function renderWorkspaceTable() {
    const tbody = document.getElementById("wsManagerTableBody");
    const countEl = document.getElementById("wsTableCount");
    if (!tbody) return;

    if (!state.workspaces || state.workspaces.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-slate-500">Chưa có workspace nào. Hãy thêm mới bên dưới.</td></tr>';
      if (countEl) countEl.innerText = "0 workspace";
      return;
    }
    
    if (countEl) countEl.innerText = state.workspaces.length + " workspace" + (state.workspaces.length > 1 ? "s" : "");

    tbody.innerHTML = state.workspaces.map(ws => {
      const defBadge = ws.is_default 
        ? '<span class="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded text-[10px] font-semibold"><i class="fa-solid fa-check mr-1"></i>Mặc định</span>'
        : `<button type="button" onclick="handleSetDefaultWorkspace('${ws.id}')" class="text-slate-500 hover:text-brand-400 text-[10px] transition"><i class="fa-regular fa-star"></i> Đặt</button>`;
      
      return `
        <tr class="hover:bg-surface-800/50 transition">
          <td class="p-3 font-medium text-slate-200">${escapeHtml(ws.name || ws.path)}</td>
          <td class="p-3 font-mono text-slate-400 text-[11px] truncate max-w-[200px]" title="${escapeHtml(ws.path)}">${escapeHtml(ws.path)}</td>
          <td class="p-3 text-center">
            <button type="button" onclick="openWorkspaceServicesModal('${ws.id}')" class="px-2 py-1 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded text-[11px] font-semibold transition flex items-center gap-1 mx-auto" title="Quản lý các repo services của workspace">
              <i class="fa-solid fa-network-wired text-[10px]"></i> Services
            </button>
          </td>
          <td class="p-3 font-mono text-slate-400 text-[11px]">${escapeHtml(ws.features_dir || "docs/features")}</td>
          <td class="p-3 text-center">${defBadge}</td>
          <td class="p-3 text-right">
              <button type="button" onclick="editWorkspace('${ws.id}')" class="text-slate-400 hover:text-brand-400 transition" title="Sửa"><i class="fa-solid fa-pen-to-square"></i></button>
              <button type="button" onclick="handleDeleteWorkspace('${ws.id}')" class="text-slate-400 hover:text-rose-400 transition" title="Xóa"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  window.editWorkspace = (id) => {
    const ws = state.workspaces.find(w => w.id === id);
    if (!ws) return;
    
    document.getElementById("wsEditId").value = ws.id;
    document.getElementById("wsFormName").value = ws.name || "";
    document.getElementById("wsFormPath").value = ws.path || "";
    document.getElementById("wsFormFeaturesDir").value = ws.features_dir || "docs/features";
    document.getElementById("wsFormIsDefault").checked = !!ws.is_default;
    
    document.getElementById("wsFormTitle").innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Sửa Workspace: <span class="text-slate-200">' + escapeHtml(ws.name || ws.path) + '</span>';
    document.getElementById("wsSubmitBtnText").innerText = "Cập nhật";
    document.getElementById("btnCancelEditWs").classList.remove("hidden");
  };

  async function handleSaveWorkspaceForm(e) {
    if (e) e.preventDefault();
    
    const id = document.getElementById("wsEditId").value;
    const name = document.getElementById("wsFormName").value.trim();
    const path = document.getElementById("wsFormPath").value.trim();
    const features_dir = document.getElementById("wsFormFeaturesDir").value.trim() || "docs/features";
    const is_default = document.getElementById("wsFormIsDefault").checked;

    if (!name || !path) {
      showToast("Vui lòng nhập Tên và Đường dẫn", "warning");
      return;
    }

    const btnSubmit = document.getElementById("btnSaveWorkspace");
    const originalText = document.getElementById("wsSubmitBtnText").innerText;
    // B17: chống double-submit form workspace
    if (btnSubmit && btnSubmit.disabled) return;
    if (btnSubmit) {
      btnSubmit.disabled = true;
      document.getElementById("wsSubmitBtnText").innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';
    }

    try {
      const payload = { name, path, features_dir, is_default };
      let res;
      if (id) {
        // Cập nhật
        res = await fetch("/api/v1/workspaces/" + id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } else {
        // Thêm mới
        res = await fetch("/api/v1/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      }

      if (!res.ok) throw new Error("Lỗi lưu workspace");
      showToast(id ? "Cập nhật thành công!" : "Thêm mới thành công!", "success");
      resetWorkspaceForm();
      await loadWorkspaces();
      renderWorkspaceTable();
      updateFeaturePathHint();
      if (typeof closeWorkspaceManagerModal === 'function') {
        closeWorkspaceManagerModal();
      }
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        document.getElementById("wsSubmitBtnText").innerText = originalText;
      }
    }
  }

  window.handleSetDefaultWorkspace = async (id) => {
    try {
      const res = await fetch("/api/v1/workspaces/" + id + "/set-default", { method: "POST" });
      if (!res.ok) throw new Error("Không thể đặt mặc định");
      showToast("Đã đặt workspace mặc định", "success");
      await loadWorkspaces();
      renderWorkspaceTable();
      updateFeaturePathHint();
    } catch(err) {
      showToast(err.message, "error");
    }
  };

  window.handleDeleteWorkspace = async (id) => {
    if (!confirm("Bạn có chắc muốn xóa workspace này khỏi danh sách quản lý? (Không xóa file thực tế)")) return;
    try {
      const res = await fetch("/api/v1/workspaces/" + id, { method: "DELETE" });
      if (!res.ok) throw new Error("Xóa thất bại");
      showToast("Đã xóa workspace", "success");
      await loadWorkspaces();
      renderWorkspaceTable();
      updateFeaturePathHint();
    } catch(err) {
      showToast(err.message, "error");
    }
  };
  // ==========================================
  // WORKSPACE SERVICES MANAGEMENT (Polyrepo)
  // ==========================================
  let currentManagingWorkspaceId = null;
  let currentWorkspaceServices = [];

  window.openWorkspaceServicesModal = async (workspaceId) => {
    currentManagingWorkspaceId = workspaceId;
    const ws = state.workspaces.find(w => w.id === workspaceId);
    if (!ws) return;

    const modal = document.getElementById("modalWorkspaceServices");
    const titleEl = document.getElementById("wsServicesModalTitle");
    const subTitleEl = document.getElementById("wsServicesModalSubtitle");
    if (titleEl) titleEl.textContent = ws.name || ws.path;
    if (subTitleEl) subTitleEl.textContent = "Đường dẫn: " + ws.path;

    if (modal) modal.classList.remove("hidden");
    resetServiceForm();
    await loadWorkspaceServices(workspaceId);
  };

  window.closeWorkspaceServicesModal = () => {
    const modal = document.getElementById("modalWorkspaceServices");
    if (modal) modal.classList.add("hidden");
    currentManagingWorkspaceId = null;
    currentWorkspaceServices = [];
  };

  async function loadWorkspaceServices(workspaceId) {
    const tbody = document.getElementById("wsServicesTableBody");
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-500"><i class="fa-solid fa-spinner fa-spin mr-1"></i> Đang tải danh sách services...</td></tr>';
    }
    try {
      // B18: timeout để bảng services không kẹt trạng thái "Đang tải..."
      const res = await fetchWithTimeout(`/api/v1/workspaces/${workspaceId}/services`, {}, 10000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('Máy chủ trả về HTTP ' + res.status);
      if (data.success) {
        currentWorkspaceServices = data.services || [];
        renderWorkspaceServicesTable(currentWorkspaceServices);
      } else {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-rose-400">Lỗi: ${escapeHtml(data.error || 'không xác định')}</td></tr>`;
      }
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-rose-400">Lỗi kết nối: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderWorkspaceServicesTable(services) {
    const tbody = document.getElementById("wsServicesTableBody");
    if (!tbody) return;

    if (!services || services.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-slate-500">Chưa có service nào trong workspace này. Bấm "Quét Dịch vụ (Auto-Scan)" hoặc "Thêm thủ công".</td></tr>';
      return;
    }

    tbody.innerHTML = services.map(s => {
      const enabledChecked = s.is_enabled ? 'checked' : '';
      return `
        <tr class="hover:bg-surface-800/50 transition">
          <td class="p-3 text-center">
            <input type="checkbox" ${enabledChecked} onchange="handleToggleService('${s.id}', this.checked)" class="w-4 h-4 rounded bg-surface-800 border-slate-700 text-indigo-500 cursor-pointer">
          </td>
          <td class="p-3 font-semibold text-slate-200">
            <i class="fa-solid fa-cube text-indigo-400 mr-1.5 text-[10px]"></i>${escapeHtml(s.service_key)}
          </td>
          <td class="p-3 font-mono text-slate-400 text-[11px]">${escapeHtml(s.repo_path)}</td>
          <td class="p-3 font-mono text-emerald-400 text-[11px]">
            <span class="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded">${escapeHtml(s.dev_branch)}</span>
          </td>
          <td class="p-3 font-mono text-slate-400 text-[11px]">
            ${s.deploy_branch ? `<span class="px-2 py-0.5 bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded">${escapeHtml(s.deploy_branch)}</span>` : '<span class="text-slate-600">—</span>'}
          </td>
          <td class="p-3 text-right">
            <div class="flex items-center justify-end gap-2">
              <button type="button" onclick="editService('${s.id}')" class="text-slate-400 hover:text-indigo-400 transition" title="Sửa"><i class="fa-solid fa-pen-to-square"></i></button>
              <button type="button" onclick="handleDeleteService('${s.id}')" class="text-slate-400 hover:text-rose-400 transition" title="Xóa"><i class="fa-solid fa-trash-can"></i></button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  function resetServiceForm() {
    const form = document.getElementById("wsServiceForm");
    if (!form) return;
    document.getElementById("serviceEditId").value = "";
    document.getElementById("serviceFormKey").value = "";
    document.getElementById("serviceFormRepoPath").value = "";
    document.getElementById("serviceFormDevBranch").value = "";
    document.getElementById("serviceFormDeployBranch").value = "";
    document.getElementById("serviceFormIsEnabled").checked = true;
    document.getElementById("serviceFormTitle").innerHTML = '<i class="fa-solid fa-plus-circle"></i> Thêm Service Mới';
    document.getElementById("serviceSubmitBtnText").textContent = "Lưu Service";
    form.classList.add("hidden");
  }

  window.editService = (serviceId) => {
    const s = currentWorkspaceServices.find(item => item.id === serviceId);
    if (!s) return;
    const form = document.getElementById("wsServiceForm");
    if (!form) return;

    form.classList.remove("hidden");
    document.getElementById("serviceEditId").value = s.id;
    document.getElementById("serviceFormKey").value = s.service_key;
    document.getElementById("serviceFormRepoPath").value = s.repo_path;
    document.getElementById("serviceFormDevBranch").value = s.dev_branch;
    document.getElementById("serviceFormDeployBranch").value = s.deploy_branch || "";
    document.getElementById("serviceFormIsEnabled").checked = Boolean(s.is_enabled);
    document.getElementById("serviceFormTitle").innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Sửa Service: <span class="text-slate-200">${escapeHtml(s.service_key)}</span>`;
    document.getElementById("serviceSubmitBtnText").textContent = "Cập nhật";
  };

  window.handleToggleService = async (serviceId, isEnabled) => {
    try {
      const res = await fetch(`/api/v1/workspaces/${currentManagingWorkspaceId}/services/${serviceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: isEnabled ? 1 : 0 })
      });
      const data = await res.json();
      if (!data.success) {
        showToast(data.error || 'Lỗi cập nhật trạng thái service', 'error');
        await loadWorkspaceServices(currentManagingWorkspaceId);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  window.handleDeleteService = async (serviceId) => {
    if (!confirm('Bạn có chắc chắn muốn xóa cấu hình service này khỏi workspace?')) return;
    try {
      const res = await fetch(`/api/v1/workspaces/${currentManagingWorkspaceId}/services/${serviceId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        showToast('Đã xóa service thành công', 'success');
        await loadWorkspaceServices(currentManagingWorkspaceId);
      } else {
        showToast(data.error || 'Lỗi khi xóa service', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  async function handleScanWorkspaceServices() {
    if (!currentManagingWorkspaceId) return;
    const btn = document.getElementById("btnScanWorkspaceServices");
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang quét...';
    }

    try {
      const res = await fetch(`/api/v1/workspaces/${currentManagingWorkspaceId}/services/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_save: true })
      });
      const data = await res.json();
      if (data.success) {
        const count = (data.detected || []).length;
        showToast(`Đã quét và cập nhật thành công ${count} service(s)!`, 'success');
        await loadWorkspaceServices(currentManagingWorkspaceId);
      } else {
        showToast(data.error || 'Lỗi quét service', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }
    }
  }

  async function handleSaveServiceForm(e) {
    if (e) e.preventDefault();
    if (!currentManagingWorkspaceId) return;

    const id = document.getElementById("serviceEditId").value;
    const service_key = document.getElementById("serviceFormKey").value.trim();
    const repo_path = document.getElementById("serviceFormRepoPath").value.trim();
    const dev_branch = document.getElementById("serviceFormDevBranch").value.trim();
    const deploy_branch = document.getElementById("serviceFormDeployBranch").value.trim();
    const is_enabled = document.getElementById("serviceFormIsEnabled").checked ? 1 : 0;

    if (!service_key || !repo_path || !dev_branch) {
      showToast('Vui lòng điền đủ Tên Service, Đường dẫn và Nhánh Dev', 'warning');
      return;
    }

    const isEdit = Boolean(id);
    const url = isEdit
      ? `/api/v1/workspaces/${currentManagingWorkspaceId}/services/${id}`
      : `/api/v1/workspaces/${currentManagingWorkspaceId}/services`;
    const method = isEdit ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_key,
          repo_path,
          dev_branch,
          deploy_branch,
          is_enabled
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast(isEdit ? 'Cập nhật service thành công' : 'Thêm service thành công', 'success');
        resetServiceForm();
        await loadWorkspaceServices(currentManagingWorkspaceId);
      } else {
        showToast(data.error || 'Lỗi lưu service', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function updateFeaturePathHint() {
    const hintEl = document.getElementById("hintWorkspacePath");
    const evidenceHintEl = document.getElementById("evidenceFolderHint");
    if (!hintEl) return;
    
    const wsId = document.getElementById("createTaskWorkspace")?.value;
    const taskCode = document.getElementById("createTaskCode")?.value.trim() || "[Mã Task]";
    
    if (!wsId || !state.workspaces) {
      hintEl.innerText = "Chưa chọn workspace";
      return;
    }
    
    // Tìm trong danh sách
    const ws = state.workspaces.find(w => w.id === wsId || w.path === wsId);
    if (ws) {
      const fdir = ws.features_dir || "docs/features";
      hintEl.innerText = ws.path + "/" + fdir + "/" + taskCode;
      if (evidenceHintEl) {
        evidenceHintEl.innerText = ws.path + "/" + fdir + "/[task_code]/evidence";
      }
    } else {
      hintEl.innerText = "Không tìm thấy thư mục lưu trữ";
    }
  }

  // ==================== FOLDER BROWSER LOGIC ====================
  let fbCurrentPath = "";
  let fbParentPath = null;
  
  const modalFB = document.getElementById("modalFolderBrowser");
  const fbBreadcrumb = document.getElementById("folderBrowserBreadcrumb");
  const fbList = document.getElementById("folderBrowserList");
  const fbBtnBack = document.getElementById("btnFolderBrowserBack");
  const wsFormPathInput = document.getElementById("wsFormPath");
  let selectedFolderPath = "";

  function openFolderBrowser() {
    const initial = wsFormPathInput?.value.trim() || "";
    selectedFolderPath = initial;
    if (modalFB) modalFB.classList.remove("hidden");
    loadFolderBrowser(initial);
  }

  function closeFolderBrowser() {
    const modalFB = document.getElementById("modalFolderBrowser");
    if (modalFB) modalFB.classList.add("hidden");
  }

  function selectFolderBrowser() {
    const wsFormPathInput = document.getElementById("wsFormPath");
    const finalPath = selectedFolderPath || fbCurrentPath;
    if (wsFormPathInput && finalPath) {
      const normalized = finalPath.replace(/\\/g, '/');
      wsFormPathInput.value = normalized;
      wsFormPathInput.dispatchEvent(new Event('input', { bubbles: true }));
      wsFormPathInput.dispatchEvent(new Event('change', { bubbles: true }));
      showToast(`Đã chọn: ${normalized}`, "success");
    }
    closeFolderBrowser();
  }

  function folderBrowserBack() {
    if (fbParentPath !== null) loadFolderBrowser(fbParentPath);
  }

  async function loadFolderBrowser(targetPath) {
    const fbList = document.getElementById("folderBrowserList");
    const fbBreadcrumb = document.getElementById("folderBrowserBreadcrumb");
    const fbBtnBack = document.getElementById("btnFolderBrowserBack");
    try {
      if (fbList) fbList.innerHTML = `<div class="flex items-center justify-center h-full text-slate-500 text-sm"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Đang tải danh sách thư mục...</div>`;

      const res = await fetchWithTimeout("/api/v1/workspaces/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPath: targetPath })
      }, 10000);
      if (!res.ok) throw new Error("Máy chủ trả về HTTP " + res.status);
      const data = await res.json();
      fbCurrentPath = data.currentPath || "";
      fbParentPath = data.parentPath;
      selectedFolderPath = fbCurrentPath;

      // Render breadcrumb
      if (fbBreadcrumb) {
        fbBreadcrumb.innerText = fbCurrentPath === "" || fbCurrentPath === "/" ? "Máy tính này / Root" : fbCurrentPath;
      }

      // Back button
      if (fbBtnBack) {
        fbBtnBack.disabled = (fbCurrentPath === "" || fbCurrentPath === "/" || data.parentPath === null);
      }

      // Render folder list
      if (fbList) {
        if (!data.folders || data.folders.length === 0) {
          fbList.innerHTML = `<div class="text-center text-slate-500 text-xs py-4">Không có thư mục con nào.</div>`;
        } else {
          fbList.innerHTML = data.folders.map(f => {
            const isSelected = selectedFolderPath && (selectedFolderPath === f.path || selectedFolderPath === f.path.replace(/[\\/]$/, ''));
            return `
              <div class="flex items-center justify-between p-2 hover:bg-surface-800 rounded-lg cursor-pointer transition text-sm ${isSelected ? 'bg-brand-500/20 text-brand-300 font-semibold' : 'text-slate-300'} folder-item" data-folder-path="${encodeURIComponent(f.path)}">
                <div class="flex items-center gap-2 truncate">
                  <i class="fa-solid fa-folder text-brand-400 flex-shrink-0"></i>
                  <span class="truncate">${escapeHtml(f.name)}</span>
                </div>
                <button type="button" class="btn-enter-folder px-2 py-0.5 rounded text-[11px] bg-surface-700 hover:bg-surface-600 text-slate-300" title="Mở thư mục này">
                  Mở <i class="fa-solid fa-arrow-right ml-1"></i>
                </button>
              </div>
            `;
          }).join("");

          fbList.querySelectorAll('.folder-item').forEach(el => {
            const p = decodeURIComponent(el.getAttribute('data-folder-path'));
            // Click chọn
            el.addEventListener('click', (e) => {
              if (e.target.closest('.btn-enter-folder')) return;
              selectedFolderPath = p;
              fbList.querySelectorAll('.folder-item').forEach(item => item.classList.remove('bg-brand-500/20', 'text-brand-300', 'font-semibold'));
              el.classList.add('bg-brand-500/20', 'text-brand-300', 'font-semibold');
            });
            // Double click hoặc bấm nút Mở để vào trong
            el.addEventListener('dblclick', () => loadFolderBrowser(p));
            el.querySelector('.btn-enter-folder')?.addEventListener('click', (e) => {
              e.stopPropagation();
              loadFolderBrowser(p);
            });
          });
        }
      }
    } catch (err) {
      if (fbList) fbList.innerHTML = `<div class="text-center text-rose-400 text-xs py-4"><i class="fa-solid fa-triangle-exclamation mr-1"></i> ${err.message}</div>`;
    }
  }

  // Setup event listeners for Folder Browser
  document.getElementById("btnWsBrowseFolder")?.addEventListener("click", openFolderBrowser);
  document.getElementById("btnCloseFolderBrowser")?.addEventListener("click", closeFolderBrowser);
  document.getElementById("btnCancelFolderBrowser")?.addEventListener("click", closeFolderBrowser);
  fbBtnBack?.addEventListener("click", () => {
    if (fbParentPath !== null) loadFolderBrowser(fbParentPath);
  });

  document.getElementById("btnSelectFolderBrowser")?.addEventListener("click", () => {
    const finalPath = selectedFolderPath || fbCurrentPath;
    if (wsFormPathInput && finalPath) {
      // Chuẩn hóa dấu gạch chéo sang / để tránh lỗi escape ký tự Windows
      const normalized = finalPath.replace(/\\/g, '/');
      wsFormPathInput.value = normalized;
      wsFormPathInput.dispatchEvent(new Event('input', { bubbles: true }));
      wsFormPathInput.dispatchEvent(new Event('change', { bubbles: true }));
      showToast(`Đã chọn: ${normalized}`, "success");
    }
    closeFolderBrowser();
  });

  // =========================================================================
  // CLONE TASK FEATURE (NHÂN BẢN TASK)
  // =========================================================================
  function openCloneTaskModal(jobId) {
    const targetId = jobId || state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!targetId) {
      showToast('Vui lòng chọn một Task để nhân bản', 'warning');
      return;
    }
    const job = (state.jobs && state.jobs.find(j => j.id === targetId || j.task_code === targetId)) || (state.activeJob && (state.activeJob.id === targetId || state.activeJob.task_code === targetId) ? state.activeJob : null);
    if (!job) { showToast('Không tìm thấy dữ liệu Task để nhân bản', 'warning'); return; }

    const modal = document.getElementById('cloneTaskModal');
    const sourceInfo = document.getElementById('cloneSourceTaskInfo');
    const inputCode = document.getElementById('newCloneTaskCode');
    const errText = document.getElementById('cloneTaskError');

    if (modal) modal.dataset.targetId = targetId;
    if (sourceInfo) {
      sourceInfo.innerHTML = `<strong>[${escapeHtml(job.task_code || job.id)}]</strong> ${escapeHtml(job.title || '')}<br><span class="text-slate-400 text-[11px]">Workspace: ${escapeHtml(job.repo_path || './')} | Branch: ${escapeHtml(job.base_branch || job.branch || 'main')}</span>`;
    }
    if (inputCode) {
      const curCode = job.task_code || 'TASK-01';
      let suggestedCode = curCode + '-CLONE';
      const numMatch = curCode.match(/(.*?)(\d+)$/);
      if (numMatch) {
        const prefix = numMatch[1];
        const nextNum = parseInt(numMatch[2], 10) + 1;
        suggestedCode = `${prefix}${String(nextNum).padStart(numMatch[2].length, '0')}`;
      }
      inputCode.value = suggestedCode;
    }
    if (errText) {
      errText.classList.add('hidden');
      errText.textContent = '';
    }
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => {
      inputCode?.focus();
      inputCode?.select();
    }, 50);
  }

  function closeCloneTaskModal() {
    const modal = document.getElementById('cloneTaskModal');
    if (modal) modal.classList.add('hidden');
  }

  document.getElementById('closeCloneModalBtn')?.addEventListener('click', closeCloneTaskModal);
  document.getElementById('cancelCloneModalBtn')?.addEventListener('click', closeCloneTaskModal);

  document.getElementById('cloneTaskForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const modalTargetId = document.getElementById('cloneTaskModal')?.dataset?.targetId;
    const targetId = modalTargetId || state.activeJobId || (state.activeJob && state.activeJob.id);

    const inputCode = document.getElementById('newCloneTaskCode');
    const errText = document.getElementById('cloneTaskError');
    const submitBtn = document.getElementById('submitCloneTaskBtn');
    const newTaskCode = inputCode ? inputCode.value.trim() : '';

    if (!newTaskCode) {
      if (errText) {
        errText.textContent = 'Mã task mới là bắt buộc!';
        errText.classList.remove('hidden');
      }
      return;
    }

    if (errText) errText.classList.add('hidden');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Đang tạo...';
    }

    try {
      const res = await fetch(`/api/v1/jobs/${targetId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newTaskCode })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        showToast(data.message || `Đã clone task thành công thành ${newTaskCode}!`, 'success');
        closeCloneTaskModal();
        await fetchJobsList(true);
        if (data.job && data.job.id) {
          selectJob(data.job.id);
        }
      } else {
        if (errText) {
          errText.textContent = data.error || 'Lỗi khi nhân bản task';
          errText.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (errText) {
        errText.textContent = 'Lỗi kết nối server: ' + err.message;
        errText.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-copy mr-1"></i> <span>Tạo Task Clone</span>';
      }
    }
  });
  // =========================================================================
  // WORKER SYSTEM LOGS MODAL (Hiển thị dạng Code, Nền đen & Load theo Chunk)
  // =========================================================================
  let workerLogsEventSource = null;
  let workerLogsAutoScroll = true;
  let workerLogsFilter = '';
  let workerLogsEntries = [];
  let workerLogsStartLine = 0;
  let workerLogsEndLine = 0;
  let workerLogsTotalLines = 0;
  let workerLogsHasMoreOlder = false;
  let workerLogsIsLoadingOlder = false;
  const WORKER_LOGS_CHUNK_SIZE = 100;

  function colorizeCodeLog(text, isError) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    if (isError || /\[ERROR\]|Unhandled|Error:|Failed|FAIL/i.test(text)) {
      return `<span class="text-rose-400 font-semibold">${escaped}</span>`;
    }
    if (/\[WARN\]|Warning:|WARNING/i.test(text)) {
      return `<span class="text-amber-300">${escaped}</span>`;
    }
    if (/\[BOOT\]|✓|Sẵn sàng/i.test(text)) {
      return `<span class="text-emerald-400">${escaped}</span>`;
    }
    if (/\[TIMEOUT\]/i.test(text)) {
      return `<span class="text-rose-300 font-bold bg-rose-950/60 px-1 rounded">${escaped}</span>`;
    }
    if (/(GET|POST|PATCH|PUT|DELETE)\s+\/api\/v1\/\S+/i.test(text)) {
      return escaped.replace(/(GET|POST|PATCH|PUT|DELETE)\s+(\/api\/v1\/\S+)\s+(\d{3})/i, (m, meth, url, status) => {
        const methColor = meth === 'GET' ? 'text-sky-400' : (meth === 'POST' ? 'text-emerald-400' : (meth === 'DELETE' ? 'text-rose-400' : 'text-purple-400'));
        const statusColor = status.startsWith('2') ? 'text-emerald-400' : (status.startsWith('4') || status.startsWith('5') ? 'text-rose-400' : 'text-slate-400');
        return `<span class="${methColor} font-bold">${meth}</span> <span class="text-slate-200">${url}</span> <span class="${statusColor} font-bold">${status}</span>`;
      });
    }
    return `<span class="text-slate-300">${escaped}</span>`;
  }

  function createLogLineRow(entry) {
    const row = document.createElement('div');
    row.className = 'flex items-baseline hover:bg-[#121212] py-[0.5px] px-1 font-mono text-[10.5px] leading-[16px] select-text transition-colors';
    row.dataset.lineNum = entry.lineNum || '';

    const lineNumStr = entry.lineNum ? String(entry.lineNum) : '';
    row.innerHTML = `<span class="text-zinc-600 select-none text-right pr-2 pl-0.5 w-12 shrink-0 font-mono text-[10px] border-r border-[#1a1a1a] mr-2">${lineNumStr}</span>
      <div class="flex-1 whitespace-pre font-mono text-zinc-300">${colorizeCodeLog(entry.text, entry.isError)}</div>`;
    return row;
  }

  function updateFooterInfo() {
    const rangeLabel = document.getElementById('workerLogsRangeLabel');
    const totalLabel = document.getElementById('workerLogsTotalLabel');
    const reachedStartEl = document.getElementById('workerLogsReachedStart');
    const loadOlderBtn = document.getElementById('btnLoadOlderWorkerLogs');

    if (rangeLabel) rangeLabel.textContent = `${workerLogsStartLine || 0} - ${workerLogsEndLine || 0}`;
    if (totalLabel) totalLabel.textContent = `${workerLogsTotalLines || 0} dòng`;

    if (reachedStartEl) {
      if (workerLogsStartLine <= 1 && workerLogsEntries.length > 0) {
        reachedStartEl.classList.remove('hidden');
      } else {
        reachedStartEl.classList.add('hidden');
      }
    }

    if (loadOlderBtn) {
      if (workerLogsHasMoreOlder && workerLogsStartLine > 1) {
        loadOlderBtn.classList.remove('opacity-40', 'pointer-events-none');
        loadOlderBtn.title = 'Tải thêm log cũ hơn';
      } else {
        loadOlderBtn.classList.add('opacity-40', 'pointer-events-none');
        loadOlderBtn.title = 'Đã tải hết log cũ nhất';
      }
    }
  }

  function renderAllWorkerLogs(preserveScrollBottom = false) {
    const container = document.getElementById('workerLogsContainer');
    if (!container) return;

    const filterTerm = workerLogsFilter.toLowerCase();
    const visibleEntries = filterTerm
      ? workerLogsEntries.filter(e => (e.text || '').toLowerCase().includes(filterTerm))
      : workerLogsEntries;

    if (visibleEntries.length === 0) {
      container.innerHTML = `<div class="text-slate-500 italic py-6 text-center">${filterTerm ? 'Không có dòng log nào khớp với từ khóa tìm kiếm.' : 'Chưa có nhật ký ghi nhận.'}</div>`;
      updateFooterInfo();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const entry of visibleEntries) {
      frag.appendChild(createLogLineRow(entry));
    }

    container.innerHTML = '';
    container.appendChild(frag);
    updateFooterInfo();

    if (preserveScrollBottom || workerLogsAutoScroll) {
      container.scrollTop = container.scrollHeight;
    }
  }

  // B14: đổi tên để không trùng với loadOlderLogs của Live Terminal
  async function loadOlderWorkerLogs() {
    if (workerLogsIsLoadingOlder || !workerLogsHasMoreOlder || workerLogsStartLine <= 1) {
      return;
    }

    workerLogsIsLoadingOlder = true;
    const loadingBanner = document.getElementById('workerLogsLoadingOlder');
    if (loadingBanner) loadingBanner.classList.remove('hidden');

    const container = document.getElementById('workerLogsContainer');
    const prevScrollHeight = container ? container.scrollHeight : 0;
    const prevScrollTop = container ? container.scrollTop : 0;

    try {
      const targetEndLine = workerLogsStartLine - 1;
      const res = await fetch(`/api/v1/system/logs?endLine=${targetEndLine}&limit=${WORKER_LOGS_CHUNK_SIZE}`);
      const data = await res.json();

      if (res.ok && data.success && Array.isArray(data.logs) && data.logs.length > 0) {
        // Prepend vào danh sách entries
        workerLogsEntries = [...data.logs, ...workerLogsEntries];
        workerLogsStartLine = data.startLine;
        workerLogsHasMoreOlder = data.hasMoreOlder;
        workerLogsTotalLines = data.totalLines;

        // Prepend các elements vào container
        if (container) {
          const filterTerm = workerLogsFilter.toLowerCase();
          const visibleNewLogs = filterTerm
            ? data.logs.filter(e => (e.text || '').toLowerCase().includes(filterTerm))
            : data.logs;

          const frag = document.createDocumentFragment();
          for (const entry of visibleNewLogs) {
            frag.appendChild(createLogLineRow(entry));
          }

          container.insertBefore(frag, container.firstChild);

          // Giữ vị trí cuộn mượt mà
          const newScrollHeight = container.scrollHeight;
          container.scrollTop = newScrollHeight - prevScrollHeight + prevScrollTop;
        }

        updateFooterInfo();
      } else {
        workerLogsHasMoreOlder = false;
        updateFooterInfo();
      }
    } catch (err) {
      console.warn('Lỗi khi tải log cũ:', err);
    } finally {
      workerLogsIsLoadingOlder = false;
      if (loadingBanner) loadingBanner.classList.add('hidden');
    }
  }

  async function loadLatestChunkAndConnect() {
    const container = document.getElementById('workerLogsContainer');
    if (container) {
      container.innerHTML = '<div class="text-slate-500 italic py-6 text-center"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Đang tải chunk log mới nhất...</div>';
    }

    workerLogsEntries = [];
    workerLogsStartLine = 0;
    workerLogsEndLine = 0;
    workerLogsTotalLines = 0;
    workerLogsHasMoreOlder = false;

    try {
      const res = await fetch(`/api/v1/system/logs?limit=${WORKER_LOGS_CHUNK_SIZE}`);
      const data = await res.json();

      if (res.ok && data.success && Array.isArray(data.logs)) {
        workerLogsEntries = data.logs;
        workerLogsStartLine = data.startLine;
        workerLogsEndLine = data.endLine;
        workerLogsTotalLines = data.totalLines;
        workerLogsHasMoreOlder = data.hasMoreOlder;
        renderAllWorkerLogs(true);
      }
    } catch (e) {
      if (container) {
        container.innerHTML = `<div class="text-rose-400 italic py-6 text-center">Lỗi tải log ban đầu: ${e.message}</div>`;
      }
    }

    // Kết nối SSE realtime
    if (workerLogsEventSource) {
      workerLogsEventSource.close();
      workerLogsEventSource = null;
    }

    workerLogsEventSource = new EventSource('/api/v1/system/logs/stream');

    workerLogsEventSource.addEventListener('log', (e) => {
      try {
        const entry = JSON.parse(e.data);
        workerLogsEndLine++;
        workerLogsTotalLines = Math.max(workerLogsTotalLines, workerLogsEndLine);
        if (workerLogsStartLine === 0) workerLogsStartLine = workerLogsEndLine;

        const fullEntry = {
          lineNum: workerLogsEndLine,
          text: entry.text,
          isError: entry.isError
        };

        workerLogsEntries.push(fullEntry);
        // Giữ buffer RAM hợp lý (tối đa 2500 dòng)
        if (workerLogsEntries.length > 2500) {
          workerLogsEntries.shift();
          workerLogsStartLine++;
        }

        // Kiểm tra filter
        if (!workerLogsFilter || (entry.text || '').toLowerCase().includes(workerLogsFilter.toLowerCase())) {
          if (container) {
            // Xóa thông báo placeholder nếu có
            const emptyNotice = container.querySelector('.text-slate-500');
            if (emptyNotice && workerLogsEntries.length === 1) {
              container.innerHTML = '';
            }

            container.appendChild(createLogLineRow(fullEntry));

            // Xóa DOM cũ nếu vượt quá 1200 nodes để không bị lag DOM
            while (container.childNodes.length > 1200) {
              container.removeChild(container.firstChild);
            }

            if (workerLogsAutoScroll) {
              container.scrollTop = container.scrollHeight;
            }
          }
        }
        updateFooterInfo();
      } catch (err) {}
    });

    workerLogsEventSource.onerror = () => {
      const badge = document.getElementById('workerLogsLiveBadge');
      if (badge) {
        badge.className = 'flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[10px] font-semibold';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span><span>Mất kết nối</span>';
      }
    };

    workerLogsEventSource.onopen = () => {
      const badge = document.getElementById('workerLogsLiveBadge');
      if (badge) {
        badge.className = 'flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-semibold';
        badge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>Live Streaming</span>';
      }
    };
  }

  function openWorkerLogsModal() {
    const modal = document.getElementById('workerLogsModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    loadLatestChunkAndConnect();
  }

  function closeWorkerLogsModal() {
    const modal = document.getElementById('workerLogsModal');
    if (modal) modal.classList.add('hidden');
    if (workerLogsEventSource) {
      workerLogsEventSource.close();
      workerLogsEventSource = null;
    }
  }

  // Khởi tạo các event listeners cho Worker Logs
  document.getElementById('btnOpenWorkerLogsModal')?.addEventListener('click', openWorkerLogsModal);
  document.getElementById('btnCloseWorkerLogsModal')?.addEventListener('click', closeWorkerLogsModal);
  document.getElementById('workerLogsModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'workerLogsModal') closeWorkerLogsModal();
  });

  // Lắng nghe sự kiện lăn chuột lên đỉnh để tự động load chunk cũ hơn (Infinite Scroll Upwards)
  const logsContainer = document.getElementById('workerLogsContainer');
  logsContainer?.addEventListener('scroll', () => {
    if (logsContainer.scrollTop < 40 && workerLogsHasMoreOlder && !workerLogsIsLoadingOlder) {
      loadOlderWorkerLogs();
    }
  });

  // Nút bấm thủ công "Tải log cũ"
  document.getElementById('btnLoadOlderWorkerLogs')?.addEventListener('click', loadOlderWorkerLogs);

  document.getElementById('btnToggleWorkerLogsAutoScroll')?.addEventListener('click', () => {
    workerLogsAutoScroll = !workerLogsAutoScroll;
    const label = document.getElementById('workerLogsAutoScrollLabel');
    const btn = document.getElementById('btnToggleWorkerLogsAutoScroll');
    if (label) label.textContent = workerLogsAutoScroll ? 'ON' : 'OFF';
    if (btn) {
      btn.className = workerLogsAutoScroll
        ? 'px-2.5 py-1 rounded-lg text-xs bg-surface-800 text-emerald-400 border border-slate-700 hover:bg-surface-750 transition flex items-center gap-1.5'
        : 'px-2.5 py-1 rounded-lg text-xs bg-surface-800 text-slate-400 border border-slate-700 hover:bg-surface-750 transition flex items-center gap-1.5';
    }
    if (workerLogsAutoScroll && logsContainer) {
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  });

  document.getElementById('workerLogsFilterInput')?.addEventListener('input', (e) => {
    workerLogsFilter = e.target.value.trim();
    renderAllWorkerLogs(false);
  });

  document.getElementById('btnRefreshWorkerLogs')?.addEventListener('click', () => {
    loadLatestChunkAndConnect();
    showToast('Đã làm mới logs mới nhất!', 'info');
  });

  document.getElementById('btnCopyWorkerLogs')?.addEventListener('click', () => {
    const text = workerLogsEntries.map(e => e.text).join('\n');
    if (!text) {
      showToast('Chưa có log nào để sao chép', 'warning');
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      showToast('Đã sao chép toàn bộ logs vào Clipboard!', 'success');
    }).catch(() => {
      showToast('Không thể sao chép logs', 'error');
    });
  });

  document.getElementById('btnClearWorkerLogsView')?.addEventListener('click', () => {
    workerLogsEntries = [];
    workerLogsStartLine = 0;
    workerLogsEndLine = 0;
    if (logsContainer) logsContainer.innerHTML = '<div class="text-slate-500 italic py-6 text-center">Đã xóa màn hình hiển thị. Đang chờ log mới...</div>';
    updateFooterInfo();
    showToast('Đã xóa màn hình hiển thị log', 'info');
  });

  document.getElementById('btnClearServerLogFile')?.addEventListener('click', async () => {
    if (!confirm('Bạn có chắc chắn muốn xóa sạch toàn bộ file logs của máy chủ worker trên ổ đĩa không?')) {
      return;
    }
    try {
      const res = await fetch('/api/v1/system/logs', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        workerLogsEntries = [];
        workerLogsStartLine = 0;
        workerLogsEndLine = 0;
        workerLogsTotalLines = 0;
        workerLogsHasMoreOlder = false;
        if (logsContainer) logsContainer.innerHTML = '<div class="text-slate-500 italic py-6 text-center">Toàn bộ logs trên máy chủ đã được làm trống.</div>';
        updateFooterInfo();
        showToast('Đã làm trống toàn bộ file log trên server!', 'success');
      } else {
        showToast(data.error || 'Lỗi khi xóa log', 'error');
      }
    } catch (e) {
      showToast('Lỗi kết nối: ' + e.message, 'error');
    }
  });

  // Hỗ trợ phím ESC để đóng modal
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('workerLogsModal');
      if (modal && !modal.classList.contains('hidden')) {
        closeWorkerLogsModal();
      }
    }
  });

  window.aiWorker.openWorkerLogsModal = openWorkerLogsModal;
  window.aiWorker.closeWorkerLogsModal = closeWorkerLogsModal;
  window.aiWorker.openCloneTaskModal = openCloneTaskModal;
  window.aiWorker.closeCloneTaskModal = closeCloneTaskModal;
  // Cho phép kiểm thử/giám sát nhanh thanh thông báo từ console.
  window.aiWorker.renderTaskAlertSections = renderTaskAlertSections;
  window.aiWorker.syncTaskAlertBar = syncTaskAlertBar;
  window.aiWorker.openTaskAlertModal = openTaskAlertModal;
  window.aiWorker.closeTaskAlertModal = closeTaskAlertModal;
  window.aiWorker.jobIdFromHash = jobIdFromHash;

  // =========================================================================
  // PROCESS JANITOR (Dọn tiến trình rác)
  // =========================================================================
  let janitorAutoRefreshTimer = null;
  let janitorRunsCache = [];
  let janitorSelectedRunId = null;
  let janitorIsRunning = false;

  // Định dạng mốc thời gian ISO -> chuỗi đọc được. Chỉ dùng cho textContent.
  function formatJanitorDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('vi-VN', { hour12: false });
  }

  // Định dạng thời lượng (ms) ngắn gọn cho danh sách và thẻ tóm tắt.
  function formatJanitorDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
    const totalSeconds = Math.floor(value / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }

  function janitorTriggerLabel(trigger) {
    const raw = (trigger === undefined || trigger === null) ? '' : String(trigger).trim();
    const key = raw.toLowerCase();
    if (key === 'manual') return 'Thủ công';
    if (key === 'auto' || key === 'schedule' || key === 'interval') return 'Tự động';
    if (key === 'startup' || key === 'boot') return 'Khởi động';
    return raw || 'Không rõ';
  }

  function showJanitorError(message) {
    const banner = document.getElementById('janitorErrorBanner');
    const text = document.getElementById('janitorErrorText');
    if (text) text.textContent = message || 'Đã xảy ra lỗi không xác định.';
    if (banner) banner.classList.remove('hidden');
  }

  function clearJanitorError() {
    const banner = document.getElementById('janitorErrorBanner');
    if (banner) banner.classList.add('hidden');
  }

  function updateJanitorStatusUI(status) {
    const chip = document.getElementById('janitorStatusChip');
    const info = document.getElementById('janitorScheduleInfo');
    const enabled = Boolean(status && status.enabled);

    if (chip) {
      chip.textContent = enabled ? 'BẬT' : 'TẮT';
      chip.className = enabled ? 'janitor-chip is-on' : 'janitor-chip is-off';
    }

    if (info) {
      if (!status) {
        info.textContent = 'Không đọc được trạng thái Janitor.';
      } else {
        const parts = [];
        const intervalMs = Number(status.interval_ms) || 0;
        parts.push(intervalMs >= 60000
          ? `Quét mỗi ${Math.round(intervalMs / 60000)} phút`
          : (intervalMs > 0 ? `Quét mỗi ${Math.round(intervalMs / 1000)} giây` : 'Chưa rõ chu kỳ quét'));
        if (status.enabled) {
          parts.push(status.next_run_at
            ? `lần chạy tới ${formatJanitorDateTime(status.next_run_at)}`
            : 'chưa có lịch chạy tới');
        } else {
          parts.push('tự động tắt, chỉ chạy thủ công');
        }
        if (status.running) parts.push('đang chạy...');
        if (status.dry_run) parts.push('chế độ mô phỏng (dry-run)');
        const cfg = status.config || {};
        if (cfg.grace_minutes !== undefined && cfg.grace_minutes !== null) {
          parts.push(`ân hạn ${cfg.grace_minutes} phút`);
        }
        info.textContent = parts.join(' · ');
      }
      // Giữ nguyên chuỗi đầy đủ khi bị truncate trên màn hình hẹp.
      info.title = info.textContent;
    }

    const runBtn = document.getElementById('btnJanitorRunNow');
    if (runBtn) runBtn.disabled = Boolean(janitorIsRunning || (status && status.running));
  }

  function startJanitorAutoRefresh() {
    stopJanitorAutoRefresh();
    janitorAutoRefreshTimer = setInterval(() => {
      const modal = document.getElementById('janitorModal');
      if (!modal || modal.classList.contains('hidden')) {
        stopJanitorAutoRefresh();
        return;
      }
      loadJanitorStatus();
    }, 15000);
  }

  function stopJanitorAutoRefresh() {
    if (janitorAutoRefreshTimer) {
      clearInterval(janitorAutoRefreshTimer);
      janitorAutoRefreshTimer = null;
    }
  }

  async function loadJanitorStatus() {
    try {
      const res = await fetchWithTimeout('/api/v1/janitor/status', {}, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      updateJanitorStatusUI(data || {});
      // Tự xoá banner lỗi cũ nếu đây là lỗi trạng thái và lần này đã tải được.
      const banner = document.getElementById('janitorErrorBanner');
      const errorText = document.getElementById('janitorErrorText');
      if (banner && !banner.classList.contains('hidden')
        && errorText && errorText.textContent.indexOf('trạng thái Janitor') !== -1) {
        clearJanitorError();
      }
      return data;
    } catch (err) {
      updateJanitorStatusUI(null);
      showJanitorError('Không tải được trạng thái Janitor: ' + (err.message || 'lỗi kết nối'));
      return null;
    }
  }

  function renderJanitorRunsList() {
    const list = document.getElementById('janitorRunsList');
    const countEl = document.getElementById('janitorRunsCount');
    if (countEl) countEl.textContent = String(janitorRunsCache.length);
    if (!list) return;

    if (!janitorRunsCache.length) {
      list.innerHTML = `
        <div class="text-[11px] text-slate-500 italic py-8 px-3 text-center leading-relaxed">
          <i class="fa-solid fa-broom block text-xl mb-1.5 text-slate-600"></i>
          Chưa có lần dọn tiến trình nào.<br>Bấm "Chạy ngay" hoặc chờ lịch quét tự động.
        </div>`;
      return;
    }

    list.innerHTML = janitorRunsCache.map((run) => {
      const runId = (run && run.id) ? String(run.id) : '';
      const active = Boolean(runId) && runId === String(janitorSelectedRunId || '');
      const killed = Number(run && run.killed) || 0;
      const ports = (run && Array.isArray(run.freed_ports)) ? run.freed_ports : [];
      const isRunning = Boolean(run) && !run.finished_at;
      const triggerCls = String((run && run.trigger) || '').toLowerCase() === 'manual'
        ? 'janitor-tag is-manual'
        : 'janitor-tag';
      const itemCls = active ? 'janitor-run-item active' : 'janitor-run-item';
      return `
        <button type="button" data-janitor-run-id="${escapeHtml(runId)}" class="w-full text-left px-2.5 py-2 rounded-lg border transition ${itemCls}">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-semibold ${active ? 'janitor-accent' : 'text-slate-200'} truncate">${escapeHtml(formatJanitorDateTime(run && run.started_at))}</span>
            <span class="${triggerCls} shrink-0">${escapeHtml(janitorTriggerLabel(run && run.trigger))}</span>
          </div>
          <div class="mt-1 flex items-center gap-2 text-[10px] flex-wrap">
            <span class="${killed > 0 ? 'text-rose-300' : 'text-slate-500'}"><i class="fa-solid fa-broom mr-1"></i>Đã dọn ${killed}</span>
            <span class="text-slate-500"><i class="fa-solid fa-network-wired mr-1"></i>${ports.length ? 'Port ' + escapeHtml(ports.join(', ')) : 'Không port'}</span>
            <span class="text-slate-500 font-mono">${escapeHtml(formatJanitorDuration(run && run.duration_ms))}</span>
            ${isRunning ? '<span class="text-amber-300"><i class="fa-solid fa-spinner fa-spin"></i> đang chạy</span>' : ''}
          </div>
        </button>`;
    }).join('');
  }

  // Trả về mảng runs khi thành công, null khi lỗi (để không xoá trạng thái lỗi đang hiển thị).
  async function loadJanitorRuns() {
    try {
      const res = await fetchWithTimeout('/api/v1/janitor/runs?limit=30', {}, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const runs = Array.isArray(data) ? data : ((data && Array.isArray(data.runs)) ? data.runs : []);
      janitorRunsCache = runs;
      renderJanitorRunsList();
      return runs;
    } catch (err) {
      janitorRunsCache = [];
      renderJanitorRunsList();
      setJanitorDetailState('error', 'Không tải được lịch sử dọn tiến trình: ' + (err.message || 'lỗi kết nối'));
      showJanitorError('Không tải được lịch sử dọn tiến trình: ' + (err.message || 'lỗi kết nối'));
      return null;
    }
  }

  // kind: 'ready' | 'empty' | 'loading' | 'error'
  function setJanitorDetailState(kind, message) {
    const emptyEl = document.getElementById('janitorDetailEmpty');
    const contentEl = document.getElementById('janitorDetailContent');

    if (kind === 'ready') {
      if (emptyEl) emptyEl.classList.add('hidden');
      if (contentEl) contentEl.classList.remove('hidden');
      return;
    }

    if (contentEl) contentEl.classList.add('hidden');
    if (emptyEl) {
      const icon = kind === 'error'
        ? 'fa-triangle-exclamation text-rose-400'
        : (kind === 'loading' ? 'fa-spinner fa-spin text-slate-500' : 'fa-broom text-slate-600');
      emptyEl.classList.remove('hidden');
      emptyEl.innerHTML = `<i class="fa-solid ${icon} block text-xl mb-1.5"></i>${escapeHtml(message || '')}`;
    }
  }

  function renderJanitorRunDetail(run) {
    const report = (run && run.report) || {};
    const killedList = Array.isArray(run && run.killed_list)
      ? run.killed_list
      : (Array.isArray(report.killed_list) ? report.killed_list : []);
    const protectedList = Array.isArray(run && run.protected_list)
      ? run.protected_list
      : (Array.isArray(report.protected_list) ? report.protected_list : []);
    const errors = Array.isArray(run && run.errors)
      ? run.errors
      : (Array.isArray(report.errors) ? report.errors : []);
    // Log có thể là mảng dòng (đúng hợp đồng API) hoặc chuỗi thô (fallback phòng thủ).
    const rawLog = (run && run.log !== undefined && run.log !== null) ? run.log : report.log;
    let logLines = [];
    if (Array.isArray(rawLog)) {
      logLines = rawLog;
    } else if (typeof rawLog === 'string') {
      logLines = rawLog.split(/\r?\n/);
    }
    const ports = Array.isArray(run && run.freed_ports) ? run.freed_ports : [];
    const scanned = Number(run && run.scanned) || 0;
    const killed = Number(run && run.killed) || 0;
    const protectedCount = (run && run.protected_count !== undefined && run.protected_count !== null)
      ? Number(run.protected_count) || 0
      : protectedList.length;
    const isRunning = Boolean(run) && !run.finished_at;

    const titleEl = document.getElementById('janitorRunDetailTitle');
    if (titleEl) {
      const runId = (run && run.id) ? String(run.id) : '';
      titleEl.textContent = runId ? `${formatJanitorDateTime(run.started_at)} · ${runId.slice(0, 8)}` : '';
    }

    // Thẻ tóm tắt
    const summary = document.getElementById('janitorRunSummary');
    if (summary) {
      const cards = [
        { label: 'Quét', value: String(scanned), icon: 'fa-magnifying-glass', cls: 'text-slate-200' },
        { label: 'Đã dọn', value: String(killed), icon: 'fa-broom', cls: killed > 0 ? 'text-rose-300' : 'text-slate-300' },
        { label: 'Bảo vệ', value: String(protectedCount), icon: 'fa-shield-halved', cls: 'text-emerald-300' },
        { label: 'Thời lượng', value: formatJanitorDuration(run && run.duration_ms), icon: 'fa-stopwatch', cls: 'text-slate-300' }
      ];
      summary.innerHTML = cards.map((card) => `
        <div class="janitor-stat">
          <div class="text-[9px] uppercase tracking-wider text-slate-500 flex items-center gap-1"><i class="fa-solid ${card.icon} text-[9px]"></i>${escapeHtml(card.label)}</div>
          <div class="text-sm font-mono font-semibold ${card.cls} mt-0.5">${escapeHtml(card.value)}</div>
        </div>`).join('');
    }

    // Dòng meta: trigger, port giải phóng, trạng thái
    const meta = document.getElementById('janitorRunMeta');
    if (meta) {
      const dryRun = Boolean(run && run.dry_run) || Boolean(report.dry_run);
      meta.innerHTML = `
        <span class="px-1.5 py-0.5 rounded bg-surface-800 border border-slate-700">Trigger: ${escapeHtml(janitorTriggerLabel(run && run.trigger))}</span>
        <span>Port giải phóng: ${ports.length ? escapeHtml(ports.join(', ')) : '—'}</span>
        ${dryRun ? '<span class="janitor-accent"><i class="fa-solid fa-flask mr-1"></i>Dry-run: chỉ mô phỏng, không kill</span>' : ''}
        ${isRunning ? '<span class="text-amber-300"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Đang chạy...</span>' : ''}`;
    }

    // Bảng tiến trình đã dọn
    const killedWrap = document.getElementById('janitorRunKilledWrap');
    if (killedWrap) {
      if (!killedList.length) {
        killedWrap.innerHTML = `
          <div class="janitor-stat text-center text-[11px] text-slate-500 italic">
            <i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>Không có tiến trình nào bị dọn trong lần chạy này.
          </div>`;
      } else {
        const rows = killedList.map((proc) => {
          const item = proc || {};
          const pid = (item.rootPid !== undefined && item.rootPid !== null) ? item.rootPid : item.pid;
          const killedOk = item.killed === true;
          const dryRunItem = Boolean(item.dry_run);
          const statusCls = killedOk ? 'text-emerald-400' : (dryRunItem ? 'janitor-accent' : 'text-rose-400');
          const statusText = killedOk ? 'Đã kill' : (dryRunItem ? 'Mô phỏng' : 'Thất bại');
          const portText = Array.isArray(item.port) ? item.port.join(', ') : item.port;
          const ageText = (item.ageMinutes !== undefined && item.ageMinutes !== null) ? item.ageMinutes : null;
          const cmdTitle = item.cmd || item.name || '';
          return `
            <tr>
              <td class="font-mono text-slate-400">${escapeHtml(pid !== undefined && pid !== null ? pid : '—')}</td>
              <td class="janitor-cell-name text-slate-200 truncate" title="${escapeHtml(cmdTitle)}">${escapeHtml(item.name || '—')}</td>
              <td class="janitor-cell-reason text-slate-400 truncate" title="${escapeHtml(item.reason || '')}">${escapeHtml(item.reason || '—')}</td>
              <td class="font-mono text-slate-400">${(portText !== undefined && portText !== null && portText !== '') ? escapeHtml(portText) : '—'}</td>
              <td class="font-mono text-slate-400">${ageText !== null ? escapeHtml(ageText) : '—'}</td>
              <td class="font-semibold ${statusCls}">${statusText}${item.error ? `<span class="text-slate-500 font-normal ml-1" title="${escapeHtml(item.error)}">(chi tiết)</span>` : ''}</td>
            </tr>`;
        }).join('');
        killedWrap.innerHTML = `
          <div class="overflow-x-auto custom-scrollbar rounded-lg border border-slate-800">
            <table class="janitor-table">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Tiến trình</th>
                  <th>Lý do</th>
                  <th>Port</th>
                  <th>Tuổi (phút)</th>
                  <th>Kết quả</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }
    }

    // Danh sách tiến trình được bảo vệ (rút gọn)
    const protectedWrap = document.getElementById('janitorRunProtectedWrap');
    if (protectedWrap) {
      if (!protectedList.length) {
        protectedWrap.innerHTML = '';
      } else {
        const shown = protectedList.slice(0, 30);
        const more = protectedList.length - shown.length;
        protectedWrap.innerHTML = `
          <div class="janitor-stat">
            <div class="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1"><i class="fa-solid fa-shield-halved text-emerald-400 mr-1"></i>Được bảo vệ (${protectedList.length})</div>
            <div class="flex flex-wrap gap-1">
              ${shown.map((proc) => {
                const item = proc || {};
                return `<span class="px-1.5 py-0.5 rounded bg-surface-800 border border-slate-700 text-[10px] text-slate-400 font-mono" title="${escapeHtml(item.reason || '')}">${escapeHtml(item.pid)} · ${escapeHtml(item.name || '?')}</span>`;
              }).join('')}
              ${more > 0 ? `<span class="px-1.5 py-0.5 text-[10px] text-slate-500">+${more} nữa</span>` : ''}
            </div>
          </div>`;
      }
    }

    // Lỗi khi kill
    const errorsWrap = document.getElementById('janitorRunErrorsWrap');
    if (errorsWrap) {
      if (!errors.length) {
        errorsWrap.innerHTML = '';
      } else {
        errorsWrap.innerHTML = `
          <div class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-amber-200">
            <div class="text-[10px] uppercase tracking-wider text-amber-300 font-semibold mb-1"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Lỗi khi dọn (${errors.length})</div>
            <ul class="list-disc janitor-error-list space-y-1 text-[11px] font-mono">
              ${errors.slice(0, 20).map((msg) => `<li>${escapeHtml(msg)}</li>`).join('')}
            </ul>
          </div>`;
      }
    }

    // Khối log (dùng textContent: an toàn, không cần escape HTML)
    const logEl = document.getElementById('janitorRunLog');
    const logCountEl = document.getElementById('janitorLogLines');
    if (logCountEl) logCountEl.textContent = `${logLines.length} dòng`;
    if (logEl) {
      logEl.textContent = logLines.length
        ? logLines.map((line) => String(line)).join('\n')
        : '[EMPTY] Không có dòng log nào cho lần chạy này.';
      logEl.scrollTop = 0;
    }

    setJanitorDetailState('ready');
  }

  async function selectJanitorRun(id) {
    const runId = (id === undefined || id === null) ? '' : String(id);
    if (!runId) return;
    janitorSelectedRunId = runId;
    renderJanitorRunsList();
    setJanitorDetailState('loading', 'Đang tải chi tiết lần chạy...');

    try {
      const res = await fetchWithTimeout(`/api/v1/janitor/runs/${encodeURIComponent(runId)}`, {}, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (String(janitorSelectedRunId) !== runId) return; // Người dùng đã chọn lần chạy khác
      const run = (data && (data.run || data)) || null;
      if (!run || typeof run !== 'object') throw new Error('Phản hồi rỗng');
      renderJanitorRunDetail(run);
    } catch (err) {
      if (String(janitorSelectedRunId) !== runId) return;
      setJanitorDetailState('error', 'Không tải được chi tiết lần chạy: ' + (err.message || 'lỗi kết nối'));
    }
  }

  // Tải song song status + danh sách, giữ (hoặc chọn mới) lần chạy đang xem.
  async function refreshJanitorModal() {
    clearJanitorError();
    const [runs] = await Promise.all([loadJanitorRuns(), loadJanitorStatus()]);
    if (!Array.isArray(runs)) return false;

    const selectedStillExists = Boolean(janitorSelectedRunId)
      && runs.some((run) => run && String(run.id) === String(janitorSelectedRunId));
    const targetId = selectedStillExists
      ? janitorSelectedRunId
      : (runs[0] && runs[0].id ? runs[0].id : '');
    if (targetId) {
      await selectJanitorRun(targetId);
    } else {
      setJanitorDetailState('empty', 'Chưa có lần dọn tiến trình nào. Bấm "Chạy ngay" để dọn ngay.');
    }
    return true;
  }

  async function openJanitorModal() {
    const modal = document.getElementById('janitorModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    clearJanitorError();
    janitorSelectedRunId = null;
    setJanitorDetailState('loading', 'Đang tải dữ liệu...');
    await refreshJanitorModal();
    // Nếu người dùng đã đóng modal trong lúc tải thì không tạo timer rò rỉ.
    const modalAfterLoad = document.getElementById('janitorModal');
    if (modalAfterLoad && !modalAfterLoad.classList.contains('hidden')) {
      startJanitorAutoRefresh();
    }
  }

  function closeJanitorModal() {
    const modal = document.getElementById('janitorModal');
    if (modal) modal.classList.add('hidden');
    stopJanitorAutoRefresh();
    janitorSelectedRunId = null;
  }

  async function runJanitorNow() {
    if (janitorIsRunning) return;
    const btn = document.getElementById('btnJanitorRunNow');
    const icon = document.getElementById('janitorRunNowIcon');
    const label = document.getElementById('janitorRunNowLabel');

    janitorIsRunning = true;
    if (btn) btn.disabled = true;
    if (icon) icon.className = 'fa-solid fa-spinner fa-spin text-[11px]';
    if (label) label.textContent = 'Đang dọn...';
    clearJanitorError();

    try {
      const res = await fetchWithTimeout('/api/v1/janitor/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }, 60000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok === false) {
        const reason = (data && (data.error || data.reason)) || `HTTP ${res.status}`;
        throw new Error(reason);
      }

      const killed = Number(data.report && data.report.killed) || 0;
      showToast(
        killed > 0 ? `Đã dọn ${killed} tiến trình rác.` : 'Đã chạy dọn tiến trình: không có tiến trình rác.',
        killed > 0 ? 'success' : 'info'
      );

      await Promise.all([loadJanitorStatus(), loadJanitorRuns()]);
      const newId = (data.record && data.record.id)
        || (data.report && data.report.id)
        || (janitorRunsCache[0] && janitorRunsCache[0].id);
      if (newId) {
        await selectJanitorRun(newId);
      } else {
        setJanitorDetailState('empty', 'Chưa có lần dọn tiến trình nào.');
      }
    } catch (err) {
      const message = err && err.message ? err.message : 'lỗi kết nối';
      showJanitorError('Chạy dọn tiến trình thất bại: ' + message);
      showToast('Không chạy được dọn tiến trình: ' + message, 'error');
    } finally {
      janitorIsRunning = false;
      if (icon) icon.className = 'fa-solid fa-play text-[11px]';
      if (label) label.textContent = 'Chạy ngay';
      if (btn) btn.disabled = false;
    }
  }

  // Khởi tạo event listeners cho Process Janitor
  document.getElementById('btnOpenJanitorModal')?.addEventListener('click', openJanitorModal);
  document.getElementById('btnCloseJanitorModal')?.addEventListener('click', closeJanitorModal);
  document.getElementById('janitorModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'janitorModal') closeJanitorModal();
  });
  document.getElementById('btnJanitorRunNow')?.addEventListener('click', runJanitorNow);
  document.getElementById('btnJanitorRefresh')?.addEventListener('click', async () => {
    const ok = await refreshJanitorModal();
    showToast(
      ok ? 'Đã làm mới dữ liệu Dọn tiến trình.' : 'Không tải được dữ liệu Dọn tiến trình.',
      ok ? 'info' : 'error'
    );
  });
  // Ủy quyền sự kiện cho danh sách lần chạy (tránh nhúng id vào inline onclick).
  document.getElementById('janitorRunsList')?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-janitor-run-id]');
    if (!item) return;
    const runId = item.getAttribute('data-janitor-run-id');
    if (runId) selectJanitorRun(runId);
  });

  // Hỗ trợ phím ESC để đóng modal Dọn tiến trình
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('janitorModal');
    if (modal && !modal.classList.contains('hidden')) closeJanitorModal();
  });

  window.aiWorker.openJanitorModal = openJanitorModal;
  window.aiWorker.closeJanitorModal = closeJanitorModal;
  window.aiWorker.loadJanitorStatus = loadJanitorStatus;
  window.aiWorker.loadJanitorRuns = loadJanitorRuns;
  window.aiWorker.selectJanitorRun = selectJanitorRun;
  window.aiWorker.runJanitorNow = runJanitorNow;
})();

