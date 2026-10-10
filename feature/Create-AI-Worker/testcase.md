# Kịch bản kiểm thử chi tiết (testcase.md)
## Feature: Create-AI-Worker — Server Quản lý & Điều phối Headless AI Agent Code

- **Feature ID:** `Create-AI-Worker`
- **Domain:** AI Worker Platform / Test Specification
- **Phiên bản:** 1.3.0
- **Trạng thái:** DRAFT / PLAN-REVIEW
- **Tài liệu tham chiếu:** `expect.md`, `plan.md`
- **Số lượng kịch bản:** 30 Test Cases (`TC-01` đến `TC-30`)

---

## 1. Ma trận đối chiếu độ bao phủ (Traceability Matrix)

Bảng đối chiếu giữa các Tiêu chí nghiệm thu (`AC-01` đến `AC-20`), Quy tắc an toàn hệ thống và 30 Kịch bản kiểm thử (`TC-01` đến `TC-30`):

| Mã AC | Nội dung tiêu chí nghiệm thu | Test Cases kiểm chứng | Đánh giá bao phủ |
|---|---|---|---|
| **AC-01** | Khởi động & Quản lý Service, Health Check, Runner Status | `TC-01`, `TC-07` | Hoàn toàn bao phủ |
| **AC-02** | Hỗ trợ đầy đủ 5 CLI Runner (`claude`, `opencode`, `omp`, `codex`, `antigravity`) | `TC-01`, `TC-02`, `TC-03`, `TC-04`, `TC-05`, `TC-06` | Hoàn toàn bao phủ |
| **AC-03** | Khởi tạo Task qua REST API, xếp hàng và cấp phát worker slot | `TC-02`, `TC-03`, `TC-04`, `TC-05`, `TC-06`, `TC-07` | Hoàn toàn bao phủ |
| **AC-04** | Cách ly Workspace độc lập (Git Worktree / Sandbox Isolation) | `TC-08`, `TC-14` | Hoàn toàn bao phủ |
| **AC-05** | Realtime Log Streaming qua SSE/WebSocket với độ trễ < 500ms | `TC-09`, `TC-27` | Hoàn toàn bao phủ |
| **AC-06** | Secret Masking (che giấu API keys, token dạng `***MASKED***`) | `TC-10` | Hoàn toàn bao phủ |
| **AC-07** | Hủy tác vụ an toàn trong tối đa 5 giây (`POST /jobs/{id}/cancel`) | `TC-11`, `TC-12`, `TC-13` | Hoàn toàn bao phủ |
| **AC-08** | Xử lý Hard Timeout tự động và thu hồi tài nguyên | `TC-11`, `TC-13` | Hoàn toàn bao phủ |
| **AC-09** | Thu thập kết quả thực thi & Git Diff tổng kết | `TC-02`, `TC-03`, `TC-04`, `TC-05`, `TC-06`, `TC-08` | Hoàn toàn bao phủ |
| **SAFE-01** | Quy tắc an toàn tiên quyết: Di chuyển vào Thùng rác (Recycle Bin / Trash) | `TC-08`, `TC-12`, `TC-13`, `TC-14`, `TC-19`, `TC-20`, `TC-21`, `TC-22`, `TC-23`, `TC-24`, `TC-25`, `TC-26`, `TC-28`, `TC-29` | Hoàn toàn bao phủ |
| **AC-10** | Single-Server Web UI Dashboard (Dashboard phục vụ tại cùng cổng HTTP với API) | `TC-15` | Hoàn toàn bao phủ |
| **AC-11** | Step-by-step Visual Tracing & Realtime Terminal UI (Timeline 5 bước, ANSI log) | `TC-16`, `TC-27`, `TC-30` | Hoàn toàn bao phủ |
| **AC-12** | Web-based Process Control & Diff Viewer (Cancel/Re-run trực tiếp, Diff Viewer) | `TC-17`, `TC-27`, `TC-30` | Hoàn toàn bao phủ |
| **AC-13** | Multi-Agent Step Configuration (Cấu hình runner riêng biệt cho từng bước qua config/UI) | `TC-18` | Hoàn toàn bao phủ |
| **AC-14** | Dynamic Self-Healing Lifecycle (Vòng lặp Testing ⇄ Fixing tự động và Max Retry Limit) | `TC-19`, `TC-20`, `TC-21`, `TC-28`, `TC-29` | Hoàn toàn bao phủ |
| **AC-15** | Dual Planning Generation (Sinh song song Dev Plan & Test Plan với đầy đủ steps, mock data) | `TC-22` | Hoàn toàn bao phủ |
| **AC-16** | Local Service Auto-Start, Readiness Probe & Browser Evidence Testing (E2E Screenshot) | `TC-23`, `TC-28` | Hoàn toàn bao phủ |
| **AC-17** | Visual Verification Failure to FIXING Handoff & Re-test Success to DONE | `TC-24`, `TC-25`, `TC-26`, `TC-28`, `TC-29` | Hoàn toàn bao phủ |
| **AC-18** | Multi-Verification Evidence Gate (Ảnh + API + Log + DB) | `TC-28`, `TC-29` | Hoàn toàn bao phủ |
| **AC-19** | Human-in-the-Loop Clarification & PENDING State (Chỉ kích hoạt tại bước PLANNING; IMPLEMENT/TESTING/FIXING tự động 100%, từ chối PENDING) | `TC-30` | Hoàn toàn bao phủ |
| **AC-20** | Live Terminal Full-Fidelity Streaming (xterm.js) | `TC-27` | Hoàn toàn bao phủ |
## 2. Danh mục chi tiết 30 Kịch bản kiểm thử (TC-01 đến TC-30)

### TC-01: Health Check & Runner Discovery (5 CLI)
- **Mã kịch bản:** `TC-01`
- **Mục tiêu:** Xác minh hệ thống khởi động thành công, endpoint Health Check phản hồi HTTP 200 và tự động phát hiện tình trạng cài đặt của cả 5 CLI Runner (`claude`, `opencode`, `omp`, `codex`, `antigravity`).
- **Tiêu chuẩn ánh xạ:** `AC-01`, `AC-02`
- **Tiền điều kiện (Preconditions):**
  - AI Worker Server đang chạy tại địa chỉ cấu hình (mặc định `http://localhost:8080`).
  - Môi trường host có sẵn đường dẫn thực thi của ít nhất 1 CLI hoặc mock binaries giả lập trong biến môi trường `PATH`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Giao thức: `GET /api/v1/health`
  - Headers: `Accept: application/json`
- **Các bước thực hiện (Steps):**
  1. Gửi HTTP GET request tới `http://localhost:8080/api/v1/health`.
  2. Ghi nhận HTTP Status Code và payload JSON trả về.
  3. Kiểm tra danh sách runners trong trường `runners`.
- **Kết quả mong đợi (Expected Results):**
  - HTTP Status Code: `200 OK`.
  - Body trả về JSON có cấu trúc:
    ```json
    {
      "status": "UP",
      "version": "1.0.0",
      "uptimeSeconds": 120,
      "runners": {
        "claude": { "available": true, "path": "C:\\npm\\claude.cmd", "version": "0.2.1" },
        "opencode": { "available": true, "path": "C:\\bin\\opencode.exe", "version": "1.0.4" },
        "omp": { "available": true, "path": "C:\\bin\\omp.exe", "version": "2.1.0" },
        "codex": { "available": true, "path": "C:\\npm\\codex.cmd", "version": "0.9.3" },
        "antigravity": { "available": true, "path": "C:\\bin\\antigravity.exe", "version": "1.2.0" }
      },
      "activeSlots": 0,
      "maxSlots": 4,
      "queueLength": 0
    }
    ```
  - Cả 5 trường tên adapter đều hiện diện trong object `runners`.
- **Hậu điều kiện / Cleanup:** Không cần dọn dẹp.

---

### TC-02: Claude Code Headless Execution (Tự động bypass permission)
- **Mã kịch bản:** `TC-02`
- **Mục tiêu:** Xác minh Claude Code Adapter thực thi tác vụ headless thành công, tự động chèn cờ bypass approval prompt (`--dangerously-skip-permissions` hoặc cấu hình tương đương) và không bị treo chờ người dùng nhập phím.
- **Tiêu chuẩn ánh xạ:** `AC-02`, `AC-03`, `AC-09`
- **Tiền điều kiện (Preconditions):**
  - Worker slot còn trống ít nhất 1 slot.
  - Claude CLI Runner ở trạng thái khả dụng (`available: true`).
  - Một git repository thử nghiệm đã khởi tạo tại `tests/fixtures/sample-repo`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Endpoint: `POST /api/v1/jobs`
  - Body JSON:
    ```json
    {
      "runner": "claude",
      "repoPath": "tests/fixtures/sample-repo",
      "prompt": "Tạo một file hello.txt chứa nội dung 'Hello from Claude Headless'",
      "timeoutSeconds": 180,
      "autoApprove": true
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo job `POST /api/v1/jobs`. Nhận `jobId` từ phản hồi HTTP 201.
  2. Theo dõi trạng thái job qua `GET /api/v1/jobs/{jobId}` cho đến khi trạng thái chuyển sang `COMPLETED` (hoặc timeout kiểm tra sau tối đa 60 giây).
  3. Kiểm tra file log của tiến trình thực thi để xác nhận câu lệnh kích hoạt CLI.
  4. Kiểm tra thư mục làm việc để xác nhận file `hello.txt` đã được sinh ra.
- **Kết quả mong đợi (Expected Results):**
  - HTTP Status khi tạo: `201 Created` với `jobId` định dạng UUID hợp lệ.
  - Câu lệnh process spawn chứa đầy đủ các cờ non-interactive: `claude -p "..." --dangerously-skip-permissions`.
  - Tiến trình hoàn thành với exit code `0`, không xảy ra timeout hay block do interactive prompt.
  - Trạng thái cuối của job: `COMPLETED`.
  - File `hello.txt` được tạo với nội dung chính xác.
  - Trường `gitDiff` trong kết quả job chứa diff của file `hello.txt`.
- **Hậu điều kiện / Cleanup:**
  - Dọn dẹp thư mục làm việc tạm thời bằng cách chuyển vào Trash/Recycle Bin.

---

### TC-03: OpenCode Headless Execution (--auto-approve)
- **Mã kịch bản:** `TC-03`
- **Mục tiêu:** Xác minh OpenCode Adapter khởi chạy đúng lệnh với cờ `--auto-approve`, không hỏi xác nhận tool call và ghi nhận diff hoàn chỉnh.
- **Tiêu chuẩn ánh xạ:** `AC-02`, `AC-03`, `AC-09`
- **Tiền điều kiện (Preconditions):**
  - OpenCode Runner khả dụng.
  - Thư mục git fixture sạch.
- **Dữ liệu kiểm thử (Input Payload):**
  - Endpoint: `POST /api/v1/jobs`
  - Body JSON:
    ```json
    {
      "runner": "opencode",
      "repoPath": "tests/fixtures/sample-repo",
      "prompt": "Thêm hàm sum(a, b) vào file math.js",
      "timeoutSeconds": 180,
      "autoApprove": true
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo job `POST /api/v1/jobs`.
  2. Kiểm tra command line thực thi từ server log.
  3. Đợi job chuyển trạng thái sang `COMPLETED`.
  4. Đọc kết quả qua `GET /api/v1/jobs/{jobId}`.
- **Kết quả mong đợi (Expected Results):**
  - Process spawn: `opencode --auto-approve --prompt "Thêm hàm sum(a, b) vào file math.js"`.
  - Trạng thái kết thúc: `COMPLETED`, exit code 0.
  - File `math.js` được cập nhật trong workspace của job.
  - Kết quả trả về chứa danh sách file thay đổi: `["math.js"]` và `gitDiff` chứa mã nguồn mới.
- **Hậu điều kiện / Cleanup:**
  - Dọn dẹp thư mục tạm vào Trash.

---

### TC-04: OMP Headless Execution (--mode headless --yes)
- **Mã kịch bản:** `TC-04`
- **Mục tiêu:** Xác minh OMP (Oh My Prompt/Agent) Adapter khởi chạy đúng cú pháp headless `--mode headless --yes`, hoàn thành tác vụ tự động.
- **Tiêu chuẩn ánh xạ:** `AC-02`, `AC-03`, `AC-09`
- **Tiền điều kiện (Preconditions):**
  - OMP Runner khả dụng.
- **Dữ liệu kiểm thử (Input Payload):**
  - Endpoint: `POST /api/v1/jobs`
  - Body JSON:
    ```json
    {
      "runner": "omp",
      "repoPath": "tests/fixtures/sample-repo",
      "prompt": "Tạo file README.md mô tả dự án ngắn gọn",
      "timeoutSeconds": 180,
      "autoApprove": true
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo job `POST /api/v1/jobs`.
  2. Bắt log command line spawn từ server.
  3. Đợi job hoàn tất.
  4. Kiểm tra file `README.md` và diff thu thập được.
- **Kết quả mong đợi (Expected Results):**
  - Command line được kích hoạt có chứa `--mode headless --yes`.
  - Exit code 0, không có prompt xác nhận nào làm treo tiến trình.
  - Trạng thái job: `COMPLETED`.
  - File `README.md` tồn tại trong workspace.
- **Hậu điều kiện / Cleanup:**
  - Chuyển thư mục tạm vào Recycle Bin / Trash.

---

### TC-05: Codex CLI Headless Execution (--non-interactive)
- **Mã kịch bản:** `TC-05`
- **Mục tiêu:** Xác minh Codex CLI Adapter khởi chạy với cờ `--non-interactive`, truyền prompt chính xác và kết thúc thành công.
- **Tiêu chuẩn ánh xạ:** `AC-02`, `AC-03`, `AC-09`
- **Tiền điều kiện (Preconditions):**
  - Codex CLI Runner khả dụng.
- **Dữ liệu kiểm thử (Input Payload):**
  - Endpoint: `POST /api/v1/jobs`
  - Body JSON:
    ```json
    {
      "runner": "codex",
      "repoPath": "tests/fixtures/sample-repo",
      "prompt": "Viết hàm helper formatDate(d) trong dateUtils.ts",
      "timeoutSeconds": 180,
      "autoApprove": true
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo job `POST /api/v1/jobs`.
  2. Kiểm tra log khởi tạo tiến trình của server.
  3. Đợi job đạt trạng thái `COMPLETED`.
- **Kết quả mong đợi (Expected Results):**
  - Command line chứa cờ `--non-interactive` (hoặc cú pháp không tương tác của Codex CLI).
  - Trạng thái job cập nhật thành `COMPLETED`.
  - Phản hồi chứa diff của file `dateUtils.ts`.
- **Hậu điều kiện / Cleanup:**
  - Chuyển thư mục tạm vào Trash.

---

### TC-06: Antigravity CLI Headless Execution (--headless --task)
- **Mã kịch bản:** `TC-06`
- **Mục tiêu:** Xác minh Antigravity CLI Adapter kích hoạt đúng cú pháp `--headless --task "<prompt>"`, chạy độc lập và trả về kết quả chuẩn xác.
- **Tiêu chuẩn ánh xạ:** `AC-02`, `AC-03`, `AC-09`
- **Tiền điều kiện (Preconditions):**
  - Antigravity CLI Runner khả dụng.
- **Dữ liệu kiểm thử (Input Payload):**
  - Endpoint: `POST /api/v1/jobs`
  - Body JSON:
    ```json
    {
      "runner": "antigravity",
      "repoPath": "tests/fixtures/sample-repo",
      "prompt": "Phân tích cấu trúc thư mục và tạo file ARCHITECTURE.md tóm tắt",
      "timeoutSeconds": 240,
      "autoApprove": true
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo job `POST /api/v1/jobs`.
  2. Bắt log lệnh spawn tiến trình.
  3. Theo dõi trạng thái tiến trình đến khi hoàn thành.
  4. Xác nhận file `ARCHITECTURE.md` và git diff được trích xuất.
- **Kết quả mong đợi (Expected Results):**
  - Command line thực thi chứa cờ `--headless` và `--task`.
  - Trạng thái job: `COMPLETED`, exit code 0.
  - Thu thập đầy đủ git diff và danh sách file thay đổi.
- **Hậu điều kiện / Cleanup:**
  - Chuyển thư mục tạm vào Trash.

---

### TC-07: Queue & Concurrency Slot Limiter (Quá tải slot đưa vào hàng đợi)
- **Mã kịch bản:** `TC-07`
- **Mục tiêu:** Xác minh cơ chế giới hạn slot đồng thời (`maxSlots = 2`). Khi gửi liên tiếp 3 job, 2 job đầu tiên chuyển sang `RUNNING`, job thứ 3 được giữ trong hàng đợi ở trạng thái `QUEUED`. Sau khi 1 job hoàn thành, job thứ 3 tự động được kích hoạt lên `RUNNING`.
- **Tiêu chuẩn ánh xạ:** `AC-01`, `AC-03`
- **Tiền điều kiện (Preconditions):**
  - Server cấu hình `maxConcurrencySlots = 2`.
  - Hàng đợi hiện tại rỗng (`queueLength = 0`, `activeSlots = 0`).
- **Dữ liệu kiểm thử (Input Payload):**
  - 3 request liên tiếp tới `POST /api/v1/jobs`:
    - Job A: `{ "runner": "claude", "prompt": "Task A sleep 5s", "timeoutSeconds": 30 }`
    - Job B: `{ "runner": "opencode", "prompt": "Task B sleep 5s", "timeoutSeconds": 30 }`
    - Job C: `{ "runner": "omp", "prompt": "Task C sleep 5s", "timeoutSeconds": 30 }`
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo Job A -> Nhận `jobA_id`.
  2. Gửi ngay request tạo Job B -> Nhận `jobB_id`.
  3. Gửi ngay request tạo Job C -> Nhận `jobC_id`.
  4. Lập tức kiểm tra `GET /api/v1/jobs` và `GET /api/v1/health`.
  5. Chờ 6 giây (để Job A hoặc B hoàn tất).
  6. Kiểm tra lại trạng thái của Job C.
- **Kết quả mong đợi (Expected Results):**
  - Tại bước 4:
    - Job A có trạng thái `RUNNING`.
    - Job B có trạng thái `RUNNING`.
    - Job C có trạng thái `QUEUED`.
    - `activeSlots = 2`, `queueLength = 1`.
  - Tại bước 6:
    - Ít nhất một trong hai Job A hoặc B chuyển sang `COMPLETED`.
    - Job C tự động chuyển từ `QUEUED` sang `RUNNING`.
    - `activeSlots <= 2`.
- **Hậu điều kiện / Cleanup:**
  - Chờ tất cả các job kết thúc; dọn dẹp các thư mục làm việc tạm thời vào Trash.

---

### TC-08: Workspace Isolation & Git Worktree Cleanup (2 job song song không xung đột)
- **Mã kịch bản:** `TC-08`
- **Mục tiêu:** Xác minh 2 job chạy song song trên cùng một base git repo được cách ly hoàn toàn qua 2 git worktree độc lập, không bị xung đột branch/file, và sau khi hoàn thành worktree được dọn dẹp an toàn.
- **Tiêu chuẩn ánh xạ:** `AC-04`, `AC-09`
- **Tiền điều kiện (Preconditions):**
  - Base git repo tại `tests/fixtures/isolation-repo` đã có commit gốc.
- **Dữ liệu kiểm thử (Input Payload):**
  - Job 1: `{ "runner": "claude", "repoPath": "tests/fixtures/isolation-repo", "branch": "feature/branch-1", "prompt": "Sửa file index.js thành 'Module 1'" }`
  - Job 2: `{ "runner": "opencode", "repoPath": "tests/fixtures/isolation-repo", "branch": "feature/branch-2", "prompt": "Sửa file index.js thành 'Module 2'" }`
- **Các bước thực hiện (Steps):**
  1. Khởi tạo đồng thời Job 1 và Job 2.
  2. Kiểm tra hệ thống file tại thư mục worktree cache của server: xác nhận 2 thư mục worktree riêng biệt được tạo (ví dụ: `.worktrees/job-1` và `.worktrees/job-2`).
  3. Chờ cả 2 job hoàn tất với trạng thái `COMPLETED`.
  4. Kiểm tra repo gốc: branch `feature/branch-1` chứa mã của Job 1, branch `feature/branch-2` chứa mã của Job 2; không có hiện tượng overwrite chéo.
  5. Kiểm tra danh sách worktree qua lệnh `git worktree list` trong repo gốc.
- **Kết quả mong đợi (Expected Results):**
  - Cả 2 job thực thi thành công không bị lock file hay git index conflict.
  - Worktree của từng job độc lập hoàn toàn.
  - Sau khi job kết thúc, server tự động thực hiện `git worktree remove` hoặc chuyển worktree cũ vào Trash.
  - `git worktree list` chỉ còn lại branch chính của repo gốc, không bị rò rỉ orphaned worktrees.
- **Hậu điều kiện / Cleanup:**
  - Dọn dẹp an toàn các test branch đã tạo.

---

### TC-09: Realtime Log Streaming qua SSE (Latency < 500ms)
- **Mã kịch bản:** `TC-09`
- **Mục tiêu:** Xác minh endpoint Server-Sent Events (SSE) stream log stdout/stderr trực tiếp tới client với độ trễ từ lúc tiến trình in ra đến lúc client nhận được nhỏ hơn 500ms.
- **Tiêu chuẩn ánh xạ:** `AC-05`
- **Tiền điều kiện (Preconditions):**
  - Job đang chạy hoặc vừa được khởi tạo và chưa kết thúc.
- **Dữ liệu kiểm thử (Input Payload):**
  - Endpoint tạo job: `POST /api/v1/jobs` (Job in ra 5 dòng log cách nhau 1 giây).
  - Endpoint SSE: `GET /api/v1/jobs/{jobId}/logs/stream`
  - Header: `Accept: text/event-stream`
- **Các bước thực hiện (Steps):**
  1. Gửi tạo job, nhận `jobId`.
  2. Ngay lập tức mở kết nối SSE tới `http://localhost:8080/api/v1/jobs/{jobId}/logs/stream`.
  3. Lắng nghe các event `data: ...` và ghi nhận timestamp của từng message nhận được.
  4. So sánh timestamp sinh log của runner và timestamp client nhận được để tính latency.
  5. Chờ message kết thúc stream: `event: done` hoặc `event: end`.
- **Kết quả mong đợi (Expected Results):**
  - Kết nối SSE thiết lập thành công với HTTP Status 200 và header `Content-Type: text/event-stream`.
  - Các dòng log được truyền theo định dạng:
    ```text
    data: {"timestamp": "2026-10-08T10:00:00.100Z", "level": "INFO", "message": "Step 1 started"}
    data: {"timestamp": "2026-10-08T10:00:01.102Z", "level": "INFO", "message": "Step 2 started"}
    ```
  - Độ trễ truyền log trung bình < 500ms giữa thời điểm ghi và nhận.
  - Nhận được sự kiện đóng stream khi job hoàn tất.
- **Hậu điều kiện / Cleanup:** Đóng client socket.

---

### TC-10: Secret Masking Verification (Che giấu API keys trong log)
- **Mã kịch bản:** `TC-10`
- **Mục tiêu:** Xác minh hệ thống lọc và thay thế toàn bộ chuỗi token, API key nhạy cảm (Anthropic, OpenAI, GitLab token, Bearer token) thành `***MASKED***` trong realtime SSE log và file log lưu trữ trên đĩa.
- **Tiêu chuẩn ánh xạ:** `AC-06`
- **Tiền điều kiện (Preconditions):**
  - Bộ lọc Secret Masking Filter của server đã kích hoạt.
- **Dữ liệu kiểm thử (Input Payload):**
  - Prompt tạo job yêu cầu agent in ra giá trị biến môi trường hoặc chuỗi token giả lập:
    ```json
    {
      "runner": "claude",
      "prompt": "echo 'Testing secrets: sk-ant-api03-abcdef1234567890abcdef and sk-proj-1234567890abcdef1234 and glpat-1234567890abcdef1234'",
      "timeoutSeconds": 60
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Tạo job và đồng thời theo dõi log stream qua SSE.
  2. Chờ job hoàn tất.
  3. Đọc lại toàn bộ log qua `GET /api/v1/jobs/{jobId}/logs`.
  4. Quét toàn bộ nội dung log stream và log file trên đĩa.
- **Kết quả mong đợi (Expected Results):**
  - Trong log SSE và log file, tuyệt đối không xuất hiện các chuỗi nguyên bản:
    - `sk-ant-api03-abcdef1234567890abcdef`
    - `sk-proj-1234567890abcdef1234`
    - `glpat-1234567890abcdef1234`
  - Các chuỗi trên đã được thay thế thành `***MASKED***`.
  - Không làm gián đoạn việc format hoặc đọc hiểu các log bình thường xung quanh.
- **Hậu điều kiện / Cleanup:** Dọn dẹp job log tạm thời.

---

### TC-11: Hard Timeout & Process Tree Kill (Tiêu diệt triệt để process con)
- **Mã kịch bản:** `TC-11`
- **Mục tiêu:** Xác minh khi job chạy vượt quá `timeoutSeconds`, server tự động ngắt kết nối, gửi tín hiệu hủy toàn bộ cây tiến trình (process tree kill) không để sót tiến trình mồ côi (zombie/orphan process), cập nhật trạng thái `TIMED_OUT`.
- **Tiêu chuẩn ánh xạ:** `AC-07`, `AC-08`
- **Tiền điều kiện (Preconditions):**
  - Cấu hình job với `timeoutSeconds = 5`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Request tạo job thực hiện lệnh sleep hoặc tác vụ vô tận:
    ```json
    {
      "runner": "claude",
      "prompt": "Chạy vòng lặp vô tận hoặc sleep 60s để test timeout",
      "timeoutSeconds": 5
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo job. Nhận `jobId`.
  2. Lấy PID của tiến trình gốc và các tiến trình con được spawn ra.
  3. Chờ 6 giây (vượt qua mốc timeout 5s).
  4. Kiểm tra trạng thái job qua `GET /api/v1/jobs/{jobId}`.
  5. Kiểm tra danh sách tiến trình trên OS (Windows Tasklist hoặc Unix ps) đối với PID gốc và toàn bộ PID con.
- **Kết quả mong đợi (Expected Results):**
  - Sau đúng 5 giây, server kích hoạt timeout watchdog.
  - Lệnh kill process tree được thực thi (`taskkill /F /T /PID <pid>` trên Windows hoặc `SIGKILL` tới Process Group trên Linux).
  - Không có bất kỳ process con nào tiếp tục chạy ngầm.
  - Trạng thái của job chuyển thành `TIMED_OUT`.
  - Log cuối của job ghi nhận cảnh báo: `Job exceeded execution timeout of 5 seconds. Process tree killed.`
- **Hậu điều kiện / Cleanup:** Giải phóng slot trong worker pool.

---

### TC-12: Job Cancellation via API (Hủy an toàn trong 5s)
- **Mã kịch bản:** `TC-12`
- **Mục tiêu:** Xác minh khi gọi API hủy tác vụ `POST /api/v1/jobs/{id}/cancel`, server lập tức tiêu diệt toàn bộ tiến trình agent và tiến trình con trong vòng tối đa 5 giây, cập nhật trạng thái thành `CANCELLED`.
- **Tiêu chuẩn ánh xạ:** `AC-07`
- **Tiền điều kiện (Preconditions):**
  - Một job đang ở trạng thái `RUNNING` (tác vụ dài, ví dụ: 120 giây).
- **Dữ liệu kiểm thử (Input Payload):**
  - Tạo job: `{ "runner": "opencode", "prompt": "Chạy tác vụ build lớn 120s", "timeoutSeconds": 180 }`
  - Lệnh hủy: `POST /api/v1/jobs/{jobId}/cancel`
- **Các bước thực hiện (Steps):**
  1. Gửi tạo job, đợi trạng thái chuyển thành `RUNNING`.
  2. Ghi nhận thời điểm $T_0$.
  3. Gửi request `POST /api/v1/jobs/{jobId}/cancel`.
  4. Đo thời gian phản hồi $T_1$ và thời gian trạng thái chuyển sang `CANCELLED` $T_2$.
  5. Kiểm tra tình trạng tiến trình OS.
- **Kết quả mong đợi (Expected Results):**
  - API trả về HTTP Status `200 OK` (hoặc `202 Accepted`) với nội dung xác nhận hủy.
  - Thời gian từ lúc gọi cancel đến khi toàn bộ tiến trình dừng hẳn $\Delta T = T_2 - T_0 \le 5$ giây.
  - Trạng thái job cập nhật thành `CANCELLED`.
  - Worker slot được giải phóng ngay lập tức cho các tác vụ tiếp theo.
- **Hậu điều kiện / Cleanup:** Worktree được thu hồi an toàn vào Trash.

---

### TC-13: Idle Hang Detection (Phát hiện agent treo)
- **Mã kịch bản:** `TC-13`
- **Mục tiêu:** Xác minh server có khả năng phát hiện khi một CLI agent bị treo không sinh log đầu ra (stdout/stderr) trong khoảng thời gian cấu hình `idleTimeoutSeconds` (ví dụ: đang chờ input ngầm từ bàn phím), tự động ngắt và gắn cờ cảnh báo `IDLE_TIMEOUT` hoặc `HANG_DETECTED`.
- **Tiêu chuẩn ánh xạ:** `AC-07`, `AC-08`
- **Tiền điều kiện (Preconditions):**
  - Server bật tính năng `idleHangDetection: true` với `idleTimeoutSeconds = 10`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Job kích hoạt một script chặn luồng nhập (chờ `stdin` vô hạn nhưng không in log):
    ```json
    {
      "runner": "omp",
      "prompt": "Mô phỏng prompt bị treo input",
      "timeoutSeconds": 60,
      "idleTimeoutSeconds": 10
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Kích hoạt job.
  2. Quan sát log stream. Sau dòng log đầu tiên, tiến trình rơi vào trạng thái im lặng không có bất kỳ output nào.
  3. Đợi 11 giây.
  4. Kiểm tra trạng thái job qua API.
- **Kết quả mong đợi (Expected Results):**
  - Sau 10 giây im lặng, Idle Monitor phát hiện vi phạm ngưỡng không có output.
  - Server kích hoạt ngắt tiến trình agent.
  - Trạng thái job cập nhật thành `FAILED` kèm mã lỗi / lý do `IDLE_HANG_DETECTED` hoặc `IDLE_TIMEOUT`.
  - Không để tiến trình chiếm dụng worker slot đến hết mốc `timeoutSeconds` (60s).
- **Hậu điều kiện / Cleanup:** Dọn dẹp tài nguyên.

---

### TC-14: Safe File Recycling (Chuyển vào Trash, không xóa vĩnh viễn)
- **Mã kịch bản:** `TC-14`
- **Mục tiêu:** Xác minh quy tắc tiên quyết an toàn tuyệt đối: Khi dọn dẹp worktree tạm thời, file log cũ, hoặc workspace của job đã hủy/hoàn thành, hệ thống BẮT BUỘC sử dụng hàm chuyển vào thùng rác (Recycle Bin / Trash), TUYỆT ĐỐI KHÔNG dùng lệnh xóa vĩnh viễn (`rm -rf` hoặc `os.remove` / `fs.rmSync(..., { recursive: true })` trực tiếp).
- **Tiêu chuẩn ánh xạ:** `AC-04`, `SAFE-01` (Quy tắc an toàn hệ thống)
- **Tiền điều kiện (Preconditions):**
  - Hệ điều hành host hỗ trợ Recycle Bin (Windows) hoặc Trash (Linux/macOS).
  - Thư viện an toàn (ví dụ: `send2trash` trên Python hoặc `trash` trên Node.js) đã được tích hợp vào server worker.
- **Dữ liệu kiểm thử (Input Payload):**
  - Tạo job tạo file tạm thời trong workspace:
    ```json
    {
      "runner": "claude",
      "prompt": "Tạo workspace tạm thời và hoàn thành job",
      "cleanupWorkspace": true
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Khởi tạo job và ghi nhận đường dẫn workspace tạm thời (ví dụ: `.worktrees/temp-job-14`).
  2. Cho job chạy hoàn tất hoặc gọi cancel để kích hoạt luồng cleanup.
  3. Kiểm tra mã nguồn module dọn dẹp để đảm bảo không gọi direct unlink/delete.
  4. Kiểm tra sự biến mất của thư mục `.worktrees/temp-job-14` tại vị trí làm việc.
  5. Mở và kiểm tra thùng rác của hệ điều hành (Recycle Bin trên Windows hoặc `~/.local/share/Trash` trên Linux).
- **Kết quả mong đợi (Expected Results):**
  - Thư mục `.worktrees/temp-job-14` không còn tồn tại ở vị trí cũ trong project.
  - Thư mục trên được tìm thấy nguyên vẹn bên trong Thùng rác (Recycle Bin / Trash) của hệ điều hành.
  - Audit log của server ghi nhận rõ ràng: `Moved workspace '.worktrees/temp-job-14' to Trash/Recycle Bin successfully`.
  - Không có bất kỳ lệnh xóa vĩnh viễn nào được thực thi.
- **Hậu điều kiện / Cleanup:** Người kiểm thử có thể khôi phục lại file từ Recycle Bin nếu cần đối chứng.

---

### TC-15: Single Server Web Access (Truy cập Web UI cùng cổng API)
- **Mã kịch bản:** `TC-15`
- **Mục tiêu:** Xác minh mô hình kiến trúc Single Server: Truy cập Web UI Dashboard qua trình duyệt tại địa chỉ `http://localhost:PORT` (ví dụ: `http://localhost:3000/`) được phục vụ thành công tài nguyên HTML/CSS/JS tĩnh của Dashboard SPA, đồng thời các endpoint REST API (`/api/v1/*`) và Server-Sent Events/WebSocket (`/api/v1/jobs/:id/events`) hoạt động ổn định trên cùng một cổng HTTP mà không cần web server hay reverse proxy riêng biệt.
- **Tiêu chuẩn ánh xạ:** `AC-10`
- **Tiền điều kiện (Preconditions):**
  - AI Worker Node.js Server đã được khởi động và lắng nghe trên cổng duy nhất (ví dụ: `PORT=3000`).
  - Web UI Dashboard tĩnh đã được đóng gói và đặt trong thư mục public/static của server.
- **Dữ liệu kiểm thử (Input Payload):**
  - Gửi request HTTP GET tới `http://localhost:3000/` với Header `Accept: text/html`.
  - Gửi request HTTP GET tới `http://localhost:3000/api/v1/health` với Header `Accept: application/json`.
  - Gửi request HTTP GET tới URL route client-side `http://localhost:3000/jobs/job-test-01` với Header `Accept: text/html`.
- **Các bước thực hiện (Steps):**
  1. Gửi HTTP GET request tới `http://localhost:3000/`.
  2. Kiểm tra mã trạng thái phản hồi HTTP, Header `Content-Type`, và nội dung tài liệu HTML (thẻ `<title>`, thẻ script bundle, thẻ style, container root của Dashboard).
  3. Gửi HTTP GET request tới API endpoint `http://localhost:3000/api/v1/health` trên cùng cổng.
  4. Kiểm tra phản hồi API đảm bảo không bị xung đột với middleware static file serving.
  5. Gửi HTTP GET request tới route SPA con `http://localhost:3000/jobs/job-test-01` để kiểm tra cơ chế HTML5 History API fallback.
- **Kết quả mong đợi (Expected Results):**
  - Request tới `http://localhost:3000/` trả về mã HTTP `200 OK`, `Content-Type: text/html`, tải trọn vẹn mã nguồn trang Web UI Dashboard.
  - Request tới `/api/v1/health` trả về mã HTTP `200 OK`, `Content-Type: application/json`, payload JSON đúng định dạng của API.
  - Các static asset (CSS, JavaScript bundle, SVG icons) tải về thành công với mã HTTP `200 OK`.
  - Request tới route SPA con trả về nội dung `index.html` với mã HTTP `200 OK` (không bị lỗi `404 Not Found`).
- **Hậu điều kiện / Cleanup:** Không phát sinh trạng thái rác hoặc tài nguyên cần dọn dẹp.

---

### TC-16: Step-by-step Visual Tracing (Hiển thị trực quan timeline 5 bước)
- **Mã kịch bản:** `TC-16`
- **Mục tiêu:** Xác minh tính năng Step-by-step Visual Tracing: Giao diện Web UI Dashboard hiển thị chính xác timeline tiến trình 5 bước của Agent (`1. Provisioning`, `2. Planning`, `3. Tool Execution`, `4. File Modifications & Git Diff`, `5. Finalization & Verification`) theo thời gian thực (realtime) với các trạng thái tương ứng (`pending`, `running`, `completed`, `failed`) khi tác vụ đang được thực thi.
- **Tiêu chuẩn ánh xạ:** `AC-11`
- **Tiền điều kiện (Preconditions):**
  - AI Worker Server đang chạy bình thường và kết nối SSE (`/api/v1/jobs/:id/events`) hoạt động ổn định.
  - Trình duyệt đang mở trang chi tiết Job trên Web UI Dashboard.
- **Dữ liệu kiểm thử (Input Payload):**
  - Payload tạo Job mới:
    ```json
    {
      "runner": "claude",
      "prompt": "Tạo hàm cộng hai số nguyên và cập nhật file math.ts",
      "worktree": true
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi lệnh tạo Job mới qua Web UI hoặc REST API và mở giao diện chi tiết Job (`/jobs/{jobId}`).
  2. Quan sát thành phần timeline 5 bước trên giao diện Dashboard khi Job bắt đầu:
     - Bước 1 - Provisioning (`PROVISIONING`): Chuẩn bị môi trường, khởi tạo Git Worktree độc lập, cấp phát worker slot.
     - Bước 2 - Planning (`PLANNING`): Agent đọc yêu cầu, phân tích prompt, lập kế hoạch thực thi.
     - Bước 3 - Tool Execution (`TOOL_EXECUTION`): Agent gọi các công cụ (đọc code, tìm kiếm, chạy lệnh).
     - Bước 4 - File Modifications & Git Diff (`FILE_MODIFICATION`): Agent ghi các thay đổi vào file, trích xuất git diff.
     - Bước 5 - Finalization & Verification (`VERIFICATION`): Chạy xác minh kiểm thử, hoàn tất tác vụ và đóng workspace.
  3. Kiểm tra sự kiện SSE truyền từ server về client và đối chiếu với chuyển đổi trạng thái trực quan trên UI (icon xoay đang chạy, badge màu xanh lá khi hoàn thành, badge màu đỏ khi lỗi).
- **Kết quả mong đợi (Expected Results):**
  - Web UI hiển thị đầy đủ và rõ ràng 5 bước theo đúng thứ tự logic đã thiết kế.
  - Mỗi bước chuyển trạng thái đồng bộ với backend event: Ban đầu ở `pending`, khi bắt đầu chuyển sang `running` (có animation/spinner), khi hoàn thành chuyển sang `completed` (hiển thị dấu kiểm checkmark).
  - Độ trễ hiển thị từ khi backend phát event đến khi giao diện UI cập nhật không quá 500ms.
  - Khi tác vụ kết thúc thành công, cả 5 bước hiển thị trạng thái `completed`.
- **Hậu điều kiện / Cleanup:** Worker slot được giải phóng, workspace tạm thời được chuyển vào Thùng rác (Recycle Bin / Trash).

---

### TC-17: Web-based Job Cancellation & Control (Hủy và điều khiển tác vụ từ UI)
- **Mã kịch bản:** `TC-17`
- **Mục tiêu:** Xác minh chức năng kiểm soát tiến trình từ giao diện Web UI: Người dùng có thể nhấn nút "Cancel Task" trên Web UI để gửi lệnh dừng tác vụ ngay lập tức; hệ thống đảm bảo dừng hoàn toàn AI Runner cùng toàn bộ cây tiến trình con (process tree) trong tối đa 5 giây (<= 5s) và cập nhật trạng thái trên giao diện sang `CANCELLED`. Ngoài ra, người dùng có thể bấm nút "Re-run" để chạy lại tác vụ.
- **Tiêu chuẩn ánh xạ:** `AC-12`, `AC-07`
- **Tiền điều kiện (Preconditions):**
  - Một tác vụ AI Worker đang ở trạng thái thực thi `RUNNING` (ví dụ: prompt yêu cầu thực hiện nhiều bước xử lý).
  - Người dùng đang mở trang chi tiết Job trên Web UI Dashboard.
- **Dữ liệu kiểm thử (Input Payload):**
  - Job ID đang chạy: `job-control-test-01`.
  - Thao tác: Nhấn nút "Cancel Task" trên giao diện Web UI, xác nhận trên hộp thoại modal (Confirm Modal).
- **Các bước thực hiện (Steps):**
  1. Tạo và khởi chạy tác vụ Job có thời lượng thực thi dự kiến trên 30 giây.
  2. Mở trang Web UI của Job và quan sát trạng thái hiển thị `RUNNING`.
  3. Nhấn vào nút "Cancel Task" trên thanh công cụ điều khiển của Web UI.
  4. Nhấn nút xác nhận hủy trên hộp thoại modal cảnh báo.
  5. Giám sát request HTTP được Web UI gửi đi: `POST /api/v1/jobs/{jobId}/cancel`.
  6. Đo đếm thời gian từ thời điểm nhấn nút xác nhận đến khi tiến trình chính và các tiến trình con của CLI Runner kết thúc hoàn toàn trên hệ điều hành host.
  7. Quan sát cập nhật trạng thái trên Web UI Dashboard.
  8. Nhấn nút "Re-run" trên Web UI để kiểm tra việc tái kích hoạt tác vụ mới với cấu hình tham số tương tự.
- **Kết quả mong đợi (Expected Results):**
  - Web UI phát lệnh HTTP POST hủy tác vụ thành công, nhận phản hồi `200 OK` (hoặc `202 Accepted`).
  - Hệ thống thu hồi và tiêu diệt triệt để cây tiến trình của CLI Runner trong thời gian <= 5 giây, không để lại tiến trình mồ côi (orphan process).
  - Web UI cập nhật trạng thái tác vụ thành `CANCELLED` ngay lập tức, bước hiện tại trên timeline chuyển sang trạng thái dừng.
  - Nút "Re-run" hiển thị và cho phép tạo một Job mới với cùng tham số runner và prompt khi người dùng bấm vào.
- **Hậu điều kiện / Cleanup:** Worker slot được giải phóng, thư mục làm việc liên quan được dọn dẹp bằng cách chuyển vào Thùng rác (Recycle Bin / Trash).

---

### TC-18: Web Diff Viewer & Terminal Rendering (Xem Git Diff và Terminal ANSI)
- **Mã kịch bản:** `TC-18`
- **Mục tiêu:** Xác minh tính năng hiển thị chi tiết mã nguồn và log trên Web UI:
  1. Terminal UI (sử dụng xterm.js hoặc tương đương) hiển thị chính xác luồng log stream thời gian thực, thông dịch chuẩn xác các mã màu ANSI escape sequences và hỗ trợ cuộn tự động (auto-scroll).
  2. Diff Viewer (sử dụng thư viện diff2html hoặc component diff trực quan) hiển thị trực tiếp các thay đổi Git Diff với cú pháp tô màu sinh động (dòng thêm màu xanh `+`, dòng bớt màu đỏ `-`, hỗ trợ chế độ xem linh hoạt).
- **Tiêu chuẩn ánh xạ:** `AC-11`, `AC-12`, `AC-09`
- **Tiền điều kiện (Preconditions):**
  - Tác vụ đã tạo ra log có chứa mã định dạng ANSI màu sắc và phát sinh thay đổi file có git diff.
  - Người dùng đang mở trang chi tiết Job trên Web UI Dashboard và chuyển đổi giữa các tab "Terminal Logs" và "Git Diff".
- **Dữ liệu kiểm thử (Input Payload):**
  - Luồng log stream chứa chuỗi ký tự ANSI:
    `\u001b[32m[INFO]\u001b[0m Worker initialized successfully.\n\u001b[33m[WARN]\u001b[0m Retrying lock acquisition...\n\u001b[31m[ERROR]\u001b[0m Sample test error output.`
  - Nội dung Git Diff phát sinh:
    ```diff
    diff --git a/src/math.ts b/src/math.ts
    index 1234567..89abcdef 100644
    --- a/src/math.ts
    +++ b/src/math.ts
    @@ -1,3 +1,5 @@
    -export function add(a: number, b: number): number { return 0; }
    +export function add(a: number, b: number): number {
    +  return a + b;
    +}
    ```
- **Các bước thực hiện (Steps):**
  1. Mở trang Web UI chi tiết của Job.
  2. Chọn tab "Terminal Logs":
     - Quan sát hiển thị log: kiểm tra các mã màu ANSI (xanh lá `[INFO]`, vàng `[WARN]`, đỏ `[ERROR]`) có được hiển thị bằng màu sắc đồ họa chuẩn thay vì các chuỗi ký tự escape thô (`\u001b[...]`).
     - Cuộn thanh cuộn lên trên và kiểm tra chức năng Auto-scroll khi có log mới được đẩy về.
  3. Chọn tab "Git Diff":
     - Kiểm tra danh sách các file đã thay đổi hiển thị ở thanh điều hướng bên trái hoặc đầu trang.
     - Kiểm tra khối hiển thị diff: dòng thêm mới màu nền xanh lá với ký tự `+`, dòng bị xóa màu nền đỏ với ký tự `-`.
     - Kiểm tra hiển thị số dòng tương ứng của file gốc và file mới.
     - Kiểm tra nút chuyển đổi chế độ xem Line-by-line (Inline) và Side-by-side (nếu hỗ trợ).
- **Kết quả mong đợi (Expected Results):**
  - Terminal UI hiển thị log với định dạng phông chữ monospace, nền tối tiêu chuẩn, màu sắc ANSI được chuyển đổi chính xác không có rác ký tự.
  - Chức năng auto-scroll tự động cuộn xuống đáy màn hình khi có dòng log mới xuất hiện.
  - Diff Viewer phân tích cú pháp git diff chính xác, phân biệt trực quan các dòng thêm/xóa/sửa đổi bằng màu sắc rõ nét.
  - Giao diện phản hồi mượt mà, không gặp hiện tượng treo đơ trình duyệt khi tải log lớn hoặc diff có nhiều file.
- **Hậu điều kiện / Cleanup:** Đóng tab trình duyệt, hoàn tất kiểm thử.

---

### TC-19: Multi-Agent Step Configuration Verification
- **Mã kịch bản:** `TC-19`
- **Mục tiêu:** Xác minh hệ thống hỗ trợ cấu hình linh hoạt các CLI runner/agent khác nhau cho từng bước trong quy trình thực thi (Planning, Implementing, Testing, Fixing) thông qua file cấu hình `config.json` (hoặc YAML) và cho phép ghi đè (override) trực tiếp qua Web UI / API khi khởi tạo job. Hệ thống kích hoạt chính xác agent được cấu hình cho từng giai đoạn tương ứng.
- **Tiêu chuẩn ánh xạ:** `AC-13`
- **Tiền điều kiện (Preconditions):**
  - AI Worker Server đang chạy bình thường.
  - Các CLI Runner (`claude`, `opencode`, `omp`, `antigravity`) đã được cấu hình trong hệ thống hoặc có mock runner khả dụng.
- **Dữ liệu kiểm thử (Input Payload):**
  - File cấu hình mặc định `config.json`:
    ```json
    {
      "pipeline": {
        "defaultStepAgents": {
          "planning": "claude",
          "implementing": "opencode",
          "testing": "omp",
          "fixing": "claude"
        }
      }
    }
    ```
  - Payload override khi trigger Job qua API `POST /api/v1/jobs` hoặc chọn trên Web UI:
    ```json
    {
      "repoUrl": "https://github.com/example/sample-repo.git",
      "prompt": "Triển khai tính năng đăng nhập và viết test",
      "stepAgents": {
        "planning": "claude",
        "implementing": "opencode",
        "testing": "omp",
        "fixing": "claude"
      }
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Khởi động AI Worker Server và kiểm tra cấu hình mặc định `defaultStepAgents` trong file `config.json`.
  2. Mở Web UI tạo Job mới, chọn các agent tương ứng cho từng bước:
     - Bước 1 (Planning): Chọn `claude`.
     - Bước 2 (Implementing): Chọn `opencode`.
     - Bước 3 (Testing): Chọn `omp`.
     - Bước 4 (Fixing): Chọn `claude`.
  3. Gửi yêu cầu tạo job qua Web UI (hoặc gửi payload trực tiếp tới API `POST /api/v1/jobs`).
  4. Theo dõi timeline trên Web UI và kiểm tra thông tin chi tiết từng bước qua API `GET /api/v1/jobs/{jobId}`.
  5. Đối chiếu process ID và command-line của từng tiến trình con được spawn trong mỗi bước trên host OS để xác nhận đúng CLI binary tương ứng.
- **Kết quả mong đợi (Expected Results):**
  - Job được khởi tạo thành công với HTTP Status 201 Created và lưu đúng cấu hình `stepAgents`.
  - Trong giai đoạn `PLANNING`: Tiến trình runner `claude` được kích hoạt và thực thi phân tích.
  - Trong giai đoạn `IMPLEMENTING`: Tiến trình runner `opencode` được kích hoạt để sinh mã nguồn.
  - Trong giai đoạn `TESTING`: Tiến trình runner `omp` được kích hoạt để chạy bộ kiểm thử.
  - Web UI Timeline hiển thị icon, tên agent tương ứng cho từng bước (`Planning: claude`, `Implementing: opencode`, `Testing: omp`, `Fixing: claude`).
  - Toàn bộ log stream thể hiện rõ sự chuyển giao giữa các agent mà không bị gián đoạn session hoặc mất context workspace.
- **Hậu điều kiện / Cleanup:** Thu hồi các tiến trình worker và dọn dẹp worktree vào Thùng rác (Recycle Bin / Trash).

---

### TC-20: Testing to Fixing State Transition on Test Failure
- **Mã kịch bản:** `TC-20`
- **Mục tiêu:** Xác minh vòng đời chuyển đổi trạng thái tự động khi bước `TESTING` phát hiện lỗi kiểm thử hoặc build fail: Hệ thống tự động chuyển trạng thái từ `TESTING` sang `FIXING`, kích hoạt agent được gán cho bước Fixing kèm toàn bộ log lỗi để phân tích và tự động sửa mã nguồn, sau đó tự động quay lại bước `TESTING` để kiểm thử lại (Feedback loop). Khi bài test pass, job tiếp tục chuyển sang `FINALIZING` và `COMPLETED`.
- **Tiêu chuẩn ánh xạ:** `AC-14`
- **Tiền điều kiện (Preconditions):**
  - AI Worker Server đang chạy bình thường.
  - Repository kiểm thử mẫu có chứa một unit test ban đầu đang ở trạng thái FAIL (ví dụ: hàm trả về sai kết quả mong đợi).
  - Cấu hình `maxFixingRetries >= 1` (ví dụ: mặc định là 3).
- **Dữ liệu kiểm thử (Input Payload):**
  - Payload tạo Job:
    ```json
    {
      "repoUrl": "https://github.com/example/failing-calc-repo.git",
      "prompt": "Sửa lỗi hàm add() để vượt qua toàn bộ unit test",
      "stepAgents": {
        "planning": "claude",
        "implementing": "opencode",
        "testing": "omp",
        "fixing": "claude"
      },
      "maxFixingRetries": 3
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi yêu cầu tạo Job qua API `POST /api/v1/jobs`.
  2. Quan sát hệ thống thực hiện lần lượt các bước `PLANNING` -> `IMPLEMENTING` -> `TESTING`.
  3. Khi bước `TESTING` chạy lệnh test và phát hiện lỗi (exit code != 0, xuất hiện thông báo FAIL):
     - Ghi nhận trạng thái chuyển đổi trên timeline Web UI và qua polling `GET /api/v1/jobs/{jobId}`.
  4. Quan sát hệ thống tự động chuyển trạng thái Job sang `FIXING`:
     - Kiểm tra agent được chỉ định cho Fixing (`claude`) được spawn kèm context chứa stdout/stderr lỗi từ bước `TESTING`.
  5. Agent Fixing thực hiện chỉnh sửa file mã nguồn để khắc phục lỗi.
  6. Sau khi agent Fixing hoàn tất việc sửa lỗi, hệ thống tự động kích hoạt lại bước `TESTING` lần 2 (re-test).
  7. Lần kiểm thử thứ 2 thành công (exit code == 0, toàn bộ test PASS).
  8. Quan sát hệ thống chuyển tiếp sang `FINALIZING` và kết thúc với `COMPLETED`.
- **Kết quả mong đợi (Expected Results):**
  - Timeline trạng thái ghi nhận đầy đủ chuỗi chuyển đổi:
    `PLANNING` -> `IMPLEMENTING` -> `TESTING (Failed)` -> `FIXING (Attempt 1)` -> `TESTING (Passed)` -> `FINALIZING` -> `COMPLETED`.
  - Web UI cập nhật hiển thị bước `FIXING` màu vàng/cam cảnh báo đang sửa lỗi kèm số thứ tự lần lặp `Retry 1/3`.
  - Log của bước `FIXING` thể hiện agent nhận diện đúng nguyên nhân lỗi từ log test trước đó và áp dụng bản vá thành công.
  - Bước `TESTING` thứ 2 xác nhận kết quả kiểm thử đạt 100% PASS.
  - Job kết thúc thành công với trạng thái cuối cùng là `COMPLETED`.
- **Hậu điều kiện / Cleanup:** Dọn dẹp workspace tạm thời vào Thùng rác (Recycle Bin / Trash).

---

### TC-21: Max Fixing Retry Guardrail
- **Mã kịch bản:** `TC-21`
- **Mục tiêu:** Xác minh cơ chế chặn lặp vô hạn (Infinite Loop Prevention) và bảo vệ ngân sách khi mã nguồn liên tục không thể vượt qua bài kiểm thử. Khi số lần thử sửa lỗi vượt quá giới hạn `maxFixingRetries` (ví dụ: cấu hình là 3 lần), hệ thống phải dừng an toàn, không kích hoạt thêm vòng lặp Fixing, chuyển trạng thái Job sang `FAILED` kèm lý do lỗi rõ ràng `MAX_FIXING_RETRIES_EXCEEDED`.
- **Tiêu chuẩn ánh xạ:** `AC-14`, `R-14`, `R-15`
- **Tiền điều kiện (Preconditions):**
  - AI Worker Server đang chạy bình thường.
  - Repository kiểm thử mẫu có lỗi logic phức tạp hoặc test case cố tình không thể thỏa mãn (bài test luôn luôn fail).
  - Cấu hình `maxFixingRetries: 3`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Payload tạo Job:
    ```json
    {
      "repoUrl": "https://github.com/example/impossible-task-repo.git",
      "prompt": "Sửa lỗi bài toán không thể thỏa mãn",
      "stepAgents": {
        "planning": "claude",
        "implementing": "opencode",
        "testing": "omp",
        "fixing": "claude"
      },
      "maxFixingRetries": 3
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi yêu cầu tạo Job qua API `POST /api/v1/jobs`.
  2. Hệ thống thực thi qua các bước `PLANNING`, `IMPLEMENTING`, rồi chuyển vào `TESTING`.
  3. Lần test 1 thất bại -> Hệ thống chuyển sang `FIXING (Attempt 1)`.
  4. Agent hoàn tất sửa lỗi lần 1 -> Hệ thống quay lại `TESTING` -> Tiếp tục thất bại.
  5. Hệ thống chuyển sang `FIXING (Attempt 2)`.
  6. Agent hoàn tất sửa lỗi lần 2 -> Hệ thống quay lại `TESTING` -> Tiếp tục thất bại.
  7. Hệ thống chuyển sang `FIXING (Attempt 3)`.
  8. Agent hoàn tất sửa lỗi lần 3 -> Hệ thống quay lại `TESTING` -> Tiếp tục thất bại (Đạt ngưỡng retry thứ 3).
  9. Quan sát phản ứng của hệ thống sau khi lần test sau lượt retry thứ 3 thất bại.
- **Kết quả mong đợi (Expected Results):**
  - Hệ thống đếm chính xác số lần retry: `resolveRetryCount = 3`.
  - Sau lần kiểm thử thất bại thứ 3, hệ thống KHÔNG kích hoạt thêm bước `FIXING` lần thứ 4.
  - Job lập tức dừng an toàn, thu hồi toàn bộ tiến trình con và chuyển trạng thái sang `FAILED`.
  - Phản hồi từ API `GET /api/v1/jobs/{jobId}` và hiển thị trên Web UI:
    - `status`: `FAILED`
    - `errorCode`: `MAX_FIXING_RETRIES_EXCEEDED`
    - `errorMessage`: `Đã vượt quá số lần sửa lỗi tối đa (3/3 lần). Tiến trình dừng để bảo vệ tài nguyên.`
  - Web UI hiển thị thông báo lỗi rõ ràng trên thẻ trạng thái và đánh dấu bước `TESTING` / `FIXING` cuối cùng ở trạng thái thất bại màu đỏ.
  - Hệ thống không bị treo hoặc rò rỉ tiến trình nền, giải phóng worker slot kịp thời.
- **Hậu điều kiện / Cleanup:** Dọn dẹp workspace và di chuyển thư mục tạm vào Thùng rác (Recycle Bin / Trash).
---

### TC-22: Dual Planning Generation Verification
- **Mã kịch bản:** `TC-22`
- **Mục tiêu:** Xác minh hệ thống trong giai đoạn `PLANNING` có khả năng sinh song song đồng thời hai bản kế hoạch: Kế hoạch triển khai mã nguồn (`dev_plan.md`) và Kế hoạch kiểm thử chi tiết (`test_plan.md`). Kiểm tra `dev_plan.md` phân tích đầy đủ kiến trúc, danh sách file cần sửa đổi, API contracts và logic thực thi; kiểm tra `test_plan.md` liệt kê chi tiết các kịch bản test, các bước kiểm thử cụ thể (steps), dữ liệu kiểm thử/mock data cần dùng, và các điều kiện assertion mong đợi (visual assertions, DOM selectors, console check).
- **Tiêu chuẩn ánh xạ:** `AC-15`
- **Tiền điều kiện (Preconditions):**
  - AI Worker Server đang chạy bình thường.
  - Repository kiểm thử mẫu đã sẵn sàng trong workspace.
  - Job được khởi tạo ở trạng thái `TO DO` và được chuyển vào trạng thái `PLANNING`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Payload tạo Job:
    ```json
    {
      "repoUrl": "https://github.com/example/sample-web-app.git",
      "prompt": "Xây dựng tính năng Quản lý Danh mục Công việc (Todo List) gồm: tạo công việc mới, đánh dấu hoàn thành, xóa công việc, hiển thị số lượng công việc còn lại",
      "stepAgents": {
        "planning": "claude",
        "implementing": "opencode",
        "testing": "omp",
        "fixing": "claude"
      }
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Gửi yêu cầu tạo Job qua API `POST /api/v1/jobs`.
  2. Quan sát hệ thống tiếp nhận tác vụ ở trạng thái `TO DO` và tự động chuyển sang `PLANNING`.
  3. Tiến trình Agent/Dual Planning Generator kích hoạt để sinh song song cả hai kế hoạch.
  4. Kiểm tra sự xuất hiện của hai file trong workspace của job (`.workspaces/{jobId}/plans/dev_plan.md` và `.workspaces/{jobId}/plans/test_plan.md` hoặc thư mục feature tương ứng).
  5. Đọc và xác thực cấu trúc nội dung của `dev_plan.md`:
     - Có mục phân tích kiến trúc (Architecture Overview).
     - Có danh sách file cần tạo/chỉnh sửa (Target Files).
     - Có chi tiết API / State Management / UI Components.
     - Có trình tự các bước thực hiện mã nguồn rõ ràng, không có placeholder `...`.
  6. Đọc và xác thực cấu trúc nội dung của `test_plan.md`:
     - Có danh sách các test cases UI/E2E cụ thể.
     - Mỗi test case có các bước tương tác chi tiết: URL điều hướng, selector cần click, input text cần điền (fill).
     - Có bộ dữ liệu mẫu (Mock data / Test data payload) chuẩn bị sẵn.
     - Có điều kiện kiểm chứng (Assertions: element visibility, text content, screenshot checkpoint).
  7. Kiểm tra Web UI Dashboard hiển thị cả hai bản kế hoạch `Dev Plan` và `Test Plan` trên giao diện chi tiết Job.
  8. Xác nhận hệ thống chuyển trạng thái mượt mà từ `PLANNING` sang `IMPLEMENT` sau khi hai bản kế hoạch được tạo thành công.
- **Kết quả mong đợi (Expected Results):**
  - Cả hai file `dev_plan.md` và `test_plan.md` được sinh đầy đủ, cấu trúc mạch lạc, chuẩn kỹ thuật, không bị cắt cụt.
  - Trạng thái Job cập nhật tuần tự: `TO DO` -> `PLANNING` -> `IMPLEMENT`.
  - Web Dashboard hiển thị badge và tab cho phép chuyển đổi xem Dev Plan và Test Plan song song.
- **Hậu điều kiện / Cleanup:** Di chuyển các file tạm sinh ra vào Thùng rác (Recycle Bin / Trash).

---

### TC-23: Local Service Auto-Start & Readiness Probe
- **Mã kịch bản:** `TC-23`
- **Mục tiêu:** Xác minh hệ thống tự động khởi chạy dịch vụ kiểm thử cục bộ (Local Service Runner) bên trong workspace của job sau khi giai đoạn `IMPLEMENT` kết thúc và bắt đầu bước `TESTING`. Kiểm tra cơ chế Readiness Probe (port scanning / HTTP healthcheck ping lặp định kỳ) theo dõi tiến trình khởi động của dev server (ví dụ: `npm run dev`) cho đến khi phát hiện port đã mở và endpoint phản hồi HTTP 200 OK trước khi cho phép Browser Test Runner bắt đầu tương tác.
- **Tiêu chuẩn ánh xạ:** `AC-16`
- **Tiền điều kiện (Preconditions):**
  - Job đã hoàn tất bước `IMPLEMENT` thành công.
  - Workspace của job chứa mã nguồn ứng dụng web có cấu hình script khởi động (`npm run dev` hoặc `npm start`).
  - Cấu hình port hoặc cơ chế tự động cấp phát port động (Dynamic Port Discovery).
- **Dữ liệu kiểm thử (Input Payload):**
  - Cấu hình khởi động dịch vụ cục bộ:
    ```json
    {
      "localService": {
        "command": "npm run dev",
        "port": 3000,
        "readyPath": "/",
        "readyTimeoutMs": 30000,
        "probeIntervalMs": 500
      }
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Hệ thống chuyển trạng thái từ `IMPLEMENT` sang `TESTING`.
  2. Local Service Runner kích hoạt tiến trình con chạy lệnh `npm run dev` trong thư mục workspace.
  3. Healthcheck Watcher bắt đầu thực hiện Readiness Probe: gửi HTTP GET request lặp lại mỗi 500ms tới `http://localhost:3000/`.
  4. Theo dõi log stdout của local dev server được stream realtime về Web UI Terminal.
  5. Quan sát phản hồi từ Readiness Probe:
     - Trong 1-3 giây đầu: Service đang biên dịch (trả về Connection Refused hoặc pending) -> Hệ thống tiếp tục chờ mà không crash.
     - Khi dev server biên dịch xong: Trả về HTTP 200 OK.
  6. Xác nhận Healthcheck Watcher đánh dấu `SERVICE_READY` và chuyển giao quyền điều khiển cho Browser Test Runner.
  7. Kiểm tra kịch bản phụ (Failure Branch): Nếu quá 30 giây service không phản hồi (ví dụ: build lỗi cú pháp), hệ thống phải ngắt timeout an toàn với mã lỗi `LOCAL_SERVICE_STARTUP_TIMEOUT`.
- **Kết quả mong đợi (Expected Results):**
  - Tiến trình local service khởi chạy ổn định dưới nền (background child process), không làm block tiến trình chính của Worker Server.
  - Readiness Probe phát hiện chính xác thời điểm service sẵn sàng nhận request; không xảy ra hiện tượng race condition khi browser kết nối quá sớm.
  - Web UI Dashboard hiển thị thẻ thông tin "Local Service Active" kèm đường dẫn URL và chỉ số port.
- **Hậu điều kiện / Cleanup:** Dừng tiến trình local service thông qua `tree-kill` an toàn, giải phóng port mạng.

---

### TC-24: Browser E2E Test & Evidence Screenshot Capture
- **Mã kịch bản:** `TC-24`
- **Mục tiêu:** Xác minh Browser Test Runner (sử dụng MCP CloakBrowser hoặc Playwright headless) tự động kết nối vào URL của local service, thực hiện tương tác UI (navigate, click, fill input, verify DOM elements) theo từng bước đã định nghĩa trong `test_plan.md`, chụp ảnh màn hình (screenshot) tại các checkpoint quan trọng và lưu trữ có cấu trúc vào thư mục `feature/<feature-name>/evidence/` (hoặc `docs/features/<TICKET-ID>/evidence/`) kèm metadata JSON.
- **Tiêu chuẩn ánh xạ:** `AC-16`
- **Tiền điều kiện (Preconditions):**
  - Local service đang chạy ổn định và đã vượt qua Readiness Probe từ `TC-23`.
  - Thư mục lưu trữ evidence đã được cấp quyền ghi.
- **Dữ liệu kiểm thử (Input Payload):**
  - Kịch bản các bước kiểm thử trong `test_plan.md`:
    ```json
    {
      "testSteps": [
        { "step": 1, "action": "navigate", "url": "http://localhost:3000" },
        { "step": 2, "action": "fill", "selector": "#todo-input", "value": "Viết unit test cho AI Worker" },
        { "step": 3, "action": "click", "selector": "#add-btn" },
        { "step": 4, "action": "verify", "selector": ".todo-item", "expectedCount": 1 }
      ],
      "evidenceDir": "feature/Create-AI-Worker/evidence"
    }
    ```
- **Các bước thực hiện (Steps):**
  1. Browser Test Runner khởi chạy instance Chromium ở chế độ headless.
  2. Mở tab mới và điều hướng tới URL `http://localhost:3000`.
  3. Chụp ảnh màn hình bước 1: lưu file `evidence/step-01-initial-page.png`.
  4. Thực hiện điền dữ liệu vào ô `#todo-input` và nhấn nút `#add-btn`.
  5. Chờ DOM cập nhật và chụp ảnh màn hình bước 2: lưu file `evidence/step-02-item-added.png`.
  6. Tạo file `evidence/metadata.json` chứa thông tin chi tiết: tên ảnh, thời gian chụp, kích thước viewport, test step tương ứng, URL hiện tại.
  7. Kiểm tra việc đóng instance trình duyệt (`browser.close()`) sạch sẽ sau khi hoàn tất chuỗi kiểm thử.
  8. Mở Web UI Dashboard trên tab "Visual Evidence": kiểm tra các ảnh thumbnail được hiển thị trực quan kèm metadata.
- **Kết quả mong đợi (Expected Results):**
  - Browser runner thực hiện tuần tự và chính xác tất cả thao tác giao diện mà không gặp unhandled rejection.
  - Các file ảnh screenshot được lưu thành công vào đúng thư mục `evidence/`, định dạng PNG chuẩn, hình ảnh rõ nét, phản ánh đúng trạng thái thực tế của giao diện.
  - File `metadata.json` lưu trữ đầy đủ thông tin ngữ cảnh của từng ảnh.
  - Trình duyệt headless đóng hoàn toàn, không để lại tiến trình zombie Chrome/Chromium chạy ngầm trên máy host.
- **Hậu điều kiện / Cleanup:** Dọn dẹp session trình duyệt; di chuyển file tạm vào Thùng rác (Recycle Bin / Trash).

---

### TC-25: Visual Verification Failure to FIXING Handoff
- **Mã kịch bản:** `TC-25`
- **Mục tiêu:** Xác minh kịch bản kiểm thử giao diện phát hiện lỗi (ví dụ: giao diện bị lệch bố cục, thiếu nút bấm, lỗi JavaScript console hoặc vi phạm assertion từ `test_plan.md`): Visual Verifier (sử dụng Multimodal Vision LLM kết hợp DOM verification) phân tích ảnh screenshot evidence và đánh giá `FAIL`. Hệ thống tự động đóng gói toàn bộ ngữ cảnh lỗi thành Context Handoff Pack (bao gồm ảnh screenshot bằng chứng, console error logs, test step failed, current git diff) và chuyển trạng thái từ `TESTING` sang `FIXING`, kích hoạt Agent chuyên trách sửa lỗi.
- **Tiêu chuẩn ánh xạ:** `AC-17`
- **Tiền điều kiện (Preconditions):**
  - Local service đang chạy.
  - Mã nguồn trong bước `IMPLEMENT` cố ý tạo ra lỗi giao diện (ví dụ: nút "Xóa" bị ẩn do CSS `display: none` hoặc hàm xử lý click bị lỗi syntax ném ra uncaught error).
- **Dữ liệu kiểm thử (Input Payload):**
  - Test step yêu cầu: "Nút Xóa phải hiển thị và click được để xóa công việc".
  - Giao diện thực tế: Nút Xóa bị ẩn hoàn toàn trên màn hình.
- **Các bước thực hiện (Steps):**
  1. Browser runner thực hiện test step kiểm tra nút Xóa -> Không tìm thấy phần tử hiển thị trong viewport.
  2. Chụp ảnh màn hình bằng chứng: `evidence/step-03-delete-button-missing.png`.
  3. Thu thập toàn bộ console logs từ trình duyệt (ghi nhận lỗi nếu có) và DOM snapshot.
  4. Visual Verifier phân tích ảnh screenshot `step-03-delete-button-missing.png`:
     - So sánh đối chiếu với yêu cầu trong `test_plan.md`.
     - Kết luận: Nút Xóa không xuất hiện trên giao diện.
     - Đánh giá kiểm thử: `VERDICT: FAIL`.
  5. Hệ thống kích hoạt cơ chế Handoff:
     - Tạo Context Handoff Pack với các trường:
       ```json
       {
         "status": "FAIL",
         "failedStep": 3,
         "description": "Nút Xóa (.delete-btn) không hiển thị trong viewport",
         "evidenceImagePath": "feature/Create-AI-Worker/evidence/step-03-delete-button-missing.png",
         "consoleErrors": ["Error: Element .delete-btn not found or invisible"],
         "gitDiff": "diff --git a/src/TodoList.vue b/src/TodoList.vue..."
       }
       ```
     - Chuyển trạng thái Job từ `TESTING` sang `FIXING`.
     - Kích hoạt Fixing Agent (được chỉ định trong `stepAgents.fixing`), nạp toàn bộ Context Handoff Pack làm prompt chỉ đạo.
  6. Kiểm tra giao diện Web UI Dashboard:
     - Timeline chuyển trạng thái sang màu cam cảnh báo `FIXING`.
     - Hiển thị trực quan ảnh screenshot lỗi và log stack trace tương ứng để lập trình viên theo dõi.
- **Kết quả mong đợi (Expected Results):**
  - Visual Verifier phát hiện chính xác lỗi giao diện dựa trên bằng chứng screenshot và DOM.
  - Context Handoff Pack được đóng gói đầy đủ, chứa đường dẫn ảnh, log lỗi và diff mà không bị cắt cụt (no `...`).
  - Trạng thái Job chuyển đổi mượt mà từ `TESTING` sang `FIXING`.
  - Fixing Agent được khởi động với đầy đủ ngữ cảnh và tiến hành phân tích mã nguồn để sửa lỗi.
- **Hậu điều kiện / Cleanup:** Dọn dẹp an toàn qua Thùng rác (Recycle Bin / Trash).

---

### TC-26: Re-test Verification Success to DONE
- **Mã kịch bản:** `TC-26`
- **Mục tiêu:** Xác minh vòng lặp tự phục hồi khép kín (Self-Healing Loop): Sau khi Agent trong giai đoạn `FIXING` phân tích ngữ cảnh từ `TC-25`, sửa chữa mã nguồn thành công và cập nhật workspace -> Hệ thống tự động chuyển trạng thái từ `FIXING` quay lại `TESTING` -> Tự động re-start/hot-reload local service -> Browser Test Runner chạy lại toàn bộ Test Plan -> Chụp ảnh screenshot mới vào `evidence/` -> Visual Verifier đánh giá `PASS` 100% -> Hệ thống chính thức chuyển trạng thái sang `DONE`, nghiệm thu hoàn tất.
- **Tiêu chuẩn ánh xạ:** `AC-17`
- **Tiền điều kiện (Preconditions):**
  - Job đang ở trạng thái `FIXING` sau bước `TC-25`.
  - Fixing Agent hoàn thành sửa mã nguồn (đã gỡ bỏ `display: none` và hiển thị nút Xóa đúng chuẩn).
- **Dữ liệu kiểm thử (Input Payload):**
  - Mã nguồn đã được sửa lỗi; Test Plan tương ứng với đầy đủ tiêu chí nghiệm thu.
- **Các bước thực hiện (Steps):**
  1. Fixing Agent gửi tín hiệu hoàn tất sửa lỗi kèm tóm tắt các thay đổi đã thực hiện.
  2. Hệ thống ghi nhận commit mới trong workspace của job và tự động chuyển trạng thái từ `FIXING` sang `TESTING` (Lần test thứ 2).
  3. Local service tự động cập nhật code mới (hot-reload hoặc khởi động lại), Readiness Probe xác nhận service sẵn sàng.
  4. Browser Test Runner khởi chạy lại kịch bản kiểm thử:
     - Thực hiện lại chuỗi test steps từ đầu đến cuối.
     - Bước 3: Tìm nút Xóa -> Nút Xóa hiển thị hợp lệ, click thực hiện xóa công việc thành công.
     - Chụp ảnh screenshot mới lưu vào: `evidence/step-03-delete-button-fixed.png`.
  5. Visual Verifier phân tích ảnh mới:
     - Xác nhận nút Xóa đã xuất hiện đầy đủ, bố cục cân đối, phản hồi click chuẩn xác.
     - Không còn bất kỳ console error nào.
     - Đánh giá kiểm thử: `VERDICT: PASS`.
  6. Hệ thống thực hiện teardown: dừng local service, đóng browser instance, thu hồi tài nguyên an toàn.
  7. Chuyển trạng thái Job từ `TESTING` sang `DONE`.
  8. Kiểm tra Web UI Dashboard:
     - Trạng thái Job hiển thị huy hiệu màu xanh lá `DONE`.
     - Bảng tổng kết hiển thị đầy đủ danh sách file đã thay đổi, ảnh bằng chứng thành công (`step-03-delete-button-fixed.png`), và tổng thời gian thực hiện qua các chu kỳ.
- **Kết quả mong đợi (Expected Results):**
  - Vòng lặp chuyển trạng thái `FIXING` -> `TESTING` -> `DONE` diễn ra hoàn toàn tự động, trơn tru.
  - Ảnh screenshot mới phản ánh giao diện đã khắc phục lỗi thành công.
  - Toàn bộ tiến trình con (local service, headless browser) được dừng sạch sẽ, không có rò rỉ tài nguyên.
  - Trạng thái cuối cùng của Job là `DONE`, đạt 100% tiêu chí nghiệm thu.
- **Hậu điều kiện / Cleanup:** Dọn dẹp workspace tạm; chuyển các file rác phát sinh vào Thùng rác (Recycle Bin / Trash).

### TC-27: Live Terminal Streaming & ANSI Fidelity Verification
- **Mã kịch bản:** `TC-27`
- **Mục tiêu:** Xác minh tính năng Live Terminal Streaming View hiển thị trực tiếp dòng xuất stdout/stderr từ tiến trình runner (Host Child Process) lên giao diện Web UI sử dụng xterm.js: đảm bảo stream dữ liệu thời gian thực với độ trễ < 500ms, bảo toàn nguyên vẹn các mã màu và định dạng ANSI (ANSI color escape codes), hỗ trợ auto-scroll theo dòng mới xuất hiện, và cho phép sao chép log thô (raw logs) chính xác.
- **Tiêu chuẩn ánh xạ:** `AC-05`, `AC-11`, `AC-12`, `AC-18`
- **Tiền điều kiện (Preconditions):**
  - Worker service đang chạy và Web UI Dashboard đang mở trên trình duyệt.
  - Một Job đang được khởi chạy với CLI runner (ví dụ: `claude` hoặc `codex`) sinh mã và xuất log liên tục có chứa các chuỗi ANSI escape (màu xanh lá, đỏ, vàng, in đậm, progress spinner).
- **Dữ liệu kiểm thử (Input Payload):**
  - Payload tạo Job: `POST /api/v1/jobs` với lệnh sinh output chứa đa dạng ANSI codes: màu sắc `\u001b[32mSUCCESS\u001b[0m`, `\u001b[31mERROR\u001b[0m`, và các dòng log nhiều định dạng.
- **Các bước thực hiện (Steps):**
  1. Gửi request tạo Job mới để kích hoạt tiến trình Host Child Process.
  2. Mở trang chi tiết Job trên Web UI Dashboard, chuyển sang tab "Live Terminal".
  3. Kết nối kênh WebSocket/SSE stream log của Job (`/api/v1/jobs/{id}/stream`).
  4. Quan sát hiển thị của component xterm.js:
     - Đo lường độ trễ từ thời điểm tiến trình con in ra stdout đến khi dòng chữ xuất hiện trên xterm.js (yêu cầu < 500ms).
     - Kiểm tra kết xuất trực quan: các mã màu ANSI được render chuẩn xác thành màu sắc trên canvas/DOM (xanh cho thành công, đỏ cho lỗi, không bị hiển thị chuỗi escape thô như `^[[32m`).
  5. Khi log tiếp tục sinh thêm nhiều dòng vượt quá chiều cao viewport của terminal, kiểm tra tính năng auto-scroll tự cuộn xuống đáy.
  6. Thực hiện thao tác chọn văn bản và bấm nút "Copy Raw Logs" hoặc copy trực tiếp từ xterm.js, đối chiếu với raw stream nhận được qua WebSocket.
- **Kết quả mong đợi (Expected Results):**
  - Độ trễ truyền phát log trung bình < 500ms, không xảy ra hiện tượng drop gói tin hoặc giật lag UI.
  - Thư viện xterm.js render chuẩn xác 100% các mã định dạng và màu sắc ANSI.
  - Thanh cuộn tự động cuộn theo dòng log mới nhất trừ khi người dùng chủ động cuộn ngược lên để xem log cũ.
  - Chức năng copy log giữ đúng nội dung văn bản nguyên bản.
- **Hậu điều kiện / Cleanup:** Đóng kết nối WebSocket/SSE; dọn dẹp workspace tạm; chuyển các file rác phát sinh vào Thùng rác (Recycle Bin / Trash).

### TC-28: Multi-Verification Evidence Gate Pass
- **Mã kịch bản:** `TC-28`
- **Mục tiêu:** Xác minh cổng kiểm định đa kênh (Multi-Verification Evidence Gate): Để một task được chuyển sang trạng thái hoàn tất `DONE`, hệ thống bắt buộc phải xác nhận thành công đồng thời cả 4 trụ cột kiểm chứng độc lập:
  1. Ảnh chụp giao diện UI qua MCP CloakBrowser khớp với thiết kế/yêu cầu.
  2. Kết quả kiểm thử API trả về mã HTTP 200 kèm payload hợp lệ.
  3. Tra cứu log hệ thống/service sạch, không chứa bất kỳ runtime exception hay fatal error nào.
  4. Truy vấn Cơ sở Dữ liệu (DB query) thực tế xác nhận dữ liệu đã được thêm/sửa/xóa đúng nghiệp vụ.
  Khi và chỉ khi toàn bộ 4 kênh đều đạt đánh giá `PASS`, hệ thống mới chính thức chuyển trạng thái Job sang `DONE`.
- **Tiêu chuẩn ánh xạ:** `AC-14`, `AC-16`, `AC-17`, `AC-19`, `SAFE-01`
- **Tiền điều kiện (Preconditions):**
  - Local service (backend & frontend) được kích hoạt bởi Host Child Process và Readiness Probe xác nhận sẵn sàng.
  - Cơ sở dữ liệu cục bộ đã sẵn sàng và kết nối thành công.
  - Job đang ở giai đoạn `TESTING` sau khi agent hoàn thành bước `IMPLEMENT`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Feature yêu cầu: "Tạo người dùng mới với tên 'Nguyen Van A' và email 'vana@example.com'".
  - Tiêu chí nghiệm thu 4 trụ cột trong `test_plan.md`:
    - UI: Form tạo người dùng hiển thị thông báo "Tạo thành công" và người dùng mới xuất hiện trong danh sách.
    - API: `POST /api/users` trả về HTTP 201 Created kèm `id` và thông tin người dùng.
    - Log: Không có uncaught exception hay stack trace trong console/server logs.
    - DB: `SELECT * FROM users WHERE email = 'vana@example.com'` trả về đúng 1 bản ghi khớp dữ liệu.
- **Các bước thực hiện (Steps):**
  1. Hệ thống bước vào giai đoạn kiểm thử tự động đa kênh (Multi-Verification Gate):
  2. **Kênh 1 - Ảnh chụp UI qua MCP CloakBrowser:**
     - MCP CloakBrowser điều hướng đến trang quản lý người dùng, nhập thông tin form và nhấn submit.
     - Chụp ảnh màn hình lưu vào `evidence/ui-verification-pass.png`.
     - Visual Verifier xác nhận thông báo thành công và danh sách hiển thị đúng -> Kênh 1: `PASS`.
  3. **Kênh 2 - Kết quả API Test:**
     - Gửi test request hoặc kiểm tra request được phát sinh trong quá trình E2E, xác nhận response trả về HTTP 200/201 kèm body JSON hợp lệ -> Kênh 2: `PASS`.
  4. **Kênh 3 - Tra cứu Log sạch:**
     - Trích xuất toàn bộ log của server backend và browser console trong suốt quá trình test.
     - Bộ lọc log phân tích không tìm thấy từ khóa lỗi nghiêm trọng (Exception, Error, FATAL, Uncaught) -> Kênh 3: `PASS`.
  5. **Kênh 4 - Tra cứu Cơ sở Dữ liệu thực tế:**
     - Thực thi câu lệnh SQL trực tiếp: `SELECT id, name, email FROM users WHERE email = 'vana@example.com';`.
     - Xác nhận bản ghi tồn tại trong bảng dữ liệu với thông tin trùng khớp hoàn toàn -> Kênh 4: `PASS`.
  6. Hệ thống tổng hợp kết quả của cả 4 trụ cột: `[UI: PASS, API: PASS, LOG: PASS, DB: PASS]`.
  7. Thực hiện đóng gói Evidence Bundle và chuyển trạng thái Job sang `DONE`.
- **Kết quả mong đợi (Expected Results):**
  - Cả 4 trụ cột đều được thẩm định độc lập và ghi nhận kết quả chi tiết trong báo cáo nghiệm thu.
  - Do cả 4 kênh đều đạt `PASS`, hệ thống phê duyệt nghiệm thu và chuyển Job sang `DONE`.
  - Trên Web UI Dashboard hiển thị chi tiết bằng chứng của từng trụ cột (ảnh chụp từ MCP CloakBrowser, response API, log trích xuất, kết quả truy vấn DB).
- **Hậu điều kiện / Cleanup:** Thu hồi tài nguyên, dừng tiến trình service cục bộ; dọn dẹp các bản ghi test trong DB; chuyển file rác phát sinh vào Thùng rác (Recycle Bin / Trash).

### TC-29: Multi-Verification Failure to FIXING Loop
- **Mã kịch bản:** `TC-29`
- **Mục tiêu:** Xác minh cơ chế xử lý khi có ít nhất một kênh trong Cổng kiểm định đa kênh bị thất bại (Multi-Verification Failure): Dù giao diện UI chụp qua MCP CloakBrowser hoặc phản hồi API có thể giả mạo thành công, nhưng kênh Cơ sở Dữ liệu phát hiện thiếu bản ghi (do lỗi uncommitted transaction / rollback ngầm) hoặc kênh Log phát hiện exception/stack trace ẩn -> Hệ thống ngay lập tức đánh giá tổng thể `FAIL`, từ chối chuyển `DONE`, đóng gói Context Handoff Pack chi tiết lỗi và chuyển trạng thái sang `FIXING` để Agent tự động khắc phục.
- **Tiêu chuẩn ánh xạ:** `AC-14`, `AC-17`, `AC-19`, `SAFE-01`
- **Tiền điều kiện (Preconditions):**
  - Local service đang chạy dưới sự điều phối của Host Child Process.
  - Mã nguồn trong bước `IMPLEMENT` tạo ra lỗi ngầm: API endpoint trả về HTTP 200 và UI hiển thị "Thành công" giả lập, nhưng transaction DB bị rollback hoặc bỏ quên lệnh `db.commit()`, hoặc xuất hiện lỗi `UnhandledPromiseRejection` ẩn trong server logs.
- **Dữ liệu kiểm thử (Input Payload):**
  - Request tạo đơn hàng mới: `POST /api/orders` với tổng tiền 500,000 VND.
  - Kỳ vọng: Giao diện hiển thị đơn hàng thành công, DB có bản ghi đơn hàng mới, log không có lỗi.
- **Các bước thực hiện (Steps):**
  1. Thực hiện quy trình kiểm tra đa kênh (Multi-Verification Gate):
  2. Kênh 1 (UI MCP CloakBrowser): Form submit thành công, màn hình hiển thị popup "Đặt hàng thành công", chụp ảnh `evidence/ui-order-success.png` -> Kênh 1: `PASS`.
  3. Kênh 2 (API Test): Endpoint trả về HTTP 200 OK -> Kênh 2: `PASS`.
  4. Kênh 3 (Tra cứu Log): Quét log phát hiện dòng cảnh báo/lỗi: `WARN: Transaction not committed / DB pool connection leak` hoặc không phát hiện lỗi.
  5. Kênh 4 (Tra cứu Cơ sở Dữ liệu): Thực thi truy vấn: `SELECT * FROM orders WHERE customer_id = 'CUST-01';`.
     - Kết quả truy vấn: Trả về 0 bản ghi (rỗng) do thiếu commit vào DB.
     - Đánh giá Kênh 4: `FAIL` (Sai lệch dữ liệu thực tế).
  6. Hệ thống tổng hợp kết quả 4 trụ cột: `[UI: PASS, API: PASS, LOG: PASS, DB: FAIL]`. Do có kênh thất bại, kết luận chung của cổng kiểm định: `VERDICT: FAIL`.
  7. Hệ thống ngăn chặn việc chuyển sang `DONE`, khởi tạo Context Handoff Pack chứa bằng chứng:
     - Log chi tiết lỗi DB: "Expected order record in DB but query returned 0 rows".
     - Dữ liệu query SQL và bảng tham chiếu.
     - Ảnh UI và API response để đối chiếu sai lệch.
  8. Hệ thống tự động chuyển trạng thái Job từ `TESTING` sang `FIXING`, bàn giao ngữ cảnh cho Fixing Agent.
- **Kết quả mong đợi (Expected Results):**
  - Hệ thống phát hiện chính xác lỗi ngầm nhờ vào việc kiểm tra đa kênh toàn diện, không bị đánh lừa bởi UI/API response bề nổi.
  - Job không bị chuyển nhầm sang `DONE`, mà chuyển sang trạng thái `FIXING`.
  - Context Handoff Pack chứa đầy đủ dữ liệu giúp Fixing Agent xác định ngay nguyên nhân gốc rễ (Root Cause) để tiến hành sửa mã nguồn.
- **Hậu điều kiện / Cleanup:** Giữ nguyên ngữ cảnh lỗi trong workspace phục vụ giai đoạn `FIXING`; di chuyển các file rác không cần thiết vào Thùng rác (Recycle Bin / Trash).

### TC-30: Human-in-the-Loop Clarification Flow & PENDING State (Planning-Only Enforcement)
- **Mã kịch bản:** `TC-30`
- **Mục tiêu:** Xác minh luồng làm rõ yêu cầu có sự tham gia của con người (Human-in-the-Loop Clarification Flow) và trạng thái `PENDING` theo quy tắc nghiệp vụ bất biến:
  1. Trạng thái `PENDING` **CHỈ ĐƯỢC PHÉP KÍCH HOẠT DUY NHẤT Ở BƯỚC `PLANNING`**: Khi Agent khảo sát yêu cầu, kiến trúc và sinh Dual Plan (Dev Plan + Test Plan), nếu phát hiện điểm mơ hồ hoặc cần quyết định kỹ thuật từ người dùng -> Agent gửi tín hiệu làm rõ, hệ thống tạm dừng an toàn và chuyển Job sang `PENDING`. Web UI hiển thị popup/card tương tác gồm các lựa chọn cấu hình (radio/checkbox) và ô chat tự do. Khi người dùng gửi câu trả lời (`POST /api/v1/jobs/{id}/clarify`), hệ thống nạp câu trả lời vào ngữ cảnh Agent và đưa Job quay trở lại bước `PLANNING` để hoàn thiện kế hoạch.
  2. **Sau khi PLANNING xong (kế hoạch đã chốt), TUYỆT ĐỐI KHÔNG PENDING NỮA**: Toàn bộ các bước sau (`IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE`) vận hành hoàn toàn tự động (autonomous execution & self-healing loop) dựa trên Dev Plan & Test Plan đã phê duyệt, không thể kích hoạt `PENDING`.
  3. **Cơ chế Guardrail ngăn chặn vi phạm**: Cố tình giả lập Agent ở bước `IMPLEMENT` hoặc `FIXING` phát tín hiệu đặt câu hỏi / làm rõ -> Hệ thống lập tức từ chối chuyển sang `PENDING`, không hiển thị popup chờ người dùng, và tự động phản hồi chỉ dẫn yêu cầu Agent bám sát kế hoạch mà không tạm dừng chờ người dùng.
- **Tiêu chuẩn ánh xạ:** `AC-11`, `AC-12`, `AC-19`, `AC-20`
- **Tiền điều kiện (Preconditions):**
  - Worker service đang chạy và Web UI Dashboard đang mở theo dõi Job.
  - Job đang thực thi ở bước `PLANNING`.
- **Dữ liệu kiểm thử (Input Payload):**
  - Payload làm rõ hợp lệ tại bước `PLANNING`:
    ```json
    {
      "type": "CLARIFICATION_REQUIRED",
      "question": "Vui lòng chọn cơ chế xác thực bạn muốn sử dụng cho hệ thống:",
      "options": [
        {"id": "jwt", "label": "JSON Web Token (JWT Bearer Token)"},
        {"id": "oauth2", "label": "OAuth2 / OpenID Connect"},
        {"id": "session", "label": "Session Cookie-based Authentication"}
      ],
      "allowCustom": true
    }
    ```
  - Payload giả lập Agent cố tình đặt câu hỏi ở bước `IMPLEMENT` hoặc `FIXING`:
    ```json
    {
      "type": "CLARIFICATION_REQUIRED",
      "question": "Có nên đổi thư viện mã hóa mật khẩu bcrypt sang argon2 trong tầng Service không?",
      "options": [
        {"id": "argon2", "label": "Dùng Argon2"},
        {"id": "bcrypt", "label": "Giữ nguyên Bcrypt"}
      ]
    }
    ```
- **Các bước thực hiện (Steps):**
  - **Phần A: Kiểm thử luồng PENDING chuẩn xác trong bước PLANNING:**
    1. Job khởi tạo và bắt đầu tại bước `PLANNING`. Agent phân tích yêu cầu ban đầu ("Tích hợp tính năng đăng nhập cho hệ thống"), phát hiện điểm mơ hồ về cơ chế xác thực.
    2. Agent phát tín hiệu yêu cầu làm rõ (`CLARIFICATION_REQUIRED`). Hệ thống xác định Job đang ở bước `PLANNING` -> Hợp lệ: Lưu trạng thái checkpoint an toàn và chuyển trạng thái Job sang `PENDING`.
    3. Kiểm tra Web UI Dashboard:
       - Huy hiệu trạng thái Job chuyển sang màu vàng hổ phách với nhãn `PENDING (Waiting for input)`.
       - Modal popup / interactive card nổi bật xuất hiện trên giao diện hiển thị câu hỏi của Agent cùng các lựa chọn radio và ô chat nhập liệu tự do.
    4. Người dùng thao tác trên Web UI:
       - Chọn radio option: `JSON Web Token (JWT Bearer Token)`.
       - Nhập vào ô chat văn bản bổ sung: "Sử dụng access token hạn 15 phút và refresh token hạn 7 ngày lưu trữ trong HTTP-only cookie".
       - Nhấn nút "Gửi câu trả lời" (Submit Clarification).
    5. Web UI gửi request `POST /api/v1/jobs/{id}/clarify` mang theo lựa chọn và nội dung hướng dẫn của người dùng.
    6. Hệ thống tiếp nhận phản hồi, nạp ngữ cảnh vào Agent và chuyển trạng thái Job từ `PENDING` quay trở lại bước `PLANNING` (`RESUMED`).
    7. Agent tiếp tục thực thi trong `PLANNING`: Hoàn thiện Dual Plan (Dev Plan & Test Plan) với đầy đủ cấu hình JWT theo chỉ dẫn người dùng.
    8. Dual Plan được chốt và lưu trữ. Hệ thống hoàn tất bước `PLANNING` và chuyển Job sang bước `IMPLEMENT`.
  - **Phần B: Kiểm thử Guardrail từ chối PENDING và thực thi tự động ở các bước sau PLANNING:**
    9. Job bắt đầu bước `IMPLEMENT`. Hệ thống thiết lập cờ `autonomousMode = true` và khóa hoàn toàn khả năng chuyển sang `PENDING`.
    10. Giả lập tình huống bất thường: Agent ở bước `IMPLEMENT` (hoặc `FIXING`) cố tình phát tín hiệu `CLARIFICATION_REQUIRED` (hỏi về thư viện mã hóa mật khẩu).
    11. Hệ thống tiếp nhận sự kiện và kiểm tra Guardrail Rule:
        - Xác định bước hiện tại là `IMPLEMENT` (hoặc `FIXING`), không phải là `PLANNING`.
        - Từ chối chuyển đổi trạng thái sang `PENDING` (Job tiếp tục duy trì trạng thái thực thi hiện tại, không tạm dừng).
        - Giao diện Web UI không hiển thị popup chờ người dùng, terminal log ghi nhận cảnh báo Guardrail.
        - Hệ thống tự động phản hồi chỉ dẫn (system guidance injection) vào tiến trình Agent: `"CLARIFICATION_REJECTED: Clarification is strictly restricted to PLANNING stage. Proceed autonomously following the approved Dev Plan and Test Plan."`.
    12. Agent tiếp nhận chỉ dẫn tự động, không dừng lại chờ người dùng mà tiếp tục triển khai mã nguồn bám sát Dual Plan đã được làm rõ từ trước.
    13. Tiến trình chuyển tiếp tuần tự sang `TESTING` và bước `FIXING` (chu trình Self-Healing Loop). Tại bước `FIXING`, giả lập thử lại một lần nữa tín hiệu `CLARIFICATION_REQUIRED` -> Hệ thống tiếp tục từ chối và yêu cầu bám sát kế hoạch kiểm thử đã định sẵn.
    14. Tác vụ hoàn thành toàn bộ chu trình và chuyển sang trạng thái `DONE`.
- **Kết quả mong đợi (Expected Results):**
  - Trạng thái `PENDING` hoạt động chuẩn xác và DUY NHẤT ở bước `PLANNING`. Sau khi người dùng phản hồi, Job quay trở lại bước `PLANNING` để hoàn thiện kế hoạch.
  - Khi bước `PLANNING` hoàn tất và kế hoạch được chốt, các bước tiếp theo (`IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE`) vận hành tự động 100%, không bị tạm dừng hay gián đoạn.
  - Bước kiểm tra giả lập cố tình đặt câu hỏi ở bước `IMPLEMENT` hoặc `FIXING` bị hệ thống từ chối chuyển sang `PENDING`; hệ thống tự động inject chỉ dẫn yêu cầu bám sát kế hoạch mà không tạm dừng chờ người dùng.
  - Loại bỏ hoàn toàn rủi ro nghẽn tiến trình (Deadlock / Process Blocking) do chờ phản hồi con người trong chu trình `TESTING ⇄ FIXING`.
  - Timeline và realtime ANSI terminal log ghi nhận đầy đủ, minh bạch luồng chuyển đổi trạng thái và các cảnh báo Guardrail tương ứng.
- **Hậu điều kiện / Cleanup:** Job hoàn thành các bước tiếp theo; thu hồi tài nguyên; dọn dẹp các tệp tạm và đưa vào Thùng rác (Recycle Bin / Trash).

---

## 3. Hướng dẫn thực thi kiểm thử (Execution Guidelines)

1. **Kiểm thử tự động (Automated Test Suite):**
   - Các kịch bản từ `TC-01` đến `TC-30` được triển khai dưới dạng test suite tự động (Integration Tests & E2E Tests) trong thư mục `tests/e2e/`.
   - Lệnh thực thi:
     ```bash
     npm test -- tests/e2e/worker-scenarios.test.ts
     ```
     *(Hoặc `pytest tests/e2e/test_worker_scenarios.py` tùy stack triển khai)*.

2. **Tiêu chí Đạt (Pass Criteria):**
   - 100% kịch bản từ `TC-01` đến `TC-30` phải đạt trạng thái `PASS`.
   - Không có ngoại lệ rò rỉ tiến trình con (orphan process), rò rỉ trình duyệt hay rò rỉ worktree.
   - 100% token nhạy cảm được che giấu (`***MASKED***`).
   - Mọi thao tác dọn dẹp file đều gửi vào Thùng rác (Recycle Bin / Trash), tuyệt đối không xóa vĩnh viễn.
