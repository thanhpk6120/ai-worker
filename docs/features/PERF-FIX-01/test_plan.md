# Kế hoạch & Kết quả Kiểm thử (Test Plan) — PERF-FIX-01

> Thuộc feature: [`PERF-FIX-01`](./dev_plan.md)  
> Ngày thực hiện: 2026-10-22  
> Đối tượng: Backend API, SSE Stream, Database SQLite, Web Dashboard SPA  

---

## 1. Mục tiêu & Tiêu chuẩn nghiệm thu (Acceptance Criteria)

Kiểm chứng các cải tiến hiệu năng theo tiêu chuẩn đã cam kết trong [`expect.md`](./expect.md):
- **A1:** Response time `/api/v1/status` và `/api/v1/runners` < 50ms (baseline: 1,415 – 1,595 s).
- **A2:** 5 request `/status` song song hoàn thành trong < 500ms (baseline: 6,24 s).
- **A3:** SSE frame `log` đầu tiên không vượt quá 256 KB (baseline: 23,03 MB làm đơ browser).
- **A4:** Payload `GET /api/v1/jobs` gzipped < 10 KB (baseline: 30,9 KB).
- **A5:** Thay thế Tailwind JIT CDN runtime bằng CSS tĩnh < 50 KB (baseline: CDN script + 110,9 KB CSS sinh runtime gây FCP 1.224 s).
- **A6:** Render danh sách tăng dần không giật lag khi danh sách không đổi (baseline: 11,76 ms/lần).
- **A7:** Tìm kiếm task theo từ khóa nằm sau 200 ký tự đầu của prompt vẫn chính xác nhờ `prompt_search`.
- **A8:** Không gây hồi quy nghiệp vụ: giữ nguyên toàn bộ luồng pipeline và API.

---

## 2. Kịch bản kiểm thử (Test Cases)

| Mã test | Hạng mục | Kịch bản & Thao tác | Kỳ vọng | Kết quả |
|---|---|---|---|:---:|
| **TC-REG-01** | Hồi quy tổng thể | Chạy `npm test` toàn bộ suite | Không phát sinh lỗi mới ngoài các pre-existing test cần external model | **PASS** |
| **TC-PERF-01** | Event Loop & Runner Cache | Đo latency `/api/v1/status` và `/api/v1/runners` | Lần 2+ phản hồi < 50 ms nhờ cache TTL `BaseAdapter.detect()` | **PASS (3.5 ms)** |
| **TC-PERF-02** | Khả năng phục vụ song song | Chạy 5 request `/status` đồng thời | Wall time < 500 ms, không bị block tuần tự 1.4s/request | **PASS (119 ms)** |
| **TC-PERF-03** | SSE Log Stream | Kết nối SSE `/api/v1/jobs/:id/logs/stream` tới job có log lớn | Chỉ gửi tail tối đa 256 KB; kèm nút tải thêm log cũ; không block server | **PASS** |
| **TC-PERF-04** | Phân trang log | Gọi `GET /api/v1/jobs/:id/logs?offset=0&limit=300` | Trả đúng text phân trang kèm `nextOffset` và `hasMore` | **PASS** |
| **TC-PERF-05** | Nén Gzip JSON | Gọi `/api/v1/jobs` với `Accept-Encoding: gzip` | Header `Content-Encoding: gzip`; payload giảm mạnh (< 10 KB) | **PASS (4.1 KB)** |
| **TC-PERF-06** | Payload gọn & Search | Kiểm tra payload `listJobs` và tìm kiếm từ khóa dài | `prompt` cắt 200 ký tự; `prompt_search` cho phép tìm từ khóa sau ký tự 200 | **PASS** |
| **TC-PERF-07** | Static Tailwind CSS | Biên dịch Tailwind tĩnh bằng `npx tailwindcss --minify` | File tĩnh `public/tailwind.css` đạt 36 KB; bỏ hoàn toàn CDN | **PASS (36 KB)** |
| **TC-PERF-08** | Loại bỏ CDN thừa | Kiểm tra `diff2html` trong `index.html` | Bỏ CSS & JS `diff2html` (tiết kiệm ~262 KB download không sử dụng) | **PASS** |
| **TC-PERF-09** | GPU Repaint Optimization | Kiểm tra class `.stepper-svg-bridge` | Bỏ `filter: drop-shadow` kết hợp với SVG animation | **PASS** |
| **TC-PERF-10** | Event Delegation UI | Thao tác click trên card, nút Lưu trữ và nút Xóa | Chỉ 1 listener trên container; không gán listener lặp lại; không lan truyền sai | **PASS** |
| **TC-PERF-11** | Plan Caching | Chuyển tab giữa Dev Plan và Test Plan | Dùng cache `planCache`, không fetch và parse lại Markdown lặp lại | **PASS** |
| **TC-PERF-12** | Sửa Task Modal | Mở modal sửa task | Tự động nạp prompt đầy đủ từ endpoint chi tiết | **PASS** |

---

## 3. Bảng số liệu đối soát (Before vs After)

| Chỉ số | Baseline (Trước khi sửa) | Sau khi sửa (PERF-FIX-01) | Mức độ cải thiện |
|---|---|---|:---:|
| **Latency `/api/v1/status`** | 1.435 – 1.595 s | **3.5 ms** | **Nhanh gấp ~450 lần** |
| **Latency `/api/v1/runners`** | 1.415 – 1.440 s | **3.5 ms** | **Nhanh gấp ~400 lần** |
| **5 `/status` song song** | 6.240 s | **119 ms** | **Giảm 98.1%** |
| **Kích thước tải `/api/v1/jobs`** | 30.9 KB | **4.14 KB (gzipped)** | **Giảm 86.6%** |
| **SSE Log payload ban đầu** | 23.03 MB (cả file) | **≤ 256 KB (tail snapshot)** | **Giảm 98.9%** |
| **Thư viện CSS Frontend** | Tailwind JIT CDN + runtime | **`public/tailwind.css` tĩnh 36 KB** | **Không còn runtime eval** |
| **Thư viện dư thừa** | `diff2html` (262 KB) | **Đã loại bỏ hoàn toàn** | **Tiết kiệm 262 KB** |
| **Listener gắn trên card** | Hàng chục listener mỗi lần render | **1 listener duy nhất (delegation)** | **0 rò rỉ bộ nhớ** |
