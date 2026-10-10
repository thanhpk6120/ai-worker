# Đặc tả yêu cầu nghiệp vụ & kỹ thuật (expect.md)
## Feature: Create-AI-Worker — Server Quản lý & Điều phối Headless AI Agent Code

- **Feature ID:** `Create-AI-Worker`
- **Domain:** AI Worker Platform / Agent Orchestration / Headless Runner / Visual Verification / Multi-Verification Evidence Gate
- **Ngôn ngữ & Nền tảng:** JavaScript / Node.js (Toàn bộ hệ thống chạy trên Single Server duy nhất)
- **Phiên bản:** 2.1.0
- **Trạng thái:** DRAFT / PLAN-REVIEW
- **Tác giả:** System Architect & AI Team
- **Hỗ trợ các CLI:** Claude Code, OpenCode, OMP, Codex CLI, Antigravity CLI
- **Browser Engine:** MCP CloakBrowser (khẳng định duy nhất, không dùng Playwright)
- **Local Service Management:** Host Child Process (khẳng định duy nhất, không dùng Docker)

---

## 1. Bối cảnh & Vấn đề (Context & Problem Statement)

### 1.1 Thực trạng
- Hiện nay, các kỹ sư phần mềm sử dụng nhiều AI Agent CLI khác nhau để viết code, refactor, phân tích lỗi và tạo unit test (`claude` từ Anthropic, `opencode`, `omp` - Oh My Prompt/Agent, `codex` từ OpenAI, `antigravity` từ DeepMind).
- Phần lớn các CLI này hoạt động ở chế độ tương tác đầu cuối (interactive TTY), đòi hỏi con người trực tiếp gõ lệnh, bấm xác nhận (approval prompt) và chờ kết quả tại máy cá nhân.
- Khi muốn tự động hóa luồng làm việc (tự động giải quyết Jira issue, tự động fix bug khi có GitLab CI failed, tự động chạy loop viết unit test hoặc audit security), việc thiếu một **server tập trung quản lý và trigger các AI Agent ở chế độ headless** trở thành rào cản lớn.
- **Thiếu Live Terminal Streaming trực quan**: Trong quá trình agent chạy headless, người dùng không thể quan sát trực tiếp từng dòng lệnh, log build và output dòng lệnh, dẫn đến trạng thái "hộp đen" gây khó khăn cho việc giám sát tiến độ và phát hiện tắc nghẽn.
- **Kiểm thử đơn lẻ không đảm bảo chất lượng (Thiếu Multi-Verification Gate)**: Đặc biệt trong các tác vụ phát triển giao diện (Frontend / Web UI) hoặc các tính năng tương tác người dùng, các agent thông thường chỉ dừng lại ở việc kiểm tra exit code của lệnh build hoặc chạy unit test dòng lệnh. Thiếu sót lớn nhất là không tự động khởi chạy service tại local qua Host Child Process, không tương tác thực tế trên trình duyệt qua MCP CloakBrowser, và không có cơ chế chụp ảnh màn hình (screenshot) kết hợp kiểm tra API, quét Log và truy vấn trực tiếp Cơ sở Dữ liệu để nghiệm thu đa kênh. Hậu quả là agent báo thành công nhưng giao diện bị vỡ layout, API trả về sai cấu trúc hoặc dữ liệu không được ghi vào DB.
- **Thiếu cơ chế tương tác Human-in-the-Loop khi có điểm mơ hồ (Clarification)**: Khi agent gặp tình huống yêu cầu chưa rõ ràng, cần lựa chọn kiến trúc hoặc cần con người phê duyệt quyết định quan trọng, agent thường tự đoán mò dẫn đến sai lệch nghiệp vụ, hoặc bị crash/timeout do không có cơ chế tạm dừng an toàn và hỏi ý kiến người dùng qua giao diện Web.

### 1.2 Mục tiêu dự án
Xây dựng một hệ thống **AI Worker Server** hoàn chỉnh dựa trên nền tảng **JavaScript / Node.js**, gói gọn trong **1 SERVER DUY NHẤT (Single Server)** phục vụ đồng thời Backend Engine, REST API, SSE/WebSocket và Web UI Dashboard trên cùng một cổng (ví dụ: `http://localhost:3000`), có nhiệm vụ:
1. Cung cấp API (REST, WebSocket, SSE) cho phép hệ thống bên ngoài hoặc người dùng trigger các tác vụ AI Code.
2. Cung cấp **Giao diện Web UI Dashboard trực quan** truy cập ngay trên trình duyệt để quản lý, trigger, cấu hình agent cho từng bước, theo dõi tiến độ từng bước, xem gallery ảnh nghiệm thu trực quan, tương tác trả lời câu hỏi làm rõ khi task rơi vào trạng thái `PENDING` (chỉ được kích hoạt duy nhất trong bước `PLANNING` - sau khi `PLANNING` kết thúc, hệ thống chuyển sang tự hành hoàn toàn `IMPLEMENT`, `TESTING`, `FIXING` tuyệt đối không bao giờ vào `PENDING`), xem diff mã nguồn và can thiệp điều khiển (Cancel, Re-run).
3. **Live Terminal Output Streaming View**: Tích hợp component Web Terminal (xterm.js) hiển thị trực tiếp từng dòng lệnh, log stdout/stderr với đầy đủ mã màu ANSI, auto-scroll, khả năng copy log và xem raw stream trong suốt quá trình agent thực thi.
4. **Đa kênh Thẩm định Nghiệm thu (Multi-Verification Evidence Gate)**: Khi hoàn thành bước TESTING, hệ thống không chỉ kiểm tra đơn lẻ mà phải cung cấp đồng thời 4 nguồn bằng chứng nghiệm thu thực tế:
   - 📸 **File ảnh (UI Screenshot Evidence)**: Chụp trực tiếp qua **MCP CloakBrowser** cho các tác vụ giao diện.
   - 🌐 **Kết quả Test API (API Test Results)**: Gọi endpoint thực tế, assert HTTP status code, validate JSON response payload.
   - 📋 **Tra cứu Log (Log Verification)**: Quét application/service logs để xác nhận không có runtime error, stack trace, unhandled exception.
   - 🗄️ **Tra cứu Cơ sở Dữ liệu (Database Query Verification)**: Thực hiện query DB thực tế để xác nhận dữ liệu đã được insert/update/delete chính xác theo nghiệp vụ.
   Chỉ khi **TẤT CẢ** các tiêu chí bằng chứng trên thực sự thành công thì task mới được coi là `DONE`. Nếu chưa thành công -> Đẩy sang `FIXING` kèm toàn bộ context bằng chứng và lặp lại chu trình test.
5. Hỗ trợ 5 nền tảng AI Agent CLI cốt lõi:
   - **Claude Code** (`claude`)
   - **OpenCode** (`opencode`)
   - **OMP** (`omp`)
   - **Codex CLI** (`codex`)
   - **Antigravity CLI** (`antigravity`)
6. **Chuẩn hóa bộ trạng thái vòng đời đầy đủ**:
   - Các trạng thái thực thi tuần tự: `TO DO`, `PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`, `DONE`.
   - Trạng thái chờ tương tác Human-in-the-Loop: `PENDING` (chỉ kích hoạt duy nhất tại bước `PLANNING`).
   - Các trạng thái kết thúc/ngoại lệ: `FAILED`, `CANCELLED`, `TIMED_OUT`.
   - **Cơ chế PENDING (Human-in-the-Loop Clarification)**: 
     + Trạng thái `PENDING` **chỉ được kích hoạt duy nhất trong bước `PLANNING`** để agent khảo sát yêu cầu, kiến trúc và sinh Dual Plan mở rộng trước khi chốt kế hoạch. Nếu có câu hỏi làm rõ hoặc phân vân lựa chọn, task chuyển sang `PENDING`. Mọi nỗ lực chuyển sang `PENDING` ở các bước sau (`IMPLEMENT`, `TESTING`, `FIXING`) đều bị block và auto-bypassed.
     + Tiến trình agent tạm dừng an toàn (Pause/Wait).
     + Web UI Dashboard hiển thị popup/card câu hỏi:
       * Các lựa chọn có sẵn (multiple choice options dạng radio/checkbox) để người dùng tích chọn nhanh.
       * Ô chat nhập câu trả lời tùy chỉnh (custom reply text input).
     + Khi người dùng gửi câu trả lời -> Hệ thống nạp câu trả lời vào agent, quay lại `PLANNING` để hoàn thiện kế hoạch.
     + **Quy tắc Tự hành Hoàn toàn (Fully Autonomous Execution):** Một khi bước `PLANNING` hoàn tất và kế hoạch đã chốt, hệ thống chuyển sang `IMPLEMENT` – từ thời điểm này, các bước `IMPLEMENT`, `TESTING`, `FIXING` chạy hoàn toàn tự động dựa trên `dev_plan.md` và `test_plan.md`, tuyệt đối không chuyển sang `PENDING` nữa. Nếu agent cố hỏi ở giai đoạn này, runner sẽ tự động bypass với lệnh bắt buộc bám sát kế hoạch.

---

## 2. Đối tượng sử dụng & Tác nhân (Actors)

| Actor | Mô tả | Nhu cầu chính |
|---|---|---|
| **Developer / Engineer** | Lập trình viên trong dự án | Truy cập Web UI Dashboard qua trình duyệt để tạo job, cấu hình agent cho từng bước (`PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`), theo dõi tiến độ từng bước của agent và vòng lặp sửa lỗi, xem Live Terminal streaming qua xterm.js, tương tác trả lời câu hỏi làm rõ khi task ở trạng thái `PENDING` (chỉ giới hạn ở bước `PLANNING`, chọn options có sẵn hoặc chat custom reply), xem gallery ảnh và bằng chứng đa kênh trong Multi-Verification Evidence Gate, xem diff thay đổi, can thiệp dừng/chạy lại. |
| **CI/CD Pipeline** | GitLab CI / GitHub Actions | Kích hoạt AI Agent tự động qua REST API để sửa lỗi build, chạy kiểm thử trực quan hoặc tự sinh test coverage sau merge request; nhận kết quả nghiệm thu đa kênh. |
| **Issue Tracker / ChatOps** | Jira, GitLab Issue, Slack bot | Gửi webhook hoặc gọi API khi có ticket mới `[AI-TASK]` để điều phối AI Worker thực hiện tự động từ planning đến kiểm thử giao diện thực tế. |
| **System Administrator** | Quản trị viên hệ thống AI | Quản lý Agent Registry và cấu hình các agent khả dụng, thiết lập cấu hình Max Retries cho vòng lặp Fixing, giám sát tài nguyên (CPU, RAM, concurrency slots, browser instances trên máy host), kiểm tra tình trạng kết nối của các runner CLI và MCP CloakBrowser. |

### 2.1 Bảng Use Cases chi tiết (Use Cases Table)

| Mã UC | Tên Use Case | Tác nhân chính | Mô tả chi tiết |
|---|---|---|---|
| **UC-01** | Quản lý Agent Registry & Tools | System Administrator | Xem danh sách, kích hoạt hoặc vô hiệu hóa các agent CLI (`claude`, `opencode`, `omp`, `codex`, `antigravity`), công cụ kiểm thử trình duyệt duy nhất **MCP CloakBrowser** và cơ chế quản lý local service bằng **Host Child Process**; cài đặt cấu hình runtime mặc định. |
| **UC-02** | Cấu hình Multi-Agent Pipeline cho từng bước | Developer / CI/CD Pipeline | Tùy biến lựa chọn agent chuyên trách cho từng bước (`PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`) hoặc áp dụng Workflow Template có sẵn; thiết lập tham số Max Retries (`maxFixingRetries`). |
| **UC-03** | Khởi tạo Job & Giám sát Dual Planning | Developer | Tạo job mới với yêu cầu cụ thể, giám sát hệ thống tự động sinh song song Dev Plan (`dev_plan.md`) và Test Plan (`test_plan.md`) trước khi bước vào triển khai mã nguồn. |
| **UC-04** | Giám sát Kiểm thử Giao diện qua MCP CloakBrowser | Developer | Theo dõi Local Service khởi chạy qua Host Child Process, trình duyệt MCP CloakBrowser truy cập kiểm thử tự động, xem ảnh chụp màn hình evidence thời gian thực trên Web UI Dashboard. |
| **UC-05** | Tự động sửa lỗi với Context Handoff Pack & Max Retries Guard | AI Worker Engine | Khi bước `TESTING` phát hiện lỗi kiểm thử hoặc lỗi thẩm định đa kênh, hệ thống tự động đóng gói toàn bộ bằng chứng chuyển cho agent bước `FIXING` sửa mã nguồn và kích hoạt re-test, có cơ chế Max Retries Guard ngăn lặp vô hạn. |
| **UC-06** | Cung cấp API cho CI/CD và Hệ thống Ngoài | CI/CD Pipeline | Trigger tác vụ AI Code, truy vấn tiến độ, lấy diff, tải ảnh evidence và log qua REST API / WebSocket. |
| **UC-07** | Tương tác Làm rõ Human-in-the-Loop (`PENDING` State — PLANNING Only) | Developer / AI Agent | Khi agent trong bước `PLANNING` gặp điểm mơ hồ hoặc cần quyết định kỹ thuật, task tự động chuyển sang trạng thái `PENDING` và tạm dừng an toàn; Web UI Dashboard hiển thị popup/card câu hỏi hỗ trợ cả lựa chọn trắc nghiệm có sẵn (radio/checkbox) và ô chat nhập văn bản custom reply. Khi người dùng submit, hệ thống nạp câu trả lời vào agent và tiếp tục hoàn thiện kế hoạch ở bước `PLANNING`. Các bước sau tự hành hoàn toàn, không chuyển `PENDING`. |
| **UC-08** | Xem Trực tiếp Live Terminal Output Streaming | Developer | Kỹ sư theo dõi tiến độ chi tiết từng dòng lệnh stdout/stderr qua component Live Web Terminal (xterm.js) với đầy đủ mã màu ANSI, auto-scroll, khả năng copy log và xem raw stream mà không bị trễ hay mất định dạng. |
| **UC-09** | Thẩm định Nghiệm thu Đa kênh (Multi-Verification Evidence Gate) | AI Worker Engine / Developer | Hệ thống tự động thu thập và đối chiếu đồng thời 4 nguồn bằng chứng nghiệm thu: 📸 Ảnh chụp giao diện MCP CloakBrowser, 🌐 Assert HTTP status & payload API, 📋 Quét log hệ thống loại trừ runtime error/exception, và 🗄️ Truy vấn trực tiếp database xác nhận bản ghi. Task chỉ được coi là `DONE` khi toàn bộ 4 kênh đều đạt thành công. |

---

## 3. Năng lực cốt lõi của hệ thống (Core Capabilities)

### 3.1 Task Ingestion & API Gateway
- Nhận yêu cầu qua REST API:
  - `POST /api/v1/jobs`: Tiếp nhận job mới (repo URL/path, branch, prompt/spec, agent configuration, timeout, extra flags).
  - `GET /api/v1/jobs`: Lấy danh sách jobs kèm phân trang, bộ lọc trạng thái (`TO DO`, `PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`, `DONE`, `PENDING`, `FAILED`, `CANCELLED`, `TIMED_OUT`) và tìm kiếm.
  - `GET /api/v1/jobs/{id}`: Tra cứu trạng thái, chi tiết các bước thực thi, kết quả, artifact, diff.
  - `GET /api/v1/jobs/{id}/plans`: Lấy nội dung Dev Plan và Test Plan sinh ra ở bước `PLANNING`.
  - `GET /api/v1/jobs/{id}/evidence`: Lấy danh sách ảnh chụp màn hình kèm metadata kiểm thử trực quan.
  - `GET /api/v1/jobs/{id}/verification-evidence`: Lấy chi tiết kết quả thẩm định đa kênh (UI screenshot, API response assertion, logs scan, DB query results).
  - `GET /api/v1/jobs/{id}/logs`: Lấy toàn bộ log lịch sử hoặc stream thời gian thực (SSE/WebSocket).
  - `GET /api/v1/jobs/{id}/clarification`: Lấy chi tiết câu hỏi đang chờ giải đáp khi job ở trạng thái `PENDING`.
  - `POST /api/v1/jobs/{id}/clarify`: Gửi câu trả lời cho agent khi job ở trạng thái `PENDING` (lựa chọn phương án hoặc custom reply text) để resume công việc.
  - `POST /api/v1/jobs/{id}/cancel`: Dừng khẩn cấp tiến trình agent, dev server cục bộ và browser MCP CloakBrowser.
  - `POST /api/v1/jobs/{id}/rerun`: Tạo job mới dựa trên cấu hình của job đã có.
  - `GET /api/v1/runners`: Kiểm tra danh sách runner khả dụng và tình trạng cài đặt (binary path, version, health check).
  - `GET /api/v1/system/status`: Kiểm tra tải hệ thống (CPU, RAM, số worker đang chạy, hàng đợi, tiến trình child process và browser).

### 3.2 Task Queue & Concurrency Management
- Quản lý hàng đợi công việc bằng cơ chế Queue trong bộ nhớ (hỗ trợ mở rộng persistence qua SQLite/file store).
- Cấu hình Worker Concurrency Pool (giới hạn tối đa `N` workers chạy đồng thời) để bảo vệ tài nguyên máy chủ, tránh cạn kiệt RAM do nhiều dev server hoặc browser headless chạy đồng thời trên máy host, và tránh rate limit API LLM.
- Cơ chế Retry và quản lý lỗi cho các tác vụ thất bại do lỗi mạng tạm thời hoặc crash tiến trình.

### 3.3 Workspace Sandboxing & Git Lifecycle
- Mỗi job được cấp phát một **Execution Workspace** độc lập:
  - Sử dụng cơ chế **Git Worktree** (hoặc ephemeral directory copy) để tránh xung đột mã nguồn khi nhiều job chạy song song trên cùng một repo.
  - Tự động chuẩn bị branch đích (ví dụ: `feature/ai-task-<job-id>`).
  - Nạp đầy đủ context files (`AGENTS.md`, `CLAUDE.md`, `.omp/`, specs) vào workspace trước khi kích hoạt agent.
- Thu dọn an toàn (Cleanup): Sau khi hoàn tất hoặc hủy, giải phóng worktree tạm, đóng sạch tiến trình child process của dev server và giải phóng tab/profile của MCP CloakBrowser.

### 3.4 Headless Runner Adapter Layer (Hỗ trợ 5 CLI)
Mỗi CLI Runner được bao bọc bởi một Adapter chuyên biệt kế thừa Interface chung:
1. **Claude Code Adapter (`claude`)**:
   - Lệnh headless: `claude -p "<prompt>" --non-interactive` hoặc chế độ stream JSON.
   - Quản lý session flags, context compaction và tool permissions (`--dangerously-skip-permissions` trong sandbox).
2. **OpenCode Adapter (`opencode`)**:
   - Lệnh headless: `opencode run "<prompt>" --format json` hoặc daemon RPC client.
   - Parser stdout/stderr theo format block của OpenCode.
3. **OMP Adapter (`omp`)**:
   - Lệnh headless: `omp run "<prompt>" --mode headless --yes` hoặc `omp exec -p "<prompt>"`.
   - Tự động nạp rules, skills và subagents cần thiết theo cấu hình workspace.
4. **Codex CLI Adapter (`codex`)**:
   - Lệnh headless: `codex exec "<prompt>" --non-interactive` hoặc chế độ JSON-RPC pipe.
   - Quản lý token budget, reasoning effort và model fallback.
5. **Antigravity CLI Adapter (`antigravity`)**:
   - Lệnh headless: `antigravity run --headless --task "<prompt>"` hoặc `antigravity exec --workspace <path>`.
   - Hỗ trợ truyền context pack và spec file đường dẫn trực tiếp.

### 3.5 Realtime Observability & Live Terminal Streaming View
- **Live Web Terminal (xterm.js)**:
  - Tích hợp terminal xterm.js ngay trên giao diện Web UI Dashboard.
  - Hỗ trợ đầy đủ các mã màu chuẩn ANSI (ANSI color codes), text formatting (bold, underline), tiến trình và thanh phần trăm.
  - Tính năng auto-scroll mượt mà theo dòng log mới nhất, cho phép pause scroll khi người dùng cuộn lên đọc log cũ.
  - Hỗ trợ copy vùng chọn trực tiếp từ terminal và tùy chọn xem dạng raw stdout/stderr text.
- Chạy tiến trình con qua PTY (Pseudo-terminal) hoặc stream pipe để bắt chuẩn toàn bộ mã màu ANSI và tiến độ thời gian thực.
- Phát log trực tiếp qua Server-Sent Events (SSE) hoặc WebSocket tới Client/Dashboard với độ trễ cực thấp (< 500ms).
- Tự động **Masking Secrets** (ẩn các token như `sk-ant-*`, `sk-*`, password, JWT) trước khi stream hoặc ghi ra đĩa.
- Parse và cấu trúc hóa kết quả cuối cùng:
  - Trạng thái hoàn thành: `DONE`, `FAILED`, `CANCELLED`, `TIMED_OUT`.
  - Files modified/created/deleted.
  - Danh sách ảnh screenshot evidence và kết quả thẩm định đa kênh (Multi-Verification Evidence).
  - Tóm tắt công việc (Summary generated by Agent).
  - Ước tính thời gian thực thi (execution duration).

### 3.6 Safety & Process Control
- **Hard Timeout**: Tự động ngắt job nếu vượt quá thời gian tối đa (mặc định 15 phút, có thể cấu hình theo job).
- **Graceful Termination & Tree Kill**: Khi nhận lệnh Cancel hoặc Timeout, gửi `SIGINT`/`SIGTERM` trước; nếu sau 5 giây không dừng sẽ `SIGKILL` toàn bộ cây tiến trình (Process Tree bao gồm cả runner, dev server và browser headless MCP CloakBrowser), loại bỏ triệt để tiến trình mồ côi (orphan processes).
- **Resource Monitoring**: Giám sát RAM và CPU của từng job worker, cảnh báo khi job vượt ngưỡng bộ nhớ cho phép.

### 3.7 Web UI Dashboard (Single-Server Embedded UI)
Web UI Dashboard được đóng gói và phục vụ trực tiếp từ chính Server Node.js (phục vụ static assets qua Express / Fastify / Koa), không yêu cầu người dùng phải khởi chạy frontend dev-server riêng biệt:
- **Trang Tạo Job Mới (Job Creation Form / Dialog)**:
  - Form chọn Repository (local path hoặc Git clone URL), Branch đích.
  - Ô nhập Prompt / Yêu cầu nghiệp vụ hoặc chọn từ file spec (`expect.md`).
  - Cấu hình Multi-Agent Pipeline: Dropdown chọn agent riêng cho từng bước (`PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`) hoặc chọn Template có sẵn.
  - Cấu hình tham số nâng cao: Timeout (phút), `maxFixingRetries` (1-5), Worktree isolation, Debug log, Mock options.
- **Trang Danh sách Jobs (Job List View)**:
  - Bảng hiển thị tất cả các jobs kèm trạng thái badge: `TO DO`, `PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`, `DONE`, `PENDING`, `FAILED`, `CANCELLED`, `TIMED_OUT`.
  - Hiển thị Feedback Loop Badge thể hiện số lần re-test trong vòng lặp Fixing (ví dụ: `Retry 2/3`).
  - Nút bấm thao tác nhanh: Xem chi tiết, Cancel, Re-run.
  - Bộ lọc theo trạng thái, tìm kiếm theo tên repo hoặc prompt.
- **Trang Chi tiết Job (Job Detail View)**:
  - **Timeline Header**: Thanh tiến trình thể hiện rõ ràng các bước trong vòng đời và trạng thái hiện tại.
  - **Human-in-the-Loop Clarification Panel / Modal (`PENDING`)**:
    + Tự động hiển thị nổi bật khi task chuyển sang trạng thái `PENDING` (chỉ diễn ra duy nhất trong bước `PLANNING`).
    + Trình bày rõ ràng câu hỏi hoặc điểm cần làm rõ của agent.
    + Danh sách phương án có sẵn (radio buttons hoặc checkboxes) để người dùng chọn nhanh.
    + Ô chat nhập văn bản custom (`custom reply text input`) cho phép người dùng gõ câu trả lời linh hoạt.
    + Nút "Submit Reply & Resume" để gửi câu trả lời và tiếp tục tiến trình.
  - **Tab Live Terminal View (xterm.js)**: Cửa sổ terminal với giao diện nền tối, hỗ trợ đầy đủ ANSI color codes, hiển thị từng dòng stdout/stderr trực tiếp, auto-scroll và nút copy log.
  - **Tab Dual Planning View**: Hiển thị song song nội dung của `dev_plan.md` và `test_plan.md` dưới dạng Markdown rendered.
  - **Tab Multi-Verification Evidence Gate**:
    + 📸 *Section UI Screenshots*: Gallery ảnh chụp màn hình từ MCP CloakBrowser, hiển thị theo thứ tự thời gian các bước test, cho phép click xem phóng to (lightbox) và xem metadata (URL, action, timestamp).
    + 🌐 *Section API Test Results*: Bảng kết quả gọi endpoint API, HTTP status, request/response payload assertions.
    + 📋 *Section Log Scanner*: Kết quả quét log hệ thống, highlight các cảnh báo hoặc xác nhận sạch lỗi không có runtime error/unhandled exception.
    + 🗄️ *Section Database Query Verification*: Kết quả các câu lệnh truy vấn DB kiểm chứng dữ liệu thực tế (row count, column values).
  - **Tab Code Changes / Diff**: Trình xem diff trực quan (side-by-side hoặc unified) tô màu cú pháp các file đã thay đổi.
  - **Tab Artifacts & Summary**: Tóm tắt kết quả hoàn thành từ agent, danh sách file thay đổi, thời gian thực thi.
- **Trang Runner & System Health Monitor**:
  - Danh sách 5 runner CLI kèm trạng thái khả dụng (Detected / Not Found), phiên bản hiện tại, đường dẫn binary thực thi.
  - Tình trạng khả dụng của browser testing engine **MCP CloakBrowser**.
  - Tình trạng tải hệ thống: Số worker đang chạy / Giới hạn tối đa, số tiến trình local service/browser đang mở trên máy host, dung lượng bộ nhớ Node.js sử dụng.

### 3.8 Chuẩn hóa bộ trạng thái vòng đời (State Machine & Lifecycle)
Hệ thống bóc tách vòng đời thực thi của Agent Code thành các bước chuẩn hóa, cập nhật trạng thái thời gian thực lên Web UI Dashboard:

```text
[TO DO] ──► [PLANNING] ────────────► [IMPLEMENT] ──► [TESTING] ──► [DONE]
               ▲    │                                  │
               │    │ (Cần làm rõ /                    │ (Thất bại kiểm thử)
               │    │  phân vân)                       ▼
               │    ▼                             [FIXING] ──► (Quay lại TESTING)
          [PENDING] (Chờ người dùng)
               │    ▲
               └────┘ (Submit câu trả lời ──► Hoàn thiện Plan)
```

1. **`TO DO` (Tiếp nhận & Chuẩn bị)**:
   - Tiếp nhận job từ API hoặc Dashboard.
   - Cấp phát thư mục Git Worktree cô lập cho job.
   - Checkout branch làm việc độc lập.
   - Bơm nạp các context rules bắt buộc (`AGENTS.md`, `CLAUDE.md`, `.omp/`, spec files).
   - Khởi tạo thư mục chứa evidence: `feature/<feature-name>/evidence/`.
   - Trạng thái chuyển dịch: `TO DO` → `PLANNING`.

2. **`PLANNING` (Lập kế hoạch song song — Dual Planning)**:
   - Kích hoạt **Dual Planning Engine** sinh đồng thời hai bản kế hoạch:
     + **Plan Dev (`dev_plan.md`)**: Phân tích kiến trúc, danh sách file cần sửa/tạo mới, API interfaces, data flow và các bước lập trình chi tiết.
     + **Plan Test (`test_plan.md`)**: Kế hoạch kiểm thử chi tiết xác định rõ: kiểm thử tính năng gì, các bước tương tác UI/UX qua MCP CloakBrowser, kịch bản gọi API, log cần kiểm tra, câu lệnh query DB cần xác thực, và điều kiện assertion mong đợi.
   - Cả hai bản plan được lưu lại và hiển thị trực tiếp trên Web UI Dashboard.
   - Trạng thái chuyển dịch: `PLANNING` → `IMPLEMENT` (hoặc sang `PENDING` nếu cần làm rõ).

3. **`IMPLEMENT` (Lập trình thực thi)**:
   - Agent được chỉ định cho bước Implement tiếp nhận `dev_plan.md`, tiến hành sửa đổi mã nguồn và gọi công cụ thực thi (shell commands, file edit).
   - Hệ thống theo dõi từng file thay đổi, kiểm tra tính toàn vẹn cú pháp.
   - Khi hoàn thành việc viết code, hệ thống đóng gói diff và tự động chuyển sang bước kiểm thử.
   - Trạng thái chuyển dịch: `IMPLEMENT` → `TESTING` (tự hành hoàn toàn, tuyệt đối không chuyển sang `PENDING`).

4. **`TESTING` (Kiểm thử thực tế & Multi-Verification Evidence Gate)**:
   - **Local Service Runner (Host Child Process)**: Tự động khởi chạy service trực tiếp tại local trên máy host (ví dụ: `npm run dev`, `python app.py`) trong môi trường worktree.
   - **Healthcheck Watcher**: Thăm dò port mạng hoặc endpoint HTTP (ví dụ: `http://localhost:3000`) cho đến khi service ở trạng thái sẵn sàng (Ready) hoặc timeout.
   - **Browser Test Runner (MCP CloakBrowser)**: Khởi động trình duyệt thông qua **MCP CloakBrowser**, điều hướng đến URL cục bộ theo kịch bản trong `test_plan.md`.
   - Thực hiện chuỗi hành động tương tác mô phỏng người dùng: gõ văn bản, click nút bấm, cuộn trang, đợi phần tử DOM xuất hiện.
   - **Chụp ảnh màn hình Evidence**: Chụp ảnh màn hình giao diện tại các bước kiểm thử quan trọng và lưu vào thư mục `feature/<feature-name>/evidence/` kèm metadata JSON.
   - **Kích hoạt Multi-Verification Evidence Gate**: Đồng thời thực thi thẩm định 4 kênh (UI Screenshot, API Assertions, Log Verification, DB Query Verification).
   - **Quy tắc chuyển dịch**:
     + Nếu TẤT CẢ 4 kênh kiểm chứng ĐẠT (Passed) → chuyển trạng thái sang `DONE`.
     + Nếu CÓ BẤT KỲ KÊNH NÀO THẤT BẠI (Failed) hoặc phát hiện lỗi giao diện/console error/sai dữ liệu DB → đóng gói toàn bộ bằng chứng và chuyển trạng thái sang `FIXING`.

5. **`FIXING` (Vòng lặp sửa lỗi tự động — Self-Healing)**:
   - Kích hoạt **Context-rich FIXING Handoff**: Hệ thống đóng gói toàn bộ dữ liệu gồm:
     + Đường dẫn các ảnh chụp màn hình ghi nhận lỗi giao diện.
     + Kết quả API test failed (status code, body diff).
     + Log console và application runtime error/stack trace.
     + Kết quả DB query sai lệch so với kỳ vọng.
     + Chi tiết bước kiểm thử bị fail và code diff hiện tại.
   - Agent bước Fixing phân tích chính xác nguyên nhân gốc và tiến hành sửa đổi mã nguồn.
   - Tự động chuyển ngược lại `TESTING` để re-test toàn bộ kịch bản.
   - Được bảo vệ bởi **Max Retries Guard**: Giới hạn số lần thử lại tối đa (mặc định 3 lần); nếu vượt quá ngưỡng sẽ chuyển sang trạng thái `FAILED`.

6. **`DONE` (Hoàn thành nghiệm thu)**:
   - Chỉ được kích hoạt khi bước `TESTING` vượt qua đầy đủ 4 kênh của Multi-Verification Evidence Gate.
   - Server thu thập toàn bộ báo cáo, file diff, danh sách artifact và tóm tắt công việc gửi cho người dùng.

7. **`PENDING` (Human-in-the-Loop Clarification State)**:
   - **Giới hạn nghiêm ngặt**: Trạng thái `PENDING` **chỉ được phép kích hoạt DUY NHẤT trong bước `PLANNING`**. Toàn bộ các bước sau (`IMPLEMENT` → `TESTING` → `FIXING` → `DONE`) chạy hoàn toàn tự động (autonomous execution & self-healing loop) dựa trên `dev_plan.md` & `test_plan.md` đã chốt. Mọi hành vi cố tình đặt câu hỏi trong `IMPLEMENT` hoặc `FIXING` sẽ bị hệ thống tự động bypass và chỉ thị tiếp tục bám sát kế hoạch mà không tạm dừng chờ người dùng.
   - **Điều kiện kích hoạt**: Khi Agent ở bước `PLANNING` khảo sát yêu cầu, kiến trúc và sinh Dual Plan gặp câu hỏi cần làm rõ yêu cầu hoặc phân vân lựa chọn kiến trúc/thư viện.
   - **Cơ chế hoạt động**:
     + Task tự động chuyển sang trạng thái `PENDING`.
     + Tiến trình agent tạm dừng an toàn (Pause/Wait), giải phóng tạm thời CPU nhưng giữ nguyên context workspace.
     + Web UI Dashboard hiển thị popup/card câu hỏi nổi bật:
       * Các lựa chọn có sẵn (multiple choice options dạng radio/checkbox) để người dùng tích chọn nhanh.
       * Ô chat nhập câu trả lời tùy chỉnh (`custom reply text input`) để người dùng bổ sung thông tin chi tiết.
     + Khi người dùng gửi câu trả lời qua Web UI hoặc API `POST /api/v1/jobs/{id}/clarify` -> Hệ thống nạp nội dung câu trả lời vào agent context, task tiếp tục chạy và chuyển về trạng thái `PLANNING` để hoàn thiện kế hoạch.

8. **Các trạng thái kết thúc/ngoại lệ khác**:
   - `FAILED`: Khi số lần sửa lỗi vượt quá `maxFixingRetries` hoặc gặp lỗi hệ thống nghiêm trọng không thể phục hồi.
   - `CANCELLED`: Khi người dùng chủ động bấm Cancel hoặc gọi API hủy tác vụ.
   - `TIMED_OUT`: Khi thời gian thực thi vượt quá `timeoutSeconds` cấu hình.

### 3.9 Dual Planning Engine
- Nhận input là yêu cầu công việc (prompt/spec) từ bước `TO DO`.
- Sử dụng mô hình suy luận hoặc agent chuyên trách planning để sinh đồng thời:
  1. **Dev Plan (`dev_plan.md`)**:
     - Phân tích kiến trúc tổng thể và các file bị ảnh hưởng.
     - Danh sách file cần tạo mới, chỉnh sửa, xóa bỏ.
     - Định nghĩa API contracts, data models, functions signatures.
     - Trình tự triển khai từng bước cụ thể.
  2. **Test Plan (`test_plan.md`)**:
     - Mục tiêu kiểm thử (Test Objectives & Scope).
     - Kịch bản tương tác người dùng từng bước (User Interaction Steps) cho MCP CloakBrowser.
     - Bộ dữ liệu kiểm thử (Test Data / Mock Data): tài khoản test, payload mẫu.
     - Kịch bản kiểm thử API: endpoint, phương thức, header, payload, expected HTTP status & body.
     - Kịch bản quét Log: danh sách từ khóa lỗi cần quét (error, exception, fail).
     - Kịch bản truy vấn DB: câu lệnh SQL/NoSQL query kiểm chứng dữ liệu sau khi thực thi.
     - Điều kiện nghiệm thu mong đợi (Expected Assertions) và các điểm chụp ảnh màn hình kiểm chứng (Screenshot Checkpoints).

### 3.10 Local Service Lifecycle & Browser Testing (Host Child Process & MCP CloakBrowser)
- **Local Service Runner (Khẳng định duy nhất Host Child Process)**:
  - Quản lý tiến trình nền của ứng dụng cần test (dev server, API service) trực tiếp trên máy host thông qua Node.js Child Process (`child_process.spawn`).
  - Tuyệt đối không sử dụng Docker hay containerization phức tạp trong giai đoạn này, đảm bảo gọn nhẹ và tốc độ khởi động tức thì.
  - Hỗ trợ phát hiện tự động lệnh khởi chạy từ `package.json` (`npm run dev`, `npm start`) hoặc file cấu hình chỉ định.
  - Cấp phát port linh hoạt tránh trùng lặp giữa các job song song (tự động scan free port).
- **Healthcheck Watcher**:
  - Thực hiện HTTP polling hoặc socket probe tới địa chỉ local service (ví dụ: `http://127.0.0.1:<port>`).
  - Đặt timeout tối đa (ví dụ 60 giây) cho quá trình khởi động; nếu không sẵn sàng, báo lỗi `SERVICE_START_FAILED`.
- **Browser Test Runner (Khẳng định duy nhất MCP CloakBrowser)**:
  - Tích hợp chuẩn giao thức **MCP CloakBrowser** (với các tool điều hướng: `navigate`, `click`, `fill`, `screenshot`, `wait_for_selector`, `get_text`, v.v.).
  - Tuyệt đối không sử dụng Playwright hay công cụ browser bên ngoài nào khác.
  - Thực thi tự động chuỗi tương tác theo đúng `test_plan.md`.
  - Giám sát console errors và network failures trong suốt phiên kiểm thử.

### 3.11 Multi-Verification Evidence Gate (Thẩm định Nghiệm thu Đa kênh)
Hệ thống thiết lập một cổng nghiệm thu ngặt nghèo (Multi-Verification Evidence Gate) trước khi một task được coi là hoàn thành. Không chấp nhận việc chỉ dựa vào một kênh đơn lẻ (như exit code của unit test):
1. 📸 **Kênh 1 — File ảnh (UI Screenshot Evidence qua MCP CloakBrowser)**:
   - Chụp ảnh màn hình tại từng bước quan trọng và lưu vào `feature/<feature-name>/evidence/step-<index>-<action>-<timestamp>.png`.
   - Kết hợp kiểm tra hai tầng:
     + *Tầng DOM & Console*: Không có lỗi JavaScript runtime (`console.error`), phần tử mong đợi hiển thị trên DOM tree.
     + *Tầng Multimodal Vision LLM*: Đối chiếu ảnh thực tế với mô tả giao diện mong đợi trong Test Plan để phát hiện lỗi vỡ layout, tràn chữ, sai màu sắc hoặc thành phần bị che khuất.
2. 🌐 **Kênh 2 — Kết quả Test API (API Test Results)**:
   - Gửi request thực tế tới các endpoint được tạo mới hoặc chỉnh sửa.
   - Xác thực HTTP status code (200, 201, v.v.), cấu trúc header và validate định dạng dữ liệu JSON response payload.
3. 📋 **Kênh 3 — Tra cứu Log Ứng dụng (Log Verification)**:
   - Quét toàn bộ log của dev server/application runtime sinh ra trong quá trình chạy test.
   - Xác nhận hệ thống hoàn toàn sạch lỗi: không có runtime error, stack trace, fatal warning, hay unhandled exception/rejection.
4. 🗄️ **Kênh 4 — Tra cứu Cơ sở Dữ liệu (Database Query Verification)**:
   - Thực hiện câu lệnh truy vấn dữ liệu thực tế (SQL query hoặc Datastore fetch) vào database của service.
   - Đối chiếu số lượng bản ghi và giá trị các trường dữ liệu được insert/update/delete chính xác theo logic nghiệp vụ yêu cầu.

**Quy tắc nghiệm thu:**
- Chỉ khi **TẤT CẢ** 4 kênh trên đều đạt kết quả thành công (`PASSED`), task mới được chuyển sang trạng thái `DONE`.
- Nếu có bất kỳ kênh nào thất bại (`FAILED`), hệ thống từ chối nghiệm thu, tự động chuyển sang trạng thái `FIXING` kèm toàn bộ bằng chứng của cả 4 kênh.

### 3.12 Context-rich FIXING Handoff Pack
Khi bước `TESTING` phát hiện lỗi từ bất kỳ kênh nào của Multi-Verification Evidence Gate, hệ thống không dừng lại mà tự động tổng hợp một gói ngữ cảnh đầy đủ (**Context Handoff Pack**) gửi cho agent sửa lỗi ở bước `FIXING`:
- **Evidence Links**: Danh sách đường dẫn các ảnh chụp màn hình ghi nhận lỗi trực quan.
- **Visual Defect Description**: Nhận xét từ Visual Verifier về điểm bất thường trên giao diện.
- **API Failure Details**: Mã HTTP thực tế vs kỳ vọng, body lỗi trả về.
- **Runtime & Console Logs**: Toàn bộ log lỗi terminal của server và log console của trình duyệt.
- **DB Verification Diff**: Dữ liệu thực tế trong DB vs dữ liệu mong đợi theo kịch bản.
- **Failing Step Details**: Bước cụ thể trong Test Plan bị fail kèm selector và hành động lúc xảy ra lỗi.
- **Current Code Diff**: Thay đổi mã nguồn gần nhất đã thực hiện ở bước Implement.
Agent sửa lỗi tận dụng toàn bộ ngữ cảnh này để sửa đúng trọng tâm mã nguồn, không suy đoán mù quáng.

### 3.13 Configurable Multi-Agent Step Pipeline
Hệ thống cung cấp cơ chế điều phối linh hoạt cho phép tùy biến việc sử dụng các AI Agent khác nhau trong từng bước thực thi:
- **Agent Registry Quản lý tập trung**: Cho phép bật/tắt kích hoạt từng agent CLI (`claude`, `opencode`, `omp`, `codex`, `antigravity`).
- **Phân công Agent tối ưu theo thế mạnh từng bước**:
  - Gán agent chuyên sâu về phân tích, thiết kế kiến trúc cho bước `PLANNING`.
  - Gán agent chuyên sâu về viết code tốc độ cao và thao tác công cụ cho bước `IMPLEMENT`.
  - Gán agent hoặc runner chuyên về browser automation và kiểm thử cho bước `TESTING`.
  - Gán agent chuyên sâu về phân tích lỗi và vá code chính xác cho bước `FIXING`.
- **Đa kênh cấu hình**: Cấu hình qua file `pipeline.config.json`, Workflow Templates mẫu, hoặc tùy chỉnh trực tiếp trên Web UI Dashboard.

### 3.14 Dynamic Self-Healing Lifecycle with Testing & Fixing Loop
- Vòng lặp phản hồi tự động `TESTING ⇄ FIXING`:
  - `TESTING` phát hiện lỗi → tạo Context Handoff Pack → chuyển sang `FIXING`.
  - `FIXING` sửa mã nguồn xong → tự động chuyển ngược lại `TESTING` để re-test.
- **Cơ chế Max Retries Guard**:
  - Giới hạn số lần lặp tối đa qua tham số `maxFixingRetries` (mặc định 3 lần, cấu hình từ 1 đến 5 lần).
  - Mỗi vòng lặp được cập nhật realtime lên Web UI Dashboard với Feedback Loop Badge.
  - Đảm bảo an toàn tuyệt đối: không để hệ thống lặp vô hạn gây tiêu tốn tài nguyên và token API.

---

## 4. Tiêu chí nghiệm thu (Acceptance Criteria - AC)

| Mã AC | Tiêu chí | Điều kiện nghiệm thu |
|---|---|---|
| **AC-01** | Khởi động & Quản lý Single Server | Server Node.js khởi chạy ổn định dưới dạng Single Server duy nhất, phục vụ đồng thời API, WebSocket/SSE và Web UI Dashboard trên 1 cổng HTTP (ví dụ `http://localhost:3000`). Cung cấp endpoint Health Check và Runner Status. |
| **AC-02** | Hỗ trợ đầy đủ 5 CLI Runner | Hệ thống tích hợp thành công 5 Adapter (`claude`, `opencode`, `omp`, `codex`, `antigravity`). Mỗi adapter có khả năng phát hiện binary, build lệnh headless chính xác và parse kết quả. |
| **AC-03** | Khởi tạo Task qua REST API & Web UI | Tiếp nhận job mới qua `POST /api/v1/jobs` hoặc thông qua form tạo job trên Web UI Dashboard → Server đưa vào queue và phân phối cho worker slot khả dụng. |
| **AC-04** | Cách ly Workspace (Isolation) | Hai job chạy song song trên cùng một repo hoặc các repo khác nhau không bị ghi đè hay xung đột mã nguồn nhờ cơ chế Git Worktree / Sandbox độc lập. |
| **AC-05** | Realtime Log Streaming | Client kết nối qua SSE hoặc WebSocket (và cửa sổ Terminal UI trên Web Dashboard) nhận được log stdout/stderr từng dòng ngay khi agent đang chạy, hỗ trợ ANSI color, độ trễ < 500ms. |
| **AC-06** | Secret Masking | Tất cả các API keys (OpenAI, Anthropic, GitLab, v.v.) bị che thành `***MASKED***` trong log streaming và file log lưu trữ. |
| **AC-07** | Hủy tác vụ an toàn (Cancellation) | Khi gọi `POST /api/v1/jobs/{id}/cancel` hoặc bấm nút Cancel trên Web UI, tiến trình agent, dev server cục bộ và browser MCP CloakBrowser bị tiêu diệt sạch sẽ trong vòng tối đa 5 giây; trạng thái cập nhật thành `CANCELLED`. |
| **AC-08** | Xử lý Timeout tự động | Job vượt quá thời gian `timeoutSeconds` cấu hình tự động bị ngắt, thu thập phần log trước đó và đánh dấu `TIMED_OUT`. |
| **AC-09** | Thu thập kết quả & Git Diff | Sau khi agent hoàn thành, server trích xuất danh sách file thay đổi, git diff tóm tắt và lưu vào kết quả job; hiển thị trực quan trên giao diện Web UI. |
| **AC-10** | Web Dashboard Single-Server Access | Người dùng truy cập trình duyệt tại 1 địa chỉ duy nhất (ví dụ: `http://localhost:3000`) thấy giao diện Web UI Dashboard hoạt động đầy đủ: Tạo job, Xem danh sách job, Runner Monitor, Chi tiết job. Không yêu cầu mở thêm tiến trình frontend dev-server riêng biệt. |
| **AC-11** | Visual Step-by-step Progress Tracking | Trên Web UI Dashboard, mỗi job hiển thị thanh tiến trình Timeline bóc tách rõ ràng bộ trạng thái chuẩn hóa: `TO DO` → `PLANNING` → `IMPLEMENT` → `TESTING` ⇄ `FIXING` → `DONE` và trạng thái chờ tương tác `PENDING`. Hiển thị thời gian thực thi cụ thể kèm huy hiệu Feedback Loop Badge thể hiện số vòng lặp re-test. |
| **AC-12** | Interactive Web Control | Người dùng có thể thao tác trực tiếp trên Web UI Dashboard: Bấm nút Cancel/Stop khẩn cấp; Bấm nút Re-run để chạy lại job; Xem diff trực tiếp các file sửa đổi với cú pháp highlight; Lọc/tìm kiếm danh sách job; Kiểm tra health check 5 runner CLI; Xem gallery ảnh evidence kiểm thử và kết quả thẩm định đa kênh. |
| **AC-13** | Multi-Agent Step Configuration | Hệ thống hỗ trợ cấu hình linh hoạt giao việc cho các agent khác nhau trong từng bước (`PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`) qua config file, Workflow Template hoặc trực tiếp trên form tạo job của Web UI Dashboard. |
| **AC-14** | Dynamic Self-Healing Lifecycle | Khi phát hiện lỗi ở bước Testing, vòng đời tự động chuyển trạng thái `TESTING -> FIXING` để agent sửa mã nguồn và kích hoạt re-test; hệ thống kiểm soát chặt chẽ với cơ chế Max Retry Guard (`maxFixingRetries`: mặc định 3 lần) nhằm ngăn chặn vòng lặp vô tận. |
| **AC-15** | Dual Planning Generation | Tại bước `PLANNING`, hệ thống tự động sinh song song cả hai tài liệu: `dev_plan.md` (kế hoạch mã nguồn, files, kiến trúc) và `test_plan.md` (nêu rõ test cái gì, các bước kiểm thử cụ thể, dữ liệu test/mock data cần dùng, điều kiện assertion mong đợi); cả hai tài liệu được hiển thị trên Web UI Dashboard. |
| **AC-16** | Local Service (Host Child Process) & MCP CloakBrowser Testing | Tại bước `TESTING`, hệ thống tự động khởi chạy service cục bộ bằng **Host Child Process**, chờ Healthcheck Watcher xác nhận sẵn sàng, khởi động duy nhất trình duyệt **MCP CloakBrowser** truy cập URL local, thực hiện tương tác UI theo Test Plan và chụp ảnh màn hình lưu vào thư mục `feature/<feature-name>/evidence/` kèm metadata JSON. Không sử dụng Playwright hay Docker. |
| **AC-17** | Visual Verification & Fixing Handoff | Hệ thống thực hiện xác thực trực quan (Visual Verification) trên ảnh screenshot kết hợp DOM/console errors. Nếu ĐẠT, chuyển sang `DONE`. Nếu CHƯA ĐẠT / LỖI, tự động đóng gói Context Handoff Pack (ảnh evidence, console error, test step failed, diff) chuyển cho agent bước `FIXING` khắc phục và tự động re-test. |
| **AC-18** | Multi-Verification Evidence Gate (Ảnh + API + Log + DB Verification) | Khi hoàn thành bước TESTING, hệ thống bắt buộc kiểm tra đồng thời 4 nguồn bằng chứng nghiệm thu: 📸 Ảnh screenshot qua MCP CloakBrowser, 🌐 Kết quả gọi API assert status/payload, 📋 Quét log ứng dụng không có runtime error/unhandled exception, và 🗄️ Truy vấn DB thực tế xác nhận dữ liệu nghiệp vụ. Chỉ khi TẤT CẢ 4 kênh đều đạt mới chuyển sang `DONE`; nếu có bất kỳ kênh nào thất bại, task chuyển sang `FIXING` kèm đầy đủ context của 4 kênh. |
| **AC-19** | Interactive Human-in-the-Loop Clarification (`PENDING` State — PLANNING Only) | Khi agent trong bước `PLANNING` gặp câu hỏi cần làm rõ yêu cầu hoặc phân vân lựa chọn, task tự động chuyển sang trạng thái `PENDING` và tạm dừng tiến trình an toàn (giới hạn duy nhất trong bước `PLANNING`, các bước sau tự hành hoàn toàn); Web UI Dashboard hiển thị popup/card câu hỏi hỗ trợ các lựa chọn trắc nghiệm có sẵn (radio/checkbox) và ô chat nhập văn bản custom reply; khi người dùng submit, hệ thống nạp câu trả lời vào agent và tiếp tục hoàn thiện kế hoạch ở bước `PLANNING`. |
| **SAFE-01** | Safe File Recycling | Tuyệt đối cấm xóa vĩnh viễn tệp tin/thư mục; mọi thao tác dọn dẹp Git Worktree và tệp rác bắt buộc sử dụng cơ chế chuyển vào Thùng rác (Recycle Bin / Trash). |
| **AC-20** | Live Terminal Full-Fidelity Streaming | Người dùng có thể theo dõi trực tiếp terminal thời gian thực trên Web UI Dashboard thông qua xterm.js với đầy đủ mã màu ANSI color codes, auto-scroll theo log mới nhất, tính năng copy text, và xem raw stdout/stderr mà không bị trễ hay mất ký tự định dạng. |

---

## 5. Ngoài phạm vi giai đoạn 1 (Out of Scope)

- Chưa triển khai phân tán đa cụm server (Multi-node cluster / Kubernetes dynamic pods); giai đoạn 1 tập trung tối ưu Single-node Multi-worker Server Daemon viết hoàn toàn bằng Node.js với Web UI Dashboard tích hợp.
- Tuyệt đối không sử dụng Docker hoặc container virtualization để quản lý local dev service; khẳng định duy nhất Host Child Process trực tiếp trên máy chủ.
- Tuyệt đối không sử dụng Playwright standalone; khẳng định duy nhất MCP CloakBrowser cho tự động hóa trình duyệt.
- Chưa tích hợp xác thực tài khoản doanh nghiệp phức tạp (SSO / SAML / OAuth2 multi-tenant); giai đoạn 1 hỗ trợ chạy cục bộ hoặc bảo vệ bằng API Key / Basic Auth token đơn giản.
- Không tự động giải quyết xung đột Git Merge phức tạp (nếu branch bị merge conflict, job sẽ báo lỗi để kỹ sư xử lý thủ công).
- Không can thiệp vào thuật toán suy luận nội tại của từng CLI (chỉ đóng vai trò là Host / Harness / Runner điều phối, thu thập log, quản lý local service lifecycle và bóc tách dữ liệu vòng đời).
