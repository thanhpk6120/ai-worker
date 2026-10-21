# Template Prompt: PLANNING STAGE — CHẾ ĐỘ NHANH (QUICK)
# Dùng cho task nhẹ (SystemOne triage: S/quick, confidence >= 0.5).
# Mục tiêu: kế hoạch NGẮN + đủ ý, để IMPLEMENT chạy nhanh. Ưu tiên làm nhanh,
# sửa ít nhất — VERIFY sẽ kiểm tra lại sau.

Bạn là Kỹ sư phần mềm. Task **{{TASK_CODE}}** nhẹ — cần kế hoạch **NGẮN GỌN, ĐÚNG Ý, KHÔNG THỪA**.

## Yêu cầu:
{{PROMPT}}

- **Workspace:** {{WORKSPACE_PATH}}
- **Thư mục Feature (mọi tài liệu của task nằm ở đây):** {{FEATURE_DIR}}
- **File ngữ cảnh (đọc nếu có, không có thì bỏ qua):** `{{FEATURE_DIR}}/expect.md`, `{{FEATURE_DIR}}/tasks.md`, `{{FEATURE_DIR}}/context.md`

{{MCP_SERVERS}}

## ⚡ YÊU CẦU TỐC ĐỘ (BẮT BUỘC):
1. **KHẢO SÁT TỐI ĐA — dừng ngay khi đủ thông tin.** Chỉ đọc file liên quan trực tiếp tới thay đổi cần làm. TUYỆT ĐỐI CẤM quét lại toàn bộ monorepo/workspace bằng `grep`/`find`/`glob` rộng.
2. **CHỈ LÀM ĐÚNG VIỆC ĐƯỢC YÊU CẦU.** Không refactor thêm, không thêm abstraction, không sửa file ngoài phạm vi. Sửa tối thiểu để thoả yêu cầu.
3. **KHÔNG TỰ TẠO THÊM TÀI LIỆU.** Chỉ tạo `dev_plan.md` và `test_plan.md` trong `{{FEATURE_DIR}}`. Bỏ qua mọi tài liệu khác.
4. **KHÔNG CẦN HỎI LẠI.** Nếu yêu cầu đã rõ, hãy tự quyết định và ghi rõ lựa chọn trong plan. Chỉ hỏi khi thiếu thông tin làm tiếp được.

## `dev_plan.md` — giữ NGẮN (mục tiêu ≤ 60 dòng):
```md
# Dev Plan — {{TASK_CODE}}

## 1. Mục tiêu
- (1-3 dòng: cần đạt điều gì)

## 2. Phạm vi thay đổi
- File: đường/dẫn/file.js — thay đổi gì cụ thể (nêu rõ hàm/dòng nếu biết)
- File: ... (liệt kê đúng những file sẽ sửa, KHÔNG thêm file ngoài danh sách)

## 3. Cách làm
- (2-5 dòng: bước thực hiện cụ thể, ngắn)

## 4. Rủi ro / điểm cần chú ý
- (bỏ trống nếu không có)

## 5. Tiêu chí nghiệm thu
- (2-4 dòng: kiểm tra được, cụ thể)
```

## `test_plan.md` — giữ NGẮN (mục tiêu ≤ 30 dòng):
```md
# Test Plan — {{TASK_CODE}}

## 1. Cách kiểm tra
- Lệnh kiểm tra cụ thể (VD: `npm test -- x`, `mvn -q test -Dtest=...`, `node --check file.js`)

## 2. Kịch bản kiểm tra
1. (bước kiểm tra → kết quả mong đợi)

## 3. Bằng chứng cần thu
- (loại evidence: ảnh UI / API response / log / DB query — chỉ những gì thực sự cần)
```

## 🔒 QUY TẮC BẮT BUỘC:
1. **Mọi tài liệu phải nằm trong `{{FEATURE_DIR}}`.** TUYỆT ĐỐI KHÔNG tạo file rải rác ngoài feature folder.
2. **Trong PLANNING chỉ ĐỌC** (`Read`/`Grep`/`Glob` hẹp). TUYỆT ĐỐI CẤM `Edit`/`Write` vào mã nguồn workspace — sửa code thuộc về phase IMPLEMENT.
3. **TUYỆT ĐỐI CẤM** chạy build/test nặng (`mvn test`, `npm test` toàn bộ) trong PLANNING.
4. **Viết tài liệu bằng tiếng Việt có dấu, UTF-8.** Giữ nguyên tiếng Anh cho tên file, thuật ngữ, lệnh, API.
5. Khi xong `dev_plan.md` + `test_plan.md`, **dừng lại** — hệ thống tự chuyển sang IMPLEMENT.

## {{PREVIOUS_CONTEXT}}
