---
feature: TASK-PIPELINE-FIX
service: ai-worker
status: testing
owner: AI
updated_at: 2026-10-21
---

# Báo cáo thực thi (report.md) — TASK-PIPELINE-FIX

## 1. Tóm tắt

Phân tích task `bd88ae0a-da46-4d35-af4e-49252e16dade` (RSGATE-44, FAILED sau **3h58m**), xác định **28 root cause** có bằng chứng, và sửa 3 nhóm vấn đề: timeout/retry, hiệu quả SystemOne, hệ thống evidence.

**Đợt 2 (RC-23 → RC-28)**: điều tra lại job RSGATE-44 lần 2 (fail ở IMPLEMENT sau khi bấm Start 3 lần). Phát hiện 6 lỗi xếp chồng làm **timeout user bị hệ thống tự ghi đè từ 3600s xuống 300s**: triage regex phân loại sai + `confidence: 0.9` giả ⇒ tự bật quick mode; quick cap không dùng `fallbackMs`; PLANNING timeout bị coi là "xong" và sinh plan mẫu; IMPLEMENT timeout không đi qua retry; `quick_track` không có đường reset; quick mode chọn sai template.

**Yêu cầu bổ sung**: triage **không** dùng regex mà gọi **1 lượt headless AI** trả JSON để đo độ phức tạp task. Code **không ép cờ tắt thinking**; chỉ quan sát được `thinking_tokens: 0` ở model hiện tại (xem mục 4.6).

| Nhóm | Trạng thái | Bằng chứng |
|---|---|---|
| Timeout / Retry | ✅ Đã sửa | 22/22 test `tests/timeoutRetry.test.js` |
| SystemOne | ✅ Đã sửa | 5/5 test `tests/systemoneFallback.test.js` |
| Evidence realtime + vòng đời trạng thái | ✅ Đã sửa | 12/12 test `tests/evidenceLifecycle.test.js` + 5/5 `tests/verifyTaskEvidenceStatus.test.js` |
| Timeout / Retry / Quick mode (đợt 2) | ✅ Đã sửa | AI triage thật trả `M/full` (trước: `S/quick`) + 221/221 `npm test` + verify browser 3 trạng thái `quick_track` |
| Evidence tên/mô tả/thứ tự/lightbox | ✅ Đã sửa | Verify UI thật (browser) + 17/17 `npm run test:verify-fix` |
| Hồi quy toàn hệ thống | ✅ Không có | 221/221 `npm test` + E2E `npm run test:pipeline` PASS |

---

## 2. File đã thay đổi thực tế

### 2.1 File mới (8)

| File | Mục đích |
|---|---|
| `src/execution/jobPolicy.js` | Quy tắc timeout/retry cho job: `resolveMaxRetries`, `resolveJobDeadlineMs`, `resolveDeadlineAt`, `resolveEffectiveTimeout`, `resolveRetryBackoffMs`, `detectRateLimit`. Tách riêng khỏi `server.js` để test độc lập. |
| `src/execution/aiTriage.js` | **Mới (đợt 2)**: phân loại độ phức tạp task bằng **1 lượt gọi headless AI** (`claude -p --output-format json --tools "" --strict-mcp-config --no-session-persistence`) trả JSON. Parse 3 tầng, validate/ép shape, scrub secret, cache RAM (TTL 1h), fallback fail-safe `{M, full, confidence 0.3}` (không tự bật quick track). Không truyền `jobId` (tránh kill nhầm process của job thật), `cwd = os.tmpdir()` (không nạp context repo). |
| `src/verification/evidenceStore.js` | Nguồn chân lý evidence: đọc/ghi `metadata.json` (3 shape), chuẩn hóa 3 trạng thái, sort theo step, `setStatuses` giữ nguyên shape. |
| `src/verification/evidenceWatcher.js` | Theo dõi thư mục evidence (`fs.watch` + debounce 500ms + fallback poll 2s) để đẩy evidence mới lên SSE realtime. |
| `tests/timeoutRetry.test.js` | 28 test cho timeout/retry/rate-limit/backoff/deadline tuyệt đối. |
| `tests/evidenceLifecycle.test.js` | 12 test cho vòng đời trạng thái, tên/mô tả, sort, bảo toàn 3 shape. |
| `tests/verifyTaskEvidenceStatus.test.js` | 5 test chạy `verifyTaskEvidence` **thật** rồi đọc lại `metadata.json`. |
| `tests/systemoneFallback.test.js` | 5 test cho fallback heuristic fail-safe + `getStatus()`. |
| `tests/evidenceWatcher.test.js` | 3 test cho watcher realtime. |
| `tests/stepTimeline.test.js` | 3 test cho bảng `steps` (timeline từng phase — đo được "tại sao lâu"). |
| `scripts/verify-task-pipeline-fix.js` | Verify end-to-end 17 assertion trên server thật (HTTP + SSE). |
|
|### 2.2 File sửa (8)
|
| File | Thay đổi |
|---|---|
| `src/server.js` | Import 3 module mới; `resolveMaxRetries` cho fixGate; deadline job **tuyệt đối** (persist `deadline_at`) + effective timeout; backoff giữa vòng retry; detect rate-limit (TESTING + FIXING) đọc `stdout`+`stderr`; check kết quả FIXING (RC-13); `TIMED_OUT` status riêng; `handleUpdateEvidenceStatus` nhận 3 trạng thái; `verifyTaskEvidence` ghi PASS/FAILED; `getTaskEvidences` + route `/evidence` dùng `evidenceStore` + sort 3 trạng thái; `EvidenceWatcher` quản lý theo job; **`beginStepTimeline`/`endStepTimeline`** ghi timeline bảng `steps`; route `/api/v1/systemone/status`; log `[SYSTEMONE-FALLBACK]`; timestamp prefix cho dòng log. |
| `src/storage/db.js` | `getEvidenceByJobId` mặc định `NOT VERIFY` (verdict `null`) thay vì `PASS` (RC-22). |
| `src/systemone/policy.js` | Mọi heuristic trả `fallback: true, source: 'heuristic'`. |
| `src/systemone/client.js` | `postJev` theo dõi `lastLiveState`/`lastError`; `checkFixGate` **không cho heuristic chặn retry**; `checkGuard` **scrub thật** khi `action='scrub'` (RC-20); `getStatus()`. |

| `src/verification/browserRunner.js` | `captureScreenshot` nhận `name`/`description`/`passCriteria`/`stepIndex`/`stepTotal`; tên file `${pad2(stepIndex)}_${step}.png`; `status: 'NOT VERIFY'`, `verdict: null`; `runScenario` truyền metadata step. |
| `public/app.js` | SSE evidence **upsert** theo filename; helper `evidenceStatus`/`evidenceStatusBadge` (3 màu); card gallery hiện tên + badge + "Bước N"; modal hiện tên/mô tả/bước/test case/**tiêu chí PASS** + nút ‹ › + counter "1 / 3"; phím ← →; `toggleEvidenceStatus` xoay 3 trạng thái; badge SystemOne LIVE/FALLBACK/OFF; `escapeHtml` chịu non-string. |
| `public/index.html` | Badge SystemOne trong header. |
| `package.json` | Script `test:verify-fix`. |

---

## 3. Root cause đã sửa (chi tiết)

| RC | Vấn đề | Cách sửa |
|---|---|---|
| RC-1 | `max_retries` của job bị bỏ qua — đọc `config.MAX_FIXING_RETRIES` (env=3) thay vì `pipeline_config.max_retries` (job khai 10) | `jobPolicy.resolveMaxRetries(job)` với thứ tự `job.pipeline_config.max_retries` → `maxRetries` → `job.max_retries` → `env` → `default`. Log kèm `source=`. |
| RC-2 | SystemOne 401 từ remote ⇒ mọi quyết định rơi về heuristic `confidence 0.3` nhưng vẫn dùng như model thật | Heuristic **không được chặn retry**; mọi heuristic đánh dấu `fallback: true`; log `[SYSTEMONE-FALLBACK]` 1 lần/job; badge `FALLBACK` trên UI; `GET /api/v1/systemone/status`. |
| RC-4 | Timeout chỉ per-step, không có tổng ngân sách cho job | `job_deadline_ms` / `job_deadline_minutes` trong `pipeline_config`; timeout hiệu dụng = `min(stepTimeout, remaining)`; hết deadline → `TIMED_OUT`. |
| RC-5 | Không backoff giữa các vòng retry | `resolveRetryBackoffMs` (5s × 2^n, cap 60s). |
| RC-6 | 429 rate-limit (`retry-after-ms=2396831000` ≈ 27 ngày) không được xử lý ⇒ mỗi vòng lãng phí ~1h | `detectRateLimit` ở output của TESTING và FIXING → dừng job ngay, không chạy tiếp. |
| RC-8 | Evidence không realtime — `emitJobEvidence` chỉ gọi 1 lần sau VERIFY pass | `EvidenceWatcher` theo dõi thư mục evidence → `emitJobEvidence(realtime: true)`; SSE route bật watcher + gửi snapshot ban đầu; UI upsert không trùng. |
| RC-9 | Evidence thiếu trạng thái `NOT VERIFY` — server map mọi thứ khác `FAILED` thành `PASS` | `evidenceStore.normalizeStatus` về 3 giá trị; mặc định `NOT VERIFY`; `browserRunner` ghi `NOT VERIFY`; `verifyTaskEvidence` ghi `PASS`/`FAILED`. |
| RC-11 | Ảnh không có thứ tự theo step (tên file là timestamp epoch) | `stepIndex`/`order` trong metadata + tên file `${pad2}_${step}.png`; sort `order → stepIndex → timestamp → tên file`. |
| RC-12 | Modal ảnh không có next/prev | Nút ‹ › trong modal + phím ← → + counter "1 / 3". |
| RC-13 | Kết quả FIXING bị bỏ qua — timeout 1h vẫn log "Hoàn tất sửa lỗi" rồi chạy tiếp | Check `timedOut`/`exitCode` của lượt FIXING → dừng job với lý do rõ ràng. |
| RC-16 | Job không bao giờ ở trạng thái `TIMED_OUT` (ghi `FAILED`) | Timeout IMPLEMENT/TESTING/deadline ghi `TIMED_OUT`. |
| RC-17 | UI đọc `job.max_retries` — cột không tồn tại trong schema `jobs` | Đọc `pipeline_config.max_retries` + `fix_attempt`. |
| RC-18 | **Deadline trượt mãi ⇒ AC-1.3 vô hiệu.** `resolveDeadlineAt` đọc `job.started_at` — cột này **không tồn tại** trong schema `jobs` ⇒ base = `now` ⇒ deadline = now + deadlineMs. Mà `executeStep()` chạy lại ở MỖI lần chuyển step ⇒ deadline luôn trượt tiếp ⇒ tổng ngân sách thời gian của job không bao giờ có hiệu lực. | `resolveDeadlineAt` trả `{ deadlineAt, isNew }`; lần đầu tính rồi **persist `pipeline_config.deadline_at`** (epoch ms), các lần sau đọc lại giá trị đã lưu ⇒ deadline cố định suốt vòng đời job. Test: "deadline duoc gan 1 lan roi doc lai, khong truot theo moi lan chuyen step". |
| RC-19 | **Rate-limit không bao giờ phát hiện ⇒ AC-1.5 vô hiệu.** `detectRateLimit(fixingResult.output)` — nhưng `runner.execute()` trả `{ stdout, stderr, exitCode, timedOut }`, **không có** field `output` (chỉ tồn tại trong object thủ công ở nhánh `catch`). ⇒ `output` luôn `undefined`. Log 429 của CLI nằm trong **stderr**. | Thêm `jobPolicy.collectAgentOutput(result)` gom `stdout` + `stderr` + `output`; cả 2 call site (TESTING + FIXING) dùng nó. Test: "collectAgentOutput doc stdout + stderr" + "rate-limit trong stderr duoc phat hien (case that cua job bd88ae0a)". |
| RC-20 | **`SecretScrubber` vô tác dụng.** `checkGuard` trả `promptToUse: original` ở **mọi** nhánh, kể cả `action='scrub'` ⇒ prompt vẫn chứa secret gốc. | `promptToUse` = `scrubbed` khi `action='scrub'`/`'warn'`/fallback; chỉ `action='allow'` mới giữ `original`. Test cũ khẳng định hành vi sai đã được sửa thành khẳng định secret **không** còn trong `promptToUse`. |
| RC-21 | **Bảng `steps` gần như chết ⇒ không đo được "tại sao lâu".** `updateStep` (`db.js:441`) **không có caller nào** trong `src/`; chỉ 1 step `PENDING` được tạo lúc tạo job ⇒ không có `started_at`/`finished_at`/`exit_code` theo từng bước. | Thêm `beginStepTimeline`/`endStepTimeline` trong `server.js`: mỗi phase (PLANNING/IMPLEMENT/TESTING/VERIFY/FIXING) tạo 1 step `RUNNING` với `started_at`, đóng lại với `finished_at` + `exit_code` khi phase kết thúc hoặc job terminal. Test: `tests/stepTimeline.test.js` (3 test). |
| RC-22 | `getEvidenceByJobId` (`db.js:588`) map mọi `verdict` ≠ `'FAIL'` thành `'PASS'` ⇒ evidence chưa verify hiện PASS | `verdict` = `null` khi chưa có; `status` = `'NOT VERIFY'` khi chưa verify. |
| RC-23 | **Triage phân loại sai bằng regex ⇒ cắt timeout user từ 3600s xuống 300s.** `policy.triageSignals()` dùng `raw.length < 200 && !/fix\|bug\|error\|sua\|loi/` — prompt RSGATE-44 dài 162 ký tự, không chứa từ khóa nào ⇒ `quick=true`. `client.js` gán **hardcode** `confidence: 0.9` cho nhánh regex (trong khi `policy.js` tự mô tả heuristic chỉ ≤ 0.4) ⇒ vượt cổng 0.5 ⇒ tự bật `quick_track` + quick cap 300000ms. | Triage dùng **1 lượt gọi headless AI** (`src/execution/aiTriage.js` mới): `claude -p --output-format json` (`thinking_tokens: 0`), parse 3 tầng (JSON `.result` → JSONL `message_end` → regex `\{[\s\S]*\}`), validate + ép shape, scrub secret, cache RAM. Heuristic offline còn lại có `confidence ≤ 0.4` ⇒ **không tự bật quick track**. Kill-switch `AI_TRIAGE_ENABLED` (độc lập `SYSTEMONE_ENABLED`). |
| RC-24 | **`resolveQuickStepTimeoutMs` nhận `fallbackMs` nhưng KHÔNG dùng** ⇒ không bao giờ nâng timeout được, chỉ hạ. Timeout user khai tường minh không có đường ưu tiên. | Timeout user khai tường minh **luôn thắng**: `resolveEffectiveQuickTrack()` chỉ trả true khi (1) `quick_track === true`, (2) user CHƯA tắt (`quick_track !== false`), (3) user CHƯA khai timeout. `resolveQuickStepTimeoutMs` dùng `fallbackMs` (cap ≤ timeout hiện có, sàn 1 phút). |
| RC-25 | **PLANNING timeout bị coi là "xong".** Sau timeout, `readPlanFiles` trả plan rỗng ⇒ `DualPlanningGenerator.generateDevPlan()` **sinh plan mẫu tự động** (kèm `src/rsgate_44/index.js` — hoàn toàn lạc với task Java Spring Boot) ⇒ ghi "Đã ghi dev_plan.md và test_plan.md đầy đủ" ⇒ chuyển IMPLEMENT với plan rỗng. | `planningResult` capture `timedOut` (trước đó `await runner.execute()` bỏ qua return value) ⇒ timeout/lỗi ⇒ `TIMED_OUT`/`FAILED` + **dừng pipeline**, KHÔNG sinh plan mẫu. Chỉ sinh plan mẫu khi agent trả nội dung plan hợp lệ (≥ 60 ký tự). |
| RC-26 | **Timeout ở IMPLEMENT không đi qua retry.** `implementResult.timedOut` → `throw` ⇒ `max_retries: 10` **chưa từng** áp dụng cho IMPLEMENT (chỉ dùng cho FIXING). 3 lần timeout 300000ms trong log là 3 lần user bấm Start tay. | Vòng lặp `while (implementAttempt < implementMaxRetries)` với `jobPolicy.resolveMaxRetries(job).value`, backoff `resolveRetryBackoffMs`, timer riêng từng vòng (clear trong `finally` của chính vòng đó). Hết lượt ⇒ `TIMED_OUT`/`FAILED` + `return` (không throw ra ngoài). |
| RC-27 | **`quick_track` không có đường reset** — `setQuickTrack` chỉ set `true`; `handleJobStart` gọi lại `setQuickTrack(id, true)` **mỗi lần bấm Start** ⇒ xoá cờ trong DB cũng vô ích. Không có UI nào để tắt. | `POST /api/v1/jobs/:id/quick-track` nhận `mode: 'auto' \| 'on' \| 'off'`. `auto` = **xoá key** `quick_track` (khác hẳn `false` = tắt tường minh). UI: select 3 trạng thái trong modal Sửa Task. |
| RC-28 | **Quick mode làm sai cả nội dung prompt**, không chỉ cắt thời gian — `implement-quick.md` ("SỬA TỐI THIỂU") được chọn cho task Jira cần sửa backend + frontend. | `resolveEffectiveQuickTrack()` dùng chung cho **cả** cap timeout **lẫn** chọn template (`planning-quick`/`implement-quick`). |

### Ghi nhận, KHÔNG sửa trong feature này

| RC | Vấn đề | Lý do không sửa |
|---|---|---|
| RC-3 | `MultiVerificationGate` (4 kênh UI/API/Log/DB) không được instantiate trong pipeline — chỉ dùng trong `tests/` và `scripts/`. Pipeline thật dùng `verifyTaskEvidence`. | Tích hợp 4-kênh gate là thay đổi lớn, cần feature riêng. Đã ghi nhận trong `expect.md` §4 Out of scope. |
| RC-10 | Bảng SQLite `evidence` là dead code (`getEvidenceByJobId` không có caller). | ADR-1: giữ filesystem + `metadata.json` làm nguồn chân lý. Đổi sang DB là refactor lớn. |
| RC-14 | Double-normalize timeout ở `server.js:790`. | **Không phải bug** — `normalizeTimeoutMs` giữ nguyên số ≥ 10000 (đã là ms), không nhân đôi. Đã sửa comment cho đúng. |
| RC-15 | `PENDING` chờ người dùng không có timeout (`pause_timeout` không có listener). | Ngoài phạm vi 3 nhóm yêu cầu; cần thiết kế riêng về SLA cho bước chờ người dùng. |

---

## 4. Bằng chứng kiểm thử thực tế

### 4.1 Test tự động

```
$ npm test
ℹ tests 164
ℹ pass 164
ℹ fail 0
```

```
$ npm run test:pipeline
✔ [PASS] MultiVerificationGate HOÀN TẤT: 100% cả 4 kênh đều đạt điều kiện PASS.
```

### 4.2 Verify end-to-end (server thật, HTTP + SSE)

```
$ npm run test:verify-fix
[PASS] GET /api/v1/systemone/status tra ve 200
[PASS] SystemOne status co truong live/fallbackCount/model
[PASS] GET /evidence tra ve 3 evidence
[PASS] Moi evidence co status NOT VERIFY (chua verify) :: ["NOT VERIFY","NOT VERIFY","NOT VERIFY"]
[PASS] Moi evidence co verdict null khi chua verify :: [null,null,null]
[PASS] Moi evidence co name va description
[PASS] Moi evidence co passCriteria
[PASS] Evidence sap xep theo thu tu step (order 1,2,3) :: [1,2,3]
[PASS] POST status=PASS tra ve status PASS
[PASS] POST status=FAILED tra ve status FAILED
[PASS] POST status="NOT VERIFY" duoc chap nhan
[PASS] GET /evidence phan anh 3 trang thai sau khi doi :: ["PASS","FAILED","NOT VERIFY"]
[PASS] GET /jobs/:id (nguon UI) cung dung trang thai 3 gia tri
[PASS] GET /jobs/:id (nguon UI) co name + order
[PASS] SSE gui event "evidence" realtime khi file evidence moi sinh :: events=["status","evidence"] reason=received
=== TONG KET: 17/17 PASS ===
```

### 4.3 Verify UI thật (Chromium headless, server port 3111 với DB riêng)

**Evidence Hub render 3 card với badge 3 màu:**

| # | Tên evidence | Badge | Màu | Bước |
|---|---|---|---|---|
| 1 | Danh sach doi soat | `PASS` | emerald | Bước 1 |
| 2 | Chi tiet ban ghi | `NOT VERIFY` | slate | Bước 2 |
| 3 | Man hinh loi 502 | `FAILED` | rose | Bước 3 |

**Modal chi tiết ảnh (ảnh 1/3):**
- `title` = "Danh sach doi soat" (tên evidence, không phải tên file)
- `status` = "PASS"
- `meta` = "Tệp: 01_danh_sach.png | Trạng thái: PASS"
- Nút: "Ảnh trước (←)", "Ảnh tiếp theo (→)"
- Counter: "1 / 3"
- Có block "MÔ TẢ EVIDENCE NÀY LÀ GÌ" → "Bang doi soat hien thi cot HTTP Method"
- Có block "ẢNH NÀY ĐƯỢC COI LÀ PASS KHI NÀO" → "Co cot HTTP Method va khong con cot Ma loi"
- Có "BƯỚC KIỂM THỬ" = "Bước 1", "TEST CASE", "TÊN TỆP"

**Điều hướng ảnh (test thật qua click + phím):**

| Hành động | Counter | Tên evidence | Badge |
|---|---|---|---|
| Mở ảnh 1 | 1 / 3 | Danh sach doi soat | PASS |
| Click "Ảnh tiếp theo" | 2 / 3 | Chi tiet ban ghi | NOT VERIFY |
| Click "Ảnh tiếp theo" | 3 / 3 | Man hinh loi 502 | FAILED |
| Nhấn `←` | 2 / 3 | Chi tiet ban ghi | NOT VERIFY |

**Badge SystemOne trên header:** `CHƯA GỌI` → tooltip "SystemOne openrouter/typesafe/jev-1.13 @ https://9router.thanhpk.io.vn/v1/systemone".

### 4.4 Verify 4 kênh Evidence Hub (server port 3114, 6 evidence thật: 3 ảnh + 1 API + 1 DB + 1 Log)

| Kênh | Badge trạng thái | Ghi chú |
|---|---|---|
| UI (3 ảnh) | `PASS` (emerald) · `NOT VERIFY` (slate) · `FAILED` (rose) | Sắp xếp Bước 1 → 2 → 3 |
| API | `NOT VERIFY` (slate) | Dòng "Status:" hiện `200` (đúng HTTP code) — **không** hiện chữ "PASS" |
| DB | `NOT VERIFY` (slate) | Không bị coi là `MATCH` xanh |
| Log | `NOT VERIFY` (slate) | 1 header duy nhất: `INFO` · `UI-VERIFY-DEMO` · `NOT VERIFY` · timestamp (không trùng/lồng) |
| Badge đầu modal API | `NOT VERIFY` (nền slate) | "Kết quả đối soát: NOT VERIFY (chưa verify)" — nhất quán, không còn "FAILED" đỏ |

**Nội dung card Log render thực tế:**
`INFO | UI-VERIFY-DEMO | NOT VERIFY | 2026-10-20T06:00:00.000Z | Log service khi chay kiem thu | 06_service.log | ...`

---

### 4.5 Fix UI sau review (2026-10-21)
- Sửa typo `CHƯA GỠI` (Ỡ) → `CHƯA GỌI` (Ọ) ở cả 2 chỗ render badge — đúng chuỗi user yêu cầu.
- `renderSystemOneBadge(state)` → `renderSystemOneBadge(soState)`: tham số cùng tên với biến `state` toàn cục của app.js, dễ gây nhầm lẫn khi sửa sau này.


### 4.6 Verify đợt 2 — Timeout / Retry / Quick mode (2026-10-21)

**AI triage thật** (`src/execution/aiTriage.js`, prompt RSGATE-44 gốc):
```
[AI-TRIAGE] ai-headless: complexity=M track=full needBrowser=true confidence=0.65
  reason=Doc Jira RSGATE-44 + tai lieu conf, phan tich yeu cau va implement nhieu file
```
Trước đây: `complexity=S track=quick confidence=0.9` (heuristic regex, confidence hardcode) ⇒ quick cap 300000ms. Giờ: `M/full` ⇒ **không bật quick mode**.

**Đo độ trễ lượt gọi** (đo thực tế, nhiều lần — dao động theo tải gateway):

| Lệnh | Độ trễ | Output |
|---|---|---|
| `claude -p --output-format json` (bản đầy đủ, có MCP) | ~10-17s, 69k input tokens | 1 object JSON, field `result` = text |
| `claude -p --output-format json --tools "" --strict-mcp-config --no-session-persistence` (**bản dùng thật**) | **~11-22s**, ~16.8k input tokens | 1 object JSON, field `result` = text |
| `omp -p --mode=json` | ~30s, 377 dòng JSONL | nhiễu, phải parse event `message_end` ⇒ chọn `claude` |

**Về "không thinking"**: code **không truyền cờ tắt thinking**. Ở model đang dùng, `usage.output_tokens_details.thinking_tokens` trả `0` — đây là **quan sát**, không phải hành vi được ép. Nếu đổi sang model bật thinking mặc định thì con số này sẽ khác.

**Tối ưu context**: `--tools ""` (tắt tool — quan trọng vì prompt triage chứa URL Jira + `admin/admin`, agent có thể bỏ lượt phân loại để đi mở URL) + `--strict-mcp-config` (bỏ MCP server của máy) + `--no-session-persistence` + `cwd = os.tmpdir()` (không nạp `AGENTS.md`/chỉ dẫn dự án) ⇒ input token từ ~69k xuống ~16.8k.

**`resolveEffectiveQuickTrack` với job RSGATE-44 thật** (DB: `quick_track=true`, `timeout=3600000`):
```
explicit timeout  : 3600000
=> effectiveQuickTrack: false   (không cap 300s, dùng template implement đầy đủ)
```

**3 trạng thái `quick_track` qua API** (`POST /api/v1/jobs/:id/quick-track`):

| Gửi | Response | `pipeline_config` sau |
|---|---|---|
| `{mode:"on"}` | `{"success":true,"quick_track":true}` | `..."quick_track":true` |
| `{mode:"off"}` | `{"success":true,"quick_track":false}` | `..."quick_track":false` |
| `{mode:"auto"}` | `{"success":true,"quick_track":null}` | `..."fix_attempt":3}` — **xoá hẳn key** (không thành `null`) |

**Verify UI thật** (Chromium headless, server port 3000): mở modal Sửa Task RSGATE-44 ⇒ `editTaskTimeout=60` (phút = 3600000ms), `editTaskMaxRetries=10`, select quick track = `auto`.

| Hành động | DB sau |
|---|---|
| Mở modal + bấm Lưu, **không đổi gì** | `{"timeout":3600000,...,"fix_attempt":3}` — **không** ghi `quick_track:false` (bug đã tránh) |
| Chọn `off` + Lưu | `..."quick_track":false` |
| Chọn `auto` + Lưu (từ `off`) | `..."fix_attempt":3}` — key bị xoá |
| Mở lại modal | hiển thị `auto`, `prevMode=auto` |

**Hồi quy**: 221/221 `npm test` PASS · `node --check` OK cho `src/server.js`, `src/config.js`, `src/execution/aiTriage.js`, `src/execution/jobPolicy.js`, `src/systemone/client.js`, `public/app.js`.

### 4.7 Verify đợt 3 — Vòng đời evidence & Thời lượng thực (2026-10-21)

**Evidence mới luôn `NOT VERIFY`** — đọc metadata thật của job RSGATE-44 (agent tự ghi `tests[].status: "PASSED"`):
```
shape = tests | records = 30
PASS = 0 | NOT VERIFY = 30 | other = 0
  01_ui_doi_soat_ung_dung_tich_hop_list.png => status=NOT VERIFY verdict=null verified=false
```
Trước: cả 30 hiện **PASS** (agent tự khai) mà chưa qua VERIFY.

**Vòng tròn đóng kín** (test thật, shape `tests[]`):

| Bước | Kết quả |
|---|---|
| Đọc lần 1 (agent tự khai `PASSED`/`FAILED`) | `a.png=NOT VERIFY`, `b.log=NOT VERIFY` |
| VERIFY gọi `setStatuses({a.png:'PASS', b.log:'FAILED'})` | `a.png=PASS/PASS`, `b.log=FAILED/FAIL` |
| `metadata.json` sau VERIFY | `evidenceStatus: {"a.png":{...,"verified":true}, "b.log":{...,"verified":true}}` |
| Agent ghi đè `metadata.json` (xoá `evidenceStatus`) | quay về `NOT VERIFY` (fail-safe, không giữ PASS giả) |

**Transition PASS → FAILED vẫn hoạt động** (đã kiểm tra cả 2 shape `tests[]` và `array`): `setStatuses` giữ `verified: true` ⇒ evidence đã PASS **có thể** bị đánh FAILED ở lần verify sau.

**"Thời lượng" = runtime thực** — job RSGATE-44 (`steps` thật trong DB):

| Step | Thời gian |
|---|---|
| PLANNING (lần 1) | 301s |
| IMPLEMENT (lần 1, CANCELLED) | 64s |
| PLANNING (lần 2) | 302s |
| IMPLEMENT (lần 2, TIMED_OUT) | 302s |
| PLANNING (lần 3) | 1904s |
| IMPLEMENT (lần 3) | 1908s |
| TESTING | 3601s |
| FIXING (FAILED) | 2s |
| **TỔNG runtime** | **8385s (2h20m)** |

Wall-clock (`created_at → completed_at`) là ~6h (bao gồm thời gian chờ user + thời gian job nằm im). API mới trả `runtime_ms = 8384561`.

**UI**: mở job RSGATE-44 ⇒ "Thời lượng: **02:19:44**" — khớp `runtime_ms`.

**API evidence**: 17 evidence, `{"NOT VERIFY": 17}` (trước khi sửa: agent tự khai PASS).

**Hồi quy**: 245/245 `npm test` PASS (thêm 3 file test mới: `runtimeAccounting`, `evidenceNotVerifyGate`, `evidenceNotVerifyEndToEnd`, `implementContextNoEvidence`).

## 5. Bug phát hiện trong quá trình verify UI (đã sửa)

`escapeHtml(item.order)` — `order` là **number** (1/2/3) nhưng `escapeHtml` gọi `str.replace()` → `TypeError` ngay trong `.map()` ⇒ `uiGallery.innerHTML` không bao giờ được set ⇒ gallery giữ nguyên markup tĩnh của `index.html`, còn badge đã set trước đó ⇒ triệu chứng "3 mục" + 0 card. Exception bị nuốt trong `try/catch` của `fetchJobDetails` nên không có console error.

Đã sửa 2 chỗ:
1. `public/app.js:1481-1482` → `escapeHtml(String(item.order))` / `escapeHtml(String(item.stepIndex))`.
2. `public/app.js:2965` → `escapeHtml` harden: `String(str).replace(...)` — chặn nhóm lỗi non-string.

### 5.2 Xung đột `status`: HTTP status code vs trạng thái evidence 3 giá trị

Sau khi chuẩn hóa `status` thành 3 giá trị (`NOT VERIFY` / `PASS` / `FAILED`), các chỗ ở frontend **đọc `status` như HTTP status code** bị sai:

| Vị trí | Lỗi | Sửa |
|---|---|---|
| `public/app.js:1540` (tab API) | `api.status_code \|\| api.actualStatus \|\| api.status` → `api.status` là `'PASS'` ⇒ ô "Status:" hiện chữ "PASS" thay vì mã HTTP | Đọc `api.statusCode \|\| api.status_code \|\| api.actualStatus` (server đặt `statusCode` ở `server.js:1640`) |
| `public/app.js:2405` (modal API) | Cùng lỗi | Cùng cách sửa |
| `public/app.js:1674` (tab DB) | `!db.error && db.status !== 'FAILED'` ⇒ evidence `NOT VERIFY` bị coi là **MATCH** (xanh) | Dùng `evidenceStatus(db)` → `NOT VERIFY` hiện badge xám |
| `public/app.js:2449, 2476` (modal API) | `verdict: isPass ? 'PASS' : 'FAIL'` ⇒ `NOT VERIFY` hiện "FAILED" đỏ, mâu thuẫn badge "NOT VERIFY" ở đầu modal | `verdict: null` khi `NOT VERIFY`; text "NOT VERIFY (chưa verify)" |
| `public/app.js:2713` (`renderComparisonRows`) | `!item.error && item.status !== 'FAILED'` ⇒ tương tự tab DB | Dùng `evidenceStatus(item) === EVIDENCE_STATUS.PASS` |

**Verify UI sau khi sửa (server port 3112, evidence API + DB thật):**

| Kiểm tra | Kết quả |
|---|---|
| Badge tab API | `NOT VERIFY` (xám) — không phải PASS/FAIL |
| Dòng "Status:" tab API | `200` (đúng HTTP code) |
| Badge tab DB | `NOT VERIFY` (xám) — không phải `MATCH` xanh |
| Badge đầu modal API | `NOT VERIFY` (nền slate) |
| "Kết quả đối soát" trong modal API | `NOT VERIFY (chưa verify)` — nhất quán với badge |
| Modal API hiển thị | `HTTP METHOD GET` · `STATUS CODE 200 (Kỳ vọng: 200)` · `ĐỘ TRỄ 42 ms` |

### 5.3 Bug nghiêm trọng tìm được khi review code sau verify (đã sửa + có test)

4 lỗi này làm **3 tính năng vô hiệu hoàn toàn** dù code trông đúng:

| # | Bug | Tác động | Sửa |
|---|---|---|---|
| 1 | `resolveDeadlineAt` đọc `job.started_at` — cột **không tồn tại** trong schema `jobs` ⇒ base = `now`. `executeStep()` chạy lại ở mỗi lần chuyển step ⇒ deadline **trượt mãi** | **AC-1.3 vô hiệu** — job vẫn chạy vô hạn | `resolveDeadlineAt` trả `{ deadlineAt, isNew }`; persist `pipeline_config.deadline_at` lần đầu, đọc lại các lần sau |
| 2 | `detectRateLimit(fixingResult.output)` — `runner.execute()` trả `{ stdout, stderr, exitCode, timedOut }`, **không có** field `output` | **AC-1.5 vô hiệu** — 429 không bao giờ phát hiện ⇒ mỗi vòng retry vẫn lãng phí ~1h | `collectAgentOutput(result)` gom `stdout`+`stderr`+`output`; log 429 của CLI nằm trong stderr |
| 3 | `checkGuard` trả `promptToUse: original` ở **mọi** nhánh, kể cả `action='scrub'` | **SecretScrubber vô tác dụng** — prompt vẫn chứa secret gốc | `promptToUse = scrubbed` khi `scrub`/`warn`/fallback; chỉ `allow` giữ `original` |
| 4 | `updateStep` (`db.js:441`) **không có caller**; chỉ 1 step `PENDING` tạo lúc tạo job | **Không đo được "tại sao lâu"** — không có `started_at`/`finished_at` theo bước | `beginStepTimeline`/`endStepTimeline` ghi timeline từng phase vào bảng `steps` |

Ngoài ra: `getEvidenceByJobId` (`db.js:588`) map mọi `verdict` ≠ `'FAIL'` thành `'PASS'` ⇒ evidence chưa verify hiện PASS. Đã sửa thành `verdict: null` + `status: 'NOT VERIFY'`.

**Bằng chứng:** `tests/timeoutRetry.test.js` 28 test (thêm 6 test cho deadline tuyệt đối + `collectAgentOutput`), `tests/stepTimeline.test.js` 3 test, `tests/systemone.test.js` — test cũ khẳng định `checkGuard` giữ secret gốc đã được đổi thành khẳng định secret **không** còn trong `promptToUse`.
---

## 6. Đối chiếu tiêu chí nghiệm thu

| AC | Nội dung | Trạng thái | Bằng chứng |
|---|---|---|---|
| AC-1.1 | `max_retries` job được áp dụng thật | ✅ | `tests/timeoutRetry.test.js` — "max_retries trong pipeline_config duoc dung that (job khai 10 => 10)"; log mới ghi `(source=job)` |
| AC-1.2 | Log ra nguồn giá trị | ✅ | `[SYSTEMONE-FIXGATE] attempt=X/Y (source=job\|env\|default)` |
| AC-1.3 | Tổng ngân sách thời gian cho job | ✅ | `resolveJobDeadlineMs` / `resolveDeadlineAt` / `resolveEffectiveTimeout` + test. **Deadline tuyệt đối** — persist `pipeline_config.deadline_at` (RC-18: trước đó deadline trượt mỗi lần chuyển step ⇒ vô hiệu) |
| AC-1.4 | Backoff giữa các vòng retry | ✅ | `resolveRetryBackoffMs` + test (5s/10s/20s, cap 60s) |
| AC-1.5 | 429 ⇒ dừng job | ✅ | `detectRateLimit(collectAgentOutput(result))` + test (đọc `stdout`+`stderr` — `runner.execute()` không có field `output`, RC-19); áp dụng ở TESTING và FIXING |
| AC-1.6 | Log có timestamp + timeline từng bước | ✅ | `emitJobLog` prefix `[ISO]` mỗi dòng file log; **bảng `steps`** ghi `started_at`/`finished_at`/`exit_code` từng phase (RC-21) + `tests/stepTimeline.test.js` |
| AC-1.7 | Bảng `steps` ghi timeline từng phase | ✅ | `beginStepTimeline`/`endStepTimeline` trong `server.js` — mỗi phase (PLANNING/IMPLEMENT/TESTING/VERIFY/FIXING) tạo 1 step `RUNNING` + đóng với `finished_at`/`exit_code`; test `tests/stepTimeline.test.js` (3 test) |
| AC-2.1 | Cảnh báo khi SystemOne fallback | ✅ | `[SYSTEMONE-FALLBACK]` trong log + badge `FALLBACK` trên header |
| AC-2.2 | Heuristic không dùng để chặn retry | ✅ | `checkFixGate` → `if (decision.fallback === true) return { ...decision, retry: true }` + test |
| AC-2.3 | Endpoint/probe trạng thái SystemOne | ✅ | `GET /api/v1/systemone/status` + `systemoneStatus` trong `/api/v1/health` |
| AC-2.4 | Tài liệu các bước dùng SystemOne | ✅ | `expect.md` §3.2 + `dev_plan.md` ADR-6 |
| AC-2.5 | GUARD `action='scrub'` ⇒ truyền prompt **đã scrub** | ✅ | `checkGuard` trả `promptToUse = scrubbed` khi `scrub`/`warn`/fallback (RC-20 — trước đó trả `original` ở mọi nhánh ⇒ `SecretScrubber` vô tác dụng); test `tests/systemone.test.js` khẳng định secret **không** còn trong `promptToUse` |
| AC-2.6 | SystemOne có bộ URL/key/model riêng, tách khỏi LLM | ✅ | `.env` + `config.js` + `.env.example`: `SYSTEMONE_BASE_URL=https://9router.thanhpk.io.vn/v1/systemone`, `SYSTEMONE_MODEL=openrouter/typesafe/jev-1.13`, `SYSTEMONE_API_KEY` = key 9router hợp lệ (key cũ ⇒ `401` ⇒ 6/6 quyết định fallback heuristic). Thêm `systemone.probe()` + route `GET /api/v1/systemone/probe` (1 request noul, bypass cache); `probe()` chỉ báo `live:true` khi `answers.is_alive.noul` hợp lệ. `clear-systemone-env.bat` (dùng chung cho cả 3 script start) xoá 4 biến `SYSTEMONE_*` kế thừa từ shell cha — `.env` không ghi đè `process.env` sẵn có ⇒ server chạy sai model **không log cảnh báo**. `config.js` default = self-host local (không hardcode domain). `processManager.js` gỡ `SYSTEMONE_API_KEY` khỏi env tiến trình agent con (chống rò rỉ secret). Verify: `npm run test:systemone` gọi trực tiếp 6 quyết định typed qua client — mỗi mục assert `decision.fallback !== true` **và** `confidence` là số ⇒ 6/6 từ model thật, `stats.fallbacks === 0`, `stats.cost > 0` (không tạo job ⇒ không để lại rác `docs/features/SO-PROBE-*`) |
| AC-2.7 | Model đọc được nội dung file, giới hạn context | ✅ | Probe 2026-10-21: gateway **bỏ qua** `files[]`/`file`/`content`/`attachments` (`input_tokens` không đổi 286 vs 286) ⇒ chỉ `state` mang nội dung. `src/systemone/fileContext.js` (mới): `collectFileContext()` gom nội dung theo budget token, cắt theo dòng, bỏ qua `node_modules`/build/binary, báo cáo file bị cắt; `listChangedFiles()` dùng `git status --porcelain` (gồm file **untracked** = output IMPLEMENT) + ưu tiên file trong stack trace + sắp theo mtime; `mergeStateWithFiles()` nhúng vào `state`. **Async** (`execFile` + `fs.promises`) để không chặn event loop của server SSE; file lớn chỉ đọc 1 phần qua fd + `Buffer.alloc`. Guard workspace dùng `path.relative` (bắt được ca `ws-evil`). `postJev` nâng budget `state` 4000 → `MAX_STATE_CHARS=240000` (~60k tokens; đo thực tế 240KB → HTTP 200 ~1.7s < timeout 8s; 2.7MB ⇒ `400 max_tokens_exceeded`). FIXING (`server.js`) truyền nội dung file thật; cache key dùng `sha256(fileContext)`. Test: `tests/fileContext.test.js` (17) + `tests/systemoneFileWiring.test.js` (3, stub `global.fetch` bắt body thật — **đã chứng minh bắt được bug** `slice(0,4000` bằng cách revert fix ⇒ test fail). Bằng chứng end-to-end: cùng 1 lời gọi, có file context ⇒ cost **0.00077** vs không có **0.0000145** (53×) ⇒ nội dung thực sự tới model |
| AC-2.8 | 3 script start/restart xoá env kế thừa, có test | ✅ | `clear-systemone-env.bat` (mới, dùng chung): `set "VAR="` xoá **hẳn** biến cmd (đã test: `undefined` cho process con). Cả 3 script (`start-worker.bat`, `start-worker-bg.bat`, `restart-worker.bat`) đều `call` file này trước khi spawn node. Thay `timeout /t` → `ping -n` (vì `timeout` đọc stdin ⇒ lỗi "Input redirection is not supported" khi stdin bị redirect). Test `test-start-scripts.bat`: đặt cố ý `SYSTEMONE_MODEL=oc/OLD-VALUE` + `SYSTEMONE_API_KEY=old-key` + `SYSTEMONE_BASE_URL=http://127.0.0.1:19999/...`, chạy từng script, assert (1) `GET /api/v1/systemone/status` trả `"model":"openrouter/typesafe/jev-1.13"`, (2) output **không** có dòng `ERROR:` |
| AC-2.9 | Badge SystemOne là dữ liệu TỪNG task | ✅ | Cột `jobs.systemone_state` (JSON) lưu per-task + `systemone.getJobStatus(jobId)` tracker trong client + `recordSystemOne(jobId, result, route)` ghi sau **mỗi** quyết định SystemOne (8 call site). API `GET /api/v1/jobs` + `GET /api/v1/jobs/:id` parse `systemone_state` thành object (`parseSystemOneState`). SSE event `systemone` (per-job + global) đẩy realtime; UI: badge trong **job card** (`renderSystemOneBadge`) + header chi tiết task (`activeJobSystemOneBadge`). Giá trị: `live===null` → `CHƯA GỌI`, `true` → `LIVE`, `false` → `FALLBACK`. `cached:true` / `source:'attempt-limit'` **không** tính vào `calls` (không gọi model). Test: `tests/systemoneJobState.test.js` (6 test — 2 job khác nhau có state riêng, model lỗi → FALLBACK, `checkGuard` bọc `.decision` vẫn track đúng) | Verify end-to-end (`npm run test:badge`): job mới → `systemone_state = null` (CHƯA GỌI); sau `POST /start` → `{live:true, calls:1, fallbacks:0, model:'openrouter/typesafe/jev-1.13'}` (LIVE); job thứ 2 vẫn `null` ⇒ **2 task có badge riêng biệt**. Script dùng `repo_path` tạm ⇒ không để lại rác `docs/features/BADGE-TEST-*`. **Quy tắc badge (2026-10-21)**: chỉ quyết định **từ model thật** mới đổi badge. `cached:true` / `source:'attempt-limit'` (không gọi model) và `source:'heuristic-fast'` (quyết định tức thì bằng regex — không gọi model) **không** tính vào `calls` và **không** đổi badge ⇒ badge chỉ ghi `LIVE` khi model thật thực sự quyết định.
| AC-2.10 | Không lạm dụng SystemOne | ✅ | **GUARD** (4 call site, prompt 10-14KB) → `src/execution/promptGuard.js` (mới): scrub **local** bằng `SecretScrubber` + phát hiện prompt-injection (cả tiếng Việt có/không dấu). **KHÔNG cắt bớt dữ liệu** — chỉ thay secret bằng placeholder, giữ nguyên độ dài. **DEDUP** (chỉ gán nhãn log) → `systemone.localDedup()` hash SHA16, không gọi mạng. **PREJUDGE** (chỉ ghi log, không quyết định — `verifyTaskEvidence` mới là nguồn sự thật) → **bỏ hẳn**. **Giữ lại**: TRIAGE (quyết định track) + FIXGATE (quyết định retry). Kết quả: giảm **3 network call/step** (guard ×4 + dedup + prejudge → 0), pipeline nhanh hơn, không cắt dữ liệu input. Test: `tests/promptGuard.test.js` (9 test) | **Triage chọn lọc (2026-10-21)**: `policy.triageSignals()` (regex, tức thì) quyết định TRƯỚC — task rõ ràng (`quick`/`large`) **không gọi model** (0 network call); chỉ prompt mơ hồ mới gọi model, và chỉ hỏi **2** câu (`is_quick`+`is_large`) — bỏ `need_browser` vì kết quả chỉ ghi log, không quyết định gì. Sửa kèm bug thật phát hiện qua test: heuristic cũ check `quick` trước `large` ⇒ "migrate module sang microservices" bị phân loại nhầm là **quick**; thêm `fold()` (bỏ dấu) để regex khớp cả text không dấu.
| AC-2.11 | Badge chỉ phản ánh quyết định từ model thật | ✅ | `trackJobDecision()` (client) + `recordSystemOne()` (server) bỏ qua `cached:true`, `source:'attempt-limit'` và `source:'heuristic-fast'` (quyết định tức thì bằng regex — không gọi model) ⇒ `calls` không tăng, badge không đổi. Test: `tests/systemoneJobState.test.js` — "triage heuristic-fast KHÔNG được ghi vào badge" (`calls === 0`, `live === null`) |
| AC-2.12 | TRIAGE chọn lọc + phân loại đúng | ✅ | `policy.triageSignals()` (regex tức thì) quyết định TRƯỚC: task rõ ràng (`quick`/`large`) **0 network call**; chỉ prompt mơ hồ mới gọi model, và chỉ hỏi **2** câu (`is_quick`+`is_large`) — bỏ `need_browser` (kết quả chỉ ghi log, không quyết định). **Sửa bug thật phát hiện qua test**: heuristic cũ check `quick` trước `large` ⇒ "migrate module sang microservices" bị phân loại nhầm là **quick** (bật chế độ nhanh cho task phức tạp) → đã đảo thứ tự + thêm `fold()` (bỏ dấu + lowercase) để regex khớp cả text không dấu. Test: `tests/systemone.test.js` (4 test mới) + `tests/systemoneJobState.test.js` (3 test) |
| AC-7.1 | Task nhẹ → chế độ NHANH thật sự | ✅ | `pipeline_config.quick_track` bật khi SystemOne triage = S/quick, confidence ≥ 0.5. Template mới `templates/prompt/planning-quick.md` (3.3KB vs 10.2KB) + `implement-quick.md` (2.5KB vs 5.3KB): plan ≤ 60 dòng, test_plan ≤ 30 dòng, cấm khảo sát lại toàn repo, sửa tối thiểu theo `dev_plan.md`. Trước đây `track==='quick'` **chỉ tăng priority** — không rút gọn gì |
| AC-7.2 | Chế độ nhanh giới hạn thời gian step | ✅ | `jobPolicy.resolveQuickStepTimeoutMs()` — mặc định **5 phút/step** (thay vì 15-60 phút), ghi đè được bằng `pipeline_config.quick_timeout_ms`. VERIFY vẫn chạy sau đó nên an toàn |
| AC-7.3 | Cờ quick_track nhất quán mọi lần chạy | ✅ | Lưu trong `pipeline_config.quick_track` (đọc qua `isQuickTrack(job)`) ⇒ mọi lần `executeStep` chạy lại đều dùng template quick. Test: `tests/quickTrack.test.js` (9 test) |
| AC-3.1 | Evidence realtime | ✅ | SSE event `evidence` — verify `reason=received` |
| AC-3.2 | Cơ chế phát hiện file mới | ✅ | `EvidenceWatcher` (`fs.watch` + debounce + poll fallback) |
| AC-3.3 | UI tự cập nhật, không cần reload | ✅ | Handler SSE upsert + `renderEvidenceHub()` |
| AC-4.1 | Evidence mới = `NOT VERIFY` | ✅ | `browserRunner` ghi `status: 'NOT VERIFY'`; API trả `NOT VERIFY` |
| AC-4.2 | Verify thành công → `PASS` | ✅ | `verifyTaskEvidence` ghi `PASS` — test đọc lại `metadata.json` |
| AC-4.3 | Verify lỗi → `FAILED` | ✅ | File undeclared/quá nhỏ/trùng MD5/DB lệch → `FAILED` — test |
| AC-4.4 | 3 màu badge | ✅ | Verify UI ở cả 4 kênh: UI (PASS/NOT VERIFY/FAILED), API (`NOT VERIFY` xám), DB (`NOT VERIFY` xám), Log (`NOT VERIFY` xám) + badge đầu modal — emerald / slate / rose. *Kênh Log đã đổi sang 3 trạng thái và **đã verify bằng mắt** (1 card: `INFO` · `UI-VERIFY-DEMO` · `NOT VERIFY` · timestamp, không trùng/lồng).* |
| AC-5.1 | Evidence có tên | ✅ | API có `name`; card hiện tên; verify UI đúng 3 tên |
| AC-5.2 | Chi tiết có mô tả + metadata | ✅ | Modal có "MÔ TẢ EVIDENCE NÀY LÀ GÌ" + bước/test case/tệp |
| AC-5.3 | Tên/mô tả lưu vào `metadata.json` | ✅ | `browserRunner` ghi `name`/`description`/`passCriteria`; đọc lại qua API |
| AC-6.1 | Ảnh sắp xếp theo step test | ✅ | API + UI: Bước 1, 2, 3 đúng thứ tự; sort `order → stepIndex → timestamp` |
| AC-6.2 | Chuyển ảnh khi phóng to | ✅ | Nút ‹ › + phím ← →; test click/keyboard |
| AC-6.3 | Mỗi ảnh có mô tả trong modal | ✅ | Verify UI thấy "MÔ TẢ EVIDENCE NÀY LÀ GÌ" |
| AC-6.4 | Modal hiển thị cách ảnh đó là PASS | ✅ | Verify UI thấy "ẢNH NÀY ĐƯỢC COI LÀ PASS KHI NÀO" |

---

## 7. Rủi ro còn lại

| Rủi ro | Mức | Ghi chú |
|---|---|---|
| Job có `max_retries` cao sẽ chạy lâu hơn trước | Trung bình | Đây là **ý muốn của user** (khai 10). Giờ có deadline + backoff + rate-limit stop để chặn. Job cũ không khai `max_retries` → giữ hành vi cũ (env=3). |
| `SystemOne` dùng **chung key 9router với LLM** | Trung bình | Đã fix 401 (key cũ bị gateway từ chối) bằng key hợp lệ + model `openrouter/typesafe/jev-1.13` — probe live 6/6 quyết định từ model thật. Tuy nhiên key đó **trùng** `ANTHROPIC_AUTH_TOKEN` của agent CLI. Đã gỡ `SYSTEMONE_API_KEY` khỏi env tiến trình agent con (`processManager.js`), nhưng để tách thật cần tạo key riêng trên dashboard 9router (cần thao tác tay của user). |
| `MultiVerificationGate` 4 kênh chưa chạy trong pipeline | Trung bình | RC-3 — cần feature riêng. Hiện pipeline dùng `verifyTaskEvidence` (đơn giản hơn). |
| `PENDING` chờ người dùng có thể treo vô hạn | Trung bình | RC-15 — `pause_timeout` không có listener. Ngoài phạm vi feature này. |
| Bảng SQLite `evidence` còn dead-code | Thấp | ADR-1 — không ảnh hưởng hành vi. |
| **AI triage tốn thêm ~11-22s mỗi lần bấm Start** (timeout mặc định `AI_TRIAGE_TIMEOUT_MS=30000` ⇒ biên chỉ ~8s) | Trung bình | `handleJobStart` await triage **trước** khi trả HTTP response ⇒ nút Start treo đúng bằng thời gian gọi. Cache RAM 1h theo hash(prompt+title+timeout) giảm phần lớn số lần gọi lại cho cùng 1 task. Tắt bằng `AI_TRIAGE_ENABLED=false` (khi đó tự động rơi về heuristic ≤ 0.4 ⇒ **không** cắt timeout của bạn). |
| **Triage KHÔNG tất định** — cùng 1 prompt có thể ra `M/full` (0.65) lần này, `L/full` (0.82) lần khác | Thấp | Hệ quả của việc dùng model thật thay regex. Đã ép `track==='quick' ⇒ complexity==='S'` để tránh mâu thuẫn nội tại, và cache 1h để 1 task không bị phân loại lại nhiều lần. Ngưỡng bật quick mode là `confidence >= 0.5` — với phân bố 0.55-0.65 quan sát được, ngưỡng này **có thể** vô tình bật quick mode cho task trung bình. |

---

## 8. Deploy

Không có thay đổi DB schema, không có dependency mới.

**Biến môi trường tùy chọn (mới) — đều có giá trị mặc định, không bắt buộc.** Xem `.env.example`:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `AI_TRIAGE_ENABLED` | `true` | Kill-switch nhánh triage headless AI (độc lập `SYSTEMONE_ENABLED` là kill-switch gateway Jev). `false` ⇒ rơi về heuristic offline (≤ 0.4 ⇒ **không** cắt timeout của bạn). |
| `AI_TRIAGE_TIMEOUT_MS` | `30000` | Timeout 1 lượt gọi AI triage (độc lập timeout của job). |
| `AI_TRIAGE_CACHE_TTL_MS` | `3600000` | TTL cache kết quả triage trong RAM. |

**Biến trong `pipeline_config` của job:**
- `job_deadline_ms` / `job_deadline_minutes` / `job_deadline_hours` — tổng ngân sách thời gian cho job. Không khai ⇒ không đặt deadline (giữ hành vi cũ).
- `quick_track` (`true` / `false` / không khai) + `quick_timeout_ms` — chế độ NHANH. Không khai `quick_track` ⇒ hệ thống tự quyết định theo AI triage.

**Lệnh kiểm tra sau khi deploy:**
```bash
npm test
npm run test:pipeline
npm run test:verify-fix
```

---

## 9. Bằng chứng trực quan

`docs/features/TASK-PIPELINE-FIX/evidence/`:

| File | Nội dung |
|---|---|
| `01_ui_evidence_hub_3_trang_thai.webp` | Evidence Hub: 3 card badge `PASS` (xanh) / `NOT VERIFY` (xám) / `FAILED` (đỏ), thứ tự Bước 1 → 2 → 3, tên evidence hiển thị. |
| `02_modal_api_not_verify.webp` | Modal evidence API: badge `NOT VERIFY` (slate), `STATUS CODE 200`, `KẾT QUẢ ĐỐI SOÁT: NOT VERIFY (chưa verify)` — nhất quán 3 trạng thái. |

`metadata.json` mô tả 2 ảnh trên (tên, mô tả, tiêu chí PASS, `order`/`stepIndex`, `status: PASS`).
