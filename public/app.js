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
    timerInterval: null
  };

  // Pipeline standard steps
  const PIPELINE_STEPS = ['TO DO', 'PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'DONE'];

  // Status CSS mappings
  const STATUS_CLASSES = {
    'TO DO': 'status-todo',
    'PLANNING': 'status-planning',
    'IMPLEMENT': 'status-implement',
    'TESTING': 'status-testing',
    'VERIFY': 'status-verify',
    'FIXING': 'status-fixing',
    'PENDING': 'status-pending bg-amber-500/20 text-amber-300 border border-amber-500/40',
    'DONE': 'status-done',
    'CANCELLED': 'status-cancelled',
    'TIMED_OUT': 'status-failed',
    'ARCHIVED': 'status-archived'
  };

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

    // Polling background: Xoá check document.hidden cho status để trạng thái luôn chạy ngầm
    setInterval(() => {
      fetchJobsListSilently();
    }, 8000);

    setInterval(() => {
      fetchSystemStatus();
    }, 15000);

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
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
      if (clean.length <= maxCols) {
        wrapped.push(line);
        continue;
      }

      let remaining = line;
      while (remaining.length > 0) {
        const cleanRem = remaining.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
        if (cleanRem.length <= maxCols) {
          wrapped.push(remaining);
          break;
        }

        let breakIdx = -1;
        let visibleCount = 0;
        let inAnsi = false;

        for (let j = 0; j < remaining.length; j++) {
          if (remaining[j] === '\x1b') inAnsi = true;
          if (!inAnsi) {
            if (remaining[j] === ' ') breakIdx = j;
            visibleCount++;
            if (visibleCount >= maxCols) break;
          }
          if (inAnsi && remaining[j] === 'm') inAnsi = false;
        }

        if (breakIdx > 0) {
          wrapped.push(remaining.substring(0, breakIdx));
          remaining = remaining.substring(breakIdx + 1);
        } else {
          wrapped.push(remaining.substring(0, maxCols));
          remaining = remaining.substring(maxCols);
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
    const targetCols = (state.term && state.term.cols) ? state.term.cols : 120;
    const reflowed = reflowCliText(chunk);
    const wrapped = wordWrapToCols(reflowed, targetCols);
    const formatted = formatLogWithTimestamp(isWriteln ? wrapped + '\r\n' : wrapped, timestamp);
    terminalBuffer.push(formatted);

    if (!terminalFlushRaf) {
      terminalFlushRaf = requestAnimationFrame(() => {
        if (state.term && terminalBuffer.length > 0) {
          const combined = terminalBuffer.join('');
          terminalBuffer = [];
          state.term.write(combined);
          if (state.autoScroll) {
            state.term.scrollToBottom();
          }
        }
        terminalFlushRaf = null;
      });
    }
  }

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
    if (calculatedCols > state.term.cols) {
      try {
        state.term.resize(calculatedCols, state.term.rows || 25);
      } catch (e) {}
    }
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
    setTimeout(fitTerminal, 50);
    setTimeout(fitTerminal, 150);
    setTimeout(fitTerminal, 350);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fitTerminal);
    }

    // Dùng ResizeObserver để tự động tính toán lại số cột (cols) tràn full chiều rộng khung log
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        fitTerminal();
      });
      ro.observe(container);
    }

    window.addEventListener('resize', () => {
      if (state.activeTab === 'terminal') {
        fitTerminal();
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
    document.getElementById('jobSearchInput')?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.toLowerCase().trim();
      renderJobsList();
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
        showToast(data.message, 'success');
        fetchJobDetails(state.activeJobId);
      } catch (err) {
        showToast(err.message, 'error');
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
        try { state.fitAddon.fit(); } catch (e) {}
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
    document.getElementById('btnViewRawJson')?.addEventListener('click', openRawJsonModal);
    document.getElementById('btnCloseRawJson')?.addEventListener('click', closeRawJsonModal);
    document.getElementById('btnCopyRawJson')?.addEventListener('click', copyRawJsonContent);

    // Terminal Toolbar Actions
    document.getElementById('btnToggleAutoScroll')?.addEventListener('click', toggleAutoScroll);
    document.getElementById('btnClearTerminal')?.addEventListener('click', () => {
      clearTerminalScreen({ ignoreHistory: true });
    });
    document.getElementById('btnCopyTerminalLog')?.addEventListener('click', copyTerminalLog);
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
  async function fetchJobsList() {
    const listContainer = document.getElementById('jobsListContainer');
    try {
      const res = await fetch('/api/v1/jobs');
      if (!res.ok) throw new Error('Failed to fetch jobs list: ' + res.statusText);
      const data = await res.json();
      state.jobs = Array.isArray(data) ? data : (data.jobs || []);
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
    try {
      const res = await fetch('/api/v1/jobs');
      if (!res.ok) return;
      const data = await res.json();
      const newJobs = Array.isArray(data) ? data : (data.jobs || []);
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
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}`);
      if (!res.ok) throw new Error('Failed to load job details');
      const data = await res.json();
      const job = data.job || data;

      state.activeJob = job;
      state.evidences = data.evidence || data.evidences || [];
      state.dualPlan = data.dual_plan || data.dualPlan || null;
      state.currentQuestion = data.question || null;

      renderActiveJobDetail();

      // Kết nối Realtime Log Stream SSE
      connectLogStream(jobId, clearTerm);
    } catch (err) {
      console.error('Error fetching job details:', err);
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
      // Fallback status
      state.systemStatus.online = true;
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

    if (clearTerm && state.term) {
      writeTerminalBanner(`Bắt đầu kết nối log stream cho Job #${jobId}...`);
    }

    const sseUrl = `/api/v1/jobs/${jobId}/logs/stream`;
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
        if (state.activeJob) {
          state.activeJob.current_step = payload.step || payload.current_step;
          updateStepper(state.activeJob);
        }
      } catch (e) {
        console.warn('Step event error:', e);
      }
    });

    // Custom Named Event: status
    state.eventSource.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse(event.data);
        const newStatus = payload.status;
        if (state.activeJob) {
          state.activeJob.status = newStatus;
          if (newStatus === 'PENDING') state.activeJob.had_pending = 1;
          if (newStatus === 'FIXING') state.activeJob.fix_attempt = 1;
          renderActiveJobDetail();
        }
        // Nếu chuyển sang PENDING, hiển thị question modal
        if (newStatus === 'PENDING') {
          fetchJobDetails(jobId, false);
        }
        renderJobsList();
      } catch (e) {
        console.warn('Status event error:', e);
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
        renderJobsList(true);
      } catch (e) {
        console.warn('SystemOne event error:', e);
      }
    });

    // Custom Named Event: question (Human-in-the-Loop Clarification)
    state.eventSource.addEventListener('question', (event) => {
      try {
        const questionData = JSON.parse(event.data);
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
      if (state.activeJob) {
        state.activeJob.status = payload.status;
        if (payload.status === 'PENDING') state.activeJob.had_pending = 1;
        if (payload.status === 'FIXING') state.activeJob.fix_attempt = 1;
        renderActiveJobDetail();
      }
    } else if (payload.type === 'step' && payload.step) {
      if (state.activeJob) {
        state.activeJob.current_step = payload.step;
        updateStepper(state.activeJob);
      }
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
  function renderSystemOneBadge(soState) {
    const s = soState && typeof soState === 'object' ? soState : null;
    if (!s) {
      return `<span class="px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400 border border-slate-600/30 text-[9px] font-mono tracking-tight inline-block align-middle" title="SystemOne: CHƯA GỌI - task này chưa có quyết định nào từ SystemOne">CHƯA GỌI</span>`;
    }
    const live = s.live === true ? true : (s.live === false ? false : null);
    if (live === true) {
      const tip = `SystemOne: LIVE\nSố lần gọi model thật: ${s.calls || 0}\nModel: ${s.model || '—'}${s.updatedAt ? '\nCập nhật: ' + s.updatedAt : ''}`;
      return `<span class="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-500/30 text-[9px] font-mono font-semibold tracking-tight inline-block align-middle" title="${escapeHtml(tip)}">LIVE</span>`;
    }
    if (live === false) {
      const tip = `SystemOne: FALLBACK\nRơi về heuristic offline (không phải model thật).\nSố lần fallback: ${s.fallbacks || 0}/${s.calls || 0}\nLỗi: ${s.lastError || '—'}${s.updatedAt ? '\nCập nhật: ' + s.updatedAt : ''}`;
      return `<span class="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-500/30 text-[9px] font-mono font-semibold tracking-tight inline-block align-middle" title="${escapeHtml(tip)}">FALLBACK</span>`;
    }
    return `<span class="px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400 border border-slate-600/30 text-[9px] font-mono tracking-tight inline-block align-middle" title="SystemOne: CHƯA GỌI">CHƯA GỌI</span>`;
  }

  function renderJobsList(force = false) {
    const container = document.getElementById('jobsListContainer');
    if (!container) return;

    let filtered = state.jobs;

    // Kiểm tra nhanh chữ ký dữ liệu để tránh phá hủy và render lại DOM vô ích
    const currentSignature = `${state.activeJobId}_${state.statusFilter}_${state.searchQuery}_` +
      // systemone_state phai vao chu ky: badge per-task doi khi chi trang thai SystemOne thay doi.
      filtered.map(j => `${j.id}:${j.status}:${j.updated_at || ''}:${(j.systemone_state && j.systemone_state.updatedAt) || ''}`).join('|');

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
        const titleMatch = (j.title || j.prompt || '').toLowerCase().includes(state.searchQuery);
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
      updateJobsCountBadge(0);
      return;
    }

    container.innerHTML = filtered
      .map((job) => {
        const isActive = job.id === state.activeJobId;
        const status = (job.status || 'TO DO').toUpperCase();
        const statusClass = STATUS_CLASSES[status] || 'status-todo';
        const title = escapeHtml(job.title || job.prompt || 'Untitled Job');
        const runner = escapeHtml(getEffectiveAgentForJob(job));
        const repo = escapeHtml(job.repo_path || './');
        const timeAgo = formatTimeAgo(job.created_at);
        const taskCodeDisplay = job.task_code
          ? `<span class="px-1.5 py-0.5 rounded bg-slate-800 text-brand-300 border border-brand-500/25 text-[10px] font-mono font-medium tracking-tight truncate max-w-[110px] inline-block mr-1 align-middle" title="${escapeHtml(job.task_code)}">${escapeHtml(job.task_code)}</span>`
          : '';
        const isArchived = status === 'ARCHIVED';
        const canDelete = ['TO DO', 'DONE', 'CANCELLED', 'FAILED', 'ARCHIVED'].includes(status);
        // Badge SystemOne THEO TASK: du lieu cua chinh job nay, khong phai trang thai global server.
        const soBadge = renderSystemOneBadge(job.systemone_state);

        return `
          <div class="job-card ${isActive ? 'active' : ''} p-2.5 rounded-lg border transition cursor-pointer relative group" data-job-id="${job.id}">
            <div class="flex items-center justify-between gap-1.5 mb-1.5">
              <div class="flex items-center gap-1 min-w-0">
                ${taskCodeDisplay}
                <span class="font-mono text-[11px] text-slate-400 truncate">#${job.id.substring(0, 8)}</span>
                ${soBadge}
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <span class="status-badge ${statusClass}">${status === 'PENDING' ? 'Chờ giải đáp' : status}</span>
                <!-- Nút Lưu trữ Task -->
                <button class="p-1 rounded hover:bg-amber-500/20 text-slate-400 hover:text-amber-300 transition" title="${isArchived ? 'Bỏ lưu trữ' : 'Lưu trữ Task'}" onclick="event.stopPropagation(); window.aiWorker.archiveTask('${job.id}')">
                  <i class="fa-solid fa-box-archive text-[11px] ${isArchived ? 'text-amber-400' : ''}"></i>
                </button>
                <!-- Nút Xóa Task -->
                ${canDelete ? `
                <button class="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition" title="Xóa Task" onclick="event.stopPropagation(); window.aiWorker.deleteTask('${job.id}')">
                  <i class="fa-solid fa-trash-can text-[11px]"></i>
                </button>
                ` : ''}
              </div>
            </div>
            <h4 class="text-xs font-semibold text-slate-200 line-clamp-2 mb-1.5 leading-snug">${title}</h4>
            <div class="flex items-center justify-between text-[11px] text-slate-400 font-mono">
              <span class="truncate max-w-[150px]"><i class="fa-regular fa-folder mr-1 text-slate-500"></i>${repo}</span>
              <span class="text-slate-500 shrink-0">${timeAgo}</span>
            </div>
          </div>
        `;
      })
      .join('');

    // Tự động chọn task đầu tiên nếu chưa có task nào được chọn
    if (!state.activeJobId && filtered.length > 0) {
      selectJob(filtered[0].id);
    }

    // Bind click events on cards
    container.querySelectorAll('.job-card').forEach((card) => {
      card.addEventListener('click', () => {
        const jobId = card.getAttribute('data-job-id');
        if (jobId !== state.activeJobId) {
          selectJob(jobId);
        }
      });
    });

    updateJobsCountBadge(filtered.length);
  }

  function selectJob(jobId) {
    state.activeJobId = jobId;
    renderJobsList();

    const emptyState = document.getElementById('emptyJobState');
    const activeContainer = document.getElementById('activeJobContainer');
    if (emptyState) emptyState.classList.add('hidden');
    if (activeContainer) activeContainer.classList.remove('hidden');

    fetchJobDetails(jobId, true);
    fitTerminal();
    setTimeout(fitTerminal, 60);
    setTimeout(fitTerminal, 200);
  }

  // --- Render Active Job Detail Dashboard ---
  function renderActiveJobDetail() {
    const job = state.activeJob;
    if (!job) return;

    // Header info
    const idBadge = document.getElementById('activeJobIdBadge');
    if (idBadge) idBadge.textContent = `#${job.id}`;

    const statusBadge = document.getElementById('activeJobStatusBadge');
    if (statusBadge) {
      const status = (job.status || 'TO DO').toUpperCase();
      statusBadge.textContent = status === 'PENDING' ? 'Chờ giải đáp' : status;
      statusBadge.className = `status-badge ${STATUS_CLASSES[status] || 'status-todo'}`;
      const errBox = document.getElementById('activeJobErrorBox');
      if (status === 'FAILED' && job.error_message) {
        if (errBox) {
          errBox.style.display = 'block';
          errBox.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1.5"></i><strong>Lý do thất bại:</strong> ${escapeHtml(job.error_message)}`;
        }
      } else if (errBox) {
        errBox.style.display = 'none';
      }
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
      const st = job.systemone_state;
      const live = st && typeof st === 'object' ? (st.live === true ? true : (st.live === false ? false : null)) : null;
      if (live === true) {
        soBadgeEl.textContent = 'LIVE';
        soBadgeEl.className = 'text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono font-semibold';
        soBadgeEl.title = `SystemOne: LIVE — ${st.calls || 0} quyết định từ model thật (${st.model || '—'})`;
      } else if (live === false) {
        soBadgeEl.textContent = 'FALLBACK';
        soBadgeEl.className = 'text-xs px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono font-semibold';
        soBadgeEl.title = `SystemOne: FALLBACK — ${st.fallbacks || 0}/${st.calls || 0} quyết định rơi về heuristic offline. ${st.lastError || ''}`;
      } else {
        soBadgeEl.textContent = 'CHƯA GỌI';
        soBadgeEl.className = 'text-xs px-2 py-0.5 rounded bg-slate-700/60 text-slate-400 border border-slate-600/30 font-mono';
        soBadgeEl.title = 'SystemOne: CHƯA GỌI — task này chưa có quyết định nào từ SystemOne';
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

    // Start Button State: Nút Chạy Pipeline luôn hiển thị sẵn sàng (trừ khi đang chạy IMPLEMENT/TESTING)
    const startBtn = document.getElementById('btnStartTask');
    if (startBtn) {
      const isRunning = ['IMPLEMENT', 'TESTING', 'VERIFY'].includes((job.status || '').toUpperCase());
      if (isRunning) {
        startBtn.classList.add('hidden');
      } else {
        startBtn.classList.remove('hidden');
        startBtn.disabled = false;
      }
    }

    // Cancel Button State
    
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

    // Pending Alert Banner
    const pendingBanner = document.getElementById('pendingAlertBanner');
    const pendingText = document.getElementById('pendingAlertText');
    if (pendingBanner) {
      if (job.status === 'PENDING') {
        pendingBanner.classList.remove('hidden');
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
        }
      } else {
        pendingBanner.classList.add('hidden');
      }
    }

    // Populate Task Status Select & Setup Delete Task Button
    const statusSelect = document.getElementById('taskStatusSelect');
    if (statusSelect) {
      const curStatus = (job.status || 'TO DO').toUpperCase();
      statusSelect.value = curStatus;
    }

    const deleteBtn = document.getElementById('btnDeleteTask');
    if (deleteBtn) {
      const allowedDelete = ['TODO', 'TO DO', 'DONE', 'CANCELLED', 'FAILED'];
      const curStatus = (job.status || '').toUpperCase().trim();
      if (allowedDelete.includes(curStatus)) {
        deleteBtn.classList.remove('hidden');
        deleteBtn.disabled = false;
      } else {
        deleteBtn.classList.add('hidden');
        deleteBtn.disabled = true;
      }
    }

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

    svg.innerHTML = ''; // Xóa các đường vẽ cũ

    const status = (job.status || 'TO DO').toUpperCase();
    const hasReachedPlanning = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasReachedImplement = ['IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasReachedTesting = ['TESTING', 'VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasReachedVerify = ['VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasTouchedPending = status === 'PENDING' || Boolean(Number(job.had_pending)) || Boolean(job.had_pending) || (Array.isArray(job.questions) && job.questions.length > 0);
    const hasTouchedFixing = status === 'FIXING' || getFixAttemptFromJob(job) > 0;
    const isDone = status === 'DONE';

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

    const pTodo = getNodeCenter('stepNode_TODO');
    const pPlan = getNodeCenter('stepNode_PLANNING');
    const pPend = getNodeCenter('stepNode_PENDING');
    const pImp = getNodeCenter('stepNode_IMPLEMENT');
    const pTest = getNodeCenter('stepNode_TESTING');
    const pVerify = getNodeCenter('stepNode_VERIFY');
    const pFix = getNodeCenter('stepNode_FIXING');
    const pDone = getNodeCenter('stepNode_DONE');

    const createPath = (d, className) => {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', d);
      pathEl.setAttribute('class', className);
      svg.appendChild(pathEl);
      return pathEl;
    };

    // 1. Đường nối TO DO -> PLANNING (chỉ chạm mép ngoài hình tròn, không chạy xuyên qua)
    createPath(
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
      createPath(
        `M ${pPlan.x + 17} 17 L ${pPend.x - 17} 17`,
        pendingInClass
      );
      createPath(
        `M ${pPend.x + 17} 17 L ${pImp.x - 17} 17`,
        pendingOutClass
      );
    } else {
      // KHÔNG chạm PENDING: ĐƯỜNG NỐI VÒNG LÊN TRÊN ĐẦU PENDING RỒI VÒNG XUỐNG IMPLEMENT!
      createPath(
        `M ${pPlan.x + 15} 9 Q ${pPend.x} -14 ${pImp.x - 15} 9`,
        hasReachedImplement ? 'stepper-svg-path stepper-svg-bridge' : 'stepper-svg-path'
      );
    }
    // 3. Đường nối IMPLEMENT -> TESTING (chỉ chạm mép ngoài hình tròn)
    createPath(
      `M ${pImp.x + 17} 17 L ${pTest.x - 17} 17`,
      hasReachedTesting ? 'stepper-svg-path active' : 'stepper-svg-path'
    );
    // 4. Đường chính TESTING -> VERIFY -> FIXING -> DONE (xuyên tâm FIXING, không bypass)
    createPath(
      `M ${pTest.x + 17} 17 L ${pVerify.x - 17} 17`,
      hasReachedVerify ? 'stepper-svg-path active' : 'stepper-svg-path'
    );
    if (hasTouchedFixing) {
      // Đường chính đi xuyên qua node FIXING: vàng khi active, xanh khi xong
      createPath(
        `M ${pVerify.x + 17} 17 L ${pFix.x - 17} 17`,
        status === 'FIXING' ? 'stepper-svg-path pending stroke-amber-400' : 'stepper-svg-path active'
      );
      createPath(
        `M ${pFix.x + 17} 17 L ${pDone.x - 17} 17`,
        isDone ? 'stepper-svg-path active' : 'stepper-svg-path'
      );
    } else {
      // KHÔNG chạm FIXING: ĐƯỜNG NỐI VÒNG LÊN TRÊN ĐẦU FIXING RỒI VÒNG XUỐNG DONE!
      // Bắt đầu và kết thúc tại mép trên-ngoài của hình tròn (r=17, góc 30 độ: dx=15, dy=8 -> y=9)
      createPath(
        `M ${pVerify.x + 15} 9 Q ${pFix.x} -14 ${pDone.x - 15} 9`,
        isDone ? 'stepper-svg-path stepper-svg-bridge' : 'stepper-svg-path'
      );
    }
  }


  function updateStepper(job) {
    const currentStepNameEl = document.getElementById('currentStepName');
    const status = (job.status || 'TO DO').toUpperCase();
    const currentStep = (job.current_step || status).toUpperCase();

    if (currentStepNameEl) {
      currentStepNameEl.textContent = status === 'PENDING' ? 'PENDING (Chờ làm rõ Q&A)' : currentStep;
    }

    const nodeTodo = document.getElementById('stepNode_TODO');
    const nodePlanning = document.getElementById('stepNode_PLANNING');
    const nodePending = document.getElementById('stepNode_PENDING');
    const nodeImplement = document.getElementById('stepNode_IMPLEMENT');
    const nodeTesting = document.getElementById('stepNode_TESTING');
    const nodeVerify = document.getElementById('stepNode_VERIFY');
    const nodeFixing = document.getElementById('stepNode_FIXING');
    const nodeDone = document.getElementById('stepNode_DONE');

    [nodeTodo, nodePlanning, nodePending, nodeImplement, nodeTesting, nodeVerify, nodeFixing, nodeDone].forEach(n => {
      if (!n) return;
      n.classList.remove('completed', 'active', 'pending', 'failed', 'untouched');
      n.classList.add('untouched');
    });

    const hasReachedPlanning = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasReachedImplement = ['IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasReachedTesting = ['TESTING', 'VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasReachedVerify = ['VERIFY', 'FIXING', 'DONE'].includes(status);
    const hasTouchedPending = status === 'PENDING' || Boolean(Number(job.had_pending)) || Boolean(job.had_pending) || (Array.isArray(job.questions) && job.questions.length > 0);
    const hasTouchedFixing = status === 'FIXING' || getFixAttemptFromJob(job) > 0;
    const isDone = status === 'DONE';

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

    if (nodeDone && isDone) {
      nodeDone.classList.remove('untouched');
      nodeDone.classList.add('completed');
    }

    // Vẽ đường nối SVG sau khi DOM đã ổn định
    requestAnimationFrame(() => {
      drawSvgStepperPaths(job);
    });
  }

  // --- Render Dual Plan (Dev Plan & Test Plan) ---
  function renderDualPlan() {
    const devContainer = document.getElementById('devPlanContent');
    const testContainer = document.getElementById('testPlanContent');
    const dual = state.dualPlan;

    if (devContainer) {
      if (dual && dual.dev_plan) {
        devContainer.innerHTML = formatMarkdownContent(dual.dev_plan);
      } else {
        devContainer.innerHTML = `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-file-circle-question text-3xl mb-2 text-slate-600"></i>
            <p class="font-medium">Chưa có Dev Plan cho công việc này.</p>
            <p class="text-[11px] text-slate-600 mt-1">Dev Plan sẽ được sinh ra ở bước PLANNING bởi Planning Agent.</p>
          </div>
        `;
      }
    }

    if (testContainer) {
      if (dual && dual.test_plan) {
        testContainer.innerHTML = formatMarkdownContent(dual.test_plan);
      } else {
        testContainer.innerHTML = `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-vial-circle-check text-3xl mb-2 text-slate-600"></i>
            <p class="font-medium">Chưa có Test Plan cho công việc này.</p>
            <p class="text-[11px] text-slate-600 mt-1">Test Plan mô tả kịch bản CloakBrowser, mock test data, API assertions.</p>
          </div>
        `;
      }
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

  // --- Render Multi-Verification Evidence Hub ---
  function renderEvidenceHub() {
    const countBadge = document.getElementById('evidenceCountBadge');
    if (countBadge) {
      countBadge.textContent = `${state.evidences.length} mục`;
    }

    const uiGallery = document.getElementById('uiEvidenceGallery');
    const apiList = document.getElementById('apiEvidenceList');
    const logsList = document.getElementById('logsEvidenceList');
    const dbList = document.getElementById('dbEvidenceList');

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
      const explicit = evExplicitChannel(e);
      if (explicit) return explicit;
      const fn = evFilename(e);
      if (/(\.png|\.webp|\.jpg|\.jpeg|\.svg)$/.test(fn)) return 'ui';
      if (/(\.log|\.txt)$/.test(fn)) return 'log';
      if (fn.endsWith('.sql') || fn.includes('db') || fn.includes('assert')) return 'db';
      if (fn.endsWith('.json')) return fn.includes('api') ? 'api' : 'log';
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
        uiGallery.innerHTML = `
          <div class="col-span-2 text-center py-12 text-slate-500 text-xs">
            <i class="fa-regular fa-images text-2xl mb-2 text-slate-600 block"></i>
            <p>Chưa có ảnh chụp màn hình kiểm thử UI.</p>
            <p class="text-[11px] text-slate-600 mt-1">Ảnh chụp CloakBrowser sẽ xuất hiện tại bước TESTING.</p>
          </div>
        `;
      } else {
        uiGallery.innerHTML = uiEvidences
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
          .join('');
      }
    }

    // 2. API Test Results
    if (apiList) {
      if (apiEvidences.length === 0) {
        apiList.innerHTML = `
          <div class="text-center py-12 text-slate-500 text-xs">
            <i class="fa-solid fa-server text-2xl mb-2 text-slate-600 block"></i>
            <p>Chưa có kết quả API Test.</p>
            <p class="text-[11px] text-slate-600 mt-1">Các kiểm thử HTTP assertions sẽ hiển thị tại đây.</p>
          </div>
        `;
      } else {
        apiList.innerHTML = apiEvidences
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
          .join('');
      }
    }

    // 3. Service Logs Results
    if (logsList) {
      if (logEvidences.length === 0) {
        logsList.innerHTML = `
          <div class="text-center py-12 text-slate-500 text-xs">
            <i class="fa-solid fa-shield-virus text-2xl mb-2 text-slate-600 block"></i>
            <p>Không phát hiện lỗi Runtime nào từ Service Logs.</p>
            <p class="text-[11px] text-slate-600 mt-1">Dấu vết log và Exception sẽ hiển thị tại đây.</p>
          </div>
        `;
      } else {
        logsList.innerHTML = logEvidences
          .map((item, idx) => {
            const serviceName = item.service_name || item.service || 'Service App';
            const level = ((item.level || (item.error || item.stack_trace ? 'ERROR' : (item.warn ? 'WARN' : 'INFO')))).toUpperCase();
            const timestamp = item.capturedAt || item.timestamp || item.time || item.created_at || '';
            const logExcerpt = item.log_excerpt || item.excerpt || item.message || (item.stack_trace ? item.stack_trace.split('\n')[0] : '') || 'Ghi nhận log hệ thống';
            const logFilename = item.filename || (item.file_path ? String(item.file_path).split('/').pop() : '') || '';
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
          .join('');
      }
    }

    // 4. Database Query Results
    if (dbList) {
      if (dbEvidences.length === 0) {
        dbList.innerHTML = `
          <div class="text-center py-12 text-slate-500 text-xs">
            <i class="fa-solid fa-table-list text-2xl mb-2 text-slate-600 block"></i>
            <p>Chưa có dữ liệu đối soát Database.</p>
            <p class="text-[11px] text-slate-600 mt-1">Kết quả so khớp dữ liệu SQL assertions sẽ hiển thị tại đây.</p>
          </div>
        `;
      } else {
        dbList.innerHTML = dbEvidences
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
          .join('');
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

    // Badge SystemOne: LIVE (model that) | FALLBACK (heuristic offline) | OFF
    const soStatus = document.getElementById('systemOneStatus');
    const soWrap = document.getElementById('systemOneBadgeWrap');
    if (soStatus) {
      const s = state.systemStatus.systemoneStatus;
      if (!s) {
        soStatus.textContent = '—';
        soStatus.className = 'text-slate-300 font-mono';
      } else if (s.enabled === false) {
        soStatus.textContent = 'OFF';
        soStatus.className = 'text-slate-500 font-mono';
      } else if (s.live === true) {
        soStatus.textContent = 'LIVE';
        soStatus.className = 'text-emerald-400 font-mono font-semibold';
      } else if (s.live === false) {
        soStatus.textContent = 'FALLBACK';
        soStatus.className = 'text-amber-400 font-mono font-semibold';
      } else {
        soStatus.textContent = 'CHƯA GỌI';
        soStatus.className = 'text-slate-400 font-mono';
      }
    }
    if (soWrap) {
      const s = state.systemStatus.systemoneStatus;
      const tip = s
        ? `SystemOne ${s.model} @ ${s.baseUrl}\nTrạng thái: ${s.enabled === false ? 'tắt' : (s.live === true ? 'đang gọi model thật' : (s.live === false ? 'rơi về heuristic offline' : 'chưa gọi'))}\n${s.lastError ? 'Lỗi: ' + s.lastError : ''}\nFallback: ${s.fallbackCount} lần`
        : 'Trạng thái SystemOne chưa tải';
      soWrap.setAttribute('title', tip);
    }
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
          const titleMatch = (j.title || j.prompt || '').toLowerCase().includes(state.searchQuery);
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

    if (state.activeJob && state.activeJob.created_at) {
      const durationEl = document.getElementById('activeJobDuration');
      if (durationEl) {
        const start = new Date(state.activeJob.created_at).getTime();
        const end = state.activeJob.completed_at
          ? new Date(state.activeJob.completed_at).getTime()
          : Date.now();
        const seconds = Math.max(0, Math.floor((end - start) / 1000));
        durationEl.textContent = formatDuration(seconds);
      }
    }
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
      await fetchJobDetails(state.activeJobId, false);
      await fetchJobsList();
    } catch (err) {
      alert('Lỗi kích hoạt task: ' + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-play mr-1"></i> <span>Chạy Pipeline</span>';
      }
    }
  }

  // --- Active Job Control Actions (Cancel & Rerun) ---
  async function handleCancelActiveJob() {
    if (!state.activeJobId) return;
    if (!confirm('Bạn có chắc chắn muốn hủy Job #' + state.activeJobId + '?')) return;

    try {
      const res = await fetch(`/api/v1/jobs/${state.activeJobId}/cancel`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Hủy Job thất bại');
      await fetchJobDetails(state.activeJobId);
      fetchJobsList();
    } catch (err) {
      alert('Lỗi: ' + err.message);
    }
  }

  async function handleRerunActiveJob() {
    if (!state.activeJobId) return;
    if (!confirm('Bạn có muốn khởi động chạy lại Job này?')) return;
    try {
      clearTerminalScreen({ ignoreHistory: true, marker: Date.now() - 500 });
      const res = await fetch(`/api/v1/jobs/${state.activeJobId}/rerun`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Rerun Job thất bại');
      const data = await res.json();
      const newId = data.job?.id || data.id || state.activeJobId;
      await fetchJobsList();
      selectJob(newId);
    } catch (err) {
      alert('Lỗi khi rerun: ' + err.message);
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
      const res = await fetch(`/api/v1/jobs/${state.activeJobId}/answer`, {
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

      // Nếu chưa có nội dung nhưng có file_path/url, fetch ngay từ server
      if (!fullLogText && (item.url || item.file_path)) {
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

      if (!fullLogText) {
        fullLogText = 'Đang tải nội dung file log từ server...';
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
    
    // 1. Fallback update local state immediately for snappy UI
    const evidenceIdx = state.evidences.findIndex(e => e.filename === filename || (e.file_path && e.file_path.includes(filename)));
    if (evidenceIdx !== -1) {
      state.evidences[evidenceIdx].verdict = newVerdict;
      state.evidences[evidenceIdx].status = newStatus;
      try {
        localStorage.setItem(`evidence_meta_${jobId}_${filename}`, JSON.stringify({ verdict: newVerdict, status: newStatus }));
      } catch(e){}
    }
    
    // Re-render quickly
    renderEvidenceHub();

    // 2. Background API call
    try {
      await fetch(`/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(filename)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: newVerdict, status: newStatus })
      });
    } catch(err) {
      console.warn('Failed to persist evidence status to backend', err);
      showToast('Không thể lưu trạng thái PASS/FAIL lên server, đã lưu local.', 'warning');
    }
  }

  async function deleteEvidence(filename) {
    if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn bằng chứng '${filename}' khỏi Database và thư mục evidence không?`)) return;

    const jobId = state.activeJobId || (state.activeJob && state.activeJob.id);
    if (!jobId || !filename) return;

    // 1. Update local state immediately
    state.evidences = state.evidences.filter(e => !(e.filename === filename || e.fileName === filename || (e.file_path && e.file_path.includes(filename))));
    renderEvidenceHub();

    // 2. Call backend DELETE
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Đã xóa vĩnh viễn bằng chứng ${filename}`, 'success');
        fetchJobEvidences(jobId);
      } else {
        showToast(data.error || 'Lỗi khi xóa bằng chứng trên server', 'error');
      }
    } catch(err) {
      console.error('Delete evidence failed:', err);
      showToast('Không thể kết nối đến server để xóa bằng chứng.', 'error');
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

    // 1. Update local state immediately
    state.evidences = state.evidences.filter(e => e !== item && !(e.fileName === filename || e.filename === filename || (e.file_path && e.file_path.includes(filename))));
    renderEvidenceHub();

    // 2. Call backend DELETE
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Đã xóa vĩnh viễn bằng chứng ${filename}`, 'success');
        fetchJobEvidences(jobId);
      } else {
        showToast(data.error || 'Lỗi khi xóa bằng chứng trên server', 'error');
      }
    } catch(err) {
      console.error('Delete evidence item failed:', err);
      showToast('Không thể kết nối đến server để xóa bằng chứng.', 'error');
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
      fitTerminal();
      setTimeout(fitTerminal, 40);
      setTimeout(fitTerminal, 150);
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
      const res = await fetch('/api/v1/settings');
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
      const res = await fetch('/api/v1/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Không thể lưu cài đặt trên máy chủ');
      localStorage.setItem('ai_worker_settings', JSON.stringify(payload));
      showToast('Lưu cài đặt runner thành công!', 'success');
      closeSettingsModal();
    } catch (err) {
      console.warn('Lỗi saveSettings API, lưu tạm vào localStorage:', err);
      localStorage.setItem('ai_worker_settings', JSON.stringify(payload));
      showToast('Đã lưu cài đặt runner (cục bộ)!', 'success');
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
        res = await fetch('/api/v1/workspaces/browse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPath: browsePath || '' })
        });
      } catch (netErr) {
        res = null;
      }
      if (!res || !res.ok) {
        res = await fetch('/api/v1/workspaces/browse?path=' + encodeURIComponent(browsePath || ''));
      }
      if (!res.ok) throw new Error('Không thể duyệt thư mục');
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

    let devContent = state.dualPlan?.dev_plan || '';
    let testContent = state.dualPlan?.test_plan || '';

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

    if (devContainer) {
      if (devContent) {
        devContainer.innerHTML = `<div class="prose prose-invert max-w-none text-xs leading-relaxed">${formatMarkdownContent(devContent)}</div>`;
      } else {
        devContainer.innerHTML = `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-file-code text-2xl mb-2 opacity-50 block"></i>
            Chưa có Dev Plan cho task này
          </div>
        `;
      }
    }

    if (testContainer) {
      if (testContent) {
        testContainer.innerHTML = `<div class="prose prose-invert max-w-none text-xs leading-relaxed">${formatMarkdownContent(testContent)}</div>`;
      } else {
        testContainer.innerHTML = `
          <div class="text-center py-12 text-slate-500">
            <i class="fa-solid fa-vial text-2xl mb-2 opacity-50 block"></i>
            Chưa có Test Plan cho task này
          </div>
        `;
      }
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
    const newStatus = statusSelect.value;

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
      showToast('Cập nhật trạng thái thành công!', 'success');
      fetchJobDetails(state.activeJobId, false);
      fetchJobsListSilently();
    } catch (err) {
      showToast(err.message || 'Lỗi cập nhật trạng thái', 'error');
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
    if (codeInput) codeInput.value = job.task_code || ('TASK-' + job.id.substring(0, 8).toUpperCase());
    if (titleInput) titleInput.value = job.title || '';
    if (promptInput) promptInput.value = job.prompt || '';
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

      showToast('Đã cập nhật thông tin Task thành công!', 'success');
      closeEditTaskModal();
      await fetchJobsListSilently();
      if (state.activeJobId === editingTaskId) {
        await fetchJobDetails(editingTaskId, false);
      }
    } catch (err) {
      showToast(err.message, 'error', 7000);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk mr-1"></i> Lưu thay đổi';
      }
    }
  }

  // --- Thao tác Lưu trữ và Xóa Task ---
  async function archiveTask(jobId) {
    const targetId = jobId || state.activeJobId;
    if (!targetId) return;

    try {
      const res = await fetch(`/api/v1/jobs/${targetId}/archive`, {
        method: 'POST'
      });
      const data = await res.json();
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
    }
  }

  async function deleteTask(jobId) {
    const targetId = jobId || state.activeJobId;
    if (!targetId) return;

    if (!confirm('Bạn có chắc chắn muốn xóa tác vụ này không?')) return;

    try {
      const res = await fetch(`/api/v1/jobs/${targetId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
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
    }
  }

  // Export global cho templates và inline onclick
  window.aiWorker = window.aiWorker || {};
  window.aiWorker.archiveTask = archiveTask;
  window.aiWorker.deleteTask = deleteTask;
  window.aiWorker.openEditModal = openEditTaskModal;
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
          <td class="p-3 font-mono text-slate-400 text-[11px]">${escapeHtml(ws.features_dir || "docs/features")}</td>
          <td class="p-3 text-center">${defBadge}</td>
          <td class="p-3 text-right">
            <div class="flex items-center justify-end gap-2">
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

      const res = await fetch("/api/v1/workspaces/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPath: targetPath })
      });
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

  window.aiWorker.openCloneTaskModal = openCloneTaskModal;
  window.aiWorker.closeCloneTaskModal = closeCloneTaskModal;
})();

