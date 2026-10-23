---
feature: PERF-FIX-01
service: ai-worker
status: plan-review
owner: AI
updated_at: 2026-10-22
---

# Kế hoạch kỹ thuật (dev_plan.md) — PERF-FIX-01

> Kỳ vọng nghiệp vụ: [`expect.md`](./expect.md) · Báo cáo phân tích gốc: [`../PERF-ANALYSIS-01/report.md`](../PERF-ANALYSIS-01/report.md)
> **Nguyên tắc:** sửa đúng chỗ sai, **không** dựng lại hệ thống. Mọi thay đổi trace được về một UC trong `expect.md`.
> **Ràng buộc:** giữ nguyên 100% hành vi nghiệp vụ. Giữ nguyên dependency (`cors`, `express`, `tree-kill`) — ưu tiên stdlib.

---

## 0. Tóm tắt

| Nhóm | Nội dung | UC | Ước lượng |
|---|---|---|---|
| **G0** | Chặn event loop: cache ở `BaseAdapter.detect()` + `spawn` async; `/status` không spawn | UC-1 | 1,75 h |
| **G1** | SSE log: bỏ replay 23 MB, offset + giới hạn bytes | UC-2 | 6,5 h |
| **G2** | Frontend: render tăng dần, dedupe plan, bỏ CDN thừa | UC-3,4,5 | 10 h |
| **G3** | Backend: index, prepare cache, payload gọn, nén gzip (zlib stdlib) | UC-6 | 5,75 h |
| **G4** | Ghi log async (write stream) | UC-7 | 1 h |
| | **Tổng** | | **~25 h** (chưa gồm T5) |

**Thứ tự thi triến:** G0 → G1 → G2 → G3 → G4. G0 là **gate**: nếu G0 chưa xong thì mọi số đo còn lại đều bị nhiễu bởi block 1,3 s.

---

## 1. Quyết định kiến trúc (ADR-style)

### ADR-1: Cache đặt ở `BaseAdapter.detect()` (TTL + `spawn` async), `/status` **không** gọi detect

- **Bằng chứng:** `handleHealthCheck` (`src/server.js:542-572`) gọi `runnerRegistry.detectAll()` (`src/server.js:546`) → `baseAdapter.detect()` chạy **2 `spawnSync`/runner** (`src/runners/baseAdapter.js:29,45`) × 5 runner = **10 process spawn blocking trong 1 request**. Đo: `/status` = 1,435–1,595 s; 5 request song song = wall 6,24 s.
- **Quyết định (3 lớp, độc lập):**
  1. **Ranh giới cache đặt ở `BaseAdapter.detect()`** (`src/runners/baseAdapter.js:25`) — **không** đặt ở `runnerRegistry.detectAll()`. Lý do: `detect()` có **nhiều call site trên đường chạy job**, không chỉ `detectAll()`:
     | Call site | Vị trí | Tần suất |
     |---|---|---|
     | `runnerRegistry.detectAll()` | `src/runners/runnerRegistry.js:74` | mỗi request `/status`, `/health`, `/runners` |
     | `runnerRegistry.getAvailableRunner()` | `src/runners/runnerRegistry.js:146` và `:156` | **trước MỖI pipeline step** — `src/server.js:2780` (PLANNING), `:3000` (IMPLEMENT), `:3202` (TESTING), `:3372` (FIXING); loop tới 5 runner mỗi lần |
     | `BaseAdapter.buildCommand()` | `src/runners/baseAdapter.js:312` | trước mỗi `execute()` |
     | `aiTriage` | `src/execution/aiTriage.js:305` | mỗi lần triage |
     | boot | `src/index.js:25` | 1 lần khi khởi động |

     → Chỉ cache ở `detectAll()` sẽ **để nguyên ~1,3 s blocking trên đường chạy job** (mỗi step gọi `getAvailableRunner()` → `detect()` → 2 `spawnSync`/runner).
  2. `baseAdapter.detect()` dùng `spawn` **async** (`child_process.spawn` + Promise) thay `spawnSync` → 10 lệnh chạy **song song** (đo: 1.392 ms → 365 ms).
  3. `/api/v1/status` và `/api/v1/health` **chỉ cần** `enabled` + `name` của runner → **không** gọi `detectAll()`. `detectAll()` (đầy đủ `installed`/`version`/`path`) chỉ ở `/api/v1/runners`.
- **Lý do:** lớp 3 đủ để đạt A1/A2/A3 mà **không cần cache**; lớp 1+2 bắt buộc vì `detect()` nằm trên **đường chạy job**, không chỉ đường UI.
- **Hệ quả:**
  - `/runners` có thể trả dữ liệu **stale tối đa 60 s** → đã nêu ở `expect.md` §6 Q3.
  - `detect()` giữ **API sync** (nhiều call site gọi đồng bộ) → chỉ cache-miss mới chạy refresh nền, không ai đợi.
  - Fallback phải giữ: `detection.path || this.command` (`src/runners/baseAdapter.js:313`).
  - `detectAll()` giữ **sync** → 3 caller ngoài registry (`src/index.js:25`, `src/server.js:546`, `src/server.js:718`) **không** cần sửa.
- **Rủi ro:** cache trả `installed:false` giả lúc mới khởi động → `getAvailableRunner()` có thể chọn nhầm runner. → Mitigate: lần đầu **đồng bộ chờ** detect hoàn tất (chỉ 1 lần khi boot), các lần sau đọc cache; fallback `detection.path || this.command` giữ nguyên hành vi.

### ADR-2: SSE log — **tách lịch sử khỏi stream**, tail theo byte offset

- **Bằng chứng:** `src/server.js:4310-4325` đọc `fs.readFileSync(logFilePath,'utf8')` toàn bộ file (178 ms block với 25,8 MB) rồi gửi **1 event chứa 23,03 MB**. Parse SSE chuẩn: `event "log": 1 event, data 23,03 MB`. Phía browser: 2 long task 393 + 545 ms, xử lý text 843 ms, `JSON.stringify` 163 ms.
- **Quyết định:**
  1. **SSE chỉ stream log MỚI.** Khi client kết nối, server gửi **snapshot giới hạn** (256 KB cuối) — không phải toàn bộ file.
  2. **Tail theo byte offset**: server duy trì `Map<jobId, {offset}>`; client gửi `Last-Event-ID` (hoặc query `?from=<offset>`); server đọc từ offset.
     - ⚠️ **Offset phải lấy từ counter byte của write stream** (`stream.bytesWritten`, cập nhật trong callback `stream.write(chunk, cb)`) — **KHÔNG** dùng `fs.statSync(path).size` làm nguồn offset. Lý do: `stream.write()` là bất đồng bộ, dữ liệu còn trong buffer userspace khi `statSync` chạy → offset lệch → reconnect nhận lại log cũ (duplicate) hoặc mất log. `statSync` chỉ dùng để **phát hiện file bị truncate** (`size < offset` → reset 0).
  3. **Đọc async**: `fs.promises.open` + `read` vào buffer cố định → **không** block event loop.
  4. Endpoint lịch sử riêng: `GET /api/v1/jobs/:id/logs?offset=&limit=` cho phân trang lịch sử khi user cuộn ngược.
- **Lý do:** giải quyết đồng thời UC-2 (không freeze) và giữ nguyên realtime. Offset là bắt buộc vì log là **append-only** → offset = byte size là định danh ổn định.
- **Hệ quả:** client mới kết nối **không** thấy log cũ ngay → phải có UI "tải lịch sử thêm" (gọi endpoint phân trang). Đây là **thay đổi hành vi hiển thị** → ghi rõ trong `expect.md` và task T1.3.
- **Rủi ro:** log file bị rotate/truncate → offset lệch → phải detect `size < offset` → reset về 0.

### ADR-3: Render danh sách **tăng dần** + **event delegation**

- **Bằng chứng:** `public/app.js:984` gán `container.innerHTML = ...` thay 100%; `public/app.js:1037` gán lại listener cho từng `.job-card`. Đo: `innerHTML` + forced layout = **11,76 ms/lần** (7 job) vs append tăng dần **0,02 ms**.
- **Quyết định:**
  1. Giữ `Map<jobId, {el, refs}>`; chỉ tạo node khi job **mới**, chỉ set `textContent` khi field đổi.
  2. **1 listener duy nhất** trên `#jobsListContainer` (delegate), dùng `e.target.closest('.job-card')`.
  3. Bỏ `innerHTML` hoàn toàn trong đường render danh sách.
  4. ⚠️ **Bắt buộc — xử lý 2 nút phụ (`app.js:1010` archive, `app.js:1015` delete):** chuyển `onclick="event.stopPropagation(); window.aiWorker.X(...)"` → `data-action="archive|delete"` + `data-job-id`. Handler delegation **phải** `e.stopPropagation()` + `return` sớm khi bắt `data-action`, nếu không click "Xóa Task" sẽ **vừa xoá vừa chuyển job**. Vì không còn inline handler, `canDelete` đổi phải cập nhật qua `refs.deleteBtn.hidden = !canDelete` (không dùng `replaceWith`).
  5. ⚠️ **Bắt buộc — reorder + node không còn khớp filter:** sau khi cập nhật nội dung, **re-append node theo thứ tự `filtered`** bằng `container.appendChild(node)` (thao tác này **di chuyển** node đã có, không tạo lại → vẫn rẻ hơn `innerHTML`). Job không còn khớp filter (ví dụ chuyển `TO DO` → `ARCHIVED` khi filter `ALL`) phải bị **xoá khỏi DOM**, không chỉ ẩn.
- **Lý do:** O(n) → O(changed). Đo được 590× rẻ hơn.
- **Hệ quả:** phải viết lại `renderJobsList` (~110 dòng) — cẩn thận giữ **đúng** logic filter + signature cache hiện tại, nếu không sẽ sai hiển thị trạng thái (rủi ro HIGH đã ghi ở `expect.md` §7).

> **Nguồn:** rà soát lần 2 (`review_round2.md` §1.1, §1.3) — 2 rủi ro HIGH nếu bỏ sót.


### ADR-4: `loadPlanFiles` — **cache theo (jobId, hash)** + `AbortController`

- **Bằng chứng:** `public/app.js:1244` gọi `loadPlanFiles(job.id)` trong `renderActiveJobDetail()`; hàm ở `public/app.js:3556` fetch `/api/v1/tasks/{id}/plan-files` (fallback `/api/v1/jobs/{id}/plan-files`) rồi `marked.parse` × 2. Ngoài ra `renderDualPlan()` (`public/app.js:1462`) đã `marked.parse` cùng nội dung → **parse trùng 2 lần**.
- **Quyết định:**
  1. Cache `{jobId → {hash, devHtml, testHtml}}`; chỉ fetch khi hash nội dung plan thay đổi.
  2. Cache **promise** theo `jobId` để các lần gọi chồng nhau dùng chung 1 request.
  3. Bỏ fallback 2-request: thêm `?both=1` vào endpoint để 1 request trả cả 2 plan.
  4. `AbortController` cho **mọi** `fetch` trong `app.js`; poll cũ bị abort trước khi bắn request mới.
- **Lý do:** waste chắc chắn (re-fetch + re-parse cùng nội dung không đổi) — sửa không cần đo thêm.
- **Rủi ro:** bỏ cột `prompt` (G3) có thể phá hash → kiểm tra `job.prompt` usage trước.

### ADR-5: Tailwind **build sẵn**, gỡ `diff2html`

- **Bằng chứng:** `public/index.html:9` nạp `https://cdn.tailwindcss.com` → JIT biên dịch CSS runtime + `MutationObserver` quét DOM. Đo: **1.307 CSS rule / 110,9 KB** sinh runtime; `innerHTML` 1,06 ms nhưng **11,76 ms** khi có forced layout. `public/index.html:55-56` nạp `diff2html` (CSS 2,4 KB + JS **259,7 KB**) — grep toàn `public/` **không có** tham chiếu.
- **Quyết định:**
  1. Build Tailwind offline → 1 file `public/tailwind.css` tĩnh, thay thế script CDN.
  2. Gỡ 2 thẻ `diff2html`.
- **Lý do:** loại bỏ runtime CSS compiler (style recalc O(DOM) sau mỗi lần `innerHTML`) + giảm 262 KB network.
- **Rủi ro:** Tailwind build có thể **bỏ sót** class dùng động (class sinh runtime trong JS). → Phải grep `className`/`classList` trong `public/*.js` và thêm class vào `safelist` của `tailwind.config`.
- **Câu hỏi mở:** `expect.md` §6 Q2 — cần user đồng ý thêm bước build.

### ADR-6: Backend — index + `prepare` cache + payload gọn + nén gzip (zlib stdlib)

- **Bằng chứng:**
  - 7 bảng, **không** có `CREATE INDEX` nào (`src/storage/db.js:34-197`).
  - `db.prepare(sql)` **không cache** — gọi lại mỗi request (`src/storage/db.js:355`, `270`, `320`).
  - `SELECT *` kéo cột `prompt` (10–14 KB/job) → `/api/v1/jobs` 37 job = **30,9 KB**.
  - Payload job detail **nhân bản 2×**: `job: fullJobData, ...fullJobData` (`src/server.js:1453-1454`).
  - Không có `compression` trong `package.json` → không gzip.
- **Quyết định:**
  1. `CREATE INDEX IF NOT EXISTS` cho `jobs(status)`, `jobs(created_at)`, `jobs(task_code)`, `steps(job_id)`, `questions(job_id)`.
  2. Cache `prepare` theo chuỗi SQL (`Map`), clear khi `initDb()` chạy lại.
  3. `/api/v1/jobs`: `SELECT` danh sách cột cần, thay `prompt` đầy đủ bằng **preview 200 ký tự** (`SUBSTR(prompt, 1, 200)`). Modal Sửa task chuyển sang đọc prompt đầy đủ từ `GET /api/v1/jobs/:id` (xem §2.3) — **bắt buộc**, nếu không sẽ hiển thị sai dữ liệu nghiệp vụ.
     - ⚠️ **Bắt buộc — computed alias `prompt_search`:** `app.js:965` và `app.js:1914` search bằng `(j.title || j.prompt_search || j.prompt || '')`. Nếu `prompt` chỉ còn 200 ký tự → search theo từ khóa **nằm sau ký tự 200 sẽ không ra kết quả** (prompt thật dài 10–14 KB) → **search sai**. → Trong câu lệnh query `db.listJobs()`, thêm `SUBSTR(prompt, 1, 1000) AS prompt_search` — là alias computed trực tiếp trong SQL, **không cần chạy migration**, không tốn dung lượng lưu trữ, và tránh drift dữ liệu khi `db.updateJob` được gọi.
     - *Nguồn: rà soát lần 2 (`review_round2.md` §1.4) — rủi ro HIGH nếu bỏ sót.*
  4. Bỏ `...fullJobData` ở top level (giữ `job: fullJobData`).
  5. **Nén response** — ưu tiên **`node:zlib` stdlib** (không thêm dependency): middleware `gzip` ~40 dòng, chỉ nén response JSON > 1 KB, **bỏ qua route SSE** (`/logs/stream` phải stream không nén).
     - *Phương án dự phòng:* thêm `compression` vào `dependencies` — **cần Gate 1 duyệt** theo `AGENTS.md` §11.2. Ưu tiên phương án stdlib để không phụ thuộc quyết định Gate 1.
- **Lý do:** giảm payload + tăng tốc query, đều đo được.
- **Rủi ro:** đổi shape payload `/api/v1/jobs` → **phải** cập nhật `public/app.js` cùng lúc (task T3.3 nắm cả 2).

### ADR-7: Ghi log qua **write stream**, không `appendFileSync`

- **Bằng chứng:** `src/server.js:67` `fs.appendFileSync(logFilePath, stamped, 'utf8')` mỗi log line. Đo: 0,25 ms/dòng trên file 25,8 MB — cộng dồn khi agent in nhiều log.
- **Quyết định:** giữ 1 `fs.createWriteStream` per `jobId` trong `JobEventBus` (lazy init), `write()` không chặn; đóng stream khi job kết thúc.
- **Lý do:** `appendFileSync` mở/đóng file descriptor mỗi lần → chặn event loop.
- **Rủi ro & xử lý:** offset phục vụ SSE reconnect được cập nhật liên tục qua counter byte của write stream (`stream.bytesWritten`); `fs.statSync` chỉ dùng khi khởi tạo hoặc phát hiện truncate (`size < offset` → reset 0), tránh đọc kích thước file trên đĩa khi dữ liệu còn nằm trong buffer I/O userspace.

---

## 2. Thiết kế chi tiết

### 2.1 G0 — `BaseAdapter` (cache TTL + `spawn` async) + `runnerRegistry` + `server.js`

**File:** `src/runners/baseAdapter.js` (dòng 25–70 — **ranh giới cache**), `src/runners/runnerRegistry.js` (dòng 71–87, 142–175), `src/server.js` (dòng 546, 718), `src/config.js` (`DETECT_TTL_MS`)

```js
// baseAdapter.detect() — giữ API sync, nhưng nguồn dữ liệu là cache
detect() {
  const cached = this._detectCache;
  if (cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.value;
  // cache miss: ghi nhận trạng thái "đang xác minh" và trả giá trị cache cũ (nếu có)
  this._scheduleDetectRefresh();          // fire-and-forget, async
  return cached ? cached.value : { installed: false, version: null, path: null };
}
```

- `DETECT_TTL_MS` = 60.000 (thêm vào `src/config.js`).
- `_scheduleDetectRefresh()` chạy `spawn` **async** (`child_process.spawn` + Promise), cập nhật cache khi xong. **Không** chặn.
- `runnerRegistry.detectAll()` gọi `runner.detect()` (nay đã cache-first) → tổng ~0 ms sau lần đầu.
- `/api/v1/status` + `/api/v1/health`: thay `runnerRegistry.detectAll()` bằng `runnerRegistry.listRunners()` (chỉ `name`, `command`, `aliases`, `enabled` — **không** có `installed`/`version`/`path`).
  - **Kiểm tra tương thích:** `public/app.js` có dùng `runners[].installed` từ `/status` không? → grep `\.installed` trong `public/`. Nếu có → giữ `installed` nhưng đọc từ cache (vẫn nhanh sau lần đầu).

### 2.2 G1 — SSE log

**File:** `src/server.js` (route `/api/v1/jobs/:id/logs/stream`), `public/app.js` (`connectLogStream`, `scheduleTerminalWrite`)

```
Client                          Server
  |                                |
  |-- GET .../logs/stream --------->|  đọc header: Last-Event-ID hoặc ?from=<offset>
  |                                |  offset = parseInt(lastEventId) || 0
  |                                |  nếu fileSize < offset → offset = 0 (file bị truncate)
  |                                |  đọc async tối đa 256 KB từ offset (tail)
  |<-- event: log (≤256KB) --------|  kèm event id = byte offset mới
  |                                |
  |  ... log mới đến ...            |  emitJobLog → ghi stream + phát SSE
  |                                |
  |<-- event: log (chunk mới) -----|  id = byte offset sau khi ghi
  |                                |
  |-- reconnect, Last-Event-ID: N ->|  đọc từ N, KHÔNG gửi lại log cũ
```

- Thêm endpoint lịch sử: `GET /api/v1/jobs/:id/logs?offset=&limit=` → trả `{text, nextOffset, totalSize}`.
- Client: giữ buffer log tối đa N dòng (hiện `scrollback: 10000` ở `public/app.js:316` — giữ nguyên).
- **Phải giữ:** `public/app.js:728-748` handler `event: log` — bổ sung đọc `event.lastEventId` để lưu offset.
- **Phải giữ:** mọi log mới vẫn hiển thị realtime (độ trễ < 2 s).

### 2.3 Kiểm chứng mức độ khả dụng của `prompt` và `runners` (đã grep `public/`)

**`job.prompt` — KHÔNG bỏ được, nhưng có thể cắt an toàn:**

| Vị trí | Cách dùng | Cần prompt đầy đủ? |
|---|---|---|
| `public/app.js:965` | search: `j.title \|\| j.prompt_search \|\| j.prompt` | ⚠️ Cần `prompt_search` (tối đa 1.000 ký tự) |
| `public/app.js:987` | title card: `job.title \|\| job.prompt` | ❌ chỉ cần **preview 200 ký tự** |
| `public/app.js:1122` | title header: `job.title \|\| job.prompt` | ❌ chỉ cần **preview 200 ký tự** |
| `public/app.js:1914` | đếm badge search: `j.title \|\| j.prompt_search \|\| j.prompt` | ⚠️ Cần `prompt_search` (tối đa 1.000 ký tự) |
| `public/app.js:3691` | **modal Sửa task**: `promptInput.value = job.prompt` | ✅ **CẦN ĐẦY ĐỦ** |

→ Quyết định (thay cho ý "bỏ `prompt`" ở ADR-6): list payload trả `prompt` dạng **preview 200 ký tự** (`SUBSTR(prompt, 1, 200)`) và alias computed `SUBSTR(prompt, 1, 1000) AS prompt_search` (không cần migration DB, không lo drift khi update prompt); modal Sửa task dùng **endpoint chi tiết** (`GET /api/v1/jobs/:id` đã trả `prompt` đầy đủ).
→ **Bắt buộc:** sửa `public/app.js:3691` để **fetch** job chi tiết trước khi mở modal — nếu không, ô "Prompt" sẽ hiển thị prompt bị cắt → **sai dữ liệu nghiệp vụ** (rủi ro HIGH).

**`runners[].installed` — UI KHÔNG dùng:**
grep `public/` cho `/api/v1/runners`, `/api/v1/health`, `data.runners` → **0 kết quả**. UI chỉ gọi `/api/v1/status` (`public/app.js:674`) và **không** đọc trường `runners` từ response.
→ Vì vậy `/api/v1/status` có thể **bỏ hẳn** trường `runners` mà **không phá UI**. Tuy nhiên giữ lại ở dạng rút gọn (`name` + `enabled`) để không phá vỡ API contract cho công cụ khác — xác nhận với user ở Gate 1.
### 2.4 G2 — Frontend

**File:** `public/app.js`, `public/index.html`, `public/style.css`

| Thay đổi | Vị trí | Ghi chú |
|---|---|---|
| Render list tăng dần | `public/app.js:937-1046` | Viết lại `renderJobsList`; giữ nguyên filter + signature |
| Event delegation | `public/app.js:1037-1044` | 1 listener trên container, đăng ký **1 lần** ở `initEventListeners()` |
| Bỏ `force=true` | `public/app.js:821` | Signature đã chứa `systemone_state.updatedAt` |
| Cache plan | `public/app.js:3556` | `{jobId → {hash, devHtml, testHtml}}` + cache promise |
| Bỏ parse trùng | `public/app.js:1462-1483` | `renderDualPlan` dùng cache đã parse |
| `AbortController` | `public/app.js:609, 631, 653, 673, 3565` | Mọi fetch; poll cũ bị abort |
| Debounce search | `public/app.js:380-383` | 200 ms |
| Bỏ `diff2html` | `public/index.html:55-56` | Không dùng |
| Tailwind build sẵn | `public/index.html:9` | → `public/tailwind.css` |
| Bỏ `drop-shadow` animation | `public/style.css:824-825` | Repaint SVG 60 fps |
| `contain-intrinsic-size` | `public/style.css:851-853` | Hết layout shift khi list render lại |

### 2.5 G3 — Backend

**File:** `src/storage/db.js`, `src/server.js`, `package.json`

```sql
CREATE INDEX IF NOT EXISTS idx_jobs_status       ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at    ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_task_code    ON jobs(task_code);
CREATE INDEX IF NOT EXISTS idx_steps_job_id      ON steps(job_id);
CREATE INDEX IF NOT EXISTS idx_questions_job_id  ON questions(job_id);
```

- Đặt trong `initDb()` sau khi tạo bảng → chạy 1 lần, idempotent.
- `prepare` cache: `const stmtCache = new Map();` + `getStmt(sql)`; clear trong `initDb()`.
- **Nén response:** `node:zlib` stdlib (middleware ~40 dòng), **KHÔNG** thêm dependency. Bỏ qua route SSE.

### 2.6 G4 — Ghi log

**File:** `src/server.js` (`JobEventBus.emitJobLog`)

- `JobEventBus` giữ `Map<jobId, fs.WriteStream>`; lazy tạo khi có log đầu tiên.
- `write(stamped)` thay `appendFileSync`.
- `end()` stream khi job vào trạng thái terminal (`DONE`/`FAILED`/`CANCELLED`/`TIMED_OUT`/`DELETED`). Đồng thời dừng `stopEvidenceWatcher` và đóng `stepTimeline`.
- Offset: duy trì qua counter byte tích luỹ từ write stream (`stream.bytesWritten`), **không** gọi `statSync` liên tục sau mỗi chunk để tránh lệch do buffering.

---

## 3. Ma trận truy vết (UC → thay đổi → task)

| UC | Thay đổi | File:line | Task |
|---|---|---|---|
| UC-1 | detect cache + async + `/status` không detect | `baseAdapter.js:25-70`, `runnerRegistry.js:71-87`, `server.js:546,718` | T0.1–T0.3 |
| UC-2 | SSE offset + giới hạn 256 KB + đọc async | `server.js:4310-4325`, `app.js:696-748` | T1.1–T1.4 |
| UC-3 | render tăng dần + delegation | `app.js:937-1046, 1037` | T2.1–T2.2 |
| UC-4 | cache plan + AbortController | `app.js:1244, 3556, 609-673` | T2.3–T2.5 |
| UC-5 | bỏ diff2html + Tailwind build + FCP | `index.html:9, 55-56` | T2.6–T2.7 |
| UC-6 | index + prepare cache + payload + gzip | `db.js:34-197, 355`, `server.js:1224, 1453` | T3.1–T3.5 |
| UC-7 | write stream log | `server.js:67` | T4.1–T4.2 |

**Đảm bảo truy vết ngược:** mỗi dòng diff khi implement **phải** trỏ về 1 task trong `tasks.md` và 1 UC trong `expect.md`.

---

## 4. Rủi ro kỹ thuật + biện pháp

| Rủi ro | Mức | Biện pháp |
|---|---|---|
| Render tăng dần sai logic filter → hiển thị sai trạng thái | **HIGH** | Task T2.1 yêu cầu test 3 trạng thái + so sánh DOM cũ/mới; giữ nguyên `renderJobsList` cũ trong 1 nhánh để đối chiếu |
| Bỏ `prompt` khỏi list payload làm UI lỗi | MEDIUM | Task T3.3: grep `job.prompt` trước; nếu dùng → `SUBSTR(prompt,1,200)` + endpoint chi tiết |
| Tailwind build bỏ sót class động | MEDIUM | Task T2.7: safelist + grep `className`/`classList` trong `public/*.js` |
| Offset lệch khi log bị truncate | MEDIUM | Task T1.2: detect `size < offset` → reset 0 |
| `prepare` cache giữ statement cũ sau `ALTER TABLE` | LOW | Clear cache trong `initDb()` sau migration |
| Stream log không flush trước khi đọc offset | LOW | T4.2: offset lấy từ write counter (`stream.bytesWritten`), `statSync` chỉ dùng phát hiện truncate |
| Rủi ro thêm dependency `compression` | LOW | Đã chốt: dùng `node:zlib` stdlib → **không** cần thêm dependency |
| Đo lại baseline bị nhiễu bởi thay đổi chưa xong | MEDIUM | Đo baseline **trước** mỗi nhóm; giữ 1 instance sạch để so sánh |

---

## 5. Kế hoạch kiểm thử

Chi tiết ở [`test_plan.md`](./test_plan.md) (tạo ở task T5). Tóm tắt:

| Nhóm | Kiểm thử | Công cụ |
|---|---|---|
| Hồi quy nghiệp vụ | `npm test` (278 assertions) không đổi | `node --test` |
| Hồi quy UI | 3 trạng thái job, filter, search, click đổi job | Browser + screenshot |
| Hiệu năng | A1–A9 (bảng `expect.md` §3) | Script đo trong `temp/` |
| SSE | reconnect không nhận lại log cũ; log mới vẫn realtime | Test script |
| Race | click nhanh 3 job → đúng job cuối | Test script |

> **Bắt buộc:** mọi script đo ghi file tạm vào `temp/`, **không** ghi vào `logs/` hay bất kỳ dữ liệu thật nào. Xem `PERF-ANALYSIS-01/report.md` §8.1.

---

## 6. Gate

- **Gate 1 — Plan review:** `dev_plan.md` này + `expect.md` + `tasks.md` + `review_round2.md` phải được duyệt **trước khi viết code**.
  - Cần user trả lời `expect.md` §6: Q1 (retention log), Q2 (Tailwind build), Q3 (runner stale), Q4 (có duyệt nhóm T2P UX/a11y không), Q5 (chốt `node:zlib` stdlib).
- **Gate 2 — Docs update:** không có thay đổi `docs/specs/` hay `docs/ARCHITECTURE.md` trong feature này (repo hiện **không có** `docs/specs/` và `docs/ARCHITECTURE.md` — xác nhận ở task T0.0).
- **Report:** `report.md` trong `docs/features/PERF-FIX-01/` — danh sách file đổi + số đo trước/sau.

---

## 7. Ước lượng & thứ tự

| Task | Nhóm | Ước lượng | Phụ thuộc |
|---|---|---|---|
| T0.0–T0.4 | G0 detect + chuẩn bị | 1,75 h | — |
| T1.1–T1.4 | G1 SSE | 6 h | T0.x (đo sạch) |
| T2.1–T2.7 | G2 Frontend | 8,5 h | T1.x |
| T3.1–T3.5 | G3 Backend | 5 h | T0.x |
| T4.1–T4.2 | G4 Log stream | 1 h | T1.1 (offset) |
| T5.x | Test + đo lại + report | 2 h | T0–T4 |
| | **Tổng** | **~24,25 h** | |

**Ước lượng là sơ bộ** — sẽ cập nhật sau mỗi task hoàn thành trong `tasks.md`.
