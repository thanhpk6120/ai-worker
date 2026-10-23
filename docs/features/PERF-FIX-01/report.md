---
feature: PERF-FIX-01
service: ai-worker
status: done
owner: AI
updated_at: 2026-10-22
---

# Báo cáo Triển khai (report.md) — PERF-FIX-01: Tối ưu Toàn diện Hiệu năng Web Dashboard & Subprocess Pipeline

## 1. Tóm tắt kết quả (Executive Summary)

Đã hoàn thành triển khai toàn bộ các giải pháp tối ưu hiệu năng theo kế hoạch [`dev_plan.md`](./dev_plan.md), giải quyết triệt để hiện tượng đơ, chậm, lag của Dashboard Web và tắc nghẽn Event Loop trong máy chủ Node.js:
1. **Khử tắc nghẽn Event Loop (G0):** Thêm cơ chế cache TTL 60s cho `BaseAdapter.detect()` và chuyển sang `spawn` nền bất đồng bộ. Latency của `/api/v1/status` và `/api/v1/runners` giảm từ ~1.5s xuống còn **3.5 ms** (nhanh gấp hơn 400 lần).
2. **Loại bỏ tái phát lại toàn bộ log 23 MB (G1, G4):** Chuyển việc ghi log sang Node.js WriteStream với bộ đếm byte offset tích luỹ (`stream.bytesWritten`). Endpoint SSE `/api/v1/jobs/:id/logs/stream` chỉ gửi tail snapshot tối đa 256 KB kèm theo nút tải thêm lịch sử log cũ qua endpoint phân trang `GET /api/v1/jobs/:id/logs?offset=&limit=`.
3. **Tối ưu Web UI & Static CSS (G2):**
   - Loại bỏ hoàn toàn runtime CDN Tailwind JIT script (trước đây sinh 110.9 KB CSS và ép quét DOM runtime). Biên dịch thành file CSS tĩnh thu gọn `public/tailwind.css` chỉ **36 KB**.
   - Loại bỏ bundle `diff2html` không sử dụng (tiết kiệm **262 KB** tải về).
   - Chuyển việc render danh sách task từ `innerHTML` 100% sang render tăng dần (`jobCardMap`) và event delegation (1 listener duy nhất trên container).
   - Tối ưu Dual Plan markdown caching và debounce tìm kiếm 200ms.
   - Loại bỏ `filter: drop-shadow` trên SVG animation để triệt tiêu việc repaint liên tục 60fps khi idle.
4. **Tối ưu Cơ sở dữ liệu SQLite & Payload Mạng (G3):**
   - Đánh chỉ mục (`CREATE INDEX`) cho 5 cột thường xuyên lọc và sắp xếp: `status`, `created_at`, `task_code`, `steps(job_id)`, `questions(job_id)`.
   - Caching các Prepared Statement bằng `stmtCache` (Map).
   - Cắt ngắn `prompt` thành preview 200 ký tự trên API danh sách `/api/v1/jobs`, bổ sung alias computed `SUBSTR(prompt, 1, 1000) AS prompt_search` phục vụ tìm kiếm từ khóa dài.
   - Bỏ việc nhân đôi thuộc tính top-level `...fullJobData` trong `GET /api/v1/jobs/:id`.
   - Tích hợp middleware nén Gzip bằng thư viện chuẩn `node:zlib` (stdlib) cho phản hồi JSON > 1 KB, giúp payload `/api/v1/jobs` giảm từ 30.9 KB xuống còn **4.14 KB** (giảm 86.6%).
5. **Sửa lỗi chức năng & UX (T2P, T3P):**
   - Sửa lỗi `state.systemStatus.online = false` khi mất kết nối để giao diện hiển thị đúng "Server Offline".
   - Tự động ngắt kết nối stream và dọn dẹp `EvidenceWatcher` khi task bị xoá (`status === 'DELETED'`).
   - Đặt giới hạn `express.json` xuống 2 MB an toàn và kích hoạt checkpoint WAL định kỳ `PRAGMA wal_checkpoint(TRUNCATE)`.

---

## 2. Danh sách các file đã thay đổi (Files Modified)

| File | Nội dung thay đổi |
|---|---|
| `src/config.js` | Thêm hằng số cấu hình `DETECT_TTL_MS = 60000` |
| `src/runners/baseAdapter.js` | Bổ sung cache TTL cho `detect()`, hàm `_detectSync()` ban đầu và `_refreshDetectAsync()` chạy nền với `spawn` |
| `src/storage/db.js` | Thêm `CREATE INDEX` cho 5 trường, `stmtCache`, WAL checkpoint, và tối ưu `listJobs()` với preview + `prompt_search` |
| `src/server.js` | Tích hợp WriteStream cho `JobEventBus`, SSE tail 256KB, endpoint `GET /api/v1/jobs/:id/logs`, middleware gzip stdlib, hạ body limit 2MB |
| `public/index.html` | Bỏ Tailwind CDN và diff2html CDN, thay bằng `tailwind.css` tĩnh 36KB, thêm nút tải log cũ |
| `public/style.css` | Bỏ `filter: drop-shadow` trên `.stepper-svg-bridge`, thêm `contain-intrinsic-size` cho container danh sách |
| `public/app.js` | Thêm state tracking offset, debounce search 200ms, event delegation trên card, render tăng dần qua `jobCardMap`, cache dual plan |
| `tailwind.config.js` | Cấu hình theme, màu sắc và safelist classes động để build CSS tĩnh |
| `src/tailwind-input.css` | File CSS nguồn cho Tailwind CLI |
| `package.json` | Thêm `tailwindcss` vào `devDependencies` và script `build:css` |
| `docs/features/PERF-FIX-01/test_plan.md` | Tài liệu kịch bản kiểm thử và số liệu đối soát |
| `docs/features/PERF-FIX-01/report.md` | Báo cáo hoàn thành tính năng |

---

## 3. Bảng số liệu kiểm thử thực tế (Before vs After)

| Tiêu chí | Trước khi tối ưu (Baseline) | Sau khi tối ưu (Thực đo) | Đánh giá |
|---|---|---|:---:|
| **Latency `/api/v1/status`** | 1.435 – 1.595 s | **3.5 ms** | **VƯỢT TIÊU CHUẨN (< 50ms)** |
| **Latency `/api/v1/runners`** | 1.415 – 1.440 s | **3.5 ms** | **VƯỢT TIÊU CHUẨN (< 50ms)** |
| **5 `/status` song song** | 6.240 s | **119 ms** | **VƯỢT TIÊU CHUẨN (< 500ms)** |
| **Kích thước tải `/api/v1/jobs`** | 30.9 KB (37 jobs) | **4.14 KB (gzipped)** | **GIẢM 86.6%** |
| **SSE Log chunk ban đầu** | 23.03 MB (toàn bộ file) | **≤ 256 KB (tail snapshot)** | **GIẢM 98.9%** |
| **CSS Bundle Frontend** | Runtime CDN script + 110.9 KB CSS dynamic | **`public/tailwind.css` tĩnh 36 KB** | **TIẾT KIỆM BĂNG THÔNG** |
| **Thư viện dư thừa** | `diff2html` (262 KB) | **Đã gỡ bỏ** | **TIẾT KIỆM 262 KB** |
| **Listener DOM trên Card** | N listener tạo mới mỗi 8s poll | **1 listener duy nhất (delegation)** | **0 RÒ RỈ LISTENER** |
| **Regression Unit Tests** | 77 test passed | **77 test passed (0 fail)** | **KHÔNG HỒI QUY** |

---

## 4. Kết luận

Toàn bộ các mục tiêu tối ưu hiệu năng của `PERF-FIX-01` đã được hoàn thành, kiểm tra và xác minh trên môi trường thực tế. Hệ thống vận hành nhanh, nhẹ, không còn hiện tượng treo đơ hoặc tải chậm.
