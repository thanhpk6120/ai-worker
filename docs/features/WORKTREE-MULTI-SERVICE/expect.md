---
feature: WORKTREE-MULTI-SERVICE
service: ai-worker
status: draft
owner: ThanhPK
updated_at: 2026-10-28
---

# Yêu cầu nghiệp vụ & Tiêu chuẩn nghiệm thu (expect.md) — WORKTREE-MULTI-SERVICE

## 1. Bối cảnh & Mục tiêu

Trong các dự án thực tế, một hệ thống thường bao gồm nhiều service khác nhau (microservices / polyrepo), mỗi service nằm trong một Git repository độc lập (ví dụ: `auth-service`, `order-service`, `payment-service`, `docs`, `web-frontend`).

Hiện tại, `ai-worker` khóa hàng đợi theo toàn bộ thư mục workspace, khiến các task trong cùng workspace phải thực thi tuần tự, gây lãng phí tài nguyên CPU và thời gian chờ đợi. Khi nhiều task cùng muốn chạy trên các service khác nhau, hệ thống cần cơ chế:
1. Tách **Git Worktree** theo từng task để chạy song song độc lập.
2. Quản lý danh sách service theo từng Workspace kèm nhánh phát triển (`dev_branch`) và nhánh triển khai (`deploy_branch`).
3. Cho phép AI Model mở rộng worktree động ngay tại các pha `TESTING` và `FIXING` khi phát hiện phụ thuộc mới.
4. Bổ sung bước `MERGING` để tự động merge code về nhánh phát triển của từng service, giải quyết conflict và re-test an toàn trên nhánh phát triển gốc dưới cơ chế khóa đơn luồng.

---

## 2. Yêu cầu Chức năng (Functional Requirements)

### FR-1: Quản lý Service Registry trong Cấu hình Workspace
- Khi thêm hoặc chỉnh sửa Workspace, hệ thống tự động quét các thư mục cấp 1 chứa `.git`.
- Tự động nhận diện nhánh phát triển hiện tại đang checkout ở máy local: `git -C <path> rev-parse --abbrev-ref HEAD`.
- Cho phép người dùng thêm, sửa, xóa, bật/tắt (enabled/disabled) từng service trên giao diện UI.
- Lưu cấu hình `dev_branch` và `deploy_branch` cho từng service vào cơ sở dữ liệu.

### FR-2: Thư mục làm việc Composite Task Worktree
- Mỗi task khi chạy được cấp phát thư mục làm việc riêng tại `.worktrees/<task-code>/`.
- Chỉ mount/tạo worktree cho các service mà task thực sự tác động.
- Không dùng 1 file JSON chung ở thư mục worker để tránh xung đột ghi đè đồng thời (race condition / lost update). Mỗi task có file cấu hình riêng `.task-manifest.json`.

### FR-3: Mở rộng Worktree Động tại BẤT KỲ bước nào
- Khi AI đang ở `PLANNING`, `IMPLEMENT`, `TESTING`, hoặc `FIXING` mà phát hiện cần sửa thêm service khác:
  - Hệ thống tự động tạo thêm worktree cho service đó từ đúng `dev_branch` tương ứng.
  - **Không kiểm tra slot concurrency chung** của server vì task hiện tại đã và đang giữ 1 slot thực thi rồi.
  - Cập nhật danh sách service tham gia vào `.task-manifest.json` và database.

### FR-4: Bước `MERGING` trong Pipeline Lifecycle
- Bổ sung bước `MERGING` vào vòng đời: `TO DO` ➔ `PLANNING` ➔ `IMPLEMENT` ➔ `TESTING` ➔ `VERIFY` ➔ `MERGING` ➔ `DONE`.
- Nếu merge không có conflict (Clean Merge): Hoàn tất merge và chuyển sang `DONE`.
- Nếu merge có conflict:
  - Giao quyền cho AI giải quyết conflict (3-way merge).
  - **Bắt buộc Re-test trực tiếp trên nhánh phát triển của repo gốc** (không phải trên worktree).
  - Nếu Re-test PASS: Hoàn tất merge và sang `DONE`.
  - Nếu Re-test FAIL: Hủy merge (`git merge --abort`), đưa task quay lại bước `FIXING` trong worktree.

### FR-5: Khóa Độc Quyền Đơn Luồng (Exclusive Dev Lock) cho bước `MERGING`
- Quá trình merge và re-test trực tiếp trên repo gốc **bắt buộc chạy đơn luồng tuyệt đối** theo từng service.
- Nếu có 2 task cùng đến bước `MERGING` trên cùng một service, task sau phải xếp hàng chờ task trước hoàn tất và nhả lock, ngăn chặn tuyệt đối tình trạng đè bẩn file, hỏng git index hoặc gãy build của nhau.
### FR-6: Luôn Pull Code Mới Nhất Trước Khi Thao Tác Trên Nhánh Git
- Trước khi phân nhánh worktree từ nhánh dev: tự động pull commit mới nhất từ remote (`git fetch origin <branch>:<branch>` nếu đang ở nhánh khác, hoặc `git pull` nếu đang ở nhánh dev).
- Trước khi checkout và merge vào nhánh dev gốc tại bước `MERGING`: tự động pull cập nhật nhánh dev từ remote.
- Tự động bỏ qua an toàn nếu repo local thuần túy không có remote hoặc đang offline.

---

## 3. Tiêu chí Nghiệm thu (Acceptance Criteria)

1. **AC-1 (Scan & UI):** Thêm workspace thành công, bảng service hiển thị đúng các thư mục git con và đúng nhánh đang checkout tại repo gốc.
2. **AC-2 (Concurrency):** Hai task sửa 2 service khác nhau có thể chạy song song cùng lúc trên 2 worktree độc lập mà không bị lock hàng đợi.
3. **AC-3 (Dynamic Expansion):** Khi task đang ở `TESTING` hoặc `FIXING`, yêu cầu thêm service được đáp ứng ngay lập tức, thư mục worktree mới xuất hiện và AI tiếp tục chạy mà không bị gián đoạn hay kẹt slot.
4. **AC-4 (Clean Merge):** Task không có conflict tự động merge vào đúng `dev_branch` của từng service và hoàn tất `DONE`.
5. **AC-5 (Conflict & Re-test):** Task có conflict được AI gỡ conflict, chạy re-test trên repo gốc thành công mới được sang `DONE`. Nếu re-test fail, repo gốc được hoàn tác nguyên vẹn.
6. **AC-6 (Single-Threaded Safety):** Không bao giờ xảy ra lỗi `.git/index.lock` hoặc xung đột code khi 2 task cùng merge vào cùng một service.
7. **AC-7 (Pull Before Action):** Trước khi tạo worktree hoặc merge, commit mới nhất từ remote luôn được cập nhật vào ref local mà không làm bẩn nhánh HEAD đang checkout.
