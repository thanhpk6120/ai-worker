---
feature: TASK-PIPELINE-FIX
service: ai-worker
status: testing
owner: AI
updated_at: 2026-10-21
---

# Danh sách công việc (tasks.md) — TASK-PIPELINE-FIX

| # | Task | Service | File | Trạng thái |
|---|---|---|---|---|
| **Phase A — Timeout & Retry** |||||
| A-1 | Helper `resolveMaxRetries(job)` đọc `pipeline_config.max_retries` → `maxRetries` → `job.max_retries` → env → default | ai-worker | `src/server.js` | ✅ |
| A-2 | Log fixGate kèm nguồn giá trị (`job`/`env`/`default`) | ai-worker | `src/server.js:2488` | ✅ |
| A-3 | Tính `jobDeadlineAt` từ `pipeline_config.job_deadline_ms` | ai-worker | `src/server.js` | ✅ |
| A-4 | Timeout hiệu dụng = `min(stepTimeout, remaining)`; hết deadline → dừng job | ai-worker | `src/server.js` | ✅ |
| A-5 | `detectRateLimit(output)` → dừng job ngay, không FIXING tiếp | ai-worker | `src/server.js` | ✅ |
| A-6 | Backoff giữa các vòng retry (`5s × 2^n`, cap `60s`) | ai-worker | `src/server.js` | ✅ |
| A-7 | Thời lượng từng bước đo được (timestamp log + bảng `steps`) | ai-worker | `src/server.js` (`emitJobLog`, `beginStepTimeline`/`endStepTimeline`) | ✅ |
| A-8 | Prefix timestamp ISO cho từng dòng log (cùng thay đổi với A-7) | ai-worker | `src/server.js` (`emitJobLog`) | ✅ |
| A-9 | `checkGuard` khi `action='scrub'` phải trả prompt **đã scrub** (trước trả `original` ⇒ SecretScrubber vô tác dụng) | ai-worker | `src/systemone/client.js` | ✅ |
| A-10 | Deadline tuyệt đối: persist `pipeline_config.deadline_at` (trước tính lại mỗi step ⇒ deadline trượt mãi ⇒ AC-1.3 vô hiệu) | ai-worker | `src/execution/jobPolicy.js`, `src/server.js` | ✅ |
| A-11 | `detectRateLimit` đọc `stdout`+`stderr` (`runner.execute()` **không có** field `output` ⇒ rate-limit không bao giờ phát hiện) | ai-worker | `src/execution/jobPolicy.js` (`collectAgentOutput`) | ✅ |
| A-12 | Bảng `steps` ghi timeline từng phase (trước `updateStep` không có caller ⇒ không đo được thời gian từng bước) | ai-worker | `src/server.js` | ✅ |
| A-13 | `getEvidenceByJobId` mặc định `NOT VERIFY` thay vì `PASS` khi chưa verify | ai-worker | `src/storage/db.js` | ✅ |
| **Phase B — SystemOne** |||||
| B-1 | `fixGateHeuristic` trả `fallback: true, source: 'heuristic'` | ai-worker | `src/systemone/policy.js` | ✅ |
| B-2 | Mọi đường trả heuristic trong client kèm cờ fallback | ai-worker | `src/systemone/client.js` | ✅ |
| B-3 | `checkFixGate`: heuristic **không** được chặn retry | ai-worker | `src/systemone/client.js:331` | ✅ |
| B-4 | `getStatus()` → `{ enabled, live, fallbackCount, lastError, model, baseUrl }` | ai-worker | `src/systemone/client.js` | ✅ |
| B-5 | Route `GET /api/v1/systemone/status` | ai-worker | `src/server.js` | ✅ |
| B-6 | Log cảnh báo `[SYSTEMONE-FALLBACK]` khi rơi về heuristic | ai-worker | `src/server.js` | ✅ |
| **Phase C — Evidence realtime** |||||
| C-1 | `EvidenceWatcher` theo dõi thư mục evidence (`fs.watch` + debounce + fallback poll) | ai-worker | `src/server.js` | ✅ |
| C-2 | Phát `emitJobEvidence` cho evidence mới/cập nhật | ai-worker | `src/server.js` | ✅ |
| C-3 | Bật watcher khi job vào bước chạy; tắt khi terminal | ai-worker | `src/server.js` | ✅ |
| C-4 | Payload evidence đủ field (name/description/status/order/…) | ai-worker | `src/server.js` | ✅ |
| C-5 | UI upsert evidence theo `filename` (không trùng) + re-render | ai-worker | `public/app.js:785` | ✅ |
| **Phase D — Vòng đời trạng thái** |||||
| D-1 | `captureScreenshot` ghi `status: 'NOT VERIFY'` + `order`/`stepIndex`/`description`/`passCriteria` | ai-worker | `src/verification/browserRunner.js` | ✅ |
| D-2 | API map 3 trạng thái; mặc định `NOT VERIFY` (không mặc định PASS) | ai-worker | `src/server.js:1493` | ✅ |
| D-3 | `handleUpdateEvidenceStatus` nhận `NOT VERIFY`/`PASS`/`FAILED` | ai-worker | `src/server.js:1684` | ✅ |
| D-4 | `verifyTaskEvidence` ghi lại PASS/FAILED cho từng file vào `metadata.json` | ai-worker | `src/server.js:1723` | ✅ |
| D-5 | UI badge 3 màu + sửa bug `NOT VERIFY` bị coi là PASS | ai-worker | `public/app.js` | ✅ |
| **Phase E — Tên & mô tả** |||||
| E-1 | `captureScreenshot` nhận `name`/`description`/`passCriteria`/`stepIndex`/`stepTotal` | ai-worker | `src/verification/browserRunner.js` | ✅ |
| E-2 | `getEvidenceFileMeta` đọc `name`/`passCriteria`/`order`/`stepIndex` | ai-worker | `src/server.js:278` | ✅ |
| E-3 | Item API trả `name`/`description`/`passCriteria`/`order`/`stepIndex` | ai-worker | `src/server.js:1487` | ✅ |
| E-4 | Card UI hiển thị `name` | ai-worker | `public/app.js:1433` | ✅ |
| E-5 | Modal hiển thị tên + mô tả + tiêu chí PASS + metadata | ai-worker | `public/app.js:2226` | ✅ |
| **Phase F — Thứ tự ảnh + lightbox** |||||
| F-1 | Tên file `${pad2(stepIndex)}_${safeStep}.png` | ai-worker | `src/verification/browserRunner.js:735` | ✅ |
| F-2 | Sort evidence theo `order` → `stepIndex` → `timestamp` | ai-worker | `src/server.js` | ✅ |
| F-3 | Modal ảnh: nút ‹ ›, phím ← →, chỉ báo "3 / 12" | ai-worker | `public/app.js` | ✅ |
| F-4 | Markup nút điều hướng trong modal | ai-worker | `public/index.html` | ✅ |
| F-5 | `escapeHtml` cho mọi metadata hiển thị | ai-worker | `public/app.js` | ✅ |
| **Phase G — Kiểm thử** |||||
| **Phase H — SystemOne: config, file context, badge per-task** ||||
| H-1 | Key 9router hợp lệ + model `openrouter/typesafe/jev-1.13` (key cũ ⇒ 401 ⇒ 6/6 rơi về heuristic) | ai-worker | `.env`, `.env.example`, `src/config.js`, `src/systemone/client.js` | ✅ |
| H-2 | `systemone.probe()` + route `GET /api/v1/systemone/probe`; `live` chỉ true khi `noul` hợp lệ | ai-worker | `src/systemone/client.js`, `src/server.js` | ✅ |
| H-3 | `clear-systemone-env.bat` dùng chung cho 3 script start (xoá env kế thừa) + `ping -n` thay `timeout /t` | ai-worker | `clear-systemone-env.bat`, `start-worker.bat`, `start-worker-bg.bat`, `restart-worker.bat` | ✅ |
| H-4 | `fileContext.js`: gom nội dung file (async, budget token, untracked, ưu tiên stack trace, guard `path.relative`) | ai-worker | `src/systemone/fileContext.js` | ✅ |
| H-5 | `postJev` budget `state` 4000 → `MAX_STATE_CHARS=240000`; cache key = `sha256(fileContext)` | ai-worker | `src/systemone/client.js` | ✅ |
| H-6 | FIXING truyền nội dung file thật + log số file/token/cắt | ai-worker | `src/server.js` | ✅ |
| H-7 | Badge SystemOne **per-task**: cột `jobs.systemone_state` + tracker `getJobStatus` + `recordSystemOne` (8 call site) + SSE `systemone` + UI job card & header chi tiết | ai-worker | `src/storage/db.js`, `src/systemone/client.js`, `src/server.js`, `public/app.js`, `public/index.html` | ✅ |
| H-8 | `promptGuard.js`: scrub prompt **local** + phát hiện injection (thay 4 call `checkGuard`) | ai-worker | `src/execution/promptGuard.js`, `src/server.js` | ✅ |
| H-9 | Bỏ `checkDedup` (→ `localDedup` hash local) + bỏ `checkPreJudge` (chỉ log, không quyết định) | ai-worker | `src/server.js`, `src/systemone/client.js` | ✅ |
| **Phase I — Hiệu năng & tự điều hướng** ||||
| I-1 | Chế độ NHANH cho task nhẹ: `pipeline_config.quick_track` + template `planning-quick.md` / `implement-quick.md` | ai-worker | `templates/prompt/planning-quick.md`, `templates/prompt/implement-quick.md`, `src/server.js` | ✅ |
| I-2 | Timeout quick track: `jobPolicy.resolveQuickStepTimeoutMs()` — cap **chỉ áp khi user KHÔNG khai timeout tường minh** (timeout user luôn thắng), sàn 1 phút, không vượt timeout hiện có | ai-worker | `src/execution/jobPolicy.js`, `src/server.js` | ✅ |
| **Phase J — Kiểm thử (bổ sung)** ||||
| J-6 | TRIAGE: **1 lượt gọi headless AI** (`claude -p --output-format json --tools ""`) trả JSON quyết định độ phức tạp → Jev network (2 câu, bỏ `need_browser`) → heuristic offline (≤ 0.4, không tự bật quick track) | ai-worker | `src/execution/aiTriage.js`, `src/systemone/client.js` (`decideTriage`) | ✅ |
| J-7 | Sửa bug heuristic `quick` check trước `large` ⇒ "migrate..." bị nhầm là task nhẹ; thêm `fold()` bỏ dấu | ai-worker | `src/systemone/policy.js` | ✅ |
| J-8 | Badge chỉ đổi khi model thật quyết định (bỏ qua `cached` / `attempt-limit` / `heuristic-fast`) | ai-worker | `src/systemone/client.js`, `src/server.js` | ✅ |
| J-9 | Fix UI: typo `CHƯA GỠI` → `CHƯA GỌI`; đổi tham số `renderSystemOneBadge(state)` → `soState` (không che biến `state` toàn cục) | ai-worker | `public/app.js` | ✅ |
| J-1 | Test fileContext: gom/cat/guard/untracked/ưu tiên stack trace | ai-worker | `tests/fileContext.test.js` | ✅ |
| J-2 | Test **wiring**: stub `global.fetch` bắt body thật (bắt được bug `slice(0,4000)` khi revert fix) | ai-worker | `tests/systemoneFileWiring.test.js` | ✅ |
| J-3 | Test badge per-task: 2 job có state riêng, model lỗi → FALLBACK, `checkGuard` bọc `.decision` | ai-worker | `tests/systemoneJobState.test.js` | ✅ |
| J-4 | Test `promptGuard`: scrub secret, **không cắt dữ liệu**, injection có/không dấu | ai-worker | `tests/promptGuard.test.js` | ✅ |
| J-5 | Test quick track: `quick_track` đọc/ghi, timeout cap, template quick tồn tại & ngắn hơn template chuẩn | ai-worker | `tests/quickTrack.test.js` | ✅ |
| G-1 | Test `resolveMaxRetries` + deadline + rate-limit + backoff | ai-worker | `tests/timeoutRetry.test.js` | ✅ |
| G-2 | Test SystemOne fallback không chặn retry + `getStatus` | ai-worker | `tests/systemone.test.js` | ✅ |
| G-3 | Test vòng đời evidence + sort | ai-worker | `tests/evidenceLifecycle.test.js` | ✅ |
| G-4 | `npm test` xanh, `node --check` frontend/backend | ai-worker | — | ✅ |
| **Phase K — Timeout / Retry / Quick mode (job bd88ae0a / RSGATE-44)** ||||
| K-1 | Triage dùng **1 lượt gọi headless AI** (`claude -p --output-format json`, không thinking) trả JSON thay cho regex heuristic | ai-worker | `src/execution/aiTriage.js` (mới), `src/systemone/client.js` | ✅ |
| K-2 | Heuristic offline **không tự bật** quick track (confidence ≤ 0.4 < ngưỡng 0.5); bỏ nhánh `confidence: 0.9` giả | ai-worker | `src/systemone/client.js` | ✅ |
| K-3 | **Timeout user khai tường minh luôn thắng** quick cap (chỉ cap khi user KHÔNG khai timeout) | ai-worker | `src/server.js`, `src/execution/jobPolicy.js` | ✅ |
| K-4 | PLANNING timeout/lỗi ⇒ **dừng pipeline**, KHÔNG sinh plan mẫu `DualPlanningGenerator` rồi coi là "đã xong" | ai-worker | `src/server.js` | ✅ |
| K-5 | IMPLEMENT timeout ⇒ **vòng retry** theo `pipeline_config.max_retries` + backoff, thay vì `throw` | ai-worker | `src/server.js` | ✅ |
| K-6 | `quick_track` có **đường reset**: `POST /api/v1/jobs/:id/quick-track` (`auto`/`on`/`off`) + select 3 trạng thái trong UI | ai-worker | `src/server.js`, `public/app.js`, `public/index.html` | ✅ |
| K-7 | Quick mode hiệu lực dùng chung cho **cả cap timeout lẫn template** (`planning-quick`/`implement-quick`) | ai-worker | `src/server.js` (`resolveEffectiveQuickTrack`) | ✅ |
| K-8 | Kill-switch `AI_TRIAGE_ENABLED` (độc lập `SYSTEMONE_ENABLED`) + test triage không gọi CLI thật | ai-worker | `src/config.js`, `tests/systemoneJobState.test.js` | ✅ |

## Ghi chú

- **RC-3 (`MultiVerificationGate` không chạy trong pipeline)** — ghi nhận, không sửa trong feature này. Đề xuất feature riêng.
- **RC-10 (bảng SQLite `evidence` dead-code)** — giữ nguyên, xem ADR-1.
