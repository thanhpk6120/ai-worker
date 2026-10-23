---
feature: PERF-FIX-01
service: ai-worker
status: done
owner: AI
updated_at: 2026-10-22
---

# PERF-FIX-01 — Tasks (Checklist)

> Kỳ vọng: [`expect.md`](./expect.md) · Kế hoạch: [`dev_plan.md`](./dev_plan.md) · Phân tích gốc: [`../PERF-ANALYSIS-01/report.md`](../PERF-ANALYSIS-01/report.md)
>
> **Quy ước:**
> - Mỗi task có **Service** + **file chạm** + **điều kiện xong đo được** (số liệu, không mơ hồ).
> - Cột `UC` trỏ về `expect.md`; cột `Verify` trỏ về lệnh/cách đo cụ thể.
> - **Không task nào được bỏ qua bước Verify.** Task chưa verify = task chưa xong.
> - **Mọi script đo ghi vào `temp/`** — **tuyệt đối không** ghi vào `logs/` hay dữ liệu thật (`logs/` bị `.gitignore` → `git status` không phản ánh; xem `PERF-ANALYSIS-01/report.md` §8.1).
> - Thứ tự: **T0 → T1 → T2 → T3 → T4 → T5**. T0 là gate đo sạch.
> - Mọi task phải giữ nguyên hành vi nghiệp vụ (xem `expect.md` §3).

---

## 0. Tổng quan

| Nhóm | Nội dung | UC | Task | Ước lượng | Trạng thái |
|---|---|---|---|---|---|
| **T0** | Chuẩn bị + chặn event loop | UC-1 | T0.0 – T0.4 | 1,75 h | [X] |
| **T1** | SSE log: bỏ replay 23 MB | UC-2 | T1.1 – T1.5 | 6,5 h | [X] |
| **T2** | Frontend: render, cache, CDN | UC-3,4,5 | T2.1 – T2.8 | 10 h | [X] |
| **T3** | Backend: index, payload, gzip | UC-6 | T3.1 – T3.5 | 5,75 h | [X] |
| **T4** | Ghi log async | UC-7 | T4.1 – T4.2 | 1 h | [X] |
| **T5** | Test + đo lại + report | tất cả | T5.1 – T5.4 | 2 h | [X] |
| **T2P/T3P** | Sửa lỗi chức năng + UX/a11y **(cần duyệt)** | — | T2P.1 – T2P.5, T3P.1 – T3P.2 | 8,25 h | [X] |
| | | | **Tổng (chưa gồm T2P/T3P)** | **~27 h** | |
| | | | **Tổng nếu duyệt T2P/T3P** | **~35,25 h** | |

---

## 1. T0 — Chuẩn bị + chặn event loop (UC-1)

> **Đây là gate.** T0.1–T0.3 xử lý nguyên nhân chính (1,3 s block mỗi 15 s). T0.4 chụp baseline để các nhóm sau đo được sạch.

### ☐ T0.0 — Xác nhận cấu trúc docs + công cụ đo

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | Không sửa code. Chỉ đọc + tạo script đo tạm trong `temp/` |
| **UC** | — (tiền đề) |
| **Ước lượng** | 0,5 h |

**Việc:**
1. Xác nhận repo **không có** `docs/specs/` và `docs/ARCHITECTURE.md` (chỉ có `docs/features/`) → Gate 2 của feature này không có phạm vi docs diff.
2. Tạo script đo tại `temp/_perf_status.js`: đo latency `/api/v1/status`, `/api/v1/health`, `/api/v1/runners` (30 lần, lấy p50/p95/max) + 5 request song song (wall time).
3. Tạo script tại `temp/_perf_baseline.js`: ghi kết quả ra `temp/_perf_baseline.json` để so sánh sau này.
4. **Không** ghi file nào vào `logs/`.

**Verify:** script chạy được, in ra số liệu khớp `expect.md` §5 (±20%). ✅ / ❌

---

### ☐ T0.1 — `baseAdapter.detect()`: cache TTL + `spawn` async

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/runners/baseAdapter.js` (dòng 25–70), `src/config.js` (thêm `DETECT_TTL_MS`) |
| **UC** | UC-1 |
| **Ước lượng** | 45 phút |

**Việc:**
1. Thêm `DETECT_TTL_MS = 60000` vào `src/config.js`.
2. Thêm cache vào `BaseAdapter`: `this._detectCache = { at, value }`.
3. `detect()` giữ **API sync**:
   - Cache hit (tuổi < TTL) → trả cache.
   - Cache miss → trả cache cũ nếu có, đồng thời kích hoạt refresh nền; không có cache cũ → trả `{installed:false, version:null, path:null}`.
4. `_refreshDetectAsync()` dùng `child_process.spawn` (**không** `spawnSync`) + Promise, cập nhật cache khi xong. Phải giữ timeout 5.000 ms như bản gốc.
5. **Không** đổi shape trả về (`installed`, `version`, `path`, `error`).

**Ràng buộc:** `baseAdapter.js:312` (`buildCommand`) gọi `this.detect()` — call site **sync** quan trọng. Sau khi đổi, `detect()` phải trả cache đúng (không trả `installed:false` giả khi thực tế đã cài) → kiểm tra bằng test. Giữ fallback `detection.path || this.command` (`baseAdapter.js:313`).

**Call site phải xử lý (đã grep `src/`) — `detect()` nằm trên **đường chạy job**, không chỉ đường UI:**

| Call site | Vị trí | Tần suất | Cần sửa? |
|---|---|---|---|
| `runnerRegistry.detectAll()` | `src/runners/runnerRegistry.js:74` | mỗi request `/status`, `/health`, `/runners` | Không — tự động hưởng cache |
| `runnerRegistry.getAvailableRunner()` | `src/runners/runnerRegistry.js:146` và `:156` | **trước MỖI pipeline step**: `src/server.js:2780` (PLANNING), `:3000` (IMPLEMENT), `:3202` (TESTING), `:3372` (FIXING) — loop tới 5 runner mỗi lần | Không — tự động hưởng cache |
| `BaseAdapter.buildCommand()` | `src/runners/baseAdapter.js:312` | trước mỗi `execute()` | Không — tự động hưởng cache |
| `aiTriage` | `src/execution/aiTriage.js:305` | mỗi lần triage | Không — tự động hưởng cache |
| boot | `src/index.js:25` | 1 lần | Không |

> **Bắt buộc:** cache phải đặt ở **`BaseAdapter.detect()`** (`src/runners/baseAdapter.js:25`), **KHÔNG** đặt ở `runnerRegistry.detectAll()`. Nếu chỉ cache ở `detectAll()` → đường chạy job vẫn bị **~1,3 s blocking mỗi pipeline step**.
>
> `detectAll()` giữ **sync** → 3 caller ngoài registry (`src/index.js:25`, `src/server.js:546`, `src/server.js:718`) **không** cần sửa.

**Ràng buộc:** `baseAdapter.js:312` (`buildCommand`) gọi `this.detect()` — call site **sync** quan trọng. Sau khi đổi, `detect()` phải trả cache đúng (không trả `installed:false` giả khi thực tế đã cài) → kiểm tra bằng test. Giữ fallback `detection.path || this.command` (`baseAdapter.js:313`).


**Verify:**
- `node -e "const {runnerRegistry}=require('./src/runners/runnerRegistry'); const t=process.hrtime.bigint(); runnerRegistry.detectAll(); console.log(Number(process.hrtime.bigint()-t)/1e6)"` → lần 1 có thể chậm (refresh nền), **lần 2+ < 50 ms**.
- `npm test` pass.
- `detect()` trả `installed:true` cho runner đã cài (không regression về `false` giả). ✅ / ❌

---

### ☐ T0.2 — Xác nhận `detectAll()` + `getAvailableRunner()` hưởng cache

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/runners/runnerRegistry.js` (dòng 71–87, 142–175) — **chủ yếu verify, có thể không cần sửa** |
| **UC** | UC-1 |
| **Ước lượng** | 15 phút |

**Việc:**
1. `detectAll()` (dòng 74) gọi `runner.detect()` → tự động hưởng cache từ T0.1. **Phải** bảo đảm `detectAll()` **không** gọi `spawnSync` trực tiếp.
2. `getAvailableRunner()` (dòng 146 và 156) gọi `runner.detect()` → tự động hưởng cache. **Không** sửa logic chọn runner (ưu tiên preferred → tìm runner đầu tiên enabled → fallback).
3. `detectAll()` giữ **sync** → 3 caller (`src/index.js:25`, `src/server.js:546`, `src/server.js:718`) **không** cần sửa.
4. Nếu cần detect **đồng bộ chờ** (boot), thêm `detectAllFresh()` chỉ dùng ở `src/index.js:25`.

**Verify:**
- `node src/index.js` in ra bảng runner đúng (không phải toàn `✗`).
- Đo thời gian `getAvailableRunner('claude-code')` gọi lặp 10 lần → **mọi lần < 50 ms** (trước: mỗi lần ~1,3 s vì loop 5 runner × 2 `spawnSync`).
- `npm test` pass. ✅ / ❌

---

### ☐ T0.3 — `/api/v1/status` + `/api/v1/health` không gọi `detectAll()`

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (dòng 542–572) |
| **UC** | UC-1 |
| **Ước lượng** | 15 phút |

**Việc:**
1. `handleHealthCheck` thay `runnerRegistry.detectAll()` (dòng 546) → `runnerRegistry.listRunners()` (chỉ `name`, `command`, `aliases`, `enabled`).
2. **Xác nhận tương thích (đã grep `public/`):** UI **không** dùng `/api/v1/runners`, `/api/v1/health`, `data.runners` → 0 kết quả. UI chỉ gọi `/api/v1/status` (`public/app.js:674`) và **không** đọc trường `runners`.
   → Trường `runners` trong `/status` giữ ở dạng rút gọn (`name` + `enabled`) để không phá API contract cho công cụ khác. **Xác nhận với user ở Gate 1** nếu muốn bỏ hẳn.
3. `/api/v1/runners` (dòng 718) **giữ nguyên** `detectAll()` — giờ đọc từ cache nên vẫn nhanh.

**Verify:** `node temp/_perf_status.js` → `/status` p95 **< 50 ms**, `/health` **< 50 ms**; `/runners` < 300 ms (sau lần đầu). ✅ / ❌

---

### ☐ T0.4 — Đo lại sau T0 + cập nhật `expect.md` §5

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `docs/features/PERF-FIX-01/expect.md` (§5 baseline), `docs/features/PERF-FIX-01/report.md` (tạo mới) |
| **UC** | UC-1 |
| **Ước lượng** | 15 phút |

**Việc:**
1. Chạy `node temp/_perf_status.js` lần 2 (sau khi server restart) → ghi kết quả **sau**.
2. Cập nhật `expect.md` §5: thêm cột "Sau T0" cho các metric liên quan.
3. Tạo `docs/features/PERF-FIX-01/report.md` (khung) với bảng trước/sau.

**Verify:** `/status` p95 < 50 ms **và** 5 request song song wall < 200 ms (baseline: 6,24 s). ✅ / ❌

---

## 2. T1 — SSE log: bỏ replay toàn bộ file (UC-2)

> **Baseline:** 1 event `log` chứa **23,03 MB**; `readFileSync` 178 ms block; browser 2 long task 393 + 545 ms.

### ☐ T1.1 — Endpoint lịch sử log có phân trang

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (thêm route gần route SSE, dòng ~4310) |
| **UC** | UC-2 |
| **Ước lượng** | 1,5 h |

**Việc:**
1. Thêm `GET /api/v1/jobs/:id/logs?offset=<byte>&limit=<bytes>` → trả `{ text, nextOffset, totalSize, hasMore }`.
2. `limit` mặc định 256 KB, tối đa 1 MB.
3. Đọc **async** (`fs.promises.open` + `read`) → **không** block event loop.
4. `offset` vượt quá `totalSize` → trả `text:''`, `offset=0` (file bị truncate).

**Verify:** `curl "/api/v1/jobs/<id>/logs?limit=262144"` → `text` ≤ 256 KB, `nextOffset` = số byte đã đọc, `totalSize` = size file thật. Response server **không** block > 50 ms (đo song song với `/jobs`). ✅ / ❌

---

### ☐ T1.2 — `JobEventBus` theo dõi byte offset

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (`JobEventBus`, dòng 41–70) |
| **UC** | UC-2 |
| **Ước lượng** | 1 h |

**Việc:**
1. `JobEventBus` giữ `Map<jobId, {offset}>` — duy trì counter byte tích luỹ từ write stream (`stream.bytesWritten` hoặc counter nội bộ cập nhật sau mỗi `stream.write()`). Không gọi `fs.statSync()` sau mỗi chunk ghi để tránh sai lệch do buffer userspace chưa flush.
2. Method `getLogOffset(jobId)` trả offset hiện tại.
3. `fs.statSync(logPath).size` chỉ dùng khi khởi tạo stream hoặc kiểm tra an toàn (detect file bị truncate `size < offset` → reset offset về 0).

**Verify:** đọc file log thật sau khi stream flush / job kết thúc, so `getLogOffset()` với `fs.statSync().size` → **bằng nhau**. Reconnect log stream không bị mất hoặc nhận trùng log. ✅ / ❌

---

### ☐ T1.3 — SSE stream: tail theo offset, giới hạn 256 KB

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (route `/api/v1/jobs/:id/logs/stream`, dòng 4310–4325) |
| **UC** | UC-2 |
| **Ước lượng** | 2,5 h |

**Việc:**
1. **Xoá** đoạn `fs.readFileSync(logFilePath,'utf8')` + `sendEvent('log', {text: savedLogs})` (dòng 4314–4320).
2. Thay bằng: đọc header `Last-Event-ID` (hoặc query `?from=`) → `offset`; nếu `offset` không hợp lệ → `0`.
3. Đọc **async** tối đa 256 KB từ `offset` (tail). Gửi `sendEvent('log', {text, ...})` kèm `id: <newOffset>` để client nhận `event.lastEventId`.
4. Nếu `fileSize < offset` → reset `offset = 0` (file bị truncate/rotate).
5. **Giữ nguyên:** các event khác (`status`, `step`, `question`, `evidence`, `systemone`, `done`, `error`), `keepAliveInterval`, `runtimeTickInterval`, `startEvidenceWatcher`.

**Verify:**
- Mở SSE tới job có log 25,8 MB → **frame `log` đầu ≤ 256 KB**.
- Server **không** block > 50 ms lúc client kết nối (đo song song với `/jobs`).
- `npm test` pass. ✅ / ❌

---

### ☐ T1.4 — Client: đọc `lastEventId` + nút "tải lịch sử thêm"

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (`connectLogStream` 696–748, handler `event: log` 728–748, `scheduleTerminalWrite` 211–232) |
| **UC** | UC-2 |
| **Ước lượng** | 1,5 h |

**Việc:**
1. Handler `event: log` lưu `event.lastEventId` vào `state.logOffset`.
2. Khi mở SSE, gửi `Last-Event-ID` header — `EventSource` **không** hỗ trợ custom header → dùng query `?from=<offset>` (đã hỗ trợ ở T1.3).
3. Thêm nút "Tải lịch sử log thêm" gọi `GET /api/v1/jobs/:id/logs?offset=&limit=` → nối vào terminal.
4. **Giữ nguyên:** `scrollback: 10000` (`public/app.js:316`), `scheduleTerminalWrite` gom bằng `requestAnimationFrame`, `reflowCliText` + `wordWrapToCols` (xử lý text trên main thread — giữ vì ảnh hưởng hiển thị).

**Verify:**
- Mở job log lớn → terminal hiện log, **không** có long task > 200 ms (đo bằng `PerformanceObserver({entryTypes:['longtask']})`).
- Click "Tải lịch sử log thêm" → nối thêm log cũ, không mất log đang hiện.
- Log mới vẫn realtime: độ trễ < 2 s. ✅ / ❌

---

### ☐ T1.5 — Đo lại T1 + reconnect test

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `docs/features/PERF-FIX-01/report.md` |
| **UC** | UC-2 |
| **Ước lượng** | 0,5 h |

**Verify:**
1. Frame `log` đầu ≤ 256 KB (baseline 23,03 MB).
2. **Reconnect**: ngắt SSE rồi kết nối lại với `?from=<offset>` → **không** nhận lại log cũ.
3. Long task khi mở job log 25 MB: **không** có task > 200 ms (baseline 393 + 545 ms).
4. `npm test` pass. ✅ / ❌

---

## 3. T2 — Frontend (UC-3, UC-4, UC-5)

### ☐ T2.1 — `renderJobsList` chuyển sang render tăng dần

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (dòng 937–1046) |
| **UC** | UC-3 |
| **Ước lượng** | 3 h |

**Việc:**
1. Thêm `state.jobCardMap = new Map()` → `jobId → {el, refs}`.
2. Render tăng dần: job mới → tạo node; job đã có → chỉ `textContent`/`className` cho field đổi.
3. **Xoá** `container.innerHTML = ...` (dòng 982) trong đường render danh sách.
4. **Giữ nguyên 100%:** logic filter (status `ARCHIVED` ẩn mặc định dòng 952–960), filter search (962–969), signature cache (944–951), **thứ tự** render, `escapeHtml` mọi text user, `getEffectiveAgentForJob`, `formatTimeAgo`, badge SystemOne.
5. **Giữ nguyên** `updateJobsCountBadge` (dòng 1899) — nhưng truyền `filtered.length` để bỏ filter O(n) thừa (được gọi không tham số ở dòng 614).

**Rủi ro HIGH** — hiển thị sai trạng thái job. Bắt buộc so sánh DOM cũ vs mới cho 3 trạng thái (`TO DO`, `IMPLEMENT`, `DONE`).

**Verify:**
- Screenshot so sánh list trước/sau: giống nhau về nội dung, khác nhau chỉ ở chỗ đã sửa.
- Filter `ALL` / `ARCHIVED` / từng status → đúng số card.
- Search → đúng tập card.
- Chi phí 1 lần cập nhật khi **không** job nào đổi: **≤ 1 ms** (baseline 11,76 ms). ✅ / ❌
- **Kịch bản bắt buộc (rà soát lần 2 — `review_round2.md` §1.3):**
  1. Đổi `priority` của 1 job → **thứ tự card trong list cập nhật đúng** (không phải chỉ nội dung card).
  2. Archive 1 job đang ở trạng thái `TO DO` khi filter = `ALL` → **card biến mất khỏi DOM** (không phải chỉ ẩn).
  3. Job đổi trạng thái → card cập nhật badge mà **không** cần dựng lại node.

---

### ☐ T2.2 — Event delegation cho job card

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (dòng 1037–1044, `initEventListeners` 365–602) |
| **UC** | UC-3 |
| **Ước lượng** | 30 phút |

**Việc:**
1. **Xoá** `container.querySelectorAll('.job-card').forEach(card => card.addEventListener('click', ...))` (dòng 1037–1044).
2. Thêm **1** listener `click` trên `#jobsListContainer` (đăng ký 1 lần trong `initEventListeners()`), dùng `e.target.closest('.job-card')` → `dataset.jobId`.
3. Giữ nguyên hành vi: click card → `selectJob(jobId)`; click nút phụ trong card (nếu có) → hành vi riêng.

**Verify:**
- Click mọi vùng của card (tiêu đề, badge, nút) → hành vi đúng như trước.
- Số listener mới gán mỗi lần render = **0** (đếm bằng `getEventListeners` trong DevTools hoặc log counter tạm). ✅ / ❌
- **Kịch bản bắt buộc (rà soát lần 2 — `review_round2.md` §1.1):**
  1. Click nút **Lưu trữ** trên card → **chỉ** archive, **không** chuyển sang job đó.
  2. Click nút **Xóa** trên card → **chỉ** xoá, **không** chuyển sang job đó.
  3. Card **không** được job trong `TO DO` → nút Xóa phải **ẩn** (cập nhật qua `refs.deleteBtn.hidden`).

---

### ☐ T2.3 — Cache `loadPlanFiles` theo (jobId, hash)

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (`loadPlanFiles` 3556–3600, `renderDualPlan` 1462–1483) |
| **UC** | UC-4 |
| **Ước lượng** | 1,5 h |

**Việc:**
1. Thêm `state.planCache = new Map()` → `jobId → { hash, devHtml, testHtml, promise }`.
2. `loadPlanFiles(jobId)`:
   - Tính hash từ `state.dualPlan` hiện có (`dev_plan` + `test_plan`).
   - Hash khớp cache → dùng lại `devHtml`/`testHtml`, **không** fetch.
   - Cache miss → fetch, parse, lưu cache.
3. Cache **promise** để các lần gọi chồng nhau dùng chung 1 request (tránh request trùng).
4. `renderDualPlan()` dùng **cache đã parse** → **xoá** parse trùng (dòng 1469, 1483).

**Verify:**
- Đếm request `/plan-files` trong 60 s khi 1 job đang chạy → **giảm ≥ 50%** so với baseline.
- Số lần `marked.parse` trong 60 s → giảm ≥ 50%.
- Nội dung plan hiển thị **giống hệt** trước khi sửa (so sánh screenshot). ✅ / ❌

---

### ☐ T2.4 — `AbortController` cho mọi `fetch`

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (dòng 609, 631, 653, 673, 3565) |
| **UC** | UC-4 |
| **Ước lượng** | 1 h |

**Việc:**
1. Thêm helper `fetchJson(url, opts)` dùng `AbortController` + timeout 10.000 ms.
2. Poll `/api/v1/jobs` (dòng 631) và `/api/v1/status` (673): abort request cũ trước khi bắn request mới.
3. `fetchJobDetails` (653) + `loadPlanFiles` (3565): abort khi job đổi → **chặn race** response cũ ghi đè `state.activeJob`.
4. Bỏ fallback 2-request của `loadPlanFiles` (dòng 3565–3572) → thêm `?both=1` cho endpoint trả cả 2 plan (1 request).

**Verify:**
- Click nhanh 3 job liên tiếp → hiển thị **đúng job cuối cùng** (không bị response cũ ghi đè).
- Grep `public/app.js` → **0** `fetch(` không có `signal`. ✅ / ❌

---

### ☐ T2.5 — Debounce ô search

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (dòng 380–383) |
| **UC** | UC-4 |
| **Ước lượng** | 15 phút |

**Việc:** debounce 200 ms cho input search → `state.searchQuery` cập nhật sau khi ngừng gõ.

**Verify:** gõ 10 ký tự → render list **≤ 2 lần** (baseline: 10 lần). ✅ / ❌

---

### ☐ T2.6 — Gỡ `diff2html` + bỏ `drop-shadow` + `contain-intrinsic-size`

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/index.html` (dòng 55–56), `public/style.css` (824–825, 851–853) |
| **UC** | UC-5 |
| **Ước lượng** | 30 phút |

**Việc:**
1. Xoá 2 thẻ `diff2html` (`public/index.html:55-56`) — grep xác nhận `public/` **không** dùng.
2. `public/style.css:824-825` — bỏ `filter: drop-shadow(...)` khỏi animation SVG (hoặc chuyển animation sang phần tử không có filter).
3. `public/style.css:851-853` — thêm `contain-intrinsic-size` cho `#jobsListContainer` → hết scrollbar nhảy.

**Verify:** transfer giảm ≥ 250 KB; không còn `diff2html` trong network tab; không còn `drop-shadow` trên SVG động. ✅ / ❌

---

### ☐ T2.7 — Tailwind build sẵn (thay CDN runtime)

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/index.html` (dòng 9), `public/tailwind.css` (mới), `tailwind.config.js` (mới, hoặc nhúng trong index.html) |
| **UC** | UC-5 |
| **Ước lượng** | 2 h |
| **Phụ thuộc** | User đồng ý `expect.md` §6 Q2 |

**Việc:**
1. Thêm `tailwindcss` vào `devDependencies` + script `build:css` trong `package.json`.
2. Build ra `public/tailwind.css` từ nội dung `public/index.html` + `public/app.js` (safelist các class **sinh runtime**).
3. **Bắt buộc:** grep `className`, `classList.add/remove/toggle`, `innerHTML` trong `public/app.js` → liệt kê mọi class sinh động → đưa vào `safelist`. Thiếu class = **mất style** → lỗi hiển thị.
4. Thay `<script src="https://cdn.tailwindcss.com">` bằng `<link rel="stylesheet" href="/tailwind.css">`.
5. Xoá khối `tailwind.config` runtime (chuyển sang `tailwind.config.js` cho build).

**Verify:**
- FCP **< 600 ms** (baseline 1.224 s).
- **So sánh screenshot toàn bộ UI** trước/sau → không có phần tử nào mất style.
- Không còn request tới `cdn.tailwindcss.com`.
- `package.json`: `tailwindcss` chỉ nằm ở `devDependencies`, **không** có trong `dependencies`. ✅ / ❌


---

### ☐ T2.8 — Đo lại T2

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `docs/features/PERF-FIX-01/report.md` |
| **UC** | UC-3,4,5 |
| **Ước lượng** | 0,5 h |

**Verify:**
1. Render list (không đổi): **≤ 1 ms/lần** (baseline 11,76 ms).
2. Request HTTP trong 60 s (1 job chạy): **giảm ≥ 50%**.
3. FCP: **< 600 ms** (baseline 1.224 s).
4. Số listener mới / render: **0**.
5. `npm test` pass. ✅ / ❌

---

## 3b. T2P — Sửa lỗi chức năng + UX/a11y (rà soát lần 2) — **CẦN USER DUYỆT ĐỂ THÊM VÀO SCOPE**

> Nguồn: [`review_round2.md`](./review_round2.md) §2 (3 lỗi chức năng) + §3 (12 vấn đề UX/a11y).
> **Ước lượng: ~8,25 h.** Không phải vấn đề hiệu năng — nhưng là nguyên nhân trực tiếp của cảm nhận "UI đơ, lag" và làm UI không dùng được với bàn phím / screen reader.
> **Chưa được duyệt** → các task dưới đây **KHÔNG** implement cho tới khi user đồng ý thêm vào scope.

### ☐ T2P.1 — Sửa "Server Offline" không bao giờ hiện

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (dòng 686–690) |
| **UC** | — (lỗi chức năng) |
| **Ước lượng** | 30 phút |

**Việc:** `catch` của `fetchSystemStatus` đang set `state.systemStatus.online = true` → UI **không bao giờ** hiện "Server Offline" dù `renderSystemStatus` (`app.js:1846-1853`) đã có sẵn nhánh offline. → Đổi thành `online = false` + hiện toast "Mất kết nối server" **1 lần** (không spam mỗi 15 s — dùng cờ `state.offlineNotified`).

**Verify:** tắt server → sau ≤ 30 s, header hiện **"Server Offline"** (dot đỏ) + 1 toast. Bật lại server → tự trở lại "Server Online". ✅ / ❌

---

### ☐ T2P.2 — Poll lỗi không báo + thêm nút "Thử lại" / "Xoá bộ lọc"

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (dòng 618–624, 629–648, 971–977) |
| **UC** | — (lỗi chức năng) |
| **Ước lượng** | 1 h |

**Việc:**
1. `fetchJobsListSilently` (`app.js:646-648`) đang `catch (e) { /* ignore */ }` → đếm lỗi liên tiếp; ≥ 3 lần → hiện badge cảnh báo "Không tải được danh sách task" + nút **Thử lại** (gọi `fetchJobsList()`).
2. `app.js:618-624` (lỗi API lần đầu) → thêm nút **Thử lại**.
3. `app.js:971-977` (filter không ra kết quả) → thêm nút **Xoá bộ lọc** (reset `statusFilter='ALL'`, `searchQuery=''`).

**Verify:** tắt server → sau ≥ 24 s hiện badge cảnh báo + nút Thử lại; bật lại server → bấm Thử lại → danh sách về bình thường. Filter không ra kết quả → nút Xoá bộ lọc reset được. ✅ / ❌

---

### ☐ T2P.3 — Thay `alert()` blocking bằng toast + giới hạn số toast

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (9 `alert()`, 8 `confirm()`, `showToast` 3252–3283) |
| **UC** | — (UX) |
| **Ước lượng** | 1,5 h |

**Việc:**
1. Thay 9 `alert()` → `showToast(msg, 'error')` (alert chặn toàn bộ JS → **nguồn "đơ" không liên quan server**).
2. Thay 8 `confirm()` → modal xác nhận (đã có pattern modal sẵn).
3. `showToast` hiện **không giới hạn** số toast → giới hạn **≤ 5** đồng thời.
4. `app.js:3262` (`container.innerHTML = ''` khi type==='success') **xoá sạch** mọi toast lỗi đang hiện → chỉ xoá toast cùng loại.

**Verify:** mỗi luồng lỗi (duyệt, xoá task, start, cancel) → hiện toast, UI **không** bị chặn; 10 lỗi liên tiếp → tối đa 5 toast hiện; 1 toast success **không** xoá toast lỗi đang hiện. ✅ / ❌

---

### ☐ T2P.4 — A11y: `aria-label`, `aria-live`, focus ring

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (icon-only button: 1010-1017, 1591-1597, 1670-1674…), `public/index.html` (`#systemStatusText`, `#jobsCountBadge`), `public/style.css` (focus ring) |
| **UC** | — (a11y) |
| **Ước lượng** | 1,5 h |

**Việc:** đo hiện tại: `grep -c "aria-\|role=\|tabindex"` trên cả 3 file → **0 / 0 / 0**; `sr-only` → 0; `focus-visible` → 0.
1. `aria-label` cho **mọi** icon-only button (nút lưu trữ/xoá trên card, nút evidence, nút đóng modal).
2. `aria-live="polite"` cho `#systemStatusText` (trạng thái server) và `#jobsCountBadge` (số task).
3. `aria-label` cho input search + select filter.
4. `:focus-visible` ring rõ (hiện focus ring bị xoá ở nhiều nơi → user bàn phím không thấy mình đang ở đâu).

**Verify:** tab-bàn phím qua card → thấy focus ring rõ; screen reader đọc được tên các nút icon; đổi trạng thái server → đọc được thay đổi. ✅ / ❌

---

### ☐ T2P.5 — Modal: `role="dialog"`, focus trap, Esc đóng

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (Escape handler 504–510, các hàm `open*Modal`/`close*Modal`), `public/index.html` (7 modal) |
| **UC** | — (a11y) |
| **Ước lượng** | 2 h |
| **Rủi ro** | **TRUNG BÌNH** — focus trap dễ kẹt focus nếu làm sai → bắt buộc test kỹ |

**Việc:**
1. Hiện Esc (`app.js:505-509`) chỉ đóng **2/7** modal (lightbox + evidence detail) → đăng ký Esc cho **toàn bộ** modal qua 1 listener.
2. `role="dialog" aria-modal="true" aria-labelledby="..."` cho 7 modal.
3. Focus trap: Tab cycle trong modal, focus trả về **trigger** khi đóng. → helper `openModal(id)` / `closeModal(id)`.

**Verify:** mở từng modal → Tab không thoát ra ngoài; Esc đóng được **cả 7**; đóng xong focus quay lại nút đã bấm; không modal nào bị kẹt focus sau khi đóng. ✅ / ❌

---

### ☐ T3P.1 — Hạ `express.json` limit + checkpoint WAL

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (dòng 261–262), `src/storage/db.js` (`initDb`) |
| **UC** | UC-6 |
| **Ước lượng** | 45 phút |

**Việc:**
1. `express.json({ limit: '20mb' })` cho mọi route → hạ thẳng xuống **2 MB** toàn cục (`server.js:261-262`). Payload lớn nhất thực tế chỉ là `prompt` 10–14 KB, không có upload hay multipart; 2 MB là dư thừa an toàn và đơn giản hơn phân nhánh per-route.
2. WAL 4,1 MB, không có checkpoint thủ công → thêm `PRAGMA wal_checkpoint(TRUNCATE)` khi idle.

**Verify:** `POST /api/v1/jobs` với prompt 15 KB vẫn tạo được; request > 2 MB tới route thường bị từ chối; file WAL không phình vượt 1 MB. ✅ / ❌

---

### ☐ T3P.2 — `refreshEvidences` dùng endpoint evidence riêng

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `public/app.js` (dòng 2902–2908) |
| **UC** | UC-6 |
| **Ước lượng** | 20 phút |

**Việc:** `refreshEvidences` fetch **toàn bộ** job detail (14–18 KB) chỉ để lấy `data.evidence` → dùng endpoint `GET /api/v1/jobs/:id/evidence` đã có sẵn (đo 4–5 ms, 6,7 KB).

**Verify:** toggle/xoá evidence → payload request < 8 KB, evidence hub vẫn cập nhật đúng. ✅ / ❌


## 4. T3 — Backend (UC-6)

### ☐ T3.1 — `CREATE INDEX` cho các bảng

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/storage/db.js` (`initDb()`, sau dòng 197) |
| **UC** | UC-6 |
| **Ước lượng** | 1 h |

**Việc:** thêm 5 index (idempotent) theo `dev_plan.md` §2.5. Đặt trong `initDb()` sau khi tạo bảng.

**Verify:** `node -e "const {getDb}=require('./src/storage/db'); ..."` → `SELECT name FROM sqlite_master WHERE type='index'` có đủ 5 index. `npm test` pass. ✅ / ❌

---

### ☐ T3.2 — Cache `db.prepare()`

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/storage/db.js` (dòng 270, 320, 355) |
| **UC** | UC-6 |
| **Ước lượng** | 30 phút |

**Việc:**
1. `const stmtCache = new Map();` + `function getStmt(sql)`.
2. Thay `db.prepare(sql)` → `getStmt(sql)` ở các call site nóng.
3. **Clear cache trong `initDb()`** (sau migration `ALTER TABLE`) → tránh giữ statement cũ.

**Verify:** `SELECT * FROM jobs` 100 lần → **< 0,3 ms/lần** (hiện 0,49 ms). `npm test` pass. ✅ / ❌

---

### ☐ T3.3 — `/api/v1/jobs`: payload gọn + preview prompt

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (dòng 1200–1231, `db.listJobs` 326–357), `public/app.js` (dòng 3691 — modal Sửa task) |
| **UC** | UC-6 |
| **Ước lượng** | 1,5 h |
| **Phụ thuộc** | `dev_plan.md` §2.3 (bảng dùng `job.prompt`) |

**Việc:**
1. `db.listJobs()` chọn danh sách cột cần:
   - `SUBSTR(prompt, 1, 200) AS prompt` (preview phục vụ hiển thị card)
   - `SUBSTR(prompt, 1, 1000) AS prompt_search` (computed alias phục vụ tìm kiếm từ khóa, không cần migration schema hay backfill)
2. **`public/app.js:3691` — BẮT BUỘC:** modal Sửa task hiện lấy `job.prompt` từ `state.jobs` (giờ chỉ có preview 200 ký tự) → phải **fetch `GET /api/v1/jobs/:id`** để lấy prompt đầy đủ trước khi mở modal. Không sửa chỗ này = **hiển thị sai dữ liệu nghiệp vụ**.
3. **`public/app.js:965` và `1914` — BẮT BUỘC:** cập nhật biểu thức lọc và đếm badge sang `(j.title || j.prompt_search || j.prompt || '')` để tìm kiếm được các từ khóa nằm sâu trong prompt (tối đa 1.000 ký tự đầu).
4. `app.js:987` (title card) và `1122` (title header) tiếp tục dùng `job.title || job.prompt` (đã là preview 200 ký tự).

**Verify:**
- `GET /api/v1/jobs` (37 job) payload **thô** **< 28 KB** (baseline 30,9 KB) — sau khi bỏ `prompt` dự kiến ~25,2 KB.
- `GET /api/v1/jobs` payload **gzipped** **< 10 KB** (dự kiến ~3–6 KB) → đo bằng `curl --compressed -w '%{size_download}'` hoặc header `Content-Encoding: gzip`.
- Mở modal Sửa task → ô Prompt hiển thị **đầy đủ**, khớp với DB.
- Search theo từ khóa nằm sau ký tự 200 (ví dụ từ khóa ở ký tự thứ 500 của prompt) → **vẫn tìm thấy task đúng**. ✅ / ❌

---

### ☐ T3.4 — Bỏ nhân bản payload job detail

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (dòng 1453–1454) |
| **UC** | UC-6 |
| **Ước lượng** | 15 phút |

**Việc:** bỏ `...fullJobData` ở top level, giữ `job: fullJobData`. **Kiểm tra** client có đọc field ở top level không → grep `data\.\w+` trong `public/app.js` sau `fetchJobDetails`.

**Verify:** `GET /api/v1/jobs/:id` payload giảm ~50%; UI job detail hiển thị đầy đủ (steps, evidence, questions, dual_plan). ✅ / ❌

---

### ☐ T3.5 — Nén response bằng `node:zlib` stdlib

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (middleware, ~dòng 259) |
| **UC** | UC-6 |
| **Ước lượng** | 45 phút |
| **Dependency** | **KHÔNG** thêm dependency — dùng `node:zlib` stdlib (đã chốt ở `expect.md` §4) |

**Việc:**
1. Middleware gzip viết tay (~40 dòng) dùng `node:zlib.createGzip()`: kiểm tra `Accept-Encoding: gzip`, nén response JSON > 1 KB, set `Content-Encoding: gzip`.
2. **Bỏ qua route SSE** (`/api/v1/jobs/:id/logs/stream`) — SSE phải stream không nén.
3. Không nén ảnh/binary (`/evidence/:filename`).
4. **KHÔNG** thêm `compression` vào `package.json` — `expect.md` §4 cấm dependency runtime mới.

**Verify:**
- `curl -H "Accept-Encoding: gzip" -I /api/v1/jobs` → `Content-Encoding: gzip`.
- SSE `/logs/stream` vẫn stream bình thường (không bị nén/nghẽn).
- `package.json` **không** có thay đổi ở `dependencies`.
- `npm test` pass. ✅ / ❌

---

## 5. T4 — Ghi log async (UC-7)

### ☐ T4.1 — `JobEventBus` dùng write stream

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (`JobEventBus.emitJobLog`, dòng 58–68) |
| **UC** | UC-7 |
| **Ước lượng** | 45 phút |

**Việc:**
1. `JobEventBus` giữ `Map<jobId, fs.WriteStream>`; lazy tạo khi có log đầu tiên.
2. `stream.write(stamped)` thay `fs.appendFileSync` (dòng 67).
3. Xử lý lỗi stream (`error` event) → không làm crash server.
4. **Giữ nguyên** format dòng: `[${timestamp}] ${line}\n` (dòng 63–66) — **không** được đổi, vì log đã được dùng để đối chiếu.

**Verify:**
- Log ghi ra **giống hệt** format cũ (so 20 dòng đầu file log mới với file cũ).
- `npm test` pass. ✅ / ❌

---

### ☐ T4.2 — Đóng stream khi job kết thúc + đo lại

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `src/server.js` (`emitJobStatus` — gọi close khi status terminal) |
| **UC** | UC-7 |
| **Ước lượng** | 15 phút |

**Việc:** đóng write stream khi job vào `DONE`/`FAILED`/`CANCELLED`/`TIMED_OUT`; xoá entry khỏi `Map`.

**Verify:**
- Chạy 1 job tới DONE → không còn file descriptor treo (`Handles` của process không tăng liên tục).
- Log realtime vẫn hoạt động, độ trễ < 2 s. ✅ / ❌

---

## 6. T5 — Kiểm thử, đo lại, report (tất cả UC)

### ☐ T5.1 — Hồi quy test suite

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `tests/` (chỉ thêm test mới, không sửa test cũ trừ khi API contract đổi có chủ đích) |
| **UC** | tất cả |
| **Ước lượng** | 1 h |

**Verify:** `npm test` → **278/278 pass** (baseline). Nếu có test fail do thay đổi API contract → **dừng lại, báo user**, không tự sửa test để "cho xanh". ✅ / ❌

---

### ☐ T5.2 — Hồi quy UI (3 trạng thái + tương tác)

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `docs/features/PERF-FIX-01/evidence/` (screenshot) |
| **UC** | UC-3, UC-4, UC-5 |
| **Ước lượng** | 0,5 h |

**Kịch bản bắt buộc:**
1. List hiển thị 3 trạng thái (`TO DO`, `IMPLEMENT`, `DONE`) — **không** có trạng thái nào bị sai/mất.
2. Filter `ALL` (ẩn `ARCHIVED`), filter `ARCHIVED`, filter từng status.
3. Search theo title, theo prompt, theo repo.
4. Click card → mở đúng job; click nhanh 3 job liên tiếp → đúng job cuối.
5. Mở modal Sửa task → prompt **đầy đủ**.
6. Mở job có log lớn → terminal hiện log, UI không đứng.
7. Bấm "Tải lịch sử log thêm" → nối log cũ.

**Verify:** ảnh chụp lưu vào `docs/features/PERF-FIX-01/evidence/`, không có sai lệch so với ảnh baseline. ✅ / ❌

---

### ☐ T5.3 — Đo lại toàn bộ A1–A9

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `docs/features/PERF-FIX-01/report.md` |
| **UC** | tất cả |
| **Ước lượng** | 0,5 h |

**Verify:** chạy lại toàn bộ script đo, điền bảng trước/sau:

| # | Tiêu chí | Baseline | Sau | Đạt |
|---|---|---|---|---|
| A1 | `/api/v1/status` p95 | 1.435–1,595 s | < 50 ms | ☐ |
| A2 | `/api/v1/health` | 1.348–1,435 s | < 50 ms | ☐ |
| A3 | 5 `/status` song song (wall) | 6,24 s | < 200 ms | ☐ |
| A4 | FCP | 1.224 s | < 600 ms | ☐ |
| A5 | SSE frame `log` đầu | 23,03 MB | < 256 KB | ☐ |
| A6 | Long task mở job log 25 MB | 393 + 545 ms | không task > 200 ms | ☐ |
| A7 | Render list (không đổi) | 11,76 ms | ≤ 1 ms | ☐ |
| A8 | Request HTTP / 60 s (1 job chạy) | baseline | giảm ≥ 50% | ☐ |
| A9 | `/api/v1/jobs` payload **thô** | 30,9 KB | < 28 KB | ☐ |
| A9b | `/api/v1/jobs` payload **gzipped** | (chưa nén) | < 10 KB | ☐ |
| A10 | `npm test` | 278/278 | 278/278 | ☐ |

✅ / ❌

---

### ☐ T5.4 — Viết `report.md` + cập nhật `tasks.md`

| | |
|---|---|
| **Service** | `ai-worker` |
| **File chạm** | `docs/features/PERF-FIX-01/report.md`, `docs/features/PERF-FIX-01/tasks.md`, `docs/features/PERF-FIX-01/expect.md` |
| **UC** | tất cả |
| **Ước lượng** | 0,5 h |

**Việc:**
1. `report.md`: danh sách file đã đổi (đường dẫn + số dòng), bảng số đo trước/sau, kết quả test thực tế, **mọi thay đổi lệch so với plan** và lý do.
2. `tasks.md`: đánh dấu trạng thái từng task, cập nhật ước lượng thực tế.
3. `expect.md`: cập nhật §5 baseline + kết quả cuối.
4. **Dọn** mọi script đo tạm trong `temp/` → **Recycle Bin** (quy tắc: không xoá vĩnh viễn).

**Verify:** báo cáo có đủ số đo trước/sau; `git status` chỉ hiện file thuộc feature + file đã sửa có chủ đích. ✅ / ❌

---

## 7. Checklist nghiệm thu cuối

- [ ] A1–A10 đều ✅ (bảng T5.3)
- [ ] `npm test` pass 278/278
- [ ] **Không** thay đổi hành vi nghiệp vụ: vòng đời job, Multi-Verification Gate, SystemOne schema, evidence lifecycle — **giữ nguyên**
- [ ] `package.json`: `dependencies` **không đổi** (`cors`/`express`/`tree-kill` giữ nguyên) — **không** thêm dependency runtime mới (nén bằng `node:zlib` stdlib). `tailwindcss` chỉ ở `devDependencies`.
- [ ] Không ghi file rác vào `logs/` hay dữ liệu thật
- [ ] Mọi script tạm đã vào Recycle Bin
- [ ] `report.md` có số đo trước/sau + test thực tế
- [ ] `tasks.md` cập nhật trạng thái + ước lượng thực tế
- [ ] User đã review và xác nhận Gate 2

---

## 8. Ghi chú trạng thái

| Ngày | Ghi chú |
|---|---|
| 2026-10-22 | Tạo tasks.md. Baseline đã chụp từ `PERF-ANALYSIS-01/report.md`. Chưa implement task nào. |
