# AI Worker Server (`ai-worker`)

> **Hệ thống Quản lý, Điều phối & Thực thi Headless AI Agent Code với Web Dashboard Trực quan, Live Terminal, Dual Planning, Trạng thái PENDING Tương Tác (Chỉ trong Planning) & Multi-Verification Evidence Gate**

`ai-worker` là nền tảng máy chủ dịch vụ **Single Server** viết hoàn toàn bằng **JavaScript / Node.js**, đóng vai trò là một Agent Orchestration & Execution Platform tập trung. Hệ thống vừa cung cấp API điều phối các AI Agent CLI phục vụ lập trình tự động hóa ở chế độ **Headless / Non-interactive**, vừa tích hợp sẵn **Giao diện Web Dashboard trực quan** (chạy trên cùng một cổng duy nhất, ví dụ `http://localhost:3000`), cho phép:
- Xem trực tiếp từng dòng lệnh đang chạy ở terminal thời gian thực (**Live Terminal View với `xterm.js`**).
- Tương tác Human-in-the-Loop qua trạng thái **`PENDING`** (**Chỉ diễn ra duy nhất ở bước `PLANNING`**): khi agent cần làm rõ yêu cầu để lập kế hoạch, giao diện hiển thị các câu trả lời tích chọn sẵn hoặc ô chat custom.
- **Sau khi `PLANNING` hoàn thành**: Hệ thống chuyển sang chế độ tự hành hoàn toàn (**Fully Autonomous Execution**), các bước sau tuyệt đối không chuyển sang `PENDING` nữa.
- Lập kế hoạch song song (**Dual Planning**: Dev Plan + Test Plan).
- Quản lý vòng đời chuẩn hóa: **`TO DO` $\to$ `PLANNING` $\to$ `IMPLEMENT` $\to$ `TESTING` $\underset{\text{Re-test}}{\overset{\text{Lỗi}}{\rightleftarrows}}$ `FIXING` $\to$ `DONE`**.
- Đa kênh thẩm định nghiệm thu (**Multi-Verification Evidence Gate**): Xác nhận thành công thực sự qua cả **Ảnh UI MCP CloakBrowser + Kết quả test API + Quét Log ứng dụng + Truy vấn Database thực tế**.

---

## 🌟 Năng Lực Cốt Lõi

### 1. Vòng Đời Chuẩn Hóa & Cơ Chế PENDING Độc Quyền Tại `PLANNING`

```text
               ┌──────────┐
               │  TO DO   │
               └────┬─────┘
                    │
                    ▼
          ┌───────────────────┐
          │     PLANNING      │ ◄──────────┐
          │  (Dual Planning)  │            │
          └─────────┬─────────┘            │
                    │                      │ (Trả lời xong,
                    ├──────► [ Cần hỏi? ] ──┤  quay lại Planning)
                    │             │        │
                    │             ▼        │
                    │       ┌───────────┐  │
                    │       │  PENDING  │ ─┘
                    │       └───────────┘
                    │ (Planning xong -> Khóa PENDING vĩnh viễn)
                    ▼
          ┌───────────────────┐
          │     IMPLEMENT     │  (Tự hành hoàn toàn theo Dev Plan)
          └─────────┬─────────┘
                    │
                    ▼
          ┌───────────────────┐ ◄─────────────────────────────────────┐
          │      TESTING      │                                       │
          │ (Multi-Evidence)  │                                       │
          └─────────┬─────────┘                                       │
                    │                                                 │
                    ├──────────► [ Test lỗi / Chưa đạt? ]             │
                    │                         │                       │
                    │                         ▼ (Chuyển sang sửa lỗi) │
                    │                   ┌───────────┐                 │
                    │                   │  FIXING   │ ────────────────┘
                    │                   └───────────┘  (Re-test tự động)
                    ▼
          ┌───────────────────┐
          │       DONE        │  (Tất cả 4 kênh bằng chứng đạt 100%)
          └───────────────────┘
```

#### Chi tiết các trạng thái:
1. 📋 **`TO DO`**: Tiếp nhận yêu cầu, cấp phát Git Worktree sandbox độc lập.
2. 🧠 **`PLANNING` (Dual Planning & Interactive Clarification)**:
   - **Dev Plan (`dev_plan.md`)**: Phân tích kiến trúc, danh sách file, logic xử lý, API contracts.
   - **Test Plan (`test_plan.md`)**: Xác định kiểm thử cái gì, các bước thao tác, dữ liệu test/mock data, checkpoints chụp ảnh và truy vấn DB.
   - 💬 **Trạng thái `PENDING` (Chỉ ở bước này)**: Nếu agent có câu hỏi làm rõ hoặc phân vân lựa chọn kiến trúc, task tạm dừng an toàn chuyển sang `PENDING`. Web UI hiển thị popup cho phép người dùng **tích chọn các phương án có sẵn** hoặc **chat câu trả lời tùy chỉnh**. Sau khi người dùng trả lời, agent tiếp tục hoàn thiện kế hoạch.
   - 🔒 **Quy tắc bất biến**: Khi `PLANNING` hoàn tất, kế hoạch được chốt. **Từ bước IMPLEMENT trở đi, hệ thống TUYỆT ĐỐI KHÔNG PENDING NỮA!**
3. 💻 **`IMPLEMENT`**: Agent lập trình tự động thực thi chỉnh sửa mã nguồn bám sát theo `dev_plan.md`, không ngắt quãng hỏi người dùng.
4. 🧪 **`TESTING` (Multi-Verification Evidence Gate)**:
   - Tự động chạy service ở local dưới dạng **Host Child Process**, probe HTTP readiness.
   - Điều khiển trình duyệt **MCP CloakBrowser** thực hiện các bước kiểm thử giao diện theo `test_plan.md`.
   - **Nghiệm thu đa kênh bắt buộc**:
     - 📸 **File ảnh (UI Screenshot Evidence)**: Chụp lưu vào `feature/<name>/evidence/<timestamp>.png`.
     - 🌐 **Kết quả Test API**: Kiểm tra HTTP status code và JSON schema response.
     - 📋 **Tra cứu Log**: Quét log ứng dụng xác nhận không có stack trace hay unhandled exceptions.
     - 🗄️ **Tra cứu Cơ sở Dữ liệu (Database Query)**: Thực hiện query DB thực tế xác nhận dữ liệu đã được insert/update/delete đúng nghiệp vụ!
   - Chỉ khi **TẤT CẢ** các kênh trên đạt yêu cầu $\to$ Chuyển sang **`DONE`**. Nếu bất kỳ kênh nào lỗi $\to$ Chuyển sang **`FIXING`**.
5. 🛠️ **`FIXING` (Context-Rich Autonomous Remediation)**:
   - Agent sửa lỗi tiếp nhận toàn bộ ngữ cảnh: đường dẫn ảnh bằng chứng, API failure response, DB query result sai lệch, console log lỗi và git diff.
   - Tự động sửa mã nguồn và quay lại **`TESTING`** để re-test (kiểm soát bởi `maxFixingRetries`: mặc định 3 lần). Tuyệt đối không dừng lại hỏi người dùng.
6. ✅ **`DONE`**: Nghiệm thu thành công 100%, tạo commit/patch và dọn dẹp an toàn.

---

## 🌟 Các Năng Lực Cốt Lõi Khác

- **Live Terminal Streaming View (`xterm.js`)**: Theo dõi trực tiếp từng dòng lệnh agent đang gõ ở terminal ngay trên web với mã màu ANSI, độ trễ < 500ms.
- **Multi-Agent Step Pipeline**: Cấu hình linh hoạt agent cho từng bước (ví dụ: Planning dùng Claude Code, Implement dùng OpenCode, Testing dùng OMP, Fixing dùng Claude Code).
- **Hỗ trợ 5 CLI cốt lõi**: Claude Code, OpenCode, OMP, Codex CLI, Antigravity CLI.
- **An toàn tệp tin tuyệt đối (`SAFE-01`)**: Mọi thao tác dọn dẹp worktree và file rác bắt buộc chuyển vào Thùng rác (Recycle Bin / Trash), tuyệt đối cấm xóa vĩnh viễn (`rm -rf`).
- **Database Safety Guard**: Sandbox Test Database, transaction rollback và parameterized queries ngăn ngừa rủi ro dữ liệu.

---

## 📁 Cấu Trúc Dự Án

```text
ai-worker/
├── README.md                           # Tài liệu tổng quan dự án
└── feature/
    └── Create-AI-Worker/               # Bộ tài liệu đặc tả Spec-Driven (Feature Create-AI-Worker)
        ├── expect.md                   # Yêu cầu nghiệp vụ, PENDING ở Planning, Multi-Verification Gate & 20 AC + SAFE-01
        ├── plan.md                     # Thiết kế kỹ thuật Single Server JS, State Machine, DB/API Verifier & PENDING Bus
        ├── tasks.md                    # Kế hoạch triển khai phân rã 48 tasks chi tiết qua 8 Phase
        ├── testcase.md                 # 30 kịch bản kiểm thử toàn diện (TC-01..TC-30) & Traceability Matrix
        └── impact.md                   # Phân tích tác động, an toàn DB queries, giải trừ rủi ro blocking PENDING
```

---

## 🚀 Lộ Trình Triển Khai (Roadmap)

- [x] **Spec-Driven Analysis & Gate 1 Review**: Hoàn thành toàn diện bộ 5 tài liệu đặc tả và vượt qua kiểm định chéo Gate 1 (100% Pass).
- [ ] **Phase 1: Core Foundation & API Gateway**: Dựng Single Server Node.js, Health Check, Queue Semaphore Limiter.
- [ ] **Phase 2: Workspace Sandbox Manager**: Vòng đời Git Worktree, inject context rules, Safe Trash cleanup (SAFE-01).
- [ ] **Phase 3: Unified Runner Adapter Layer**: Hiện thực 5 Adapters (Claude Code, OpenCode, OMP, Codex, Antigravity).
- [ ] **Phase 4: Multi-Agent Step Pipeline & Clarification Manager**: Hiện thực Pipeline Router, vòng lặp `TESTING ⇄ FIXING` và PENDING độc quyền ở PLANNING.
- [ ] **Phase 5: Local Service Manager & Multi-Verification Gate**: Host Child Process probe, MCP CloakBrowser, API Test, Log Scan & Database Verifier.
- [ ] **Phase 6: Web UI Dashboard**: Live Terminal xterm.js, Interactive Question Modal (Planning only), Multi-Evidence Dashboard.
- [ ] **Phase 7: Testing, Hardening & Security Audit**: Thực thi 30 kịch bản kiểm thử, kiểm tra an toàn DB, DOMPurify XSS và tải đồng thời.

---

## 📖 Tài Liệu Tham Khảo Chi Tiết

- [Đặc tả yêu cầu nghiệp vụ (expect.md)](feature/Create-AI-Worker/expect.md)
- [Thiết kế kiến trúc kỹ thuật (plan.md)](feature/Create-AI-Worker/plan.md)
- [Checklist triển khai chi tiết (tasks.md)](feature/Create-AI-Worker/tasks.md)
- [Bộ kịch bản kiểm thử toàn diện (testcase.md)](feature/Create-AI-Worker/testcase.md)
- [Báo cáo phân tích tác động và rủi ro (impact.md)](feature/Create-AI-Worker/impact.md)
