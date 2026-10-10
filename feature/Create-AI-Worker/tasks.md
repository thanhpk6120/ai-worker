---
feature: Create-AI-Worker
service: ai-worker
status: in_progress
owner: AI
updated_at: 2026-10-08
---

# Kế hoạch triển khai chi tiết (tasks.md)
## Feature: Create-AI-Worker — Server Quản lý & Điều phối Headless AI Agent Code

Tài liệu phân rã công việc kỹ thuật cho hệ thống **AI Worker Server** (kiến trúc Single Server viết hoàn toàn bằng JavaScript/Node.js) hỗ trợ 5 CLI: **Claude Code**, **OpenCode**, **OMP**, **Codex CLI**, và **Antigravity CLI**, tích hợp giao diện điều khiển **Web UI Dashboard** phục vụ trực tiếp trên cùng một cổng duy nhất.
Hệ thống hỗ trợ cấu hình đa Agent linh hoạt theo từng bước quy trình (Multi-Agent Step Pipeline Configuration) và cỗ máy trạng thái mở rộng tích hợp chu trình kiểm thử tự động với Browser Automation, Vision Multimodal Verification và vòng lặp phản hồi sửa lỗi chuyên biệt (Testing & Fixing Feedback Loop: TO DO -> PLANNING -> IMPLEMENT -> TESTING -> FIXING -> DONE).
Mỗi task tuân thủ định dạng checklist `[ ]`, có mã định danh, mô tả chi tiết, phân định rõ ràng các tầng trách nhiệm và liên kết trực tiếp với Tiêu chí nghiệm thu (Acceptance Criteria - AC) trong `expect.md`.

---

## Danh mục Tiêu chí nghiệm thu tham chiếu (AC Reference)
- **AC-01:** Khởi động & Quản lý Service (Daemon Node.js, Health Check, Runner Status).
- **AC-02:** Hỗ trợ đầy đủ 5 CLI Runner (`claude`, `opencode`, `omp`, `codex`, `antigravity`).
- **AC-03:** Khởi tạo Task qua REST API (`POST /api/v1/jobs`, hàng đợi, phân phối worker slot).
- **AC-04:** Cách ly Workspace bằng Git Worktree / Sandbox độc lập, không xung đột mã nguồn.
- **AC-05:** Realtime Log Streaming qua SSE/WebSocket với độ trễ < 500ms.
- **AC-06:** Secret Masking (che toàn bộ API keys `sk-ant-*`, `sk-*`, secrets thành `***MASKED***`).
- **AC-07:** Hủy tác vụ an toàn (Process Tree Kill triệt để trong vòng 5 giây, trạng thái `CANCELLED`).
- **AC-08:** Xử lý Timeout tự động (Hard Timeout watchdog ngắt tác vụ, trạng thái `TIMED_OUT`).
- **AC-09:** Thu thập kết quả & Git Diff (trích xuất file thay đổi, diff tóm tắt, lưu trữ artifact).
- **AC-10:** Web Dashboard Single-Server Access (Giao diện Web SPA phục vụ trực tiếp từ server Node.js tại cùng 1 cổng duy nhất với REST API).
- **AC-11:** Visual Step-by-step Progress Tracking (Theo dõi trực quan tiến độ từng bước của Agent theo 6 trạng thái chuẩn hóa: `TO DO` -> `PLANNING` -> `IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE`).
- **AC-12:** Interactive Web Control & Diff Review (Điều khiển tương tác qua Web: Cancel, Re-run, xem visual diff trực tiếp, xem realtime log qua Terminal xterm.js/ANSI).
- **AC-13:** Cấu hình Agent Pipeline linh hoạt theo từng bước (Multi-Agent Step Pipeline Configuration - Cho phép cấu hình từng bước trong quy trình: Planning, Implementation, Testing, Fixing sử dụng agent nào, qua config file và Web UI Form).
- **AC-14:** Chu trình Vòng đời Khép kín & Feedback Loop (State Machine chuẩn hóa với chu trình kiểm thử tự động, chuyển giao Handoff Context Pack sang Fixing Agent, lặp lại re-test với giới hạn `maxFixingRetries` chống lặp vô hạn).
- **AC-15:** Dual Planning Engine (sinh đồng thời `dev_plan.md` cho kiến trúc/files/APIs/logic và `test_plan.md` cho kịch bản/các bước/mock data/assertions).
- **AC-16:** Local Service Runner qua Host Child Process & Healthcheck Watcher (quản lý lifecycle của dev server trực tiếp bằng Host Child Process, wait-on port, HTTP health check readiness detection).
- **AC-17:** Browser Testing Runner qua MCP CloakBrowser & Visual Evidence Capture (tương tác tự động theo Test Plan qua MCP CloakBrowser duy nhất, chụp ảnh screenshot lưu vào thư mục `feature/<feature-name>/evidence/` hoặc `docs/features/<TICKET-ID>/evidence/` kèm metadata JSON).
- **AC-18:** Multi-Verification Evidence Gate (Thẩm định nghiệm thu đa kênh bắt buộc: UI Screenshot qua MCP CloakBrowser, API Test Assertion qua `ApiTestRunner`, Log Error Scanner qua `LogScanner`, Database Query Verification qua `DatabaseVerifier`. TẤT CẢ phải thành công mới chuyển sang `DONE`, nếu bất kỳ kênh nào lỗi chuyển sang `FIXING`).
- **AC-19:** Human-in-the-loop Clarification & Trạng thái PENDING độc quyền ở bước PLANNING (Bổ sung trạng thái `PENDING` và cơ chế pause/wait an toàn tiến trình agent CHỈ ĐƯỢC PHÉP kích hoạt duy nhất trong giai đoạn `PLANNING` khi cần làm rõ yêu cầu hoặc lựa chọn phương án Dual Plan; khi kế hoạch đã chốt, các bước `IMPLEMENT`, `TESTING`, `FIXING` tuyệt đối cấm chuyển sang `PENDING` mà chạy hoàn toàn tự động; Web UI hiển thị Interactive Question Modal với các options radio/checkbox và chat input, API `POST /api/v1/jobs/{id}/answer` nạp câu trả lời và resume agent quay lại hoàn thiện kế hoạch ở bước `PLANNING`).
- **AC-20:** Live Terminal Streaming View (Hiển thị Live Web Terminal xterm.js full-fidelity ANSI color codes, auto-scroll, copy, xem raw stdout/stderr với độ trễ thấp < 500ms).

---

## Phase 1: Core Service Foundation, API Gateway & Single-Server Serving
*Mục tiêu: Thiết lập kiến trúc khung máy chủ Node.js duy nhất (Single Server), hệ thống routing REST API, cơ chế phục vụ tĩnh Web UI Assets tại cùng một cổng, quản lý vòng đời ứng dụng và bộ điều phối hàng đợi tác vụ kết hợp Semaphore Concurrency Limiter.*

- [ ] `TASK-1.1`: **Khởi tạo kiến trúc dự án & Quản trị cấu hình (Project Foundation & Config Manager)**
  - **Mục tiêu:** Khởi tạo cấu trúc thư mục chuẩn, nạp cấu hình hệ thống từ biến môi trường/file cấu hình, thiết lập logger tập trung cho runtime Node.js.
  - **Chi tiết thực hiện:**
    - Thiết lập module cấu hình nạp các tham số: `PORT` (mặc định 3000), `MAX_CONCURRENT_WORKERS`, `DEFAULT_TIMEOUT_SECONDS`, `WORKSPACE_ROOT_DIR`, `LOG_DIR`, `SECRET_PATTERNS`, `STATIC_DIR`.
    - Hỗ trợ nạp cấu hình `AgentPipelineConfig` mặc định từ `config.json` hoặc `config/pipeline.yaml`.
    - Khởi tạo hệ thống Structured Logger hỗ trợ xuất log định dạng JSON và Console có gắn timestamp.
    - Cài đặt hệ thống quản lý mã lỗi chuẩn hóa (`AppError`, `RunnerError`, `WorkspaceError`, `PipelineError`).
  - **Liên kết AC:** `AC-01`, `AC-13`

- [ ] `TASK-1.2`: **Hiện thực REST API Gateway & Endpoints điều khiển**
  - **Mục tiêu:** Xây dựng đầy đủ các API tiếp nhận và quản lý vòng đời tác vụ AI.
  - **Chi tiết thực hiện:**
    - `POST /api/v1/jobs`: Tiếp nhận payload yêu cầu chạy agent (gồm `repo_url`, `branch`, `prompt`, `agent_type`, `pipeline_config` cho phép cấu hình agent từng bước, `max_resolve_retries`, `timeout_seconds`, `env_vars`, `extra_flags`).
    - `GET /api/v1/jobs`: Trả về danh sách jobs kèm phân trang và lọc theo trạng thái (`QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `CANCELLED`, `TIMED_OUT`).
    - `GET /api/v1/jobs/{id}`: Trả về trạng thái hiện tại, thời gian bắt đầu, kết quả, metadata và metrics thực thi.
    - `GET /api/v1/jobs/{id}/steps`: Trả về danh sách các bước có cấu trúc bóc tách từ stdout của agent (bao gồm cả các bước `TESTING` và `FIXING`).
    - `GET /api/v1/jobs/{id}/logs`: Trả về toàn bộ log lịch sử hoặc liên kết luồng stream.
    - `POST /api/v1/jobs/{id}/cancel`: Kích hoạt tín hiệu dừng khẩn cấp tác vụ đang chạy.
    - `POST /api/v1/jobs/{id}/rerun`: Tạo một job mới kế thừa toàn bộ cấu hình từ job đã kết thúc.
    - `GET /api/v1/runners`: Trả về danh sách runner khả dụng trên host, đường dẫn binary và phiên bản hiện tại.
    - `GET /api/v1/pipeline/templates`: Trả về danh sách các mẫu workflow pipeline định sẵn (ví dụ: Full Claude, Claude + OpenCode Hybrid, Codex + OMP Testing).
    - `GET /health` & `GET /api/v1/health`: Kiểm tra tình trạng hoạt động (uptime, memory usage, worker slots).
  - **Liên kết AC:** `AC-01`, `AC-03`, `AC-12`, `AC-13`

- [ ] `TASK-1.3`: **Xây dựng Semaphore Concurrency Limiter & Hàng đợi tác vụ (Job Queue Manager)**
  - **Mục tiêu:** Ngăn ngừa tình trạng quá tải CPU/RAM khi có nhiều yêu cầu trigger đồng thời bằng cơ chế worker pool giới hạn dung lượng.
  - **Chi tiết thực hiện:**
    - Xây dựng hàng đợi FIFO trong bộ nhớ (`JobQueue`) kết hợp Semaphore quản lý số slot thực thi đồng thời (`max_concurrent_workers`, mặc định: 2 tác vụ song song).
    - Quản lý trạng thái chuyển tiếp: `QUEUED` -> `PREPARING` -> `RUNNING` -> `FINALIZING` -> `COMPLETED`/`FAILED`/`CANCELLED`/`TIMED_OUT`.
    - Cung cấp hàm dispatch tự động lấy job tiếp theo trong hàng đợi khi có worker slot hoàn tất.
  - **Liên kết AC:** `AC-03`

- [ ] `TASK-1.4`: **Thiết lập Single-Server Static Serving cho Web UI Assets**
  - **Mục tiêu:** Nhúng toàn bộ tài nguyên Web UI (HTML, CSS, JS, SVG icons, fonts) vào chính server Node.js để phục vụ trên cùng 1 cổng HTTP duy nhất, không yêu cầu reverse proxy hay server phụ.
  - **Chi tiết thực hiện:**
    - Cấu hình middleware static file serving phục vụ thư mục `public/` hoặc `dist/web/`.
    - Triển khai SPA fallback routing: Mọi request dạng text/html không khớp tiền tố `/api/` hoặc `/events/` đều trả về `index.html`.
    - Thiết lập HTTP caching header hợp lý cho static assets (`Cache-Control: public, max-age=3600`) và `no-cache` cho `index.html`.
  - **Liên kết AC:** `AC-10`

- [ ] `TASK-1.5`: **Xây dựng Realtime Event Stream Engine (SSE & WebSocket)**
  - **Mục tiêu:** Cung cấp kênh truyền dữ liệu một chiều thời gian thực (Server-Sent Events) từ máy chủ xuống trình duyệt phục vụ log streaming và cập nhật bước tiến độ.
  - **Chi tiết thực hiện:**
    - Tạo endpoint `GET /api/v1/jobs/{id}/events` hỗ trợ giao thức SSE chuẩn với các headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
    - Thiết kế định dạng sự kiện:
      - `event: log` (kèm ANSI raw data hoặc text line).
      - `event: step` (cập nhật trạng thái bước thực thi mới bóc tách).
      - `event: status` (thay đổi trạng thái tổng thể của job: RUNNING, TESTING, FIXING, COMPLETED,...).
      - `event: diff` (khi kết thúc job, gửi tóm tắt diff).
    - Cài đặt cơ chế ping heartbeat mỗi 15 giây để duy trì kết nối qua firewall/proxy.
  - **Liên kết AC:** `AC-05`, `AC-11`

---

## Phase 2: Workspace Isolation & Git Engine
*Mục tiêu: Đảm bảo tính toàn vẹn và độc lập tuyệt đối giữa các tác vụ thực thi đồng thời thông qua Git Worktree, trích xuất thay đổi diff và dọn dẹp an toàn tuân thủ quy tắc thùng rác.*

- [ ] `TASK-2.1`: **Quản trị kho mã nguồn & Workspace Isolation (Worktree Sandbox Engine)**
  - **Mục tiêu:** Tạo và quản lý môi trường làm việc độc lập cho mỗi job bằng Git Worktree.
  - **Chi tiết thực hiện:**
    - Kiểm tra và tự động clone repository nguồn về thư mục quản lý nếu chưa tồn tại cục bộ.
    - Thực hiện lệnh `git worktree add <sandbox_path> -b <feature_branch>` cho từng tác vụ độc lập.
    - Kiểm tra tính hợp lệ và sạch sẽ của sandbox trước khi bàn giao cho Runner Adapter.
    - Cô lập biến môi trường cục bộ để không ảnh hưởng đến workspace gốc hoặc các job khác đang chạy đồng thời.
  - **Liên kết AC:** `AC-04`

- [ ] `TASK-2.2`: **Thu thập kết quả & Git Diff Extractor (Artifact Collector)**
  - **Mục tiêu:** Trích xuất chi tiết mã nguồn đã thay đổi, tạo bản tóm tắt diff và lưu trữ artifact sau khi agent kết thúc nhiệm vụ.
  - **Chi tiết thực hiện:**
    - Thực thi `git status --porcelain` để lấy danh sách chính xác các tệp đã thêm mới (A), chỉnh sửa (M), hoặc xóa bỏ (D).
    - Tạo tệp patch đầy đủ bằng `git diff HEAD` và sinh mã hash định danh artifact.
    - Lưu trữ tệp diff và báo cáo kết quả vào thư mục `artifacts/{job_id}/diff.patch` và `artifacts/{job_id}/summary.json`.
  - **Liên kết AC:** `AC-09`

- [ ] `TASK-2.3`: **Bộ dọn dẹp Sandbox An toàn (Safe Cleanup via Recycle Bin / Trash)**
  - **Mục tiêu:** Giải phóng dung lượng ổ đĩa và worktree an toàn, tuân thủ nghiêm ngặt quy định không xóa vĩnh viễn dữ liệu người dùng.
  - **Chi tiết thực hiện:**
    - Gỡ bỏ worktree khỏi Git quản trị bằng lệnh `git worktree remove` hoặc `git worktree prune`.
    - Đối với các file tạm, artifacts hết hạn hoặc sandbox cần dọn dẹp: bắt buộc tích hợp thư viện di chuyển vào Thùng rác (Recycle Bin trên Windows hoặc Trash trên Linux/macOS qua module Node.js chuyên dụng `trash`), tuyệt đối không dùng `rm -rf` hoặc `fs.rmSync(path, { recursive: true, force: true })` trực tiếp lên tài nguyên người dùng.
    - Ghi nhận nhật ký thu hồi tài nguyên vào logger hệ thống.
  - **Liên kết AC:** `AC-04`

---

- [ ] `TASK-2.4`: **Hiện thực ClarificationManager & Human-in-the-loop Controller (Trạng thái PENDING & Validation Chỉ Kích Hoạt Tại Bước PLANNING)**
  - **Mục tiêu:** Quản lý vòng đời câu hỏi làm rõ và tương tác người dùng (Human-in-the-loop) với cơ chế kiểm soát nghiêm ngặt: chỉ cho phép chuyển sang trạng thái `PENDING` duy nhất trong giai đoạn `PLANNING`, tuyệt đối cấm chuyển `PENDING` ở các giai đoạn sau (`IMPLEMENT`, `TESTING`, `FIXING`).
  - **Chi tiết thực hiện:**
    - Triển khai lớp `ClarificationManager`:
      - Phát hiện tín hiệu cần làm rõ từ Agent (qua event marker hoặc cấu trúc output).
      - **Cơ chế kiểm soát & Validation logic:**
        - Xác thực trạng thái hiện tại của Job trước khi xử lý câu hỏi: Chỉ kích hoạt và cho phép chuyển trạng thái Job sang `PENDING` khi Job đang ở giai đoạn `PLANNING` (để làm rõ yêu cầu, kiến trúc hoặc phân vân lựa chọn Dual Plan).
        - Chặn chuyển trạng thái `PENDING` ở các giai đoạn sau (`IMPLEMENT`, `TESTING`, `FIXING`): Nếu Agent ở các bước sau cố tình phát sinh câu hỏi làm rõ, `ClarificationManager` tự động từ chối (reject chuyển trạng thái), ghi log cảnh báo hệ thống, và trả về chỉ dẫn phản hồi tự động yêu cầu Agent tiếp tục bám sát Dev Plan & Test Plan đã được chốt từ trước mà không tạm dừng chờ người dùng.
      - Tạo và lưu trữ `ClarificationQuestion` (gồm `questionId`, `jobId`, `title`, `description`, `options`: danh sách lựa chọn dạng radio/checkbox, `allowCustomReply`: boolean, `createdAt`).
      - Tự động kích hoạt cơ chế tạm dừng an toàn (Pause/Wait) tiến trình Agent khi ở `PLANNING`.
      - Cung cấp API `POST /api/v1/jobs/{id}/answer` tiếp nhận câu trả lời người dùng (`questionId`, `selectedOptions`, `customText`).
      - Nạp câu trả lời vào ngữ cảnh (context/stdin/prompt) của Agent và kích hoạt phương thức `resume()` để tiếp tục chạy, đưa task quay lại giai đoạn `PLANNING` để hoàn thiện kế hoạch (Dev Plan và Test Plan).
      - Phát sự kiện `clarification_resolved` qua SSE/WebSocket để cập nhật Web UI.
  - **Đầu ra:** Module `ClarificationManager`, validation logic chặn `PENDING` sau `PLANNING`, endpoint `POST /api/v1/jobs/{id}/answer`, unit test pause/resume & validation.
  - **Liên kết AC:** `AC-19`

## Phase 3: Unified Runner Adapter & Multi-Agent Pipeline Layer
*Mục tiêu: Xây dựng lớp trừu tượng hóa cho 5 AI Agent CLI, thống nhất giao diện thực thi, xử lý tham số dòng lệnh headless, thiết kế Schema cấu hình pipeline đa agent linh hoạt và hiện thực bộ định tuyến Multi-Agent Step Router.*

- [ ] `TASK-3.1`: **Thiết kế Base Runner Adapter Interface & Registry**
  - **Mục tiêu:** Định nghĩa hợp đồng chung (Contract) và hệ thống đăng ký quản lý cho tất cả các runner.
  - **Chi tiết thực hiện:**
    - Thiết kế interface `IRunnerAdapter` với các phương thức cốt lõi:
      - `detect(): Promise<boolean>`
      - `getVersion(): Promise<string>`
      - `buildArgs(options: JobOptions): string[]`
      - `getEnv(options: JobOptions): Record<string, string>`
      - `parseStep(line: string): AgentStep | null`
      - `parseSummary(stdout: string): JobSummary`
    - Xây dựng `RunnerRegistry` cho phép đăng ký, truy vấn và kiểm tra trạng thái sẵn sàng của từng adapter trên host.
  - **Liên kết AC:** `AC-02`

- [ ] `TASK-3.2`: **Hiện thực Claude Code Adapter (Headless Engine)**
  - **Mục tiêu:** Tích hợp CLI `claude` hoạt động ở chế độ không tương tác (non-interactive / headless).
  - **Chi tiết thực hiện:**
    - Triển khai lớp `ClaudeCodeAdapter implements IRunnerAdapter`.
    - Cấu hình tham số dòng lệnh: `claude -p "<prompt>" --dangerously-skip-permissions --output-format json` hoặc streaming text mode.
    - Tự động phát hiện binary qua `which claude` (Unix) hoặc `where.exe claude` (Windows).
    - Bóc tách tiến độ suy luận và thao tác công cụ của Claude Code.
  - **Liên kết AC:** `AC-02`

- [ ] `TASK-3.3`: **Hiện thực OpenCode Adapter (Non-interactive Engine)**
  - **Mục tiêu:** Tích hợp CLI `opencode` chạy tự động không chờ bàn phím.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `OpenCodeAdapter implements IRunnerAdapter`.
    - Cấu hình cờ headless: `opencode run "<prompt>" --headless --yes --format json`.
    - Bóc tách sự kiện qua JSON event stream hoặc regex marker của OpenCode.
  - **Liên kết AC:** `AC-02`

- [ ] `TASK-3.4`: **Hiện thực OMP Runner Adapter (Headless Prompt Runner)**
  - **Mục tiêu:** Tích hợp CLI `omp` chạy trực tiếp các workflow và prompt tự động.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `OmpRunnerAdapter implements IRunnerAdapter`.
    - Cấu hình lệnh: `omp run "<prompt>" --non-interactive --quiet=false`.
    - Nhận diện các output tag đặc thù của OMP để bóc tách bước làm việc.
  - **Liên kết AC:** `AC-02`

- [ ] `TASK-3.5`: **Hiện thực Codex CLI Runner Adapter**
  - **Mục tiêu:** Tích hợp công cụ `codex` dòng lệnh chạy script tự động.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `CodexRunnerAdapter implements IRunnerAdapter`.
    - Cấu hình các tham số: `codex exec "<prompt>" --approval never --full-auto`.
    - Phân tích output stream từ Codex engine.
  - **Liên kết AC:** `AC-02`

- [ ] `TASK-3.6`: **Hiện thực Antigravity CLI Runner Adapter**
  - **Mục tiêu:** Tích hợp công cụ `antigravity` dòng lệnh chạy các tác vụ agentic coding tự động.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `AntigravityRunnerAdapter implements IRunnerAdapter`.
    - Cấu hình lệnh: `antigravity run "<prompt>" --mode headless --auto-approve`.
    - Bóc tách các pha phân tích, sinh code, và verify của Antigravity.
  - **Liên kết AC:** `AC-02`

- [ ] `TASK-3.7`: **Adapter Capability Verification & Mock Runner Test Suite**
  - **Mục tiêu:** Xây dựng hệ thống giả lập Runner (Mock Runner) để kiểm thử toàn diện server ngay cả trên môi trường chưa cài đặt đủ 5 CLI thực tế.
  - **Chi tiết thực hiện:**
    - Tạo `MockRunnerAdapter` hỗ trợ mô phỏng output của cả 5 loại runner kèm các kịch bản: chạy thành công, chạy gặp lỗi, chạy timeout, và xuất ANSI giả lập.
    - Viết bộ test kiểm tra khả năng phát hiện binary và nạp biến môi trường cho từng adapter.
  - **Liên kết AC:** `AC-02`

- [ ] `TASK-3.8`: **Xây dựng `AgentPipelineConfig` Schema & Multi-Agent Step Router (Per-step Agent Pipeline Routing)**
  - **Mục tiêu:** Cung cấp cơ chế quản trị registry bật/tắt các agent và bộ điều hướng pipeline cho phép chỉ định agent code độc lập cho từng giai đoạn trong quy trình thực thi.
  - **Chi tiết thực hiện:**
    - Thiết kế JSON/YAML Schema chuẩn `AgentPipelineConfig`:
      - `registry.enabledAgents`: Danh sách các agent được phép kích hoạt trong hệ thống (`claude`, `opencode`, `omp`, `codex`, `antigravity`).
      - `steps.planning`: Agent code chịu trách nhiệm phân tích yêu cầu và lập kế hoạch (ví dụ: `claude`).
      - `steps.implementation`: Agent code chịu trách nhiệm viết mã nguồn và chỉnh sửa file (ví dụ: `opencode`).
      - `steps.testing`: Agent code chịu trách nhiệm chạy kiểm thử và xác minh tính đúng đắn (ví dụ: `omp` hoặc `codex`).
      - `steps.fixing`: Agent code chịu trách nhiệm phân tích log lỗi kiểm thử và sửa lỗi mã nguồn (ví dụ: `claude`).
    - Xây dựng `PipelineConfigManager`: Hỗ trợ nạp cấu hình mặc định từ file (`config.json` hoặc `config/pipeline.yaml`), hỗ trợ đọc các Workflow Templates định sẵn, và cho phép ghi đè (override) linh hoạt thông qua payload của API `POST /api/v1/jobs` hoặc cấu hình Web UI khi trigger job.
    - Xây dựng `MultiAgentStepRouter`:
      - Kiểm tra tính hợp lệ của agent được chỉ định cho từng bước so với `RunnerRegistry` (đã kích hoạt chưa, binary có sẵn trên máy chủ không).
      - Cơ chế Fallback an toàn: Nếu agent chỉ định cho một bước không khả dụng, tự động fallback về Default Agent có cấu hình sẵn kèm cảnh báo rõ ràng.
      - Điều phối việc kích hoạt đúng Runner Adapter tương ứng khi State Machine chuyển tiếp qua từng bước trong quy trình.
  - **Liên kết AC:** `AC-13`

---

## Phase 4: Agent Step Extraction & Process Execution Engine
*Mục tiêu: Quản lý vòng đời tiến trình con qua PTY, bóc tách luồng đầu ra thời gian thực thành các bước có cấu trúc, phát luồng log/event qua SSE/WebSocket, che giấu thông tin nhạy cảm (secret masking), kiểm soát timeout, tiêu diệt triệt để cây tiến trình khi có lệnh hủy, và hiện thực State Machine mở rộng với chu trình TESTING/FIXING tự động.*

- [ ] `TASK-4.1`: **Hiện thực PTY Process Spawner (Pseudo-Terminal Engine)**
  - **Mục tiêu:** Khởi chạy tiến trình con với đầy đủ môi trường terminal giả lập nhằm bắt trọn vẹn output ANSI và tiến độ thời gian thực.
  - **Chi tiết thực hiện:**
    - Triển khai module khởi chạy tiến trình qua PTY (Pseudo-terminal) tương thích đa nền tảng (Windows ConPTY / Unix pty qua `node-pty`).
    - Cấu hình capture độc lập cả luồng `stdout` và `stderr`.
    - Duy trì mã thoát (exit code), tín hiệu dừng và trạng thái tiến trình một cách chuẩn xác.
  - **Liên kết AC:** `AC-05`

- [ ] `TASK-4.2`: **Xây dựng Agent Step Parser Engine (Bóc tách bước thực thi của Agent)**
  - **Mục tiêu:** Phân tích luồng output văn bản thô từ các CLI để tự động nhận diện và cập nhật trạng thái của từng bước trong vòng đời của Agent.
  - **Chi tiết thực hiện:**
    - Xây dựng lớp `StepParser` bóc tách luồng văn bản của từng CLI thành cấu trúc `AgentStep`:
      - `id`: Định danh duy nhất của bước.
      - `stepIndex`: Thứ tự bước trong quy trình.
      - `stepType`: `PROVISIONING` | `PLANNING` | `TOOL_EXECUTION` | `FILE_MODIFICATION` | `TESTING` | `FIXING` | `VERIFICATION`.
      - `title`: Tiêu đề ngắn gọn mô tả hành động (ví dụ: "Phân tích yêu cầu", "Chạy lệnh bash", "Sửa file index.js", "Chạy test unit", "Phân tích & sửa lỗi kiểm thử").
      - `status`: `PENDING` | `IN_PROGRESS` | `COMPLETED` | `FAILED`.
      - `toolName`: Tên công cụ được gọi (nếu là bước tool execution: `bash`, `read`, `edit`, `write`, ...).
      - `details`: Nội dung chi tiết hoặc snippet lệnh/file/log lỗi.
      - `startedAt` & `completedAt`: Mốc thời gian ghi nhận.
    - Định nghĩa các mẫu regex và parser chuyên biệt cho 5 CLI:
      - **Bước 1 (Provisioning):** Nhận diện khởi tạo git worktree, nạp biến môi trường, kiểm tra binary.
      - **Bước 2 (Planning & Reasoning):** Bóc tách các đoạn suy luận, phân tích task, đọc file cấu trúc dự án.
      - **Bước 3 (Tool Execution & Code Modification):** Bắt các sự kiện đọc file, gọi lệnh terminal, chỉnh sửa mã nguồn.
      - **Bước 4 (Testing & Verification):** Bóc tách các lệnh chạy unit test, build test, linting.
      - **Bước 5 (Fixing & Bug Fix):** Bóc tách các hành động sửa lỗi dựa trên kết quả test thất bại.
    - Phát sự kiện `step` qua EventEmitter khi có bước mới hoặc bước hiện tại thay đổi trạng thái.
  - **Liên kết AC:** `AC-11`, `AC-14`

- [ ] `TASK-4.3`: **Hiện thực Secret Masking Stream Filter**
  - **Mục tiêu:** Loại bỏ hoàn toàn nguy cơ rò rỉ token, mật khẩu, khóa API bí mật lên giao diện Web UI hoặc nhật ký lưu trữ.
  - **Chi tiết thực hiện:**
    - Xây dựng luồng biến đổi dữ liệu (Transform Stream) lọc qua mọi byte dữ liệu `stdout`/`stderr` trước khi gửi tới SSE và ghi file log.
    - Tích hợp biểu thức chính quy (Regex) quét các mẫu nhạy cảm phổ biến:
      - Anthropic API Key: `sk-ant-[a-zA-Z0-9_\-]{20,}`
      - OpenAI API Key: `sk-[a-zA-Z0-9]{20,}`
      - GitLab Personal Access Token: `glpat-[a-zA-Z0-9_\-]{20,}`
      - GitHub Token: `ghp_[a-zA-Z0-9]{36}`
      - Mật khẩu / Token chuỗi: `password\s*=\s*['"][^'"]+['"]`
    - Thay thế các đoạn khớp bằng nhãn an toàn: `***MASKED***`.
  - **Liên kết AC:** `AC-06`

- [ ] `TASK-4.4`: **Xây dựng Log Buffer & Historical Replay Manager**
  - **Mục tiêu:** Lưu trữ nhật ký đầy đủ và cho phép người dùng mở lại trang Web UI sau khi job đã bắt đầu mà không bị mất log trước đó.
  - **Chi tiết thực hiện:**
    - Lưu toàn bộ output thô (đã qua Secret Masking) vào tệp `logs/{job_id}.log`.
    - Duy trì Ring Buffer trong bộ nhớ (500 dòng gần nhất) cho mỗi job đang chạy để phục vụ phản hồi nhanh.
    - Khi client mới kết nối tới SSE endpoint, tự động phát lại toàn bộ lịch sử các bước (`step` events) và log hiện có trước khi chuyển sang chế độ live stream.
  - **Liên kết AC:** `AC-05`, `AC-11`

- [ ] `TASK-4.5`: **Hiện thực Process Tree Killer & Graceful Termination**
  - **Mục tiêu:** Hủy triệt để toàn bộ cây tiến trình của agent khi người dùng bấm Cancel trên Web UI hoặc khi server shutdown, tránh sinh tiến trình zombie.
  - **Chi tiết thực hiện:**
    - Lưu lại Root Process ID (PID) của tiến trình con khi khởi chạy.
    - Áp dụng kỹ thuật duyệt và tiêu diệt toàn bộ Process Tree (`tree-kill` trên Node.js hoặc `taskkill /pid <PID> /T /F` trên Windows, `kill -9 -<PGID>` trên Unix).
    - Thực hiện theo quy trình 2 bước: gửi `SIGINT`/`SIGTERM` chờ phản hồi trong tối đa 5 giây; nếu không phản hồi sẽ áp dụng `SIGKILL` triệt để.
    - Cập nhật trạng thái job thành `CANCELLED` và kích hoạt dọn dẹp worktree an toàn.
  - **Liên kết AC:** `AC-07`, `AC-12`

- [ ] `TASK-4.6`: **Xây dựng Timeout Watchdog Timer**
  - **Mục tiêu:** Ngắt tự động các tác vụ bị treo, vòng lặp vô hạn hoặc chạy quá thời gian cấu hình.
  - **Chi tiết thực hiện:**
    - Khởi tạo bộ đếm thời gian độc lập cho mỗi job dựa trên `timeout_seconds` (mặc định 900 giây / 15 phút).
    - Khi hết hạn thời gian, tự động gọi cơ chế Process Tree Killer, đánh dấu trạng thái `TIMED_OUT`.
    - Bổ sung thông tin nguyên nhân timeout vào nhật ký và metadata của job.
  - **Liên kết AC:** `AC-08`

- [ ] `TASK-4.7`: **Hiện thực State Machine Chuẩn hóa Vòng đời Tác vụ: `TO DO` -> `PLANNING` -> `IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE` & Kiểm Soát Chặt Chẽ Trạng Thái `PENDING` (Chỉ Ở Bước PLANNING)**
  - **Mục tiêu:** Mở rộng và chuẩn hóa toàn diện cỗ máy trạng thái (FSM) quản lý trọn vẹn vòng đời tác vụ theo chuẩn 6 bước cốt lõi (`TO DO`, `PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`, `DONE`) cùng trạng thái tương tác người dùng `PENDING` (chỉ diễn ra duy nhất ở bước `PLANNING`), ngăn ngừa trạng thái bất định và chống lặp vô hạn.
  - **Chi tiết thực hiện:**
    - Định nghĩa Enum trạng thái nghiêm ngặt:
      - `TO DO`: Tiếp nhận yêu cầu, phân bổ slot worker, chuẩn bị sandbox workspace.
      - `PLANNING`: Kích hoạt bộ sinh kế hoạch song song (Dual Planning: Dev Plan và Test Plan).
      - `IMPLEMENT`: Kích hoạt agent lập trình triển khai mã nguồn theo Dev Plan (chạy hoàn toàn tự động).
      - `TESTING`: Khởi chạy Local Service qua Host Child Process, tương tác qua MCP CloakBrowser, kích hoạt Multi-Verification Gate (UI Screenshot, API Test, Log Scan, Database Query).
      - `FIXING`: Tiếp nhận Handoff Context Pack (ảnh evidence, API errors, logs, DB trace), agent sửa code, sau đó chuyển lại `TESTING` để re-test (chạy hoàn toàn tự động).
      - `PENDING`: Trạng thái tạm dừng an toàn (Pause/Wait) khi Agent gặp câu hỏi cần làm rõ hoặc phân vân lựa chọn — **CHỈ ĐƯỢC PHÉP KÍCH HOẠT DUY NHẤT Ở GIAI ĐOẠN `PLANNING`**.
      - `DONE`: Hoàn thành toàn bộ quy trình, nghiệm thu thành công.
      - Terminal states khác: `FAILED`, `CANCELLED`, `TIMED_OUT`.
    - Thiết lập bảng chuyển trạng thái (State Transition Table) hợp lệ & Validation Rules:
      - Tuyến chính: `TO DO` -> `PLANNING` -> `IMPLEMENT` -> `TESTING`.
      - **Cơ chế PENDING độc quyền ở PLANNING:**
        - Cho phép chuyển đổi `PLANNING` -> `PENDING` khi Agent phát hiện câu hỏi cần làm rõ yêu cầu hoặc lựa chọn kế hoạch.
        - Cho phép chuyển đổi `PENDING` -> `PLANNING` khi nhận câu trả lời từ người dùng qua API `/answer` để tiếp tục hoàn thiện kế hoạch.
      - **Validation logic chặn chuyển trạng thái PENDING sau PLANNING:**
        - Tuyệt đối CẤM chuyển đổi sang `PENDING` từ các trạng thái sau (`IMPLEMENT`, `TESTING`, `FIXING`). State Machine sẽ ném lỗi `InvalidStateTransitionException` hoặc từ chối chuyển trạng thái nếu nhận được yêu cầu chuyển sang `PENDING` ngoài giai đoạn `PLANNING`.
        - Khi kế hoạch đã được chốt ở bước `PLANNING`, toàn bộ các bước còn lại (`IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE`) vận hành hoàn toàn tự động (autonomous execution & self-healing loop) bám sát Dev Plan & Test Plan.
      - Tại `TESTING`: Nếu Multi-Verification Gate (cả 4 kênh) PASS -> `DONE`; nếu bất kỳ kênh nào FAIL -> chuyển sang `FIXING`.
      - Từ `FIXING`: Bắt buộc chỉ được chuyển lại về `TESTING` để re-test (không được nhảy cóc sang `DONE` hoặc rơi vào `PENDING`).
      - Khi ở `FIXING`, nếu vượt quá giới hạn `maxFixingRetries` (mặc định 3 lần) mà vẫn fail -> chuyển sang `FAILED`.
    - Phát sự kiện SSE/WebSocket realtime mỗi khi có sự chuyển dịch trạng thái để giao diện Web UI cập nhật lập tức.
  - **Đầu ra:** Module `JobStateMachine` chuẩn hóa kèm validation chặn `PENDING` sau `PLANNING`, test suite kiểm thử toàn bộ transition paths.
  - **Liên kết AC:** `AC-14`, `AC-19`

- [ ] `TASK-4.8`: **Xây dựng Cơ chế Chuyển giao Ngữ cảnh Lỗi (FIXING Handoff Context Pack Engine kèm Visual Evidence)**
  - **Mục tiêu:** Thu thập, chuẩn hóa và đóng gói toàn bộ thông tin kiểm thử thất bại từ bước `TESTING` (gồm ảnh screenshot bằng chứng, console logs, stack trace) để cung cấp ngữ cảnh đầy đủ nhất cho Agent bước `FIXING`.
  - **Chi tiết thực hiện:**
    - Thu thập dữ liệu từ kết quả bước `TESTING`:
      - Đường dẫn và danh sách ảnh chụp màn hình bằng chứng lỗi tại thư mục `feature/<feature-name>/evidence/`.
      - Kết quả đánh giá trực quan từ Visual Multimodal Verifier (danh sách visual defects, nhận định lỗi giao diện).
      - Console errors của browser (uncaught exceptions, failed network requests).
      - Stdout/stderr của dev server và unit/integration test logs.
      - Danh sách các file mã nguồn đã bị thay đổi trong workspace.
    - Đóng gói cấu trúc dữ liệu `HandoffContextPack`:
      - `failedTestCount`: Số lượng test/assertion thất bại.
      - `visualDefects`: Danh sách lỗi giao diện ghi nhận từ ảnh screenshot.
      - `evidenceScreenshots`: Danh sách đường dẫn ảnh chụp màn hình bằng chứng.
      - `errorSummary`: Tóm tắt lỗi ngắn gọn cho prompt đầu vào của agent.
      - `cleanedTestLog`: Toàn bộ log lỗi kiểm thử đã được xử lý qua bộ lọc Secret Masking (`AC-06`).
      - `modifiedFilesSnapshot`: Danh sách các file mã nguồn đã thay đổi.
      - `currentRetryAttempt`: Chỉ số vòng lặp hiện tại (ví dụ: Lần 1 / Tối đa 3 lần).
    - Tạo Prompt chuyên biệt cho Fixing Agent: "Dưới đây là danh sách lỗi kiểm thử và ảnh bằng chứng giao diện phát sinh sau khi chạy test. Hãy phân tích ảnh screenshot, error stack trace và mã nguồn trong workspace để sửa lỗi chính xác, bảo đảm không phá vỡ các phần đã pass".
    - Lưu trữ bản snapshot `HandoffContextPack` vào thư mục artifacts (`artifacts/{job_id}/handoff_retry_{attempt}.json`).
  - **Đầu ra:** Module `HandoffContextPackEngine`, artifact snapshot JSON và test case bàn giao context.
  - **Liên kết AC:** `AC-14`, `AC-18`

- [ ] `TASK-4.9`: **Hiện thực Dual Planning Generator (Sinh song song Dev Plan & Test Plan)**
  - **Mục tiêu:** Trong trạng thái `PLANNING`, tự động sinh ra hai bản kế hoạch độc lập nhưng đồng bộ: `dev_plan.md` (kế hoạch triển khai mã nguồn) và `test_plan.md` (kế hoạch kiểm thử cụ thể).
  - **Chi tiết thực hiện:**
    - Phân rã prompt lập kế hoạch thành 2 luồng chỉ dẫn kỹ thuật:
      - Luồng Dev Plan: Yêu cầu phân tích kiến trúc, danh sách file cần tạo/chỉnh sửa, thiết kế API endpoints, xử lý business logic và ràng buộc dữ liệu.
      - Luồng Test Plan: Yêu cầu xác định rõ các kịch bản kiểm thử, các bước kiểm thử cụ thể trên giao diện (click, fill input, verify text), dữ liệu test/mock data cần dùng, và điều kiện assertion mong đợi tại từng bước.
    - Kích hoạt AI Agent (hoặc điều phối 2 prompt song song nếu runner hỗ trợ) để sinh cấu trúc tài liệu Markdown chuẩn hóa.
    - Kiểm tra tính nhất quán (Consistency Gate) giữa Dev Plan và Test Plan trước khi chuyển trạng thái sang `IMPLEMENT`.
    - Lưu trữ trực tiếp hai file `dev_plan.md` và `test_plan.md` vào thư mục job artifacts / workspace.
  - **Đầu ra:** Generator module sinh song song 2 bản plan chuẩn, tài liệu `dev_plan.md` và `test_plan.md`.
  - **Liên kết AC:** `AC-15`

- [ ] `TASK-4.10`: **Hiện thực Local Service Runner & Healthcheck Watcher (Quản lý Lifecycle Dev Server)**
  - **Mục tiêu:** Tự động khởi chạy service trực tiếp tại local trước khi thực hiện browser test, giám sát cổng mạng và trạng thái sẵn sàng nhận request (Readiness Healthcheck).
  - **Chi tiết thực hiện:**
    - Phân tích workspace để nhận diện lệnh khởi chạy thích hợp (`npm run dev`, `npm start`, `node server.js`...) hoặc lấy từ cấu hình job.
    - Khởi chạy dev server dưới dạng tiến trình background con có quản lý PID độc lập (Process Lifecycle Manager).
    - Healthcheck Watcher:
      - Kiểm tra kết nối cổng mạng (wait-on port) định kỳ 200ms - 500ms.
      - Gửi HTTP GET tới endpoint `/health` hoặc root URL (`http://localhost:{port}/`) cho đến khi nhận HTTP 200 OK (hoặc timeout 60s).
    - Thu thập stdout/stderr của dev server, gắn cờ nhận diện và đẩy vào log stream chung để dễ truy vết.
    - Cơ chế Shutdown an toàn: Khi hoàn thành kiểm thử hoặc xảy ra lỗi, tự động dọn dẹp và kết liễu tiến trình dev server triệt để, không để xung đột cổng port cho các job tiếp theo.
  - **Đầu ra:** Module `LocalServiceRunner` với các hàm `startService()`, `waitForReady()`, `stopService()`.
  - **Liên kết AC:** `AC-16`

- [ ] `TASK-4.11`: **Hiện thực Browser Testing Runner & Visual Evidence Capture (MCP CloakBrowser)**
  - **Mục tiêu:** Tự động điều khiển trình duyệt qua MCP CloakBrowser headless, truy cập vào URL local service, thực hiện tương tác UI theo Test Plan và chụp ảnh màn hình lưu vào thư mục evidence.
  - **Chi tiết thực hiện:**
    - Tích hợp công cụ Browser Automation (MCP CloakBrowser).
    - Khởi tạo phiên duyệt web độc lập cho từng job, điều hướng đến URL local service (ví dụ: `http://localhost:3000`).
    - Parse kịch bản kiểm thử từ `test_plan.md` thành chuỗi hành động cụ thể:
      - Điều hướng trang (`navigate`).
      - Tương tác phần tử UI: click nút, nhập dữ liệu biểu mẫu (`fill`, `type_text`), chọn dropdown (`select_option`), cuộn trang (`scroll`).
      - Chờ đợi phần tử hiển thị (`wait_for_selector`, `wait_for_text`).
    - Chụp ảnh màn hình (Screenshot Capture):
      - Tự động chụp screenshot sau mỗi bước tương tác quan trọng hoặc khi phát hiện trạng thái giao diện thay đổi.
      - Chụp ảnh full-page hoặc viewport theo cấu hình test.
      - Lưu ảnh vào thư mục `feature/<feature-name>/evidence/` (hoặc `docs/features/<TICKET-ID>/evidence/`) theo định dạng đặt tên chuẩn: `step_{index}_{action_name}.png`.
    - Sinh file metadata `evidence/metadata.json` chứa thông tin chi tiết: step index, action, timestamp, selector, URL, console logs snapshot tại thời điểm chụp.
  - **Đầu ra:** Module `BrowserTestRunner`, Evidence Storage Manager và bộ ảnh screenshot hoàn chỉnh trong thư mục `evidence/`.
  - **Liên kết AC:** `AC-17`

- [ ] `TASK-4.12`: **Hiện thực Visual Multimodal Verifier Engine (Kiểm định Giao diện & Chức năng bằng Vision LLM)**
  - **Mục tiêu:** Sử dụng Multimodal Vision LLM kết hợp dữ liệu DOM và console errors để phân tích ảnh chụp màn hình evidence, xác minh giao diện và chức năng có đạt tiêu chí hay không.
  - **Chi tiết thực hiện:**
    - Thu thập danh sách ảnh screenshot từ thư mục `evidence/` kèm metadata và console logs.
    - Xây dựng Visual Verification Prompt: Cung cấp yêu cầu giao diện (từ expect.md và test_plan.md), truyền ảnh screenshot trực tiếp vào Vision LLM (multimodal model).
    - Chỉ thị Vision LLM phân tích đa chiều:
      - Bố cục giao diện (layout): Có bị vỡ, tràn viền, chồng chéo text/components không?
      - Trạng thái dữ liệu: Có hiển thị đúng mock data, text thông báo thành công/lỗi không?
      - Sự xuất hiện của các components cần thiết theo đặc tả.
    - Phân tích DOM và Console logs: Kiểm tra xem có unhandled JS errors, 404/500 API calls hay không.
    - Sinh báo cáo đánh giá cấu trúc JSON:
      - `passed`: `true` hoặc `false`.
      - `confidenceScore`: Điểm tin cậy (0 - 100).
      - `defects`: Danh sách các điểm bất thường hoặc lỗi thị giác được phát hiện.
      - `verdictSummary`: Tóm tắt đánh giá kết quả nghiệm thu.
    - Tự động ra quyết định chuyển trạng thái: nếu `passed === true` -> chuyển sang `DONE`; nếu `passed === false` -> chuyển sang `FIXING`.
  - **Đầu ra:** Module `VisualMultimodalVerifier`, JSON verification report.
  - **Liên kết AC:** `AC-18`

---

- [ ] `TASK-4.13`: **Xây dựng ApiTestRunner cho Multi-Verification Gate**
  - **Mục tiêu:** Tự động thực thi các test cases API đối với local service và kiểm tra kết quả theo đặc tả trong Test Plan.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `ApiTestRunner`:
      - Đọc danh sách API test cases từ `test_plan.md` hoặc cấu hình job.
      - Gửi HTTP requests (GET, POST, PUT, DELETE, PATCH) tới endpoint của local service với timeout và headers quy định.
      - Kiểm tra mã phản hồi HTTP status code (ví dụ: 200, 201, 204).
      - Xác thực JSON response payload, schema cấu trúc và các trường dữ liệu quan trọng.
      - Ghi nhận chi tiết kết quả từng request: URL, method, duration, status, request body, response body, kết luận PASSED/FAILED.
  - **Đầu ra:** Module `ApiTestRunner`, test report JSON chi tiết.
  - **Liên kết AC:** `AC-18`

- [ ] `TASK-4.14`: **Xây dựng DatabaseVerifier cho Multi-Verification Gate**
  - **Mục tiêu:** Thực thi các câu lệnh SQL truy vấn trực tiếp cơ sở dữ liệu để xác nhận dữ liệu đã được thêm, sửa, xóa chính xác theo nghiệp vụ.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `DatabaseVerifier`:
      - Kết nối tới cơ sở dữ liệu của dự án (hỗ trợ SQLite, PostgreSQL, MySQL qua cấu hình kết nối trong workspace/test plan).
      - Thực thi các câu lệnh SQL verification (SELECT query) trước và sau khi thực hiện kịch bản test.
      - Kiểm tra số lượng bản ghi (record count) và giá trị các cột dữ liệu quan trọng so với kỳ vọng trong Test Plan.
      - Đóng gói kết quả query gồm: câu truy vấn SQL, số dòng trả về, snapshot dữ liệu dạng bảng/JSON, trạng thái PASSED/FAILED.
  - **Đầu ra:** Module `DatabaseVerifier`, bộ adapter kết nối DB an toàn read-only.
  - **Liên kết AC:** `AC-18`

- [ ] `TASK-4.15`: **Xây dựng LogScanner quét Service Logs cho Multi-Verification Gate**
  - **Mục tiêu:** Phân tích toàn bộ log đầu ra của Host Child Process trong và sau quá trình test để phát hiện lỗi runtime tiềm ẩn.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `LogScanner`:
      - Lắng nghe và thu thập toàn bộ log stdout/stderr của dev server cục bộ.
      - Áp dụng các bộ lọc regex phát hiện: uncaught exceptions, unhandled promise rejections, fatal errors, stack traces, panics, warning nghiêm trọng.
      - Phân loại mức độ lỗi (CRITICAL, ERROR, WARNING) và trích xuất dòng log gây lỗi cùng ngữ cảnh lân cận (3 dòng trước và sau).
      - Đánh giá kết luận: `CLEAN` (không phát hiện lỗi) hoặc `HAS_ERRORS` (kèm danh sách lỗi đã lọc).
  - **Đầu ra:** Module `LogScanner`, báo cáo log analysis JSON.
  - **Liên kết AC:** `AC-18`

- [ ] `TASK-4.16`: **Hiện thực Multi-Verification Gate Evaluator & Fixing Decision Engine**
  - **Mục tiêu:** Tổng hợp kết quả từ cả 4 kênh thẩm định (Screenshot qua MCP CloakBrowser, API Test, Log Scan, DB Query) và đưa ra quyết định chuyển sang `DONE` hoặc `FIXING`.
  - **Chi tiết thực hiện:**
    - Triển khai lớp `MultiVerificationGateEvaluator`:
      - Thu thập kết quả đồng thời từ: (1) `VisualMultimodalVerifier` (UI Screenshot Evidence qua MCP CloakBrowser), (2) `ApiTestRunner` (API Test Results), (3) `LogScanner` (Log Verification), (4) `DatabaseVerifier` (Database Query Verification).
      - Kiểm tra điều kiện nghiệm thu nghiêm ngặt: Chỉ khi TẤT CẢ 4 kênh đều đạt trạng thái PASSED thì Job mới đủ điều kiện hoàn thành và chuyển sang `DONE`.
      - Nếu bất kỳ kênh nào FAILED: Đóng gói toàn bộ bằng chứng thất bại (ảnh chụp lỗi, API failed payload, stack trace log, DB query sai lệch) vào `HandoffContextPack` và kích hoạt chuyển trạng thái sang `FIXING`.
  - **Đầu ra:** Module `MultiVerificationGateEvaluator`, logic gating nghiêm ngặt 4 kênh.
  - **Liên kết AC:** `AC-18`, `AC-14`

## Phase 5: Web UI Dashboard Implementation (Giao diện Web điều khiển tập trung)
*Mục tiêu: Xây dựng toàn bộ giao diện Web SPA gọn nhẹ, trực quan, thẩm mỹ, phục vụ trực tiếp từ server Node.js. Cho phép người dùng quản trị runner, tạo job với bộ chọn pipeline đa agent, theo dõi tiến độ các bước thời gian thực (bao gồm TESTING và FIXING), xem log qua Terminal giả lập và tương tác kiểm tra Git Diff trực tiếp trên trình duyệt.*

- [ ] `TASK-5.1`: **Xây dựng Single-Server Web Frontend Foundation & Layout**
  - **Mục tiêu:** Thiết lập khung giao diện ứng dụng web Single Page Application (HTML5, Modern CSS / Tailwind, Vanilla JS hoặc Vue/Preact gọn nhẹ nhúng sẵn không cần máy chủ dev riêng biệt).
  - **Chi tiết thực hiện:**
    - Thiết kế bố cục chuẩn Dashboard: Top Navigation Bar (Logo, Host Status, Worker Slot Badge, Refresh), Sidebar / Tab Switcher (Jobs, Create Job, Runners, Settings), và Main Content Area.
    - Cấu hình theme tối tân (Modern Dark/Light Mode hỗ trợ lập trình viên).
    - Xây dựng tầng API Client giao tiếp bất đồng bộ qua `fetch` và kết nối luồng sự kiện `EventSource` (SSE).
  - **Liên kết AC:** `AC-10`

- [ ] `TASK-5.2`: **Xây dựng Job Management & Creation UI**
  - **Mục tiêu:** Cung cấp giao diện trực quan để người dùng theo dõi danh sách tác vụ và khởi tạo tác vụ AI Code mới.
  - **Chi tiết thực hiện:**
    - **Màn hình Danh sách Jobs:**
      - Bảng hiển thị danh sách job với các cột: Job ID, Agent Pipeline / Runner, Repository & Branch, Trạng thái (badge có màu động), Thời gian bắt đầu, Thời lượng (Duration), và Cột Hành động.
      - Bộ lọc theo trạng thái (`ALL`, `RUNNING`, `SUCCESS`, `FAILED`, `CANCELLED`, `TESTING`, `FIXING`) và ô tìm kiếm theo ID/prompt.
    - **Màn hình Khởi tạo Job (Job Creation Modal / Page):**
      - Form chọn chế độ chạy: Đơn lẻ (Single Runner) hoặc Chuỗi quy trình (Multi-Agent Pipeline).
      - Input nhập Git Repository URL và Target Branch.
      - Textarea nhập Prompt / Nhiệm vụ với bộ đếm ký tự.
      - Cấu hình nâng cao (Accordion): Timeout (giây), Model override, Custom Environment Variables, Max Resolve Retries.
      - Nút Submit "Khởi chạy Tác vụ" có loading state và tự động chuyển hướng đến màn hình chi tiết job vừa tạo.
  - **Liên kết AC:** `AC-10`, `AC-12`, `AC-13`

- [ ] `TASK-5.3`: **Xây dựng Visual Step-by-Step Progress Timeline**
  - **Mục tiêu:** Biểu diễn trực quan tiến trình làm việc của Agent theo từng bước trên giao diện chi tiết Job.
  - **Chi tiết thực hiện:**
    - Thiết kế component Timeline dạng đứng (Vertical Step Indicator) hiển thị các bước:
      - Bước 1: Khởi tạo môi trường & Git Worktree (`PROVISIONING`).
      - Bước 2: Lập kế hoạch & Phân tích yêu cầu (`PLANNING`).
      - Bước 3: Triển khai mã nguồn & Chỉnh sửa file (`IMPLEMENTING`).
      - Bước 4: Kiểm thử tự động (`TESTING`).
      - Bước 5: Phân tích & Sửa lỗi kiểm thử (`FIXING` - hiển thị động khi có lỗi).
      - Bước 6: Hoàn tất & Trích xuất Git Diff (`FINALIZING`).
    - Mỗi bước có biểu tượng trạng thái trực quan: Chờ (Gray), Đang chạy (Spinning Blue/Amber), Hoàn tất (Green Checkmark), Thất bại (Red X).
    - Click vào từng bước để mở rộng chi tiết (thời gian thực hiện, tên tool/file đã sửa, tóm tắt kết quả kiểm thử).
  - **Liên kết AC:** `AC-11`, `AC-14`

- [ ] `TASK-5.4`: **Tích hợp Terminal Simulator (xterm.js / ANSI Color Renderer)**
  - **Mục tiêu:** Cung cấp trải nghiệm xem log thời gian thực mượt mà như đang theo dõi trực tiếp tại Terminal máy trạm.
  - **Chi tiết thực hiện:**
    - Nhúng thư viện `xterm.js` hoặc bộ parse ANSI renderer nhẹ tối ưu DOM.
    - Kết nối luồng dữ liệu từ SSE `event: log` trực tiếp vào instance terminal.
    - Cung cấp thanh công cụ điều khiển:
      - Nút "Tự động cuộn (Auto-scroll)" bật/tắt khi người dùng lăn chuột đọc lại log cũ.
      - Nút "Sao chép toàn bộ nhật ký (Copy Log)" vào Clipboard.
      - Nút "Tải file log thô (Download .log)".
      - Bộ lọc tìm kiếm từ khóa trực tiếp trên nội dung terminal.
  - **Liên kết AC:** `AC-05`, `AC-12`

- [ ] `TASK-5.5`: **Tích hợp Visual Git Diff Viewer (File Tree & Diff Highlighting)**
  - **Mục tiêu:** Trình bày trực quan các thay đổi mã nguồn do Agent thực hiện để lập trình viên review trước khi merge.
  - **Chi tiết thực hiện:**
    - Nhúng component hiển thị Diff với 2 chế độ xem: Split View (Side-by-Side) và Unified View.
    - Cột bên trái hiển thị cây tệp đã sửa đổi (File Tree) kèm số lượng dòng thêm/bớt (+ xanh / - đỏ).
    - Cột bên phải tô màu cú pháp (Syntax Highlighting) theo ngôn ngữ (JS, TS, Python, Java, Go, v.v.).
    - Tải dữ liệu diff từ API `GET /api/v1/jobs/{id}/diff` khi job hoàn tất.
  - **Liên kết AC:** `AC-09`, `AC-12`

- [ ] `TASK-5.6`: **Xây dựng Runner Status & System Control Settings**
  - **Mục tiêu:** Cung cấp màn hình quản trị hệ thống cho phép kiểm tra trạng thái các Runner và điều khiển khẩn cấp.
  - **Chi tiết thực hiện:**
    - Màn hình Runner Status: Hiển thị bảng 5 CLI Runners kèm trạng thái phát hiện (`Installed` / `Not Found`), đường dẫn thực thi và phiên bản hiện tại.
    - Widget giám sát tài nguyên: Số worker slots đang bận/rảnh, tỷ lệ RAM/CPU sử dụng.
    - Bộ điều khiển tương tác trên từng Job:
      - Nút "Hủy tác vụ (Cancel Job)" có popup xác nhận.
      - Nút "Chạy lại (Re-run Job)" cho phép kế thừa cấu hình cũ.
  - **Liên kết AC:** `AC-01`, `AC-02`, `AC-12`

- [ ] `TASK-5.7`: **Nâng cấp Web UI: Multi-Agent Step Pipeline Selector & Visual Timeline cho TESTING/FIXING**
  - **Mục tiêu:** Cung cấp giao diện trực quan trên Web UI cho phép người dùng cấu hình pipeline đa agent theo từng bước và hiển thị sinh động trạng thái `TESTING`, `FIXING` cùng vòng lặp feedback loop trên Timeline.
  - **Chi tiết thực hiện:**
    - **Nâng cấp Form Khởi tạo Job (Job Creation Form):**
      - Bổ sung bộ chọn pipeline từng bước (Step-by-Step Agent Pipeline Selector): Cho phép cấu hình riêng biệt agent cho từng giai đoạn (Planning -> dropdown chọn agent, Implementation -> dropdown chọn agent, Testing -> dropdown chọn agent, Fixing -> dropdown chọn agent).
      - Hỗ trợ dropdown chọn nhanh các Workflow Templates định sẵn (ví dụ: "Claude + OpenCode Hybrid", "Full Claude", "Codex + OMP Testing").
      - Cung cấp trường nhập `maxFixingRetries` (giá trị mặc định 3, phạm vi 1-10).
      - Tích hợp kiểm tra tính hợp lệ: Chỉ cho phép chọn các agent đang có trạng thái `ENABLED` trong Agent Registry.
    - **Nâng cấp Timeline Giám sát (Visual Execution Timeline):**
      - Bổ sung các node trạng thái `TESTING` và `FIXING` vào thanh tiến trình Timeline trực quan.
      - Hiển thị badge chỉ báo vòng lặp sửa lỗi: Ví dụ "Fixing (Vòng 1/3)", "Re-testing (Vòng 2/3)".
      - Hiển thị thông tin Agent phụ trách tại mỗi bước (ví dụ: "Testing by OMP", "Fixing by Claude Code").
      - Thêm panel mở rộng cho bước `FIXING` cho phép xem trực tiếp `HandoffContextPack` (danh sách test cases thất bại, stack trace và gợi ý khắc phục).
  - **Liên kết AC:** `AC-10`, `AC-11`, `AC-13`, `AC-14`

---

- [ ] `TASK-5.8`: **Hiện thực Dual Plan Viewer (Hiển thị song song Dev Plan và Test Plan trên Web UI Dashboard)**
  - **Mục tiêu:** Cung cấp giao diện trực quan cho phép lập trình viên xem song song hoặc chuyển đổi qua lại mượt mà giữa `Dev Plan` và `Test Plan`.
  - **Chi tiết thực hiện:**
    - Thiết kế giao diện Dual-Tab hoặc Split-View hiển thị đồng thời nội dung Markdown của `dev_plan.md` và `test_plan.md`.
    - Tích hợp Markdown renderer có syntax highlighting cho code blocks và checklist status tracker cho từng đầu mục.
    - Cho phép tìm kiếm nhanh từ khóa trong cả 2 bản plan.
    - Cập nhật realtime khi agent bước `PLANNING` hoàn thành việc sinh kế hoạch.
  - **Đầu ra:** Component `DualPlanViewer` trên Web UI Dashboard.
  - **Liên kết AC:** `AC-19`

- [ ] `TASK-5.9`: **Hiện thực Evidence Gallery Modal & Visual Test Inspector (Thư viện Ảnh chụp màn hình và Visual Inspection)**
  - **Mục tiêu:** Xây dựng thư viện hiển thị ảnh chụp màn hình bằng chứng kiểm thử trực quan và thanh tra chi tiết kết quả visual inspection.
  - **Chi tiết thực hiện:**
    - Thumbnail Grid Gallery: Hiển thị toàn bộ ảnh chụp màn hình trong thư mục `evidence/` theo thứ tự các bước test.
    - Lightbox Inspector: Cho phép click phóng to ảnh độ phân giải cao, hỗ trợ zoom/pan và so sánh ảnh giữa các lần test.
    - Hiển thị thông tin đi kèm mỗi ảnh: Test Step Description, URL kiểm thử, timestamp, console errors và đánh giá của Visual Verifier (PASS/FAIL).
    - Gắn nhãn trạng thái trực quan: Badge màu xanh (PASS) hoặc màu đỏ (DEFECT DETECTED kèm mô tả lỗi).
  - **Đầu ra:** Component `EvidenceGallery` và `VisualTestInspector` trên Web UI Dashboard.
- **Liên kết AC:** `AC-18`

---

- [ ] `TASK-5.10`: **Xây dựng Live Web Terminal Streaming View (xterm.js Full-Fidelity)**
  - **Mục tiêu:** Cung cấp Live Terminal hiển thị trực tiếp khi agent đang chạy với độ trung thực tuyệt đối (full fidelity) trên Web UI Dashboard.
  - **Chi tiết thực hiện:**
    - Tích hợp thư viện `xterm.js` và addon `xterm-addon-fit`, `xterm-addon-web-links`.
    - Hỗ trợ đầy đủ ANSI color codes, font monospace chuẩn, giao diện dark mode chuyên nghiệp.
    - Kết nối luồng stdout/stderr trực tiếp qua WebSocket/SSE với độ trễ < 500ms.
    - Cung cấp các nút công cụ tiện ích:
      - Nút bật/tắt tự động cuộn (Auto-scroll toggle).
      - Nút sao chép toàn bộ log (Copy Terminal Output).
      - Chế độ xem văn bản thô (Toggle Raw stdout/stderr mode).
  - **Đầu ra:** Component `LiveTerminal.vue` / `LiveTerminal.tsx`, giao diện terminal mượt mà.
  - **Liên kết AC:** `AC-05`, `AC-20`

- [ ] `TASK-5.11`: **Xây dựng Interactive Question Modal & Human Clarification Interface (Xử lý trạng thái PENDING Độc Quyền ở Bước PLANNING)**
  - **Mục tiêu:** Cung cấp giao diện tương tác người dùng khi Job chuyển sang trạng thái `PENDING` (chỉ diễn ra duy nhất ở bước `PLANNING`) để giải quyết câu hỏi làm rõ kế hoạch / Dual Plan, và hiển thị chỉ dẫn rõ ràng rằng các bước sau sẽ chạy tự động.
  - **Chi tiết thực hiện:**
    - Thiết kế Popup Modal / Banner cảnh báo nổi bật xuất hiện ngay khi Job nhận sự kiện `PENDING` trong bước `PLANNING`.
    - Hiển thị tiêu đề và nội dung câu hỏi chi tiết từ Agent liên quan đến yêu cầu hoặc phương án kế hoạch.
    - Cung cấp danh sách các tùy chọn có sẵn (multiple choice options dạng radio hoặc checkbox) để người dùng tích chọn nhanh.
    - Cung cấp ô nhập liệu tùy chỉnh (custom reply textarea / chat input) cho phép người dùng gõ câu trả lời hoặc chỉ đạo chi tiết.
    - Nút "Gửi câu trả lời (Submit Answer)" gửi payload lên API `POST /api/v1/jobs/{id}/answer`.
    - Tự động đóng modal, hiển thị loading và chuyển giao diện về trạng thái `PLANNING` tiếp tục hoàn thiện kế hoạch sau khi submit thành công.
    - Hiển thị thông báo hoặc nhãn chỉ dẫn trên Web UI: Quá trình làm rõ (Human-in-the-Loop) chỉ diễn ra ở bước `PLANNING`; sau khi chốt kế hoạch, các bước `IMPLEMENT`, `TESTING`, `FIXING` sẽ chạy hoàn toàn tự động mà không tạm dừng chờ người dùng.
  - **Đầu ra:** Component `ClarificationModal.vue` / `ClarificationModal.tsx`, luồng tương tác hoàn chỉnh.
  - **Liên kết AC:** `AC-19`

- [ ] `TASK-5.12`: **Xây dựng Multi-Evidence Dashboard (Tab Ảnh, Tab API, Tab Log, Tab DB Query)**
  - **Mục tiêu:** Xây dựng màn hình hiển thị toàn diện 4 kênh bằng chứng nghiệm thu trực quan trên Web UI Dashboard.
  - **Chi tiết thực hiện:**
    - Tích hợp Evidence Inspector gồm 4 Tabs chuyên biệt:
      1. **Tab 📸 UI Screenshot Evidence:** Thư viện ảnh chụp màn hình từ MCP CloakBrowser, xem chi tiết, phóng to zoom/lightbox, hiển thị visual verification verdict.
      2. **Tab 🌐 API Test Results:** Bảng tổng hợp các API test cases, phương thức HTTP, endpoint URL, HTTP status code, response time, checklist assertions, viewer JSON payload.
      3. **Tab 📋 Log Verification:** Trình xem log service có màu sắc highlight theo mức độ, bộ lọc tìm kiếm, bảng thống kê các lỗi do LogScanner phát hiện.
      4. **Tab 🗄️ Database Query Verification:** Bảng hiển thị các câu lệnh SQL thực thi, số bản ghi bị ảnh hưởng, snapshot dữ liệu trả về trước và sau khi thao tác.
    - Hiển thị tổng kết trạng thái Gate: Đạt (ALL PASSED) hoặc Không đạt (FAILED Channels highlighted).
  - **Đầu ra:** Component `MultiEvidenceDashboard.vue` / `MultiEvidenceDashboard.tsx`.
  - **Liên kết AC:** `AC-18`

## Phase 6: Testing, Hardening & Integration Verification
*Mục tiêu: Đảm bảo chất lượng hệ thống thông qua các bộ kiểm thử tự động toàn diện: unit test, integration test, stress test hàng đợi, kiểm thử bảo mật rò rỉ secret, kiểm thử cơ chế Multi-Agent Pipeline, Handoff Context và chu trình Feedback Loop Fixing.*

- [ ] `TASK-6.1`: **Xây dựng Unit Test Suite cho Core Modules, Secret Masking & Step Parser**
  - **Mục tiêu:** Đạt độ bao phủ kiểm thử cao cho các module xử lý dữ liệu lõi của server.
  - **Chi tiết thực hiện:**
    - Kiểm thử hàm Masking với các trường hợp biên: key nằm đầu dòng, cuối dòng, bị ngắt giữa chuỗi, chuỗi base64.
    - Kiểm thử `StepParser` với các chuỗi output mẫu thu thập từ cả 5 CLI, đảm bảo bóc tách đúng step và không bị false positive.
    - Kiểm thử Semaphore limiter: Đảm bảo không bao giờ vượt quá `max_concurrent_workers`.
  - **Liên kết AC:** `AC-05`, `AC-06`, `AC-11`

- [ ] `TASK-6.2`: **Kiểm thử tích hợp Git Worktree Isolation & Concurrency**
  - **Mục tiêu:** Đảm bảo khả năng chạy song song nhiều job trên cùng kho mã nguồn mà không xảy ra xung đột.
  - **Chi tiết thực hiện:**
    - Khởi chạy đồng thời 3 job trên cùng một repo Git test cục bộ.
    - Xác minh mỗi job được cấp một nhánh và worktree path riêng biệt trong `workspaces/`.
    - Xác minh thay đổi file ở job A không làm ảnh hưởng đến thư mục làm việc của job B.
    - Xác minh quy trình dọn dẹp worktree giải phóng tài nguyên sạch sẽ vào Recycle Bin / Trash.
  - **Liên kết AC:** `AC-04`

- [ ] `TASK-6.3`: **Kiểm thử đo lường Realtime SSE Streaming & Latency**
  - **Mục tiêu:** Xác minh luồng phát log và cập nhật bước thời gian thực qua SSE đạt yêu cầu độ trễ.
  - **Chi tiết thực hiện:**
    - Thiết lập kịch bản phát sinh log liên tục với tần suất cao (100 dòng/giây).
    - Đo lường khoảng thời gian từ khi tiến trình con xuất log đến khi client SSE nhận được dữ liệu (mục tiêu: độ trễ < 500ms).
    - Kiểm tra tính toàn vẹn của UTF-8 và chuỗi ANSI không bị cắt cụt giữa các chunk.
  - **Liên kết AC:** `AC-05`, `AC-11`

- [ ] `TASK-6.4`: **Kiểm thử khẩn cấp: Cancellation, Process Tree Kill & Timeout Watchdog**
  - **Mục tiêu:** Xác nhận khả năng dừng tiến trình triệt để khi có lệnh Cancel hoặc quá hạn thời gian.
  - **Chi tiết thực hiện:**
    - Khởi chạy một dummy runner có spawn các subprocess con chạy vòng lặp vô hạn.
    - Gửi tín hiệu Cancel qua API/Web UI: Xác minh toàn bộ cây tiến trình (Parent + Children) bị tiêu diệt hoàn toàn trong vòng dưới 5 giây, không còn process treo trong Task Manager/Process Table.
    - Thiết lập job với `timeout_seconds = 3`: Xác minh job tự động chuyển sang trạng thái `TIMED_OUT` và ngắt tiến trình đúng thời điểm.
  - **Liên kết AC:** `AC-07`, `AC-08`, `AC-12`

- [ ] `TASK-6.5`: **Kiểm thử Web UI Dashboard & Single Server Static Serving**
  - **Mục tiêu:** Kiểm tra hoạt động của giao diện Web trên trình duyệt khi chạy chung một cổng máy chủ với API.
  - **Chi tiết thực hiện:**
    - Kiểm tra truy cập `http://localhost:3000/` trả về trang Web Dashboard với mã HTTP 200.
    - Kiểm tra các liên kết tĩnh (CSS, JS, Fonts) tải thành công không bị lỗi 404.
    - Kiểm tra tương tác tạo job từ Form trên Web UI: Gửi dữ liệu đúng đến API và chuyển sang màn hình chi tiết.
    - Kiểm tra tính tương thích hiển thị của xterm.js và diff viewer trên các trình duyệt hiện đại (Chrome, Edge, Firefox).
  - **Liên kết AC:** `AC-10`, `AC-11`, `AC-12`

- [ ] `TASK-6.6`: **End-to-End Verification cho 5 Runner Adapters, Web UI & Báo cáo hoàn tất**
  - **Mục tiêu:** Chạy thử nghiệm trọn vẹn vòng đời tác vụ trên môi trường thật với 5 CLI runner và xuất báo cáo nghiệm thu.
  - **Chi tiết thực hiện:**
    - Chạy kịch bản E2E mẫu: Khởi tạo tác vụ -> Kiểm tra hàng đợi -> Mở Worktree -> Điều phối Runner -> Bóc tách các bước -> Hiển thị trên Web UI -> Xem log qua xterm.js -> Trích xuất Diff -> Kết thúc thành công.
    - Kiểm tra hành vi khi runner binary không tồn tại trên host: Server thông báo lỗi rõ ràng `RUNNER_NOT_FOUND` và không làm crash máy chủ.
    - Thu thập toàn bộ bằng chứng test, tổng hợp kết quả vào `report.md`.
  - **Liên kết AC:** `AC-01`, `AC-02`, `AC-03`, `AC-04`, `AC-05`, `AC-06`, `AC-07`, `AC-08`, `AC-09`, `AC-10`, `AC-11`, `AC-12`, `AC-13`, `AC-14`

- [ ] `TASK-6.7`: **Kiểm thử Multi-Agent Pipeline, Handoff Context & Feedback Loop Fixing**
  - **Mục tiêu:** Kiểm thử toàn diện cơ chế điều phối đa agent theo pipeline, chuyển giao ngữ cảnh lỗi và vòng lặp testing/fixing với giới hạn retry.
  - **Chi tiết thực hiện:**
    - Unit test cho `AgentPipelineConfig` schema validation, per-step agent resolution và `HandoffContextPack` generator.
    - Integration test mô phỏng State Machine: Trigger job -> `IMPLEMENTING` -> `TESTING` (mô phỏng fail) -> `FIXING` -> `TESTING` (mô phỏng pass) -> `COMPLETED`.
    - Kiểm thử cơ chế Infinite Loop Breaker: Mô phỏng test liên tục fail vượt quá `maxFixingRetries` (3 lần) -> xác nhận job chuyển `FAILED` đúng hạn định với mã lỗi `MAX_FIXING_RETRIES_EXCEEDED`.
    - Kiểm thử Web UI E2E: Tạo job với cấu hình multi-agent pipeline từ form, xác nhận SSE stream cập nhật đúng các bước và vòng lặp retry trên Timeline trực quan.
  - **Liên kết AC:** `AC-13`, `AC-14`

- [ ] `TASK-6.8`: **Xây dựng Unit Test Suite cho ApiTestRunner, DatabaseVerifier và LogScanner**
  - **Mục tiêu:** Đảm bảo tính chính xác và ổn định của các module thẩm định nghiệm thu đa kênh.
  - **Chi tiết thực hiện:**
    - Viết unit tests cho `ApiTestRunner`: mock HTTP responses, validate assertions, timeout handling.
    - Viết unit tests cho `DatabaseVerifier`: mock database connection, query execution, row validation.
    - Viết unit tests cho `LogScanner`: regex parsing, error classifications, false positive filtering.
    - Viết unit tests cho `MultiVerificationGateEvaluator`: kiểm tra logic gating (cả 4 pass -> DONE; 1 fail -> FIXING).
  - **Đầu ra:** File test `tests/unit/multi-verification-gate.test.js`.
  - **Liên kết AC:** `AC-18`

- [ ] `TASK-6.9`: **Xây dựng Test Suite cho ClarificationManager, Luồng PENDING Pause/Resume & Validation Chặn PENDING Sau PLANNING**
  - **Mục tiêu:** Kiểm thử độ tin cậy của cơ chế tạm dừng an toàn và nạp câu trả lời của người dùng trong bước `PLANNING`, cùng validation logic chặn chuyển `PENDING` ở các bước sau.
  - **Chi tiết thực hiện:**
    - Giả lập Agent phát câu hỏi cần làm rõ trong giai đoạn `PLANNING`, assert Job chuyển sang trạng thái `PENDING`.
    - Kiểm tra tiến trình Agent bị tạm dừng an toàn (Pause/Wait).
    - Gọi API `POST /api/v1/jobs/{id}/answer` với các tùy chọn và custom text, assert câu trả lời được nạp vào context.
    - Assert tiến trình Agent được resume thành công và Job trở lại trạng thái `PLANNING` để hoàn thiện kế hoạch.
    - Unit test validation logic: Kiểm tra hành vi khi cố tình trigger chuyển sang `PENDING` từ các trạng thái `IMPLEMENT`, `TESTING`, `FIXING` -> assert hệ thống từ chối (throw `InvalidStateTransitionException` hoặc reject), không tạm dừng tiến trình và giữ nguyên luồng chạy tự động bám sát kế hoạch.
  - **Đầu ra:** File test `tests/unit/clarification-manager.test.js` và `tests/unit/state-machine-pending-validation.test.js`.
  - **Liên kết AC:** `AC-19`

- [ ] `TASK-6.10`: **Kiểm thử Tích hợp Chu trình Toàn diện: Dual Planning, Host Child Process, MCP CloakBrowser, Multi-Verification Gate, PENDING Clarification (Chỉ ở PLANNING) & FIXING Feedback Loop**
  - **Mục tiêu:** Kiểm thử toàn diện end-to-end kịch bản chạy thực tế qua trọn vẹn các trạng thái vòng đời (`TO DO`, `PLANNING`, `PENDING`, `IMPLEMENT`, `TESTING`, `FIXING`, `DONE`).
  - **Chi tiết thực hiện:**
    - Tạo kịch bản mẫu: Yêu cầu xây dựng ứng dụng Web có tương tác dữ liệu.
    - Kiểm tra chu trình tuần tự:
      1. Tiếp nhận job (`TO DO`).
      2. Kích hoạt Dual Planning sinh đồng thời `dev_plan.md` và `test_plan.md` (`PLANNING`). Giả lập trường hợp Agent cần làm rõ yêu cầu -> chuyển `PENDING` -> User trả lời qua Web UI Modal/API `/answer` -> Resume tiếp tục hoàn thiện kế hoạch (`PLANNING`).
      3. Sau khi kế hoạch hoàn tất và chốt, chuyển sang thực thi viết mã (`IMPLEMENT`) chạy hoàn toàn tự động, xác nhận không chuyển `PENDING`.
      4. Khởi chạy Local Service qua Host Child Process, điều khiển MCP CloakBrowser, chụp ảnh evidence.
      5. Thực hiện Multi-Verification Gate: chạy đồng thời UI Screenshot, API Test, Log Scan, Database Query (`TESTING`).
    - Kịch bản Fail & Fixing Loop:
      - Giả lập lỗi API hoặc DB sai lệch để kích hoạt chuyển sang `FIXING`.
      - Xác nhận `HandoffContextPack` chứa đầy đủ bằng chứng 4 kênh.
      - Xác nhận agent bước `FIXING` sửa mã nguồn thành công hoàn toàn tự động (không dừng chờ PENDING) và chuyển lại `TESTING` re-test đạt trạng thái `DONE`.
    - Xác nhận Web UI Dashboard hiển thị Live Terminal xterm.js full-fidelity, Clarification Modal (ở bước PLANNING), và Multi-Evidence Tabs.
  - **Đầu ra:** Bộ kịch bản integration test hoàn chỉnh, test snapshots xác thực.
  - **Liên kết AC:** `AC-14`, `AC-15`, `AC-16`, `AC-17`, `AC-18`, `AC-19`, `AC-20`
---
