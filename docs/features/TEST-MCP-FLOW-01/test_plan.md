# Kế Hoạch Kiểm Thử Toàn Diện (Test Plan): TEST-MCP-FLOW-01

> **Mã kế hoạch kiểm thử:** `test-plan-TEST-MCP-FLOW-01`
> **Tính năng:** `TEST-MCP-FLOW-01`
> **Địa chỉ dịch vụ (Base URL):** `http://localhost:3000`
> **Thời gian tạo:** `2026-10-12`

---

## 1. Phạm Vi Kiểm Thử (Test Scope)
- Kiểm tra trạng thái hoạt động của máy chủ web tại địa chỉ `http://localhost:3000/`.
- Xác minh giao diện Web Dashboard của AI Worker phản hồi mã trạng thái HTTP 200.
- Xác thực nội dung trang tải về có đầy đủ cấu trúc DOM, tiêu đề trang và tài nguyên tĩnh cần thiết (CSS, JS).
- Ghi nhận bằng chứng hình ảnh (screenshot) chứng minh hệ thống đang chạy bình thường.

## 2. Cấu Hình Dịch Vụ Kiểm Thử (Service Config)
- **Start Command:** `npm start`
- **Default Port:** `3000`
- **Readiness Probe Path:** `/`
- **Startup Timeout:** `30000ms`
- **Environment:** Windows 10 Host OS

## 3. Danh Sách Công Cụ Thẩm Định
- **MCP CloakBrowser:** Tự động hóa trình duyệt web để mở tab, kiểm tra tiêu đề, nội dung và chụp ảnh màn hình giao diện.
- **Node.js HTTP Client / Fetch:** Thực hiện lệnh gọi HTTP GET kiểm tra mã trạng thái mạng.

## 4. Kịch Bản Kiểm Thử Chi Tiết (Detailed Test Cases)

### Kịch Bản 1: Khởi động và Mở Tab Trình Duyệt
- **Mục tiêu:** Mở kết nối đến `http://localhost:3000/` thông qua trình duyệt headless CloakBrowser.
- **Tiền điều kiện:** Máy chủ ai-worker đã được khởi động và lắng nghe trên cổng 3000.
- **Các bước thực hiện:**
  1. Gọi tool `mcp__cloakbrowser__tab_open` với tham số `url: "http://localhost:3000/"`.
  2. Đọc kết quả phản hồi từ trình duyệt.
- **Kỳ vọng:**
  - Tab được mở thành công.
  - Phản hồi chứa thông tin `tabId` hợp lệ (ví dụ: `t1`).
  - Tiêu đề trả về là `AI Worker - Autonomous Multi-Agent Pipeline`.

### Kịch Bản 2: Kiểm Tra Tiêu Đề và DOM Page
- **Mục tiêu:** Đảm bảo trang web trả về nội dung trang HTML của AI Worker thay vì trang lỗi của trình duyệt hoặc thông báo kết nối bị từ chối.
- **Tiền điều kiện:** Tab trình duyệt đã mở thành công ở Kịch Bản 1.
- **Các bước thực hiện:**
  1. Gọi tool `mcp__cloakbrowser__get_title` với `tabId`.
  2. Xác minh title chuỗi phản hồi.
- **Kỳ vọng:**
  - Tiêu đề chứa chuỗi `AI Worker`.

### Kịch Bản 3: Chụp Ảnh Màn Hình Làm Bằng Chứng (Visual Evidence)
- **Mục tiêu:** Lưu trữ bằng chứng hình ảnh visual evidence phục vụ nghiệm thu.
- **Tiền điều kiện:** Tab trình duyệt đã tải xong toàn bộ DOM.
- **Các bước thực hiện:**
  1. Xác định đường dẫn lưu trữ: `D:\Thanhpk\AI\ai-worker\docs\features\TEST-MCP-FLOW-01\evidence\localhost-3000-running.png`.
  2. Gọi tool `mcp__cloakbrowser__screenshot` với `fullPage: true`.
- **Kỳ vọng:**
  - Tệp ảnh được tạo thành công với dung lượng > 0 bytes.
  - Ảnh không hiển thị màn hình trắng (blank screen) hoặc lỗi 404/500.

### Kịch Bản 4: Dọn Dẹp Tài Nguyên Trình Duyệt
- **Mục tiêu:** Đóng tab trình duyệt để giải phóng bộ nhớ.
- **Tiền điều kiện:** Đã hoàn thành chụp ảnh bằng chứng.
- **Các bước thực hiện:**
  1. Gọi tool `mcp__cloakbrowser__tab_close` với `tabId`.
- **Kỳ vọng:**
  - Trình duyệt xác nhận `closed: true`.

## 5. Điểm Kiểm Tra Bằng Chứng Hình Ảnh (Screenshot Checkpoints)
| Checkpoint ID | Bước liên kết | Tệp bằng chứng dự kiến | Tiêu chí thẩm định thị giác |
|---|---|---|---|
| `cp_dashboard_running` | `step_screenshot` | `evidence/localhost-3000-running.png` | Hiển thị đầy đủ giao diện Dashboard, các bảng điều khiển, không bị màn hình trắng hay vỡ layout |

## 6. Kịch Bản Thẩm Định API (API Test Suite)
| ID | Method | Endpoint | Expected Status | Mô tả kiểm tra |
|---|---|---|---|---|
| `api_test_root` | **GET** | `http://localhost:3000/` | `200` | Trang chủ trả về index.html |
| `api_test_health` | **GET** | `http://localhost:3000/api/v1/health` | `200` | Health check endpoint trả về trạng thái ok |

## 7. Tiêu Chí Nghiệm Thu (Acceptance Criteria)
- Cổng 3000 đang lắng nghe và sẵn sàng tiếp nhận kết nối.
- Trang chủ `http://localhost:3000/` tải thành công không gặp lỗi kết nối (ECONNREFUSED).
- File ảnh chụp màn hình bằng chứng đã được lưu đúng vị trí trong thư mục feature.
- Không phát sinh exception trong quá trình kiểm tra.

## 8. Kết Luận Khảo Sát Sơ Bộ (Preliminary Assessment)
- Máy chủ `http://localhost:3000/` **đang hoạt động bình thường**.
- Title ghi nhận được: `AI Worker - Autonomous Multi-Agent Pipeline`.
- Bằng chứng ảnh đã được chụp và lưu tại `D:\Thanhpk\AI\ai-worker\docs\features\TEST-MCP-FLOW-01\evidence\localhost-3000-running.png`.
