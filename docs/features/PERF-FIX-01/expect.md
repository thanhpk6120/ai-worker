---
feature: PERF-FIX-01
service: ai-worker
status: plan-review
owner: BA / User
updated_at: 2026-10-22
---

# PERF-FIX-01 — Expect (Kỳ vọng nghiệp vụ)

> Bản phân tích hiệu năng đầy đủ: [`docs/features/PERF-ANALYSIS-01/report.md`](../PERF-ANALYSIS-01/report.md).
> Feature này **thực thi** các hạng mục P0–P3 đã đề xuất trong báo cáo đó. Không thay đổi ngôn ngữ runtime.

---

## 0. Bối cảnh

Dashboard `ai-worker` bị user đánh giá **"rất đơ, chậm, lag"**. Đã đo trên instance đang chạy (commit `acd6af8`):

| Hiện tượng đo được | Số liệu |
|---|---|
| `GET /api/v1/status` | **1,435 – 1,595 s** |
| `GET /api/v1/health` | **1,348 – 1,435 s** |
| `GET /api/v1/runners` | **1,415 – 1,440 s** |
| 5 request `/status` song song | wall **6,24 s** (xếp hàng tuần tự → blocking event loop) |
| First Contentful Paint | **1.224 s** (server chỉ cần 120 ms trả HTML) |
| Mở job có log 25,8 MB | **2 long task 393 ms + 545 ms**, xử lý text 843 ms → **UI đứng ~1,9 s** |
| Server CPU (30 s idle) | 0,02 s = **0,1% 1 core** → **không phải quá tải** |

**Kết luận chẩn đoán:** không phải tải quá năng lực, mà là **3 quyết định kiến trúc sai**:
1. Chặn event loop bằng `spawnSync` trong request handler.
2. Gửi lại toàn bộ file log (23,03 MB) trong 1 event SSE.
3. Frontend dựng lại toàn bộ DOM + re-fetch/re-parse nội dung không đổi.

**Đã loại trừ:** đổi ngôn ngữ runtime. Benchmark cùng máy cho thấy Python nhanh hơn ở bản blocking (1.109 vs 1.392 ms) nhưng ngang bằng khi dùng async (336 vs 365 ms), và chậm hơn ở SQLite (0,55 vs 0,49 ms/lần). Vấn đề là *blocking*, không phải ngôn ngữ. Port 64 file / ~28.000 dòng tốn 15–25 ngày công mà **không mang lại lợi ích hiệu năng đo được**.

---

## 1. Actors

| Actor | Mô tả | Nhu cầu |
|---|---|---|
| **DEV / Operator** | Người vận hành ai-worker, mở dashboard theo dõi job | Thao tác (click, chuyển tab, mở job) **phải phản hồi tức thì**, không đứng 1–2 s |
| **Job Runner** | Tiến trình agent CLI chạy nền | Không bị gián đoạn bởi request HTTP của UI |
| **Hệ thống** | Node.js single server, Express 5, SQLite | Event loop không bị chặn > 100 ms bởi request thường lệ |

---

## 2. Use cases

### UC-1 — Lấy trạng thái hệ thống phải nhanh

- **Trigger:** UI poll `/api/v1/status` mỗi 15 s (`public/app.js:73-75`); user mở trang Runner.
- **Hiện tại:** `handleHealthCheck` → `runnerRegistry.detectAll()` → **10 `spawnSync` blocking** (`src/runners/baseAdapter.js:29,45` × 5 runner).
- **Kỳ vọng:** `GET /api/v1/status` và `/api/v1/health` trả về **< 50 ms**; **không** spawn tiến trình con trong request handler.
- **Tiêu chí nghiệm thu:**
  - `/api/v1/status` p95 < 50 ms trong 30 lần gọi liên tiếp.
  - Đo được bằng: 30 request `/status` song song → **tất cả** < 50 ms, tổng wall < 200 ms (hiện: 6,2 s).
  - `/api/v1/runners` vẫn trả đủ `installed` / `version` / `path` (không mất tính năng).
  - CPU server trong 60 s idle vẫn < 5% 1 core.

### UC-2 — Mở job có log lớn không được đứng UI

- **Trigger:** user click 1 job đã chạy lâu (log 25,8 MB) → UI mở SSE `/api/v1/jobs/:id/logs/stream`.
- **Hiện tại:** server `readFileSync` toàn bộ file (178 ms block) → 1 event chứa **23,03 MB** → browser xử lý 843 ms text + 163 ms `JSON.stringify` → **2 long task 393 + 545 ms**.
- **Kỳ vọng:** mở job **không** gây long task > 200 ms; không gửi lại toàn bộ lịch sử log.
- **Tiêu chí nghiệm thu:**
  - SSE frame `log` đầu tiên **< 256 KB**.
  - Không có long task > 200 ms khi mở job có log ≥ 25 MB.
  - Server **không** block event loop > 50 ms khi client kết nối SSE.
  - Log mới vẫn hiển thị **realtime** (độ trễ < 2 s) — không được hy sinh tính năng này.
  - Khi client reconnect, **không** nhận lại log cũ đã xem (có `Last-Event-ID` hoặc tương đương).

### UC-3 — Danh sách job không được dựng lại vô ích

- **Trigger:** poll `/api/v1/jobs` mỗi 8 s; SSE `status` / `systemone` event.
- **Hiện tại:** `container.innerHTML = ...` thay 100% list (`public/app.js:984`) + gán lại listener cho từng card (`public/app.js:1037`).
- **Kỳ vọng:** render **tăng dần**; chỉ node thực sự đổi mới được cập nhật.
- **Tiêu chí nghiệm thu:**
  - Chi phí 1 lần cập nhật danh sách ≤ 1 ms khi **không** job nào đổi (hiện 11,76 ms).
  - Số listener gán mới mỗi lần render = **0** (dùng event delegation, 1 listener trên container).
  - Không còn `container.innerHTML =` trong đường render danh sách.

### UC-4 — Không re-fetch / re-parse nội dung không đổi

- **Trigger:** mỗi SSE `status` / `systemone` event → `renderActiveJobDetail()` → `loadPlanFiles(job.id)` (`public/app.js:1244`).
- **Hiện tại:** mỗi lần gọi 1–2 HTTP request (`/api/v1/tasks/{id}/plan-files` + fallback) + 4 lần `marked.parse` cho **cùng nội dung plan không đổi**.
- **Kỳ vọng:** nội dung plan chỉ được fetch/parse **1 lần** cho mỗi (jobId, hash nội dung).
- **Tiêu chí nghiệm thu:**
  - Đếm request HTTP trong 60 s khi 1 job đang chạy: **giảm ≥ 50%** so với baseline (baseline đo được ở `expect.md` §5).
  - Không có `fetch` nào trong `public/app.js` thiếu `AbortController` → **0 race**.
  - Click nhanh 3 job liên tiếp → hiển thị đúng job cuối cùng, không bị response cũ ghi đè.

### UC-5 — Tải trang phải nhanh

- **Trigger:** user mở dashboard lần đầu.
- **Hiện tại:** FCP **1.224 s**; Tailwind Play CDN (`public/index.html:9`) biên dịch CSS runtime + `MutationObserver` quét DOM; `diff2html` (262 KB) tải về **nhưng không dùng**.
- **Kỳ vọng:** FCP < 600 ms; không tải tài nguyên không dùng.
- **Tiêu chí nghiệm thu:**
  - FCP < 600 ms (đo lại trên cùng máy).
  - Network transfer giảm ≥ 200 KB (gỡ `diff2html`).
  - Không còn runtime CSS compiler phía client (Tailwind build sẵn ra file `.css` tĩnh).
  - `public/index.html` không còn thẻ `<script src="https://cdn.tailwindcss.com">`.

### UC-6 — Backend không phình payload / query

- **Trigger:** mọi request.
- **Hiện tại:** `SELECT *` kéo cột `prompt` (10–14 KB/job); payload job detail **nhân bản 2×** (`job: fullJobData, ...fullJobData` — `src/server.js:1448-1452`); **không có** `CREATE INDEX` trên 7 bảng; `db.prepare()` không cache; **không có** `compression`.
- **Kỳ vọng:** payload nhỏ hơn, DB có index, response được nén.
- **Tiêu chí nghiệm thu:**
  - `GET /api/v1/jobs` (37 job) payload **thô** **< 28 KB** (hiện 30,9 KB; bỏ `prompt` → 25,2 KB) và payload **gzipped** **< 10 KB** (dự kiến ~3–6 KB).
  - `GET /api/v1/jobs/:id` không còn trường trùng lặp ở top level.
  - Có `CREATE INDEX` cho `jobs(status)`, `jobs(created_at)`, `jobs(task_code)`, `steps(job_id)`.
  - Response > 1 KB được gzip (`Content-Encoding: gzip`).

### UC-7 — Ghi log không chặn event loop

- **Trigger:** agent CLI in log; `emitJobLog` ghi file (`src/server.js:66`).
- **Hiện tại:** `fs.appendFileSync` mỗi log line; đo 0,25 ms/dòng trên file 25,8 MB — cộng dồn khi log nhiều.
- **Kỳ vọng:** ghi log không block event loop.
- **Tiêu chí nghiệm thu:**
  - Dùng write stream/batch, không `appendFileSync` trong đường emit.
  - Độ trễ SSE nhận log realtime vẫn < 2 s (không hy sinh realtime).

---

## 3. Tiêu chí nghiệm thu tổng thể (Definition of Done)

| # | Tiêu chí | Đo bằng | Đạt |
|---|---|---|---|
| A1 | `/api/v1/status` | p95 < 50 ms, 30 lần gọi | ☐ |
| A2 | `/api/v1/health` | < 50 ms | ☐ |
| A3 | 5 request `/status` song song | wall < 200 ms | ☐ |
| A4 | FCP | < 600 ms | ☐ |
| A5 | SSE frame `log` đầu | < 256 KB | ☐ |
| A6 | Long task khi mở job log 25 MB | không có task > 200 ms | ☐ |
| A7 | Render danh sách khi không đổi | ≤ 1 ms/lần, 0 listener mới | ☐ |
| A8 | Request HTTP khi 1 job chạy (60 s) | giảm ≥ 50% | ☐ |
| A9 | `GET /api/v1/jobs` payload **thô** (37 job) | **< 28 KB** (hiện 30,9 KB; bỏ `prompt` → 25,2 KB) | ☐ |
| A9b | `GET /api/v1/jobs` payload **sau gzip** | **< 10 KB** (dự kiến ~3–6 KB — JSON lặp nhiều key nén rất tốt) | ☐ |
| A10 | Toàn bộ test hiện có | `npm test` pass, **không** làm đổi hành vi nghiệp vụ | ☐ |

**Ràng buộc tuyệt đối:** mọi thay đổi phải **giữ nguyên hành vi nghiệp vụ**. Cụ thể:
- Vòng đời job (`TO DO` → `PLANNING` → `IMPLEMENT` → `TESTING` → `VERIFY` → `FIXING` → `DONE`) không đổi.
- Multi-Verification Gate (4 kênh) không đổi logic pass/fail.
- SystemOne typed-decision không đổi schema.
- Evidence lifecycle (tạo/ghi/xoá/verdict) không đổi.
- Tất cả file `.md` tài liệu feature (`expect.md`, `dev_plan.md`, `tasks.md`, `test_plan.md`) **giữ nguyên** nội dung.

---

## 4. Ngoài phạm vi (Out of scope)

| Mục | Lý do |
|---|---|
| **Chuyển đổi ngôn ngữ runtime** (Python/Go/Rust) | Đo được: không mang lại lợi ích hiệu năng; chi phí 15–25 ngày công |
| Viết lại frontend bằng framework (React/Vue) | Không cần để đạt A1–A10; rủi ro cao hơn giá trị |
| Thay đổi UI/UX, bố cục, màu sắc | Feature này chỉ tối ưu hiệu năng, không đổi trải nghiệm |
| Đổi cơ chế Multi-Verification Gate | Nằm ngoài hot path đo được |
| Tối ưu `multiVerificationGate.js`, `browserRunner.js` | Chạy ngoài request path, không ảnh hưởng cảm nhận UI |
| **Thêm dependency runtime mới** vào `dependencies` | **Cấm.** Mọi fix phải dùng stdlib (`node:zlib`, `node:child_process`, `node:fs`) hoặc code sẵn có. `cors`/`express`/`tree-kill` giữ nguyên. **Ngoại lệ duy nhất: `compression`** — cần **Gate 1 duyệt** theo `AGENTS.md` §11.2; nếu không được duyệt → dùng `zlib` stdlib thủ công (~40 dòng). |
| **Thêm devDependency build-time** | **Được phép**: `tailwindcss` (devDependency, chỉ chạy lúc build CSS, không vào runtime bundle). Không ảnh hưởng dependency policy vì không ship. |
| Xoá log cũ / retention policy | Cần quyết định nghiệp vụ riêng (xem §6) |
| Xây dựng Kanban Board (theo AGENTS.md §7) | Ghi nhận lệch docs vs code; tách ticket tính năng riêng nếu cần |
| Phím tắt, command palette, chỉnh contrast màu | Không thuộc scope tối ưu hiệu năng; thuộc backlog UX |

---

## 5. Baseline đo trước khi sửa (bắt buộc chụp lại)

Các task trong `tasks.md` yêu cầu chụp baseline **trước** khi sửa, để chứng minh cải thiện. Giá trị dự kiến (từ `PERF-ANALYSIS-01/report.md`):

| Metric | Baseline |
|---|---|
| `/api/v1/status` | 1,435 – 1,595 s |
| `/api/v1/runners` | 1,415 – 1,440 s |
| 5 `/status` song song | wall 6,24 s |
| `/api/v1/jobs` payload | 30,9 KB |
| FCP | 1.224 s |
| SSE frame `log` lớn nhất | 23,03 MB |
| Long task khi mở job log lớn | 393 ms + 545 ms |
| Render list (7 job) + forced layout | 11,76 ms |
| Server CPU 30 s idle | 0,02 s |

> **Cảnh báo:** khi đo lại, **tuyệt đối không ghi vào file trong `logs/`** — dùng file tạm trong `temp/`. `logs/` bị `.gitignore` nên `git status` không phản ánh thay đổi ở đó (xem `PERF-ANALYSIS-01/report.md` §8.1).

> **Lưu ý về tên file:** báo cáo phân tích gốc nằm ở `docs/features/PERF-ANALYSIS-01/report.md`. Feature **này** (`PERF-FIX-01`) giữ `report.md` riêng cho **kết quả implement** theo `AGENTS.md` §8.1 (danh sách file thay đổi + kết quả kiểm thử). **Hai thư mục khác nhau** → không va chạm.

---

## 6. Câu hỏi còn mở (cần user quyết)

| # | Câu hỏi | Khuyến nghị | Tác động |
|---|---|---|---|
| Q1 | Log file nên giữ bao lâu? Hiện 60 file / ~58 MB, lớn nhất 25,8 MB | Retention 30 ngày + tự xoá job `DONE` > 30 ngày | Không ảnh hưởng UC-1..7, nhưng giảm rủi ro log phình |
| Q2 | Có chấp nhận build Tailwind offline (thêm 1 bước build vào quy trình) không? | **Có** — cần cho A4 | Nếu không, FCP khó đạt 600 ms |
| Q3 | `/api/v1/runners` có được phép trả `installed`/`version` bị **stale** (cache 60 s) không? | **Có** — runner CLI không đổi trong vài phút | Nếu không, `/runners` vẫn phải spawn → giữ 1,4 s |
| Q4 | Có đưa nhóm task sửa lỗi chức năng + UX/a11y (T2P.1–T2P.5, ~8,25 h) vào scope của PERF-FIX-01 không? | **Tách riêng hoặc gộp sau** | Nếu gộp: tăng thời gian từ 27 h lên 35,25 h; nhưng giải quyết trọn vẹn cảm giác "đơ, lag" và rào cản thao tác |
| Q5 | Có duyệt thêm dependency `compression` (nén gzip response) không? | **Dùng `node:zlib` stdlib** (không cần thêm dependency, tuân thủ AGENTS.md §11.2) | Nếu dùng npm package `compression`: code ngắn hơn 30 dòng nhưng phải xin phê duyệt ngoại lệ dependency policy |

---

## 7. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Đổi payload `/api/v1/jobs` (bỏ `prompt`) làm frontend lỗi | MEDIUM | Grep toàn `public/` dùng `job.prompt` trước khi bỏ; giữ `prompt` nếu UI cần |
| Tailwind build sẵn sinh CSS lớn hơn CDN runtime | LOW | Đo lại FCP + transfer sau khi build |
| `Last-Event-ID` client chưa hỗ trợ → log bị mất khi reconnect | MEDIUM | Task UC-2 có test reconnect bắt buộc |
| `db.prepare()` cache giữ statement cũ sau `ALTER TABLE` | LOW | Clear cache sau mỗi migration (`initDb`) |
| Tối ưu render làm sai hiển thị trạng thái job | HIGH | Giữ đúng logic filter/signature hiện tại; test UI 3 trạng thái |
