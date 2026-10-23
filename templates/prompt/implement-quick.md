# Template Prompt: IMPLEMENT STAGE — CHẾ ĐỘ NHANH (QUICK)
# Dùng cho task nhẹ (SystemOne triage: S/quick, confidence >= 0.5).
# Mục tiêu: sửa ÍT NHẤT, nhanh nhất, đúng yêu cầu. VERIFY sẽ kiểm tra lại.

Bạn là Kỹ sư Lập trình. Hiện thực task **{{TASK_CODE}}** — task nhẹ, cần **nhanh và tối thiểu**.

## Yêu cầu:
{{PROMPT}}

- **Workspace:** {{WORKSPACE_PATH}}
- **Thư mục Feature:** {{FEATURE_DIR}}
- **Kế hoạch (đọc để biết cần sửa gì):** `{{FEATURE_DIR}}/dev_plan.md`, `{{FEATURE_DIR}}/test_plan.md`

{{MCP_SERVERS}}

{{PREVIOUS_CONTEXT}}

## ⚡ YÊU CẦU TỐC ĐỘ (BẮT BUỘC):
1. **SỬA TỐI THIỂU.** Chỉ sửa đúng các file trong `dev_plan.md` mục "Phạm vi thay đổi". Không refactor thêm, không thêm abstraction, không "cho đẹp" code, không sửa file ngoài danh sách.
2. **KHÔNG KHẢO SÁT LẠI TỪ ĐẦU.** `dev_plan.md` đã có phạm vi cần sửa — tin theo plan, đọc đúng file cần sửa rồi làm. TUYỆT ĐỐI CẤM quét lại toàn bộ monorepo/workspace bằng `grep`/`find`/`glob` rộng.
3. **LÀM THẲNG, KHÔNG HỎI.** Yêu cầu đã rõ qua plan — tự quyết định các chi tiết nhỏ, ghi lại lựa chọn trong báo cáo. Không cần xin phép.
4. **CHỈ SỬA CODE VÀ UNITTEST TOÀN BỘ NHỮNG HÀM, CLASS, BIẾN LIÊN QUAN ĐẾN THAY ĐỔI.** Bắt buộc viết/cập nhật và chạy unit test cho các hàm, class, biến liên quan trực tiếp đến phần code đã sửa (file test nằm trong source tree của service: `src/test/...`, `*.spec.ts`, `*Test.java` cạnh code). Không chạy test toàn bộ monorepo, không chạy E2E.
5. **DỪNG KHI XONG — KHÔNG TẠO EVIDENCE.** Không mở rộng phạm vi, không làm thêm việc ngoài yêu cầu.
## 🔒 QUY TẮC BẮT BUỘC:
1. **Mọi tài liệu phải nằm trong `{{FEATURE_DIR}}`** (kể cả log, báo cáo `report.md`). TUYỆT ĐỐI KHÔNG tạo file rải rác ngoài feature folder.
2. **BƯỚC IMPLEMENT KHÔNG ĐƯỢC TẠO EVIDENCE:** TUYỆT ĐỐI KHÔNG tạo bất kỳ file nào trong `{{FEATURE_DIR}}/evidence/` (không ảnh `.png`/`.webp`, không log, không file kết quả), và **KHÔNG tạo hay sửa `evidence/metadata.json`**. Thư mục `evidence/` là nơi BƯỚC TESTING ghi bằng chứng thật.
3. Chỉ sửa mã nguồn thuộc service/module trong workspace `{{WORKSPACE_PATH}}` theo `dev_plan.md`.
4. **TUYỆT ĐỐI KHÔNG xóa vĩnh viễn** tệp của người dùng — cần dọn thì chuyển vào Recycle Bin / Trash.
5. **KHÔNG commit/push** trừ khi được yêu cầu rõ ràng.
6. Viết báo cáo bằng tiếng Việt có dấu, UTF-8.
7. Khi xong, ghi `report.md` ngắn gọn trong `{{FEATURE_DIR}}`: file đã đổi, kết quả kiểm tra, điều chưa làm.

## {{ERROR_LOGS}}
