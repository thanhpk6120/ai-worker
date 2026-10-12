# Kế Hoạch Kiểm Thử Toàn Diện (Test Plan): TEST-MCP-FLOW-01

> **Mã kế hoạch kiểm thử:** `test-plan-1791786323192`
> **Tính năng:** `TEST-MCP-FLOW-01`
> **Địa chỉ dịch vụ (Base URL):** `http://localhost:3000`
> **Thời gian tạo:** `2026-10-12T06:25:23.192Z`

---

## 1. Phạm Vi Kiểm Thử (Test Scope)
kiểm tra http://localhost:3000/ xem hoạt động chưa

## 2. Cấu Hình Dịch Vụ Kiểm Thử (Service Config)
- **Start Command:** `npm start`
- **Default Port:** `3000`
- **Readiness Probe Path:** `/`
- **Startup Timeout:** `30000ms`

## 3. Dữ Liệu Mẫu & Giả Lập (Mock Data Requirements)
| Thực thể | Mô tả dữ liệu | Cấu trúc JSON |
|---|---|---|
| `TEST-MCP-FLOW-01MockPayload` | Dữ liệu mẫu kiểm thử khởi tạo tính năng | `{   "testMode": true,   "timestamp": 1791786323193 }` |

## 4. Kịch Bản & Thao Tác UI Tự Động (Browser Test Steps)
| Thứ tự | ID Bước | Tên thao tác | Loại hành động | Selector / Tham số | Chụp màn hình |
|---|---|---|---|---|---|
| 1 | `step_nav_dashboard` | Điều hướng tới trang Dashboard | **navigate** | `http://localhost:3000/` | Có (`cp_initial_dashboard`) |
| 2 | `step_verify_title` | Chờ tiêu đề hiển thị | **wait_for_selector** | `h1, .header, #app` | Không |
| 3 | `step_interact_action` | Tương tác điều khiển giao diện | **click** | `button, .btn-primary, [data-action="test"]` | Có (`cp_after_action`) |

## 5. Điểm Kiểm Tra Bằng Chứng Hình Ảnh (Screenshot Checkpoints)
| Checkpoint ID | Bước liên kết | Tệp bằng chứng dự kiến | Tiêu chí thẩm định thị giác |
|---|---|---|---|
| `cp_initial_dashboard` | `step_nav_dashboard` | `01_dashboard_loaded.png` | Giao diện hiển thị đầy đủ thanh điều hướng, không xuất hiện thanh cuộn lỗi hay màn hình trắng |
| `cp_after_action` | `step_interact_action` | `02_action_executed.png` | Hiển thị kết quả tương tác hoặc thông báo trạng thái thành công, không có modal báo lỗi |

## 6. Kịch Bản Thẩm Định API (API Test Suite)
| ID | Method | Endpoint | Expected Status | Mô tả kiểm tra |
|---|---|---|---|---|
| `api_test_1` | **GET** | `/api/v1/test-mcp-flow-01/status` | `200` | Kiểm tra GET /api/v1/test-mcp-flow-01/status |
| `api_test_2` | **POST** | `/api/v1/test-mcp-flow-01/execute` | `201` | Kiểm tra POST /api/v1/test-mcp-flow-01/execute |

## 7. Truy Vấn Xác Thực Cơ Sở Dữ Liệu (Database Queries)
| Query ID | DB Type | Câu lệnh SQL | Kỳ vọng |
|---|---|---|---|
| `db_verify_01` | `sqlite` | `SELECT count(*) as count FROM sqlite_master WHERE type="table"` | `count >= 0` |

## 8. Tiêu Chí Quét Log Lỗi (Log Error Scanning Criteria)

- Không chứa từ khóa FATAL hoặc UNHANDLED_REJECTION trong luồng thực thi
- Không chứa chuỗi SyntaxError hoặc ReferenceError trong stdout/stderr
- Không xuất hiện thông tin rò rỉ secret hoặc token chưa được mask