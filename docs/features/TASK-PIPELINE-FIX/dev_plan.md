---
feature: TASK-PIPELINE-FIX
service: ai-worker
status: plan-review
owner: AI
updated_at: 2026-10-20
---

# Kế hoạch kỹ thuật (dev_plan.md) — TASK-PIPELINE-FIX

## 0. Tóm tắt

Sửa 3 nhóm lỗi đã chứng minh được từ task `bd88ae0a`:

1. **Timeout/Retry** — `max_retries` của job bị bỏ qua; không có tổng ngân sách thời gian; không backoff; 429 không được xử lý.
2. **SystemOne** — endpoint 401 ⇒ mọi quyết định rơi về heuristic `confidence 0.3` nhưng **vẫn dùng như model thật** để quyết định retry. Im lặng, không cảnh báo.
3. **Evidence** — không realtime; không có trạng thái `NOT VERIFY`; không có tên/mô tả; ảnh không có thứ tự theo step; modal không chuyển ảnh.

**Nguyên tắc thiết kế:** sửa đúng chỗ sai, không dựng lại hệ thống. Mọi thay đổi đều trace được về một RC trong `expect.md`.

---

## 1. Quyết định kiến trúc (ADR-style)

### ADR-1: Nguồn sự thật của evidence = filesystem + `metadata.json`, KHÔNG phải bảng SQLite `evidence`

- **Bằng chứng:** mọi route evidence (`src/server.js:1402`) và toàn bộ UI đọc từ `docs/features/<TASK>/evidence/` + `metadata.json`. `getEvidenceByJobId()` (`src/storage/db.js:569`) **không có caller nào**.
- **Quyết định:** giữ filesystem làm nguồn chân lý. Bảng `evidence` trong DB giữ nguyên hiện trạng (dead-code) — **không** refactor trong feature này.
- **Lý do:** đổi sang DB là thay đổi lớn, phải migration + viết lại toàn bộ route đọc. Không cần thiết cho 4 yêu cầu evidence.
- **Hệ quả:** trạng thái realtime phải theo dõi **filesystem**, dùng watcher/poll → phát SSE.

### ADR-2: `max_retries` của job thắng env `MAX_FIXING_RETRIES`

- **Thứ tự ưu tiên:** `job.pipeline_config.max_retries` → `job.pipeline_config.maxRetries` → `job.max_retries` → `env MAX_FIXING_RETRIES` → default `3`.
- **Lý do:** user đã nhập `max_retries: 10` khi tạo job (`public/app.js:3464` gửi `max_retries`), server đã lưu vào DB (`src/server.js:1341`), nhưng `src/server.js:2486` bỏ qua nó. Đây là bug đọc sai nguồn, không phải thiết kế.
- **Tương thích ngược:** job cũ không có `max_retries` → rơi về env → hành vi hiện tại giữ nguyên.

### ADR-3: Tổng ngân sách thời gian cho job (job-level deadline), không chỉ per-step

- **Vấn đề:** `jobTimeoutMs` áp dụng cho **từng** lần gọi adapter (`src/server.js:2152, 2301, 2374, 2501`). 5 step × 3 retry × 1h = 15h potential.
- **Quyết định:** thêm `job_deadline_ms` — deadline tuyệt đối cho cả job. Mỗi lần spawn agent, deadline còn lại được truyền xuống làm timeout hiệu dụng = `min(stepTimeout, remaining)`.
- **Vì sao cần:** user nói "1 task nhỏ nhưng làm tận mấy tiếng". Per-step timeout không giải quyết được.
- **Mặc định:** `job_deadline_ms` = `timeout × MAX_STEPS_TOTAL` nếu không khai? **Không.** Mặc định = **disabled** (không đặt deadline) để không đổi hành vi job cũ. UI sẽ cho phép khai.

### ADR-4: Backoff giữa các vòng FIXING retry

- **Quyết định:** backoff theo attempt: `min(base × 2^(attempt-1), cap)` với `base = 5s`, `cap = 60s`.
- **Lý do:** 3 vòng FIXING liên tiếp dính nhau → mỗi vòng lại chạy 1h TESTING. Backoff nhẹ giúp provider hồi phục, đồng thời tránh "vòng lặp vô ích".
- **Không** dùng backoff dài: mục tiêu là cắt vòng lãng phí, không phải trì hoãn job.

### ADR-5: 429 / rate-limit ⇒ dừng job, không retry

- **Bằng chứng:** log dòng 5407 — provider trả `429 ... retry-after-ms=2396831000` (~27 ngày).
- **Quyết định:** detect `429` hoặc `rate_limit_error` trong output của agent CLI ⇒ đánh dấu job `FAILED` với `error_message` giải thích `provider rate-limited, retry after <X>`; **không** chạy vòng FIXING tiếp theo, **không** chạy TESTING tiếp theo.
- **Lý do:** retry-after 27 ngày ⇒ mọi retry đều vô nghĩa, mỗi vòng lãng phí ~1h.

### ADR-6: SystemOne fallback phải **fail-safe**, không được giả vờ là model

- **Vấn đề:** `policy.fixGateHeuristic()` trả `p_success: 0.3, confidence: 0.3` — nhưng `checkFixGate` vẫn dùng nó để quyết định `retry`. Không ai biết đó là heuristic.
- **Quyết định:**
  1. Heuristic fixGate **không** được phép quyết định `retry=false` (chặn retry dựa trên số liệu giả). Chỉ được cho `retry=true` khi còn attempt.
  2. Mọi response có `cached:false` + `confidence <= 0.4` (heuristic) phải được đánh dấu `fallback: true`.
  3. Log cảnh báo rõ + expose trạng thái qua API/UI.
- **Lý do:** hiện tại model offline đang **giết job** bằng quyết định dựa trên số 0.3 giả. Đây là nguyên nhân trực tiếp dẫn tới `attempt 3/3 → FAILED`.
### 2.1 Phát hiện bổ sung (cross-check bằng scout độc lập)

| # | Vấn đề | Bằng chứng |
|---|---|---|
| **RC-13** | **Kết quả FIXING bị bỏ qua.** `await runner.execute(...)` ở FIXING không kiểm tra `timedOut`/`exitCode` (khác IMPLEMENT `src/server.js:2319` và TESTING `:2391` vốn có kiểm tra) ⇒ một lượt FIXING dính timeout 1h vẫn log "Hoàn tất sửa lỗi" và vòng lặp vẫn chạy tiếp. | `src/server.js:2499-2504` |
| **RC-14** | **Double-normalize timeout.** `src/server.js:790` normalize lại giá trị đã normalize: `timeout: 5000` (ms) → `<10000` → nhân 60000 ⇒ 5000 **phút** ≈ 83 giờ. | `src/server.js:790`, `src/config.js:60-65` |
| **RC-15** | **PENDING chờ người dùng không có timeout.** `clarificationManager.js:91-95` emit `pause_timeout` nhưng **không có listener nào trong toàn repo** ⇒ job treo vô hạn ở PLANNING. | `src/execution/clarificationManager.js:91-95` |
| **RC-16** | **Job không bao giờ ở trạng thái `TIMED_OUT`.** `src/server.js:154-160` chỉ log; grep `status: 'TIMED_OUT'` trong `src/` → 0 kết quả. Job timeout bị ghi `FAILED`. | `src/server.js:154-160, 2319-2325` |
| **RC-17** | **UI đọc cột không tồn tại.** `public/app.js:1052` đọc `job.max_retries` — cột này không có trong schema `jobs` ⇒ luôn `undefined` ⇒ badge luôn hiện `/3`. | `public/app.js:1051-1053`, `src/storage/db.js:35-56` |

### 2.2 Bổ sung vào kế hoạch triển khai

| Task | File | Thay đổi |
|---|---|---|
| A-9 | `src/server.js:2499-2504` | Kiểm tra `timedOut`/`exitCode` của lượt FIXING. Nếu timeout → **dừng job** (FAILED, lý do rõ ràng) thay vì coi là "Hoàn tất sửa lỗi" rồi chạy tiếp. |
| A-10 | `src/server.js:790` | Bỏ double-normalize: giá trị đã chuẩn hóa phải giữ nguyên. |
| A-11 | `src/server.js:154-160` | Khi timeout: ghi `status: 'TIMED_OUT'` cho job (thêm vào `TERMINAL_JOB_STATUSES` nếu chưa có) thay vì `FAILED`. |
| A-12 | `public/app.js:1052` | Đọc `max_retries` từ `pipeline_config` thay vì cột `job.max_retries` không tồn tại. |


### ADR-7: Evidence realtime = watcher filesystem → SSE

- **Quyết định:** thêm watcher theo thư mục evidence của job đang chạy; khi có file mới / metadata đổi → đọc lại danh sách → `jobEventBus.emitJobEvidence`.
- **Vì sao không poll từ client:** UI đã có SSE channel `evidence` (`src/server.js:3188`) — chỉ thiếu producer. Đẩy từ server là đúng hướng, không tốn request.
- **Cơ chế:** `fs.watch` với debounce 500ms + fallback interval 2s (Windows `fs.watch` không ổn định).

### ADR-8: Trạng thái evidence 3 giá trị, lưu ở `metadata.json`

- **Giá trị:** `NOT VERIFY` → `PASS` | `FAILED`.
- **Vì sao:** `metadata.json` đã là nơi lưu metadata evidence (stepName, description, timestamp...). Thêm `status` vào đó là tối thiểu.
- **Quy tắc chuyển trạng thái:**
  - Sinh evidence (agent chụp ảnh / ghi file) → `NOT VERIFY`.
  - `verifyTaskEvidence` chạy và xác nhận file hợp lệ + test case PASSED → `PASS`.
  - Verify lỗi / file rỗng / không khai báo trong `tests[]` → `FAILED`.
- **Lưu ý tương thích:** metadata cũ có `status: 'CAPTURED'` / `'PASSED'` / `'FAILED'` → cần normalize khi đọc.

### ADR-9: Thứ tự ảnh theo test step, lưu `order` + `stepIndex` trong `metadata.json`

- **Bằng chứng:** `browserRunner.js:735` đặt tên `${Date.now()}_${step}.png` → timestamp epoch, không phải sequence.
- **Quyết định:**
  1. `captureScreenshot` nhận `options.stepIndex` (số thứ tự step trong test plan) và `options.stepTotal`.
  2. Tên file: `${String(stepIndex).padStart(2,'0')}_${stepName}.png` — giữ prefix số như convention `TEST-VERIFY-FAST` đã dùng (`01_ui_system_verification.png`).
  3. `metadata.json` lưu `order` (số thứ tự trong step) + `stepIndex` + `stepName` + `description` + `passCriteria`.
  4. API sort theo `order` (fallback `stepIndex`, fallback `timestamp`).
- **Vì sao không đổi tên file cũ:** file cũ đã có trong feature dir; đổi tên phá vỡ tham chiếu. Sort theo metadata là đủ.

### ADR-10: Modal ảnh có next/prev dùng chung bộ ảnh đã sort

- **Quyết định:** modal dùng `state._evidenceCache.ui` (đã sort) → index hiện tại → nút ‹ › + phím tắt ← → + Esc. Hiển thị caption + tiêu chí PASS.
- **Lý do:** cache đã tồn tại (`public/app.js:1411`), không cần hạ tầng mới.

### ADR-11: `metadata.json` có 3 shape — đọc/ghi phải **giữ nguyên shape gốc**

- **Vấn đề phát hiện khi implement:** `metadata.json` trong workspace có **3 shape đang cùng tồn tại**:
  1. **ARRAY** — `[{ fileName, stepName, ... }]` (do `browserRunner.captureScreenshot` ghi)
  2. **OBJECT MAP** — `{ "file.png": { ... } }` (do `handleUpdateEvidenceStatus` ghi)
  3. **OBJECT CÓ `tests[]`** — `{ taskCode, verdict, tests: [ { evidence: [...] } ] }` (do CLI agent ghi)
- **Rủi ro nếu ép về 1 format:** shape 3 chứa `tests[]` — đây là dữ liệu `verifyTaskEvidence` đọc để quyết định gate (`src/server.js:2025` và `:2214`, đọc `metadataObj.tests`). Ghi đè `metadata.json` mà không giữ `tests[]` ⇒ **mọi job fail verify**.
- **Quyết định:** module `src/verification/evidenceStore.js` đọc/giữ nguyên shape:
  - `readMetadata()` nhận diện shape, trả về `{ shape, raw, records }`.
  - `writeMetadata()` ghi lại đúng shape đó; với shape `tests[]` chỉ ghi đè `evidenceStatus` (map `filename → { status, verdict }`), **không** đụng `tests[]` hay field gốc.
  - Với shape MAP, chỉ nhận key có extension file thật (`EVIDENCE_FILE_RE`) — key metadata gốc (`taskCode`, `verdict`, `notes`, `hasVisualDefects`, `consoleErrors`) là string/array nên bị bỏ qua, tránh biến thành record giả và ghi đè field gốc.
- **Bằng chứng test:** `tests/evidenceLifecycle.test.js` — 3 test khẳng định `tests[]` + key gốc còn nguyên sau khi ghi trạng thái; `tests/verifyTaskEvidenceStatus.test.js` — chạy `verifyTaskEvidence` thật rồi đọc lại `metadata.json`.

### ADR-12: `status` của evidence không được dùng làm HTTP status code ở frontend

- **Vấn đề:** sau khi chuẩn hóa `status` thành 3 giá trị (`server.js:1535`), các chỗ frontend đọc `api.status` như HTTP code sẽ hiện chữ "PASS" thay vì mã HTTP.
- **Quyết định:** server đặt `itemObj.statusCode` (`server.js:1640`) từ `parsedData`; frontend đọc `statusCode`/`status_code`/`actualStatus` — **không** đọc `status` cho HTTP code. Với kênh DB và `renderComparisonRows`, dùng `evidenceStatus(item)` để phân biệt `NOT VERIFY` với `PASS`/`FAILED`.
- **Lý do:** `status` là **trạng thái verify evidence**; HTTP code là **mã phản hồi**. Trộn hai khái niệm làm hiển thị sai.

---

## 2. Kế hoạch triển khai chi tiết

### Phase A — Timeout & Retry (`src/server.js`, `src/config.js`)

| Task | File | Thay đổi |
|---|---|---|
| A-1 | `src/server.js:2486` | `const maxRetries = resolveMaxRetries(job)` — helper mới đọc `job.pipeline_config.max_retries` → `maxRetries` → `job.max_retries` → `config.MAX_FIXING_RETRIES` → 3. Trả kèm `source` để log. |
| A-2 | `src/server.js:2488` | Log `[SYSTEMONE-FIXGATE] attempt=X/Y (source=job|env|default)`. |
| A-3 | `src/server.js:2104` | Tính `jobDeadlineAt` từ `pipeline_config.job_deadline_ms` (hoặc `deadline_minutes`). Lưu vào job khi bắt đầu. |
| A-4 | `src/server.js:2152/2301/2374/2501` | Timeout hiệu dụng = `min(jobTimeoutMs, remainingDeadline)`. Nếu remaining <= 0 → dừng job với lý do "deadline". |
| A-5 | `src/server.js` (mới helper) | `detectRateLimit(output)` → true nếu có `429`, `rate_limit_error`, `ALL_TARGETS_SKIPPED`, `retry-after-ms`. Khi true → FAILED job ngay, không FIXING. |
| A-6 | `src/server.js` | Backoff giữa các vòng retry: `sleep(min(5000 * 2^(attempt-1), 60000))` trước khi spawn FIXING (bỏ qua vòng đầu). |
| A-7 | `src/server.js` (`emitJobLog`) | Thời lượng từng bước đo được: prefix `[ISO timestamp]` cho **từng dòng** ghi vào file log. *(Không sửa `processManager` — thời lượng thu được từ timestamp log là đủ, tránh thêm field thừa.)* |
| A-8 | `src/server.js` (`emitJobLog`) | Như A-7 — cùng một thay đổi giải quyết AC-1.6. |

### Phase B — SystemOne (`src/systemone/client.js`, `src/systemone/policy.js`)

| Task | File | Thay đổi |
|---|---|---|
| B-1 | `src/systemone/policy.js:33-41` | `fixGateHeuristic` thêm `fallback: true`, `source: 'heuristic'`. |
| B-2 | `src/systemone/client.js:154, 176, 338` | Mọi đường trả về từ heuristic đều kèm `fallback: true, source: 'heuristic'`. |
| B-3 | `src/systemone/client.js:331` | `checkFixGate`: nếu `decision.fallback === true` thì **không** chặn retry (chỉ chặn khi attempt >= maxRetries thật). |
| B-4 | `src/systemone/client.js` | Thêm `getStatus()` → `{ enabled, baseUrl, model, lastError, fallbackCount, live }`. `live` = call thành công gần nhất. |
| B-5 | `src/server.js` | Route `GET /api/v1/systemone/status`. |
| B-6 | `src/server.js` | Log cảnh báo `[SYSTEMONE-FALLBACK]` khi dùng heuristic (1 lần mỗi route, không spam). |

### Phase C — Evidence realtime (`src/server.js`, `src/storage/fileManager.js`)

| Task | File | Thay đổi |
|---|---|---|
| C-1 | `src/server.js` (helper mới) | `EvidenceWatcher` — theo dõi `taskEvidenceDir` của job đang chạy. `fs.watch` + debounce 500ms + fallback interval 2s. |
| C-2 | `src/server.js` | Khi phát hiện thay đổi → dựng lại list evidence → `jobEventBus.emitJobEvidence(id, { evidence: item })` cho từng item mới/cập nhật. |
| C-3 | `src/server.js` | Bắt đầu watcher khi job vào PLANNING/IMPLEMENT/TESTING; dừng khi job terminal. |
| C-4 | `src/server.js` | `emitJobEvidence` payload phải chứa đủ field: `filename, name, description, status, verdict, order, stepIndex, stepName, url, file_path, evidence_type, channel, passCriteria`. |
| C-5 | `public/app.js:785-794` | Handler SSE evidence: **upsert** theo `filename` (không `push` trùng) + re-render. |

### Phase D — Vòng đời trạng thái evidence (`src/server.js`, `src/verification/browserRunner.js`)

| Task | File | Thay đổi |
|---|---|---|
| D-1 | `src/verification/browserRunner.js:798-820` | Ghi `status: 'NOT VERIFY'`, `verdict: null`, `order`, `stepIndex`, `stepName`, `description`, `passCriteria`. |
| D-2 | `src/server.js:1493-1497` | Map trạng thái: `meta.status` chuẩn hóa về `NOT VERIFY`/`PASS`/`FAILED`. Mặc định khi thiếu = `NOT VERIFY` (KHÔNG mặc định PASS). |
| D-3 | `src/server.js:1684-1690` | `handleUpdateEvidenceStatus` nhận `NOT VERIFY` / `PASS` / `FAILED` (hiện chỉ map `PASSED`/`FAILED`). |
| D-4 | `src/server.js:1723+` (`verifyTaskEvidence`) | Sau khi verify, **ghi lại trạng thái từng file** vào `metadata.json`: file hợp lệ & test case PASSED → `PASS`; file lỗi/rỗng/không khai báo → `FAILED`. |
| D-5 | `public/app.js` | Badge 3 màu: `NOT VERIFY` (slate), `PASS` (emerald), `FAILED` (rose). Logic `isPass` phải phân biệt 3 trạng thái (hiện `!item.verdict && status!=='FAILED'` ⇒ coi NOT VERIFY là PASS — **bug**). |

### Phase E — Tên & mô tả evidence (`src/verification/browserRunner.js`, `src/server.js`, `public/app.js`)

| Task | File | Thay đổi |
|---|---|---|
| E-1 | `src/verification/browserRunner.js:727` | `captureScreenshot` nhận `options.name`, `options.description`, `options.passCriteria`, `options.stepIndex`, `options.stepTotal`. |
| E-2 | `src/server.js` | `getEvidenceFileMeta` đọc thêm `name`, `passCriteria`, `order`, `stepIndex`. |
| E-3 | `src/server.js:1487-1500` | Item trả về API có `name`, `description`, `passCriteria`, `order`, `stepIndex`. |
| E-4 | `public/app.js:1433` | Card hiển thị `name` (fallback description → filename). |
| E-5 | `public/app.js:2226-2245` | Modal hiển thị tên + mô tả + tiêu chí PASS + metadata (step, test case, URL, thời gian). |

### Phase F — Thứ tự ảnh + lightbox (`src/verification/browserRunner.js`, `src/server.js`, `public/app.js`, `public/index.html`)

| Task | File | Thay đổi |
|---|---|---|
| F-1 | `src/verification/browserRunner.js:735` | Tên file `${pad2(stepIndex)}_${safeStep}.png` khi có `stepIndex`, fallback timestamp cũ. |
| F-2 | `src/server.js` | Sort evidence UI theo `order` → `stepIndex` → `timestamp` → tên file. |
| F-3 | `public/app.js` | Modal ảnh: nút ‹ ›, phím ← →, chỉ báo "3 / 12", caption, tiêu chí PASS. |
| F-4 | `public/index.html` | Thêm markup nút điều hướng trong `evidenceDetailModal`. |
| F-5 | `public/app.js` | `escapeHtml` áp dụng cho mọi giá trị từ metadata (tránh XSS từ file evidence tự tạo). |

### Phase G — Kiểm thử (`tests/`)

| Task | File | Nội dung |
|---|---|---|
| G-1 | `tests/timeoutRetry.test.js` (mới) | `resolveMaxRetries` đọc đúng nguồn; deadline cắt job; rate-limit detect; backoff. |
| G-2 | `tests/systemone.test.js` (mở rộng) | Fallback đánh dấu `fallback: true`; `checkFixGate` không chặn retry khi heuristic; `getStatus()`. |
| G-3 | `tests/evidenceLifecycle.test.js` (mới) | Metadata chuẩn hóa 3 trạng thái; verify ghi PASS/FAILED; sort theo order. |
| G-4 | `tests/` | Không phá vỡ test hiện có: `npm test` phải xanh. |

---

## 3. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Đổi `maxRetries` làm job cũ chạy lâu hơn | Trung bình | Chỉ job **có khai** `max_retries` mới đổi; job cũ giữ hành vi. Ghi log source để trace. |
| `NOT VERIFY` mặc định có thể làm gate fail | Cao | `verifyTaskEvidence` là nơi quyết định gate, **không** phải UI. UI chỉ hiển thị. Phải đảm bảo `verifyTaskEvidence` set PASS/FAILED cho **mọi** file trước khi kết luận gate. |
| Watcher filesystem trên Windows không ổn định | Trung bình | `fs.watch` + fallback interval 2s; dedupe bằng hash nội dung. |
| Sửa `public/app.js` (file 4000+ dòng) dễ vỡ | Trung bình | Sửa tối thiểu, giữ nguyên style; kiểm tra syntax bằng `node --check`. |
| Rate-limit detect quá rộng (false positive) | Thấp | Chỉ match pattern cụ thể: `429`, `rate_limit_error`, `ALL_TARGETS_SKIPPED`, `retry-after-ms`. Không match chuỗi thường. |
| `MultiVerificationGate` vẫn không dùng | — | Ghi nhận RC-3, đề xuất feature riêng. Không sửa trong feature này. |

---

## 4. Verification

```bash
npm test                      # toàn bộ test suite
node --check public/app.js    # syntax frontend
node --check src/server.js    # syntax backend
```

Test mới phải chứng minh được:
- `max_retries` trong `pipeline_config` **thực sự** được dùng (không chỉ `env`).
- Job cũ không có `max_retries` vẫn dùng `env` (không hồi quy).
- Evidence mới sinh = `NOT VERIFY`; sau verify = `PASS` hoặc `FAILED` tương ứng.
- Sort ảnh theo `order`/`stepIndex`.
- SystemOne fallback **không** chặn retry.
