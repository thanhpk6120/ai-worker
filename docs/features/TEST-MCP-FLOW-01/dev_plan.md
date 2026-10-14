# Kế Hoạch Triển Khai Phát Triển (Dev Plan): TEST-MCP-FLOW-01

> **Tính năng:** `TEST-MCP-FLOW-01`
> **Tech Stack:** `Node.js 22 (CommonJS), Express, MCP CloakBrowser`

---

## 1. Yêu Cầu & Mục Tiêu Kỹ Thuật (Objective & Prompt)
kiểm tra http://localhost:3000/ xem hoạt động chưa. Mục tiêu là xác minh cổng 3000 đang lắng nghe và trả về nội dung của giao diện AI Worker Dashboard mà không gặp sự cố kết nối.

## 2. Tổng Quan Kiến Trúc (Architecture Overview)
Dự án sử dụng kiến trúc Single Server (Node.js/Express) phục vụ giao diện tĩnh và API từ cùng một cổng (3000). Yêu cầu này nhằm thẩm định health check và khả năng phân phối trang chủ (`public/index.html`) qua endpoint `/`. Công cụ thẩm định được sử dụng là MCP CloakBrowser, mô phỏng người dùng truy cập trực tiếp.

## 3. Phân Rã Module & Trách Nhiệm (Module Decomposition)
| Module | Trách nhiệm chính | Dependencies |
|---|---|---|
| `Express Server` | Lắng nghe cổng 3000, phục vụ static files từ `/public` | `express, src/server.js` |
| `MCP CloakBrowser` | Mở tab mới, chụp ảnh màn hình, kiểm tra HTML/Title | `mcp__cloakbrowser` |

## 4. Danh Sách Tệp Mã Nguồn Cần Tạo Mới (Files To Create)
- Không yêu cầu tạo tệp mã nguồn mới.

## 5. Danh Sách Tệp Mã Nguồn Cần Chỉnh Sửa (Files To Modify)
- Không yêu cầu chỉnh sửa mã nguồn hiện tại do tính chất task là thẩm định/kiểm tra.

## 6. Thiết Kế API Endpoints (API Specification)
Không thay đổi API. Dịch vụ cần phản hồi HTTP 200 OK tại:
- `GET http://localhost:3000/`

## 7. Trình Tự Triển Khai (Implementation Sequence)

### Bước 1: Khởi động CloakBrowser (Đã hoàn thành)
Sử dụng tool `mcp__cloakbrowser__tab_open` để truy cập vào `http://localhost:3000/`. Đã ghi nhận title phản hồi là "AI Worker - Autonomous Multi-Agent Pipeline".

### Bước 2: Chụp ảnh bằng chứng
Lưu lại ảnh màn hình thông qua `mcp__cloakbrowser__screenshot` vào đường dẫn `D:\Thanhpk\AI\ai-worker\docs\features\TEST-MCP-FLOW-01\evidence\localhost-3000-running.png`.

### Bước 3: Hoàn tất tài liệu và báo cáo
Ghi nhận kết quả vào kế hoạch và báo cáo kiểm thử.

## 8. Ràng Buộc Kỹ Thuật & Xử Lý Biên (Constraints & Edge Cases)
- Cần đảm bảo tab trình duyệt được dọn dẹp (đóng lại) sau khi hoàn tất để tiết kiệm tài nguyên bộ nhớ.
- Đảm bảo ghi bằng chứng (evidence) đúng vào thư mục feature.

## 9. Kế Hoạch Hoàn Tác & Rollback (Checkpoint & Rollback Plan)
- Vì đây là hành động read-only (kiểm tra trang web), không cần cơ chế rollback mã nguồn.
