# Báo cáo Phân tích Vùng Ảnh hưởng & Quản trị Rủi ro An toàn (impact.md)
## Feature: Create-AI-Worker — Server Quản lý & Điều phối Headless AI Agent Code

- **Feature ID:** `Create-AI-Worker`
- **Tài liệu tham chiếu:** `feature/Create-AI-Worker/expect.md`, `feature/Create-AI-Worker/plan.md`
- **Phiên bản:** 1.3.0
- **Trạng thái:** DRAFT / PLAN-REVIEW
- **Phạm vi bảo vệ:** 5 CLI Engine (`claude`, `opencode`, `omp`, `codex`, `antigravity`), Hệ thống Host, Hạ tầng Mạng, Git Workspaces, Ngân sách LLM Token, Vòng đời Testing & Fixing / Fixing, Kiểm thử Trực quan Giao diện (Visual E2E Testing), Local Service Lifecycle, Trình duyệt Headless (MCP CloakBrowser / Playwright) & Quản trị Lưu trữ Bằng chứng (Evidence Storage), Cơ sở Dữ liệu Kiểm thử (Test Database Queries), Quản trị Trạng thái Chờ Tương tác (PENDING State Lifecycle)

---

## 1. Tổng quan & Phạm vi Đánh giá Tác động (Overview & Scope)

Dự án **AI Worker Server** triển khai một daemon tập trung có khả năng tự động hóa và điều phối việc thực thi mã nguồn của 5 AI CLI (`Claude Code`, `OpenCode`, `OMP`, `Codex CLI`, `Antigravity CLI`) ở chế độ headless / non-interactive. Do các tác tử AI có quyền chạy lệnh shell cục bộ, đọc/sửa/tạo/xóa tập tin và gọi các mô hình ngôn ngữ lớn (LLM) qua Internet, hệ thống tiềm ẩn những tác động sâu rộng tới toàn bộ môi trường host và tài nguyên doanh nghiệp.

Tài liệu này xác định ranh giới ảnh hưởng (blast radius), xây dựng ma trận rủi ro định lượng, thiết lập danh mục kiểm tra an toàn trước khi khởi chạy (Pre-run Safety Checklist) và cung cấp cẩm nang ứng phó sự cố (Incident Response & Rollback Playbook) nhằm đảm bảo hệ thống vận hành an toàn, tin cậy và tuân thủ tuyệt đối quy tắc bảo vệ dữ liệu.

---

## 2. Phân tích Vùng Ảnh hưởng (Blast Radius & Impact Analysis)

### 2.1 Hệ thống Host (Host OS & File System)
- **Tác động tiến trình (Process Impact):**
  - Mỗi tác vụ kích hoạt một PTY pseudo-terminal hoặc tiến trình con (`child_process`), kéo theo cây tiến trình lồng nhau (Agent CLI -> subshell -> node/python/mvn/cargo/git compiler).
  - Nguy cơ cạn kiệt Process Identifier (PID exhaustion) nếu các tiến trình con không được dọn dẹp triệt để khi hoàn tất hoặc timeout.
- **Tác động tập tin & Thư mục (File System Impact):**
  - Môi trường workspace độc lập được cấp phát tại `.workspaces/<jobId>/`.
  - Tác động tiềm tàng đến thư mục tạm (`%TEMP%`, `/tmp`), bộ nhớ đệm toàn cục của các package manager (`~/.npm`, `~/.cache`, `~/.m2`), và file cấu hình người dùng (`~/.claude.json`, `~/.config/opencode/`, `~/.omp/`).
  - **Quy tắc bất biến:** Không cho phép bất kỳ hành vi xóa vĩnh viễn nào (`rm -rf`, `del /f/q`, `fs.unlink`); mọi tệp tin dọn dẹp bắt buộc phải chuyển vào thùng rác (`Trash` trên Linux/macOS hoặc `Recycle Bin` trên Windows).

### 2.2 Tài nguyên Điện toán CPU / RAM (Compute Resource Impact)
- **Tải đỉnh CPU (CPU Spikes):**
  - Quá trình suy luận của LLM không ngốn CPU host, nhưng các tác vụ phụ trợ do AI Agent kích hoạt (chạy unit test suite, build TypeScript, phân tích cú pháp AST, linter toàn dự án) có thể đẩy mức sử dụng CPU lên 100% trên toàn bộ các core.
  - Khi chạy đồng thời `MAX_CONCURRENT_JOBS` (mặc định 2-4 jobs), tổng tải CPU có thể gây nghẽn toàn bộ dịch vụ khác trên máy chủ.
- **Áp lực bộ nhớ RAM (Memory Pressure):**
  - Node.js runtime của bản thân server: ~150MB - 300MB RAM.
  - Mỗi phiên AI Agent CLI chạy qua PTY: ~200MB - 500MB RAM.
  - Quá trình chạy test suite (ví dụ: JVM test, Jest test runner): 500MB - 2GB RAM cho mỗi job.
  - Tổng nhu cầu bộ nhớ đỉnh có thể vượt quá 8GB - 16GB RAM nếu không có giới hạn ngắt (cgroup / job quota).

### 2.3 Mạng & Băng thông (Network & Ingress/Egress Impact)
- **Băng thông Egress (LLM API & Package Registries):**
  - Truyền nhận liên tục giữa AI Worker và các API upstream: Anthropic API (`api.anthropic.com`), OpenAI API (`api.openai.com`), Google Vertex/Gemini API, OpenCode model gateways.
  - Tải dependencies qua Git (`git clone/fetch`), npm/pip/maven trong quá trình setup workspace.
  - Băng thông mạng có thể bị bão hòa nếu nhiều tác vụ clone repo lớn (>1GB) cùng một thời điểm.
- **Băng thông Ingress (Streaming to Clients):**
  - WebSocket / Server-Sent Events (SSE) đẩy stdout/stderr từng ký tự về cho Web UI hoặc Dashboard giám sát.
  - Mỗi ký tự hoặc dòng log sinh ra được broadcast đến các listener; lưu lượng lớn có thể gây trễ mạng nội bộ nếu không buffer hợp lý.
- **Giới hạn tỷ lệ API (Upstream Rate Limiting):**
  - Việc chạy song song nhiều worker headless dùng chung một API key doanh nghiệp dễ dẫn tới lỗi `429 Too Many Requests` (TPM / RPM limit), làm tê liệt các tác vụ khác của toàn công ty.

### 2.4 Ngân sách & Hạn ngạch LLM Token (LLM Token Budget & Cost)
- **Rủi ro bùng nổ chi phí & Lạm phát Token (Token Explosion & Token Inflation):**
  - Các Agent CLI ở chế độ headless không có con người giám sát trực tiếp có thể lọt vào vòng lặp logic (infinite retry loop) khi sửa lỗi biên dịch hoặc chạy unit test thất bại.
  - Đặc biệt, với kiến trúc vòng đời chu kỳ Testing & Fixing (AC-14), khi bài kiểm thử tự động thất bại (`TESTING` -> `FIXING`), nếu agent không thể tự khắc phục triệt để hoặc sinh ra lỗi hồi quy mới, chu kỳ lặp lại liên tục giữa kiểm thử và sửa lỗi sẽ khiến số lượng token API tiêu thụ tăng theo cấp số nhân (Token Inflation). Mỗi vòng lặp đẩy toàn bộ ngữ cảnh (codebase, test failure report, stack trace, diff trước đó và phản hồi LLM) vào prompt, tiêu tốn từ 80,000 đến 250,000 tokens cho một lượt gọi.
  - Một tác vụ chạy lặp chỉ 4-5 chu kỳ có thể đốt cháy hàng triệu tokens ($10 - $50 USD) chỉ trong thời gian ngắn, dẫn tới nguy cơ cạn kiệt ngân sách dự án/tổ chức hoặc bị các nhà cung cấp mô hình (Anthropic, OpenAI) tạm khóa tài khoản API do vượt hạn ngạch chi tiêu hoặc vi phạm rate limit (TPM/RPM).
- **Tác động hạn mức (Quota Depletion):**
  - Có thể tiêu cạn credits trả trước hoặc kích hoạt ngắt dịch vụ khẩn cấp của tài khoản tổ chức nếu không cài đặt ngưỡng `maxTokensPerJob` hoặc `maxCostPerJobUsd` (`maxJobTokens` / `maxTotalCost`).

### 2.5 Giao diện Web Dashboard & Kết nối Streaming (Web UI Dashboard & Streaming Connections)
- **Tác động bảo mật UI (UI Security Impact):**
  - **Lỗ hổng Cross-Site Scripting (XSS):** Khi render nội dung log động của agent hoặc hiển thị trực tiếp git diff chứa mã độc (ví dụ payload HTML/JS được nhúng trong mã nguồn hoặc output log của runner), nếu không qua bộ lọc làm sạch, trình duyệt client có thể bị khai thác XSS (Stored hoặc Reflected XSS).
  - **Nguy cơ tấn công Cross-Site WebSocket Hijacking (CSWSH):** Khi client kết nối tới luồng WebSocket hoặc SSE từ một domain lạ hoặc website bên ngoài, nếu server không kiểm tra chặt chẽ `Origin` header, kẻ tấn công có thể nghe lén luồng log bí mật hoặc gửi lệnh điều khiển trái phép (Cancel / Re-run runner).
- **Tác động tài nguyên & hiệu năng (Resource & Performance Impact):**
  - **Nguy cơ cạn kiệt tài nguyên máy chủ (Memory leak / Connection exhaustion):** Khi nhiều tab trình duyệt hoặc nhiều client mở đồng thời các luồng SSE/WebSocket nhận log tần suất cao (high-throughput logs hàng nghìn dòng/giây), nếu không dọn dẹp listener khi client disconnect hoặc thiếu cơ chế throttle/backpressure, máy chủ Node.js dễ bị rò rỉ bộ nhớ (Event listener leak) và cạn kiệt socket descriptor.

### 2.6 Kho Mã nguồn Git Repository (Source Control Integrity)
- **Xung đột & Rác nhánh (Branch & Ref Pollution):**
  - Tạo nhánh tự động `feature/ai-worker-<jobId>` trên local repo. Nếu không dọn dẹp hoặc cấu hình sai, hàng trăm nhánh rác cục bộ sẽ tồn đọng.
  - Nguy cơ push ngoài ý muốn (unintended push) lên nhánh được bảo vệ (`main`, `master`, `production`) nếu agent tự ý chạy lệnh `git push`.
- **Khóa chỉ mục Git (Index Lock Deadlock):**
  - Khi nhiều job cùng truy cập repo gốc mà không tách biệt bằng `git worktree`, tệp `.git/index.lock` sẽ gây xung đột làm toàn bộ các tác vụ còn lại bị fail.
- **Thất thoát dữ liệu do Worktree:**
  - Nếu tháo gỡ worktree sai cách (`rm -rf` thô bạo), metadata trong `.git/worktrees/` có thể bị hỏng (corrupted), khiến repo chính không thể tạo worktree mới.

### 2.7 Dịch vụ Cục bộ & Trình duyệt Headless (Local Service & Headless Browser Impact)
- **Tác động Tài nguyên Điện toán khi Chạy đồng thời Local Service + Headless Browser:**
  - **Áp lực bộ nhớ RAM từ Chrome/Chromium:** Mỗi phiên bản Chromium/Chrome headless khởi chạy tiêu tốn từ 300MB đến 800MB RAM. Khi tải các trang Single Page Application (SPA) nặng, có nhiều tài nguyên hình ảnh/font, hoặc mở nhiều tab kiểm thử, mức tiêu thụ có thể vượt quá 1GB RAM mỗi job. Kết hợp với Local Dev Server (Vite/Webpack/Next.js/Node.js dev server tiêu tốn 200MB - 500MB) và AI Runner CLI (200MB - 500MB), một job kiểm thử trực quan E2E có thể ngốn từ 1.5GB đến 2.5GB RAM. Khi chạy song song nhiều jobs (`MAX_CONCURRENT_JOBS` từ 2-4 jobs), tổng mức RAM có thể vượt quá 8GB - 10GB, dẫn đến nguy cơ OOM (Out Of Memory) máy host, làm sập tiến trình Node.js chính hoặc kích hoạt OOM Killer của hệ điều hành.
  - **Tải đỉnh CPU (CPU Spikes):** Quá trình khởi động trình duyệt, phân tích cú pháp CSS/DOM, render layout, thực thi mã JavaScript client-side và chụp ảnh màn hình (screenshot capture) đòi hỏi năng lực xử lý đồ họa và CPU đáng kể. Nếu Local Service đồng thời đang thực hiện hot-reload, biên dịch mã nguồn (TypeScript/Babel) trong cùng một thời điểm, mức tải CPU có thể chạm 100% trên toàn bộ các lõi CPU, gây nghẽn hệ thống, đơ máy chủ hoặc dẫn đến việc các Readiness Probe bị timeout giả tạo.
  - **Đụng độ Cổng mạng (Port Conflicts / EADDRINUSE):** Các framework frontend và backend thường mặc định lắng nghe trên các cổng tiêu chuẩn (ví dụ: 3000, 5173, 8080, 4200). Khi nhiều job chạy đồng thời hoặc job trước chưa kịp giải phóng cổng đã bắt đầu job sau, nguy cơ xảy ra lỗi `EADDRINUSE` là rất cao, khiến local service bị crash ngay khi khởi động hoặc nguy hiểm hơn là Browser Test Runner kết nối nhầm vào service của một job khác đang chạy dở.

### 2.8 Lưu trữ Bằng chứng Ảnh Màn hình (Evidence Storage Impact)
- **Nguy cơ Phình to Dung lượng Ổ cứng (Disk Space Bloat & Storage Exhaustion):**
  - Trong quy trình kiểm thử trực quan giao diện, mỗi bước kiểm thử đều chụp ảnh màn hình (full-page hoặc viewport) dưới định dạng raw PNG không nén (dung lượng mỗi file ảnh dao động từ 1MB đến 5MB tùy độ phân giải màn hình).
  - Trong một chu kỳ kiểm thử tiêu chuẩn có từ 5 đến 10 bước, dung lượng ảnh cho một lần chạy là 10MB - 30MB.
  - Khi hệ thống kích hoạt vòng lặp tự phục hồi `TESTING` ⇄ `FIXING` lặp lại 3 đến 5 lần để sửa lỗi giao diện, dung lượng thư mục `feature/<feature-name>/evidence/` (hoặc `docs/features/<TICKET-ID>/evidence/`) cho một job duy nhất có thể phình to lên tới 50MB - 150MB.
  - Nếu hệ thống vận hành liên tục qua hàng chục hoặc hàng trăm jobs mà không có cơ chế nén ảnh, giới hạn số lượng và dọn dẹp định kỳ, ổ cứng máy chủ sẽ nhanh chóng bị cạn kiệt (Disk Exhaustion).
  - Hơn thế nữa, nếu thư mục `evidence/` vô tình không được đưa vào `.gitignore`, các file ảnh nhị phân dung lượng lớn sẽ bị commit vào kho Git, làm phình to lịch sử Git repository và gây chậm chạp nghiêm trọng cho các thao tác `git clone`/`git pull`.

### 2.9 Vùng Ảnh hưởng Cơ sở Dữ liệu Kiểm thử (Database Testing Impact)
- **Rủi ro Thực thi Truy vấn Độc hại & SQL Injection:**
  - AI Agent trong quá trình thực hiện kiểm thử tự động hoặc viết kịch bản test có thể tự sinh ra các câu lệnh SQL độc hại, query không an toàn hoặc chuỗi test chứa SQL Injection trực tiếp vào database.
- **Rủi ro Kết nối Nhầm Cơ sở Dữ liệu & Ô nhiễm Dữ liệu Sản xuất:**
  - Nếu tệp cấu hình môi trường hoặc connection string trỏ nhầm vào cơ sở dữ liệu Staging hoặc Production thay vì Database kiểm thử (Test DB Sandbox), các lệnh `DROP TABLE`, `TRUNCATE`, `DELETE` hoặc `UPDATE` không kiểm soát sẽ gây mất mát hoặc sai lệch dữ liệu kinh doanh nghiêm trọng.
- **Khóa Bảng và Cạn kiệt Connection Pool (Table Locks & Pool Exhaustion):**
  - Các script kiểm thử chạy các câu lệnh query lặp lại hoặc transaction mở kéo dài mà không commit/rollback có thể dẫn đến deadlock, khóa bảng hoặc làm cạn kiệt connection pool của cơ sở dữ liệu.

### 2.10 Vùng Ảnh hưởng Trạng thái Chờ Tương tác (PENDING State Resource Retention Impact)
- **Rủi ro Giữ Kết nối & Chiếm dụng Slot Worker:**
  - Khi tác vụ rơi vào trạng thái `PENDING` (Human-in-the-loop clarification để chờ phản hồi từ người dùng qua Web UI popup/chat), worker slot trong `MAX_CONCURRENT_JOBS` có thể bị chiếm dụng liên tục nếu không có cơ chế nhường slot hoặc suspend hợp lý.
- **Rò rỉ Bộ nhớ & Treo Tiến trình (Memory Leaks & Hung Resources):**
  - Việc duy trì trạng thái `PENDING` quá lâu mà không giải phóng các kết nối tạm (WebSocket, PTY buffer, Child Process ngầm, bộ nhớ đệm cache) sẽ dẫn đến rò rỉ RAM và tài nguyên điện toán trên máy host, ngăn cản các tác vụ hàng đợi (QUEUE) khác tiếp cận slot xử lý.
---

## 3. Ma trận Rủi ro Chi tiết & Giải pháp Giảm thiểu (Risk Matrix & Mitigation)

### 3.1 Bảng Ma trận Rủi ro Định lượng

| ID | Tên Rủi ro | Khả năng (Likelihood) | Mức độ nghiêm trọng (Severity) | Cấp độ rủi ro (Risk Level) | Chiến lược ứng phó |
|---|---|:---:|:---:|:---:|---|
| **R1** | Command Injection qua Prompt / Args | Thấp (L) | Nghiêm trọng (Critical) | **CAO (HIGH)** | Tránh shell string interpolation, sanitize CLI args |
| **R2** | Fork Bomb / Runaway Process | Trung bình (M) | Cao (High) | **CAO (HIGH)** | Tree-kill watchdog, hard timeout, OS job limits |
| **R3** | Lộ lọt Secret qua Log Stream | Cao (H) | Nghiêm trọng (Critical) | **CỰC CAO (CRITICAL)** | Realtime Regex Scrubber, Masking engine |
| **R4** | Thao tác ghi/xóa ngoài Sandbox | Thấp (L) | Nghiêm trọng (Critical) | **CAO (HIGH)** | Git Worktree isolate, Path whitelist |
| **R5** | Vi phạm quy tắc xóa vĩnh viễn dữ liệu | Cao (H) | Cao (High) | **CAO (HIGH)** | Thay thế toàn bộ lệnh xóa bằng thùng rác (Trash) |
| **R6** | DoS / Cạn kiệt hàng đợi tác vụ | Trung bình (M) | Trung bình (Medium) | **TRUNG BÌNH (MEDIUM)** | Rate limiter, Queue cap, Semaphore pool |
| **R7** | Ô nhiễm Git / Push trái phép | Trung bình (M) | Cao (High) | **CAO (HIGH)** | Chặn quyền network push, Read-only remote token |
| **R8** | Cạn kiệt chi phí / Loop vô tận | Cao (H) | Cao (High) | **CAO (HIGH)** | Budget limit, Vòng lặp tối đa (Max turns) |
| **R-11** | Lỗ hổng Stored/Reflected XSS qua log stream hoặc Diff Viewer | Thấp (1) | Cao (3) | **TRUNG BÌNH (3)** | DOMPurify, escape HTML trước khi render vào DOM, Terminal xterm.js và Diff2Html an toàn |
| **R-12** | Tấn công Cross-Site WebSocket Hijacking (CSWSH) hoặc thao tác Runner trái phép qua Web UI | Thấp (1) | Cao (3) | **TRUNG BÌNH (3)** | Origin checking (whitelist localhost), Token-based Auth cho các endpoint điều khiển |
| **R-13** | Quá tải máy chủ do nhiều kết nối Web UI SSE/WebSocket đồng thời | Trung bình (2) | Trung bình (2) | **TRUNG BÌNH (4)** | Connection rate limiting, giới hạn kết nối đồng thời, auto-cleanup listener khi đóng tab |
| **R-14** | Vòng lặp vô hạn (Infinite Fixing Loop) giữa TESTING và FIXING | Trung bình (M) | Cao (High) | **CAO (HIGH)** | Hard cap `maxFixingRetries` (1-5, mặc định 3), Error Stagnation Circuit Breaker |
| **R-15** | Lạm phát chi phí/token LLM (Token Inflation) do chu kỳ Fixing lặp lại | Cao (H) | Cao (High) | **CAO (HIGH)** | Token budget ceiling (`maxJobTokens` / `maxTotalCost`), Emergency Budget Stop |
| **R-16** | Quá tải RAM & CPU khi chạy đồng thời Local Dev Server và Headless Browser | Trung bình (M) | Cao (High) | **CAO (HIGH)** | Giới hạn concurrency E2E, tắt GPU acceleration, headless mode tối giản, auto-teardown |
| **R-17** | Đụng độ cổng mạng (Port Conflict / `EADDRINUSE`) giữa các Local Services | Cao (H) | Cao (High) | **CAO (HIGH)** | Port auto-discovery & dynamic port allocation, socket probe port trống |
| **R-18** | Phình to dung lượng ổ cứng do tích tụ ảnh chụp màn hình trong `evidence/` | Cao (H) | Trung bình (M) | **TRUNG BÌNH (MEDIUM)** | Nén ảnh PNG/WebP tối ưu, giới hạn số screenshot, dọn dẹp an toàn qua Trash, đưa vào `.gitignore` |
| **R-19** | Rò rỉ tiến trình trình duyệt mồ côi (Zombie Chromium Processes) | Trung bình (M) | Cao (High) | **CAO (HIGH)** | Teardown hook `browser.close()` trong `finally`, `tree-kill` tiến trình cha-con Chromium |
| **R-20** | Rủi ro Thao tác & Truy vấn Cơ sở Dữ liệu Kiểm thử (SQL Injection / Xung đột / Ghi đè DB) | Cao (H) | Cao (High) | **CAO (HIGH)** | Sandbox Test Database, Read-only / Transaction rollback, cấm trỏ Production DB |
| **R-21** | Rủi ro Treo Tác vụ, Chiếm dụng Tài nguyên & Nghẽn Tiến trình (Deadlock) ở Trạng thái PENDING | Trung bình (M) | Cao (High) | **CAO (HIGH)** | Giới hạn PENDING duy nhất ở bước PLANNING (loại bỏ hoàn toàn rủi ro deadlock trong chu trình TESTING ⇄ FIXING), PENDING Timeout Reminder, tự động giải phóng slot |
---

### 3.2 Phân tích Chi tiết & Giải pháp Kỹ thuật cho Từng Rủi ro

#### R1: Command Injection qua Prompt hoặc Extra Args
- **Mô tả:** Kẻ tấn công hoặc người dùng không đáng tin cậy gửi prompt hoặc tham số bổ sung (`extraArgs`) chứa các ký tự điều khiển shell nguy hiểm như `; rm -rf /`, `&& cat /etc/passwd`, `| curl malicious.site`, hoặc kỹ thuật argument injection như `--config=/tmp/evil`.
- **Hậu quả:** Kẻ xấu thực thi mã từ xa (RCE) trên máy chủ host dưới quyền của user chạy server.
- **Giải pháp triệt để:**
  1. Tuyệt đối không dùng `child_process.exec()` hay `sh -c "command $args"`. Bắt buộc dùng `child_process.spawn()` hoặc `node-pty.spawn()` với mảng đối số tường minh (`args: string[]`).
  2. Whitelist nghiêm ngặt các cờ CLI hợp lệ cho từng adapter (`--model`, `--dangerously-skip-permissions`, `--print`, `-v`).
  3. Cấm triệt để việc truyền prompt thông qua cờ dòng lệnh nếu CLI đó hỗ trợ truyền qua STDIN hoặc file tạm cách ly.
  4. Lọc bỏ toàn bộ ký tự NULL byte (`\0`), escape các chuỗi đầu vào theo tiêu chuẩn POSIX / Windows CommandLine.

#### R2: Fork Bomb & Runaway Process (Tiến trình mất kiểm soát)
- **Mô tả:** AI Agent sinh ra các tiến trình biên dịch hoặc chạy test nền mà không kết thúc (ví dụ: `webpack serve`, `nodemon`, một vòng lặp `while(true)` trong test, hoặc các child processes rẽ nhánh liên tục).
- **Hậu quả:** CPU 100%, RAM cạn kiệt, hệ điều hành tê liệt, buộc phải khởi động lại máy chủ vật lý.
- **Giải pháp triệt để:**
  1. **Tree-Kill Engine:** Sử dụng gói `tree-kill` hoặc gọi `taskkill /F /T /PID <pid>` trên Windows và `kill -9 -<pgid>` trên Unix để diệt tận gốc toàn bộ cây tiến trình cha-con, không để lại tiến trình mồ côi (orphan / zombie).
  2. **Timeout Watchdog kép:**
     - *Hard Timeout:* Tự động terminate job nếu thời gian chạy vượt quá `timeoutSeconds` (mặc định 600s).
     - *Inactivity Timeout:* Nếu luồng STDOUT/STDERR không có thêm bất kỳ byte dữ liệu nào trong 180s, kích hoạt cảnh báo và kill tiến trình bị treo.
  3. **Giới hạn số tiến trình:** Trên Linux, gán tiến trình vào `cgroups` với `pids.max = 64`.

#### R3: Lộ lọt Thông tin Nhạy cảm (Secret Leaks) qua Log & Stream
- **Mô tả:** Trong quá trình chạy, agent đọc các file cấu hình (`.env`, `id_rsa`, `docker-compose.yml`, credentials) hoặc in ra biến môi trường chứa API Key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, Git Access Token, Database Password) vào STDOUT. Luồng stream này lập tức bị phát tán ra WebSocket/SSE tới giao diện người dùng hoặc lưu vào file log.
- **Hậu quả:** Rò rỉ thông tin mật cấp độ tổ chức, nguy cơ bị xâm nhập hệ thống sản xuất.
- **Giải pháp triệt để:**
  1. **Stream Buffer Scrubber:** Thiết kế một bộ lọc trung gian dạng stream pipe (Transform Stream) can thiệp vào giữa luồng PTY output và WebSocket broadcaster.
  2. **Bộ luật Regex Masking:**
     - Khóa Anthropic: `sk-ant-[a-zA-Z0-9_-]{40,}` -> `[SECRET_MASKED_ANTHROPIC_KEY]`
     - Khóa OpenAI: `sk-[a-zA-Z0-9]{40,}` -> `[SECRET_MASKED_OPENAI_KEY]`
     - GitHub/GitLab Tokens: `(ghp_|glpat-)[a-zA-Z0-9_-]{20,}` -> `[SECRET_MASKED_GIT_TOKEN]`
     - JWT Tokens: `eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+` -> `[SECRET_MASKED_JWT]`
     - Cặp mật khẩu cơ bản: `(?i)(password|secret|token|apikey)\s*[:=]\s*['"]?([^'"\s]{4,})['"]?` -> `$1: [SECRET_MASKED]`
  3. **Env Stripping:** Không truyền toàn bộ `process.env` của máy chủ host vào subprocess của runner; chỉ chuyển tiếp các biến cần thiết nằm trong whitelist định trước.

#### R4: Thao tác Ghi / Xóa File Vượt Ranh giới Sandbox (Path Traversal)
- **Mô tả:** AI Agent tạo ra lệnh shell hoặc tool call cố tình tác động tới các file hệ thống (`../../../../Windows/System32` hoặc `../../../../etc/passwd`), hoặc ghi đè mã nguồn của dự án mẹ bên ngoài thư mục worktree được chỉ định.
- **Hậu quả:** Phá hoại hệ điều hành host, làm bẩn workspace chính, tiêm mã độc vào các kho lưu trữ khác.
- **Giải pháp triệt để:**
  1. Khởi chạy tiến trình với `cwd` được cố định tại thư mục làm việc riêng biệt `.workspaces/<jobId>/`.
  2. Kiểm tra `git diff` và `git status` sau khi kết thúc để phát hiện xem có file nào bên ngoài ranh giới repo bị tác động hay không.
  3. Cấm việc symlink dẫn ra ngoài thư mục gốc của repository.
  4. Trên môi trường Linux, kích hoạt container cách ly hoặc chroot jail/systemd namespace nếu có yêu cầu cách ly cấp độ cao.

#### R5: Vi phạm Quy tắc Tiên quyết về Xóa Vĩnh viễn Dữ liệu
- **Mô tả:** Quy tắc cốt lõi của hệ thống quy định: *TẤT CẢ các thao tác xóa tập tin/thư mục BẮT BUỘC phải dùng cách di chuyển vào thùng rác (Trash / Recycle Bin), TUYỆT ĐỐI KHÔNG ĐƯỢC xóa luôn/xóa vĩnh viễn.* Nếu runner hoặc agent thực hiện lệnh xóa thô bạo (`rm -rf`, `rmdir /s /q`, `fs.rmSync(path, { recursive: true, force: true })`), dữ liệu của người dùng sẽ bị mất vĩnh viễn không thể phục hồi.
- **Hậu quả:** Vi phạm nghiêm trọng chỉ thị an toàn của hệ thống, mất mát dữ liệu quan trọng khi có sai sót logic.
- **Giải pháp triệt để:**
  1. **Thư viện Thùng rác Chuyên dụng:**
     - Trong Node.js / TypeScript: Tích hợp thư viện `trash` (chuyển tệp tin an toàn vào Recycle Bin trên Windows, và `~/.local/share/Trash` trên Linux/macOS).
     - Trong script shell: Bọc wrapper script hoặc alias lệnh `rm` để chuyển file sang thư mục Trash chuyên biệt.
  2. **Safe Workspace Cleanup Routine:**
     - Khi dọn dẹp worktree sau khi hoàn tất job:
       - Bước 1: Thực thi lệnh git metadata `git worktree remove --force <worktreePath>` để gỡ liên kết an toàn khỏi Git index.
       - Bước 2: Di chuyển toàn bộ thư mục `.workspaces/<jobId>` vào Recycle Bin bằng `trash(worktreePath)`. Tuyệt đối cấm dùng `fs.rmSync()` hay `fs.unlinkSync()`.
  3. **Audit Logger:** Bất kỳ thao tác dọn dẹp nào cũng phải ghi log chi tiết mã đường dẫn đã chuyển vào thùng rác và timestamp để phục vụ tra cứu.

#### R6: DoS / Cạn kiệt Hàng đợi Tác vụ (Queue Starvation & Flooding)
- **Mô tả:** Người dùng hoặc bot gửi dồn dập hàng nghìn yêu cầu tạo job qua API `POST /api/v1/jobs`, khiến bộ nhớ hàng đợi phình to và hệ thống sập nguồn do OOM (Out Of Memory).
- **Hậu quả:** AI Worker Server ngừng hoạt động, không thể phục vụ các công việc khẩn cấp.
- **Giải pháp triệt để:**
  1. **Queue Capacity Limit:** Giới hạn hàng đợi tối đa `MAX_QUEUE_CAPACITY = 100`. Nếu vượt quá, trả về mã lỗi `HTTP 429 Too Many Requests` hoặc `HTTP 503 Service Unavailable`.
  2. **Concurrency Limiter (Semaphore Pool):** Cố định `MAX_CONCURRENT_JOBS = 2` (hoặc tối đa theo cấu hình máy chủ). Các tác vụ còn lại buộc phải xếp hàng ở trạng thái `QUEUED`.
  3. **Priority Ingestion:** Phân loại độ ưu tiên (`HIGH`, `NORMAL`, `LOW`) để các sự cố sản xuất (hotfix) được đưa lên đầu hàng đợi.

#### R7: Ô nhiễm Kho Mã nguồn Git & Push Trái phép
- **Mô tả:** AI Agent tự động chạy lệnh `git push origin main` hoặc push các commit bị lỗi lên remote repository của công ty mà chưa qua kiểm duyệt.
- **Hậu quả:** Làm hỏng nhánh chính của dự án, kích hoạt CI/CD build lỗi diện rộng, đưa mã chưa kiểm thử vào môi trường staging/production.
- **Giải pháp triệt để:**
  1. Khi cấu hình Git trong workspace của worker, thiết lập remote URL ở dạng Read-Only hoặc không cấp phát credentials push (`git config push.default nothing`).
  2. Biến môi trường của Agent không chứa `GIT_PUSH_TOKEN` có quyền ghi trên remote repository trừ khi job được chỉ định rõ ràng là `AUTO_PUSH_ENABLED = true` và đã qua kiểm duyệt trước.
  3. Kết quả công việc mặc định chỉ được đóng gói thành file `diff.patch` hoặc giữ nguyên trên nhánh cục bộ `feature/ai-worker-<jobId>`.

#### R8: Lạm phát Chi phí do AI Agent Kẹt Vòng lặp (Infinite Loop)
- **Mô tả:** Agent thử sửa một lỗi biên dịch nhưng thất bại liên tiếp 30 lần, mỗi lần lại phân tích lại toàn bộ file log và sinh lại toàn bộ file mã nguồn.
- **Hậu quả:** Chi phí API tăng vọt hàng trăm USD cho một ticket duy nhất, đồng thời chiếm dụng slot chạy của các tác vụ khác.
- **Giải pháp triệt để:**
  1. Thiết lập cờ khống chế số bước suy luận (ví dụ: `--max-thinking-tokens`, `--turn-limit 15`).
  2. Theo dõi biến thiên kích thước của file `git diff`. Nếu sau 3 turns liên tiếp mà `git diff` không thay đổi hoặc dao động lặp lại, Watchdog tự động gửi tín hiệu ngắt (SIGINT/SIGTERM) để kết thúc sớm.
  3. Cài đặt trần chi phí tối đa cho mỗi job: `MAX_JOB_COST_USD = 5.0`. Khi ước tính số token tiêu thụ vượt ngưỡng này, server chủ động dừng job với trạng thái `FAILED_BUDGET_EXCEEDED`.

#### R-11: Lỗ hổng Stored/Reflected XSS qua Log Stream hoặc Diff Viewer
- **Mô tả:** Mã nguồn do AI Agent tạo ra hoặc output log chứa các thẻ `<script>`, thuộc tính sự kiện inline (`onload=`, `onerror=`), hoặc chuỗi thoát escape sequence độc hại được truyền trực tiếp về Web UI Dashboard và hiển thị vào DOM thông qua component terminal (xterm.js) hoặc trình xem git diff (diff2html).
- **Hậu quả:** Kẻ tấn công hoặc prompt tiêm nhiễm có thể thực thi mã JavaScript độc hại trong ngữ cảnh trình duyệt của người dùng, đánh cắp session token, đọc trộm nội dung mã nguồn nhạy cảm hoặc chiếm quyền điều khiển UI.
- **Giải pháp triệt để:**
  1. Toàn bộ nội dung diff HTML trước khi chèn vào DOM thông qua diff2html phải được làm sạch bằng thư viện `DOMPurify` với cấu hình nghiêm ngặt (`ALLOWED_TAGS`, `ALLOWED_ATTR`).
  2. Dữ liệu stream log hiển thị trên xterm.js sử dụng trực tiếp cơ chế ghi buffer an toàn của terminal (`terminal.write`), không bao giờ chèn raw HTML vào DOM container.
  3. Cấu hình tiêu chuẩn Content Security Policy (CSP) chặt chẽ trên Single Server HTTP response (`default-src 'self'`).

#### R-12: Tấn công Cross-Site WebSocket Hijacking (CSWSH) hoặc Thao tác Runner Trái phép qua Web UI
- **Mô tả:** Người dùng truy cập một website độc hại trong khi AI Worker Server đang chạy tại `http://localhost:3000`. Trang web độc hại gửi request cross-origin hoặc thiết lập kết nối WebSocket ngầm tới server nhằm đánh cắp log stream hoặc gửi lệnh điều khiển runner (Cancel / Re-run).
- **Hậu quả:** Kẻ tấn công can thiệp vào quy trình thực thi của hệ thống, huỷ ngang các tác vụ quan trọng hoặc chạy lại các job với payload mã độc.
- **Giải pháp triệt để:**
  1. WebSocket handshake và luồng SSE bắt buộc phải thẩm tra tiêu đề `Origin` trên HTTP request. Chỉ cho phép kết nối từ `http://localhost:3000`, `http://127.0.0.1:3000` hoặc danh sách whitelist được cấu hình trước.
  2. Thiết lập cơ chế Token-based Auth (Bearer token / Session secret) cho các endpoint nhạy cảm (`POST /api/v1/jobs/:id/cancel`, `POST /api/v1/jobs/:id/rerun`, `/ws/logs/:id`).

#### R-13: Quá tải Máy chủ do Nhiều Kết nối Web UI SSE/WebSocket Đồng thời
- **Mô tả:** Nhiều client hoặc người dùng mở nhiều tab trình duyệt cùng lúc để theo dõi log trực tiếp, trong khi tác vụ chạy tạo ra luồng log tần suất cao hàng nghìn dòng mỗi giây.
- **Hậu quả:** Rò rỉ EventListener trên Node.js EventEmitter (`MaxListenersExceededWarning`), tràn bộ nhớ Heap RAM máy chủ do lưu trữ buffer log không giới hạn, nghẽn Event Loop làm tê liệt các tiến trình điều phối runner.
- **Giải pháp triệt để:**
  1. **Connection Rate Limiting:** Giới hạn số lượng kết nối SSE/WebSocket tối đa đồng thời trên mỗi IP/Client (ví dụ: tối đa 5 kết nối đồng thời).
  2. **Bounded Log Buffer (Ring Buffer):** Sử dụng bộ nhớ đệm vòng giới hạn dung lượng (tối đa 10,000 dòng log gần nhất) cho mỗi job, tránh giữ mảng vô hạn trong RAM.
  3. **Auto-cleanup Listener:** Lắng nghe chặt chẽ sự kiện socket `close` / `disconnect` để tự động gỡ bỏ hoàn toàn listener khỏi EventEmitter (`runner.removeListener(...)`), giải phóng tài nguyên ngay khi client đóng tab.

#### R-14: Vòng lặp Vô hạn (Infinite Fixing Loop) giữa TESTING và FIXING
- **Mô tả:** Trong vòng đời thực thi Testing & Fixing Loop Lifecycle (AC-14), khi bước kiểm thử phát hiện lỗi (`TESTING` thất bại), hệ thống tự động chuyển trạng thái sang `FIXING` để agent phân tích và sửa mã nguồn. Sau khi sửa, hệ thống lại chuyển về `TESTING` để chạy kiểm thử lại. Nếu tác tử sửa sai, sửa không dứt điểm hoặc tạo ra lỗi hồi quy mới, chu kỳ này có thể lặp đi lặp lại vô tận.
- **Hậu quả:** Tác vụ bị kẹt vĩnh viễn ở trạng thái thực thi, chiếm dụng slot của Semaphore Pool / Concurrency Limiter, làm tê liệt hàng đợi và tiêu tốn tài nguyên tính toán của host.
- **Giải pháp triệt để:**
  1. **Giải pháp 1: Hard cap số lần retry (`maxFixingRetries`):**
     - Cấu hình số lần retry tối đa cho bước giải quyết lỗi (`maxFixingRetries`), thiết lập mặc định 3 lần (cho phép tùy biến linh hoạt từ 1 đến 5 thông qua file `config.json`/YAML hoặc trực tiếp trên Web UI theo AC-13).
     - Hệ thống duy trì biến đếm `resolveRetryCount` trong suốt vòng đời của job.
     - Khi chạm ngưỡng retry tối đa (`resolveRetryCount >= maxFixingRetries`) mà bài test vẫn tiếp tục thất bại, hệ thống tự động ngắt chu kỳ ngay lập tức, gắn nhãn trạng thái `FAILED` kèm mã nguyên nhân `MAX_FIXING_RETRIES_EXCEEDED` và thông báo tới người dùng trên Web UI.
  2. **Giải pháp 3: Error Stagnation Circuit Breaker (Cầu dao ngắt mạch khi lỗi lặp lại):**
     - Hệ thống phân tích sâu mã lỗi, stack trace hoặc hash chữ ký lỗi kiểm thử (error signature / hash) sau mỗi lần chạy test thất bại.
     - Nếu sau 2 lần fixing liên tiếp mà mã lỗi kiểm thử hoàn toàn không đổi (agent lặp lại cùng một phương án sửa sai hoặc không tạo ra bất kỳ tiến triển nào), hệ thống lập tức kích hoạt Error Stagnation Circuit Breaker để ngắt vòng lặp ngay cả khi chưa hết số lần retry tối đa.
     - Chuyển trạng thái job sang `FAILED` với nguyên nhân `ERROR_STAGNATION_DETECTED` để người dùng can thiệp thủ công, tránh lãng phí thêm thời gian và tài nguyên.

#### R-15: Lạm phát Chi phí / Token LLM (Token Inflation) do Chu kỳ Fixing Lặp lại
- **Mô tả:** Mỗi chu kỳ sửa lỗi trong trạng thái `FIXING` đòi hỏi phải nhồi toàn bộ ngữ cảnh mã nguồn, log lỗi kiểm thử và lịch sử các bước trước vào prompt LLM. Nếu tác vụ sử dụng các mô hình ngôn ngữ lớn mạnh mẽ nhưng chi phí cao mà không có hạn mức trần, việc lặp lại liên tục nhiều vòng fixing sẽ làm chi phí token tăng theo cấp số nhân.
- **Hậu quả:** Cạn kiệt ngân sách API của tổ chức chỉ trong một tác vụ đơn lẻ, nguy cơ bị nhà cung cấp mô hình (Anthropic, OpenAI) khóa tài khoản API do vượt hạn mức chi tiêu đột ngột.
- **Giải pháp triệt để:**
  1. **Giải pháp 2: Token budget ceiling cho toàn bộ Job (`maxJobTokens` / `maxTotalCost`):**
     - Theo dõi lũy kế lượng token tiêu thụ qua từng bước (Planning, Implementing, Testing, Fixing) trong suốt tiến trình thực thi job.
     - Sau mỗi lượt tương tác với agent hoặc LLM API, hệ thống cộng dồn số token và ước tính chi phí thực tế vào metadata của job.
     - Nếu tổng token vượt quá ngưỡng ngân sách trần cho phép (`maxJobTokens`) hoặc tổng chi phí vượt quá giới hạn trần (`maxTotalCost`), hệ thống kích hoạt cơ chế ngắt khẩn cấp (Emergency Budget Stop).
     - Ngay lập tức buộc dừng các tiến trình runner con, chuyển trạng thái job sang `FAILED` với lý do `BUDGET_CEILING_EXCEEDED`, đồng thời hiển thị chi tiết lượng token đã tiêu thụ trên Web UI để phục vụ kiểm toán chi phí.

#### R-16: Quá tải RAM & CPU khi Chạy đồng thời Local Dev Server và Headless Browser
- **Mô tả:** Trong giai đoạn `TESTING`, hệ thống phải đồng thời duy trì Local Dev Server (Vite, Webpack, Next.js, Node.js) và Trình duyệt Headless (Chromium/Playwright/MCP CloakBrowser) để thực hiện E2E visual testing. Việc này có thể làm tăng thêm 1.5GB - 2.5GB RAM tiêu thụ cho mỗi job, kết hợp tải đỉnh CPU khi render layout và biên dịch mã nguồn, đẩy máy chủ vào trạng thái nghẽn tài nguyên.
- **Hậu quả:** Gây sập tiến trình máy chủ chính (OOM Crash), kích hoạt OOM Killer của hệ điều hành, hoặc làm Readiness Probe bị timeout giả tạo do CPU bị chiếm dụng 100%.
- **Giải pháp triệt để:**
  1. **Giới hạn số lượng tác vụ E2E đồng thời (`MAX_CONCURRENT_E2E_JOBS`):** Cấu hình semaphore pool riêng biệt cho các tác vụ E2E (khuyến nghị tối đa 1-2 jobs E2E đồng thời trên máy chủ thông thường).
  2. **Cấu hình Trình duyệt Headless tối giản:** Tắt tăng tốc phần cứng GPU (`--disable-gpu`), tắt sandbox (`--no-sandbox`), chặn nạp tài nguyên không phục vụ kiểm thử (video, font ngoại vi nặng) để tiết kiệm 40-50% RAM của Chromium.
  3. **Giám sát ngưỡng bộ nhớ hệ thống (Memory Watchdog):** Nếu dung lượng RAM khả dụng của máy host giảm xuống dưới 15%, hệ thống tạm hoãn khởi chạy các bài test E2E mới cho đến khi các job trước hoàn tất giải phóng bộ nhớ.

#### R-17: Đụng độ Cổng Mạng (Port Conflict / EADDRINUSE) giữa các Local Services
- **Mô tả:** Các framework ứng dụng thường mặc định sử dụng các cổng mạng quen thuộc (3000, 5173, 8080, 4200). Khi nhiều job kiểm thử chạy song song trong các workspace độc lập, hoặc khi một service của job trước chưa kịp giải phóng cổng, hệ thống sẽ gặp lỗi đụng độ cổng mạng `EADDRINUSE`.
- **Hậu quả:** Local service bị crash ngay khi khởi chạy, hoặc nguy hiểm hơn là Browser Test Runner kết nối nhầm vào một dịch vụ đang chạy dở của job khác, dẫn đến kết quả kiểm thử sai lệch hoàn toàn.
- **Giải pháp triệt để:**
  1. **Port Auto-Discovery & Dynamic Port Allocation (Tự động cấp phát cổng động):** Hệ thống tích hợp module quét tìm cổng mạng trống động (quét trong dải port an toàn từ 31000 đến 39000 thông qua TCP socket probe hoặc sử dụng cổng ngẫu nhiên được cấp phát từ hệ điều hành).
  2. **Truyền cổng động qua biến môi trường:** Khi Local Service Runner kích hoạt lệnh khởi chạy service (ví dụ: `npm run dev`), hệ thống tự động tiêm biến môi trường `PORT=<dynamicPort>` vào tiến trình con.
  3. **Đồng bộ địa chỉ URL cho Browser Runner & Readiness Probe:** Toàn bộ quá trình Readiness Probe và Browser Test Runner đều kết nối chính xác tới địa chỉ `http://localhost:<dynamicPort>`, loại bỏ triệt để nguy cơ xung đột giữa các jobs.

#### R-18: Phình to Dung lượng Lưu trữ do Tích tụ Ảnh Chụp Màn hình trong evidence/
- **Mô tả:** Mỗi bước kiểm thử giao diện E2E đều chụp ảnh màn hình (screenshot full-page hoặc viewport) dưới định dạng raw PNG không nén (1MB - 5MB/ảnh). Khi trải qua vòng đời tự phục hồi `TESTING` ⇄ `FIXING` với 3-5 lượt lặp, dung lượng thư mục `feature/<feature-name>/evidence/` (hoặc `docs/features/<TICKET-ID>/evidence/`) cho mỗi job có thể phình to lên tới 50MB - 150MB.
- **Hậu quả:** Cạn kiệt dung lượng ổ cứng máy chủ (Disk Exhaustion), làm nghẽn Git repo nếu các file nhị phân dung lượng lớn vô tình bị commit vào hệ thống kiểm soát phiên bản.
- **Giải pháp triệt để:**
  1. **Nén ảnh PNG/WebP tối ưu:** Tích hợp bộ xử lý chuyển đổi ảnh chụp màn hình sang định dạng WebP hoặc áp dụng nén ảnh PNG tối ưu (lossless/lossy compression giảm 70-80% dung lượng tệp tin mà vẫn đảm bảo độ phân giải sắc nét cho mô hình Vision LLM phân tích).
  2. **Hạn chế số lượng ảnh chụp có chọn lọc:** Chỉ chụp ảnh màn hình tại các checkpoint cốt lõi được định nghĩa trong `test_plan.md` và khi phát hiện lỗi (failure checkpoint), tránh việc chụp ảnh liên tục không kiểm soát.
  3. **Dọn dẹp an toàn qua Thùng rác (Recycle Bin / Trash):** Khi dọn dẹp các ảnh bằng chứng cũ của các vòng test trước hoặc dọn dẹp workspace tạm, hệ thống BẮT BUỘC phải chuyển các tệp tin này vào Thùng rác (Recycle Bin trên Windows hoặc Trash trên Linux/macOS) theo đúng Quy tắc An toàn Tiên quyết, tuyệt đối không được dùng lệnh xóa vĩnh viễn (`rm -rf` hoặc `del`).
  4. **Cách ly hoàn toàn khỏi Git Repository:** Bắt buộc bổ sung quy tắc loại trừ `**/evidence/*.png`, `**/evidence/*.webp` vào file `.gitignore` của dự án để đảm bảo không một file ảnh bằng chứng nhị phân nào bị đẩy lên Git remote.

#### R-19: Rò rỉ Tiến trình Trình duyệt Mồ côi (Zombie Chromium Processes)
- **Mô tả:** Khi một kịch bản kiểm thử giao diện bị hủy ngang (Job Cancelled), bị ngắt do Hard Timeout, hoặc gặp ngoại lệ runtime chưa bắt được, tiến trình trình duyệt Chromium headless có thể không được đóng đúng quy trình, dẫn đến việc các tiến trình con trở thành zombie process chạy ngầm vĩnh viễn trên máy chủ.
- **Hậu quả:** Gây cạn kiệt Process Identifier (PID exhaustion) và rò rỉ dung lượng RAM nghiêm trọng sau nhiều phiên kiểm thử, làm máy chủ suy giảm hiệu năng hoặc mất khả năng spawn tiến trình mới.
- **Giải pháp triệt để:**
  1. **Dọn dẹp Browser Instance sau khi test (Auto-teardown hook):** Toàn bộ chuỗi thao tác của Browser Test Runner bắt buộc phải được bao bọc trong cấu trúc `try...finally`. Trong khối `finally`, hệ thống luôn luôn gọi `await browser.close()` để đóng phiên duyệt web ngay cả khi xảy ra lỗi bất ngờ.
  2. **Truy vết và Tiêu diệt qua `tree-kill`:** Đăng ký PID của tiến trình trình duyệt vào danh sách theo dõi tài nguyên của job. Khi job kết thúc, timeout hoặc nhận lệnh cancel, hệ thống kích hoạt cơ chế `tree-kill` để tiêu diệt sạch sẽ toàn bộ cây tiến trình cha-con của Chromium (bao gồm renderer processes, GPU processes và crashpad handlers).

#### R-20: Rủi ro Thao tác & Truy vấn Cơ sở Dữ liệu Kiểm thử (SQL Injection / Xung đột / Ghi đè DB)
- **Mô tả:** Trong giai đoạn Multi-Verification Evidence Gate, hệ thống cho phép thực hiện truy vấn DB thực tế để đối chiếu kết quả. Nếu AI Agent tự sinh các câu query không an toàn hoặc script test chứa chuỗi độc hại, có nguy cơ xảy ra SQL Injection. Nguy hiểm hơn, nếu cấu hình kết nối nhầm sang cơ sở dữ liệu Staging hoặc Production thay vì Sandbox Test DB, các thao tác DDL/DML có thể làm mất mát hoặc sai lệch dữ liệu hệ sinh thái doanh nghiệp.
- **Hậu quả:** Dữ liệu sản xuất bị ghi đè, xóa hoặc lộ lọt dữ liệu nhạy cảm; rò rỉ kết nối hoặc treo database server do các truy vấn không tối ưu hoặc transaction bị khóa chết.
- **Giải pháp triệt để:**
  1. **Sandbox Test Database bắt buộc:** Toàn bộ truy vấn kiểm chứng chỉ được phép trỏ tới Database môi trường test cô lập (ưu tiên SQLite in-memory, Docker container ephemeral hoặc database sandbox riêng biệt được khởi tạo tự động theo từng job).
  2. **Chế độ Read-only hoặc Transaction Rollback tự động:** Các kết nối cơ sở dữ liệu dùng để xác minh phải được cấp quyền Read-only tối đa. Đối với các bài test cần thao tác ghi dữ liệu, bắt buộc phải bọc toàn bộ câu lệnh trong một Transaction và tự động Rollback ngay sau khi lấy bằng chứng kiểm thử xong.
  3. **Tham số hóa truy vấn (Parameterized Queries):** Tuyệt đối cấm ghép chuỗi câu lệnh SQL (string concatenation). Mọi truy vấn do AI sinh ra phải được thực thi qua prepared statements hoặc parameterized queries có kiểm tra cú pháp nghiêm ngặt.
  4. **Validation Connection String nghiêm ngặt:** Hệ thống áp dụng bộ lọc regex connection string whitelist, từ chối mọi chuỗi kết nối chứa hostname/IP thuộc dải Production hoặc Staging.

#### R-21: Rủi ro Treo Tác vụ, Chiếm dụng Tài nguyên & Nghẽn Tiến trình (Deadlock) ở Trạng thái PENDING
- **Mô tả:** Khi AI Agent cần làm rõ yêu cầu (Human-in-the-loop clarification), tác vụ chuyển sang trạng thái `PENDING` và hiển thị Web UI popup/chat để chờ người dùng tương tác. Nếu cho phép kích hoạt `PENDING` tự do trong các bước thực thi sâu (`IMPLEMENT`, `TESTING`, `FIXING`), sẽ gây ra rủi ro nghiêm trọng: chu trình tự phục hồi (Self-Healing Loop) giữa `TESTING ⇄ FIXING` hoặc tiến trình viết code tự động bị tạm dừng đột ngột để đợi người dùng trả lời những câu hỏi vi mô/kỹ thuật. Nếu người dùng vắng mặt hoặc không phản hồi trong thời gian dài (hàng giờ hoặc hàng ngày), tác vụ tiếp tục giữ worker slot, gây nghẽn tiến trình (Deadlock / Process Blocking).
- **Hậu quả:** Gây đứt gãy và nghẽn hoàn toàn chu trình tự phục hồi `TESTING ⇄ FIXING`, phá vỡ tính tự hành (Autonomous Execution) của hệ sinh thái AI Worker; chiếm dụng dung lượng pool xử lý (`MAX_CONCURRENT_JOBS`), làm tắc nghẽn hàng đợi (QUEUE), rò rỉ bộ nhớ RAM do duy trì PTY buffer và các kết nối mạng ngầm, khiến máy chủ cạn kiệt tài nguyên cho các job mới.
- **Giải pháp triệt để:**
  1. **Quy tắc Kiến trúc Cốt lõi: Giới hạn PENDING DUY NHẤT ở bước PLANNING (Planning-Only Clarification):**
     - Trạng thái `PENDING` chỉ được phép kích hoạt DUY NHẤT tại bước `PLANNING`. Khi ở bước `PLANNING`, Agent khảo sát yêu cầu, kiến trúc và sinh Dual Plan (Dev Plan + Test Plan); nếu có câu hỏi làm rõ hoặc phân vân lựa chọn, task chuyển sang `PENDING`. Khi người dùng tương tác giải đáp (tích chọn tùy chọn hoặc chat custom), task quay trở lại `PLANNING` để hoàn thiện kế hoạch.
     - **Khi PLANNING xong (Kế hoạch đã chốt): TUYỆT ĐỐI KHÔNG PENDING NỮA!** Toàn bộ các bước sau (`IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE`) chạy hoàn toàn tự động (autonomous execution & self-healing loop), dựa trên Dev Plan & Test Plan đã được làm rõ từ trước.
     - Nếu Agent ở bước `IMPLEMENT` hoặc `FIXING` cố tình phát tín hiệu hỏi/làm rõ, hệ thống sẽ tự động intercept, từ chối chuyển sang `PENDING` và gửi chỉ dẫn (system instruction injection) yêu cầu Agent tiếp tục bám sát kế hoạch mà không tạm dừng chờ người dùng.
     - **Tác động tích cực:** Việc giới hạn `PENDING` chỉ trong bước `PLANNING` giúp loại bỏ hoàn toàn rủi ro nghẽn tiến trình (Deadlock / Process Blocking) trong chu trình `TESTING ⇄ FIXING`, đảm bảo pipeline chạy trơn tru, liên tục và không bị ngắt quãng.
  2. **Cơ chế PENDING Timeout Reminder (cho bước PLANNING):** Thiết lập bộ đếm thời gian chờ cấu hình qua `pendingTimeoutSeconds` (giá trị khuyến nghị: 15-30 phút, tối đa 60 phút). Hệ thống chủ động gửi thông báo / notification nhắc nhở tới Web UI và kênh webhook khi sắp hết thời gian chờ.
  3. **Tự động giải phóng Worker Slot & Chuyển trạng thái khi Timeout:** Khi hết thời gian `pendingTimeoutSeconds` ở bước `PLANNING` mà không có phản hồi từ người dùng, hệ thống lập tức giải phóng worker slot trở lại pool, lưu lại snapshot trạng thái vào disk và chuyển job sang trạng thái `PAUSED_EXPIRED` hoặc `CANCELLED_TIMEOUT`.
  4. **Teardown tài nguyên tạm an toàn:** Ngắt và đóng an toàn các Child Process hoặc tiến trình kiểm thử tạm thời trong thời gian chờ để trả lại RAM và CPU cho hệ điều hành.
---

## 4. Tiêu chí Kiểm tra An toàn Trước khi Chạy (Pre-run Safety Checklist)

Bảng kiểm tra an toàn này bắt buộc phải được kiểm tra (tự động hóa qua mã nguồn hoặc kiểm duyệt thủ công) trước khi cho phép hệ thống AI Worker Server tiếp nhận tác vụ chính thức.

```text
========================================================================================
                     PRE-RUN SAFETY CHECKLIST — AI WORKER SERVER
========================================================================================
[ ] TẦNG 1: MÔI TRƯỜNG HOST & HẠ TẦNG CÁCH LY
    [ ] 1.1 Thư mục `.workspaces/` đã được thêm vào `.gitignore` của repo gốc.
    [ ] 1.2 Quyền thực thi của daemon bị giới hạn, không chạy dưới quyền Administrator/Root.
    [ ] 1.3 Cơ chế dọn dẹp đã được cấu hình trỏ sang Recycle Bin / Trash (không dùng rm/del).
    [ ] 1.4 Thư viện `tree-kill` đã được kiểm tra trên OS hiện tại để đảm bảo kill sạch PID.

[ ] TẦNG 2: BẢO MẬT KHÓA & SANITIZATION DỮ LIỆU
    [ ] 2.1 Bộ lọc Secret Scrubber đã kích hoạt trên luồng WebSocket/SSE và log file.
    [ ] 2.2 Các biến môi trường nhạy cảm của host đã được gỡ bỏ khỏi whitelist truyền vào subprocess.
    [ ] 2.3 Tham số đầu vào (`extraArgs`, `prompt`) được kiểm tra cú pháp, ngăn chặn injection.
    [ ] 2.4 Token đẩy git (nếu có) bị chặn quyền push trực tiếp lên các nhánh protected.

[ ] TẦNG 3: GIỚI HẠN TÀI NGUYÊN & WATCHDOG
    [ ] 3.1 Semaphore Pool đã đặt giới hạn chạy đồng thời (`MAX_CONCURRENT_JOBS` <= số core thực).
    [ ] 3.2 Bộ đếm thời gian Hard Timeout đã cấu hình (mặc định 600 giây).
    [ ] 3.3 Bộ đếm Inactivity Timeout đã cấu hình (mặc định 180 giây không có stdout).
    [ ] 3.4 Dung lượng hàng đợi tối đa đã được chốt (tránh tràn RAM khi bị spam job).

[ ] TẦNG 4: SẴN SÀNG CỦA 5 AI RUNNER ADAPTER
    [ ] 4.1 Claude Code Adapter (`claude`): kiểm tra cờ `--print`, headless timeout, API key.
    [ ] 4.2 OpenCode Adapter (`opencode`): kiểm tra endpoint local/remote, non-interactive mode.
    [ ] 4.3 OMP Adapter (`omp`): kiểm tra đường dẫn config `.omp/`, skill injection.
    [ ] 4.4 Codex CLI Adapter (`codex`): kiểm tra xác thực OpenAI API, cờ bypass prompt.
    [ ] 4.5 Antigravity CLI Adapter (`antigravity`): kiểm tra PTY channel, capture output.

[ ] TẦNG 5: CƠ CHẾ SAO LƯU & KHÔI PHỤC (ROLLBACK READINESS)
    [ ] 5.1 Repository chính ở trạng thái working tree sạch sẽ trước khi tạo worktree mới.
    [ ] 5.2 Kịch bản khôi phục khẩn cấp (Emergency Kill Switch) đã được cấu hình và kiểm thử.

[ ] TẦNG 6: AN TOÀN WEB UI & STREAMING DASHBOARD (AC-10, AC-11, AC-12)
    [ ] 6.1 HTML/ANSI Sanitization: Toàn bộ log và code diff phải đi qua bộ lọc DOMPurify / escape HTML trước khi render vào DOM/Terminal UI.
    [ ] 6.2 Origin Checking & Token-based Auth: WebSocket/SSE endpoint phải kiểm tra Origin header (chỉ cho phép localhost / danh sách whitelist) và xác thực token nếu có cấu hình.
    [ ] 6.3 Connection Rate Limiting & Auto-cleanup: Giới hạn số lượng kết nối SSE/WS đồng thời trên mỗi IP/Client, tự động dọn dẹp listener khi client đóng tab.

[ ] TẦNG 7: BẢO VỆ VÒNG LẶP FIXING & NGÂN SÁCH TOKEN (AC-13, AC-14, R-14, R-15)
    [ ] 7.1 Kiểm tra `maxFixingRetries` được thiết lập trong khoảng an toàn (1-5, mặc định 3).
    [ ] 7.2 Kiểm tra trần chi phí / token budget ceiling (`maxJobTokens` / `maxTotalCost`) cho job.
    [ ] 7.3 Kiểm tra Error Stagnation Circuit Breaker hoạt động bình thường (ngắt khi mã lỗi lặp lại 2 lần liên tiếp).

[ ] TẦNG 8: AN TOÀN TRUY VẤN CƠ SỞ DỮ LIỆU & QUẢN TRỊ TRẠNG THÁI PENDING (R-20, R-21)
    [ ] 8.1 Database Connection String Whitelist: Xác nhận tuyệt đối không trỏ vào Staging/Production DB; bắt buộc dùng Test Sandbox DB.
    [ ] 8.2 Database Transaction Rollback / Read-only enforcement: Xác nhận các câu query kiểm thử chạy trong transaction rollback hoặc read-only mode.
    [ ] 8.3 Quản trị Trạng thái PENDING & Ngăn chặn Deadlock (R-21): Xác nhận PENDING chỉ được phép kích hoạt duy nhất ở bước PLANNING (loại bỏ hoàn toàn rủi ro Deadlock trong chu trình TESTING ⇄ FIXING); các bước IMPLEMENT/TESTING/FIXING vận hành tự động 100%; cơ chế pendingTimeoutSeconds và timeout reminder hoạt động chính xác.
========================================================================================
```

### 4.5 Kiểm tra An toàn Web UI & Streaming Dashboard
- **HTML/ANSI Sanitization:** Toàn bộ log và code diff phải đi qua bộ lọc DOMPurify / escape HTML trước khi render vào DOM/Terminal UI.
- **Origin Checking & Token-based Auth:** WebSocket/SSE endpoint phải kiểm tra Origin header (chỉ cho phép localhost / danh sách whitelist) và xác thực token nếu có cấu hình.
- **Connection Rate Limiting & Auto-cleanup:** Giới hạn số lượng kết nối SSE/WS đồng thời trên mỗi IP/Client, tự động dọn dẹp listener khi client đóng tab.

### 4.6 Kiểm tra An toàn Vòng lặp Fixing & Ngân sách Token (AC-13, AC-14, R-14, R-15)
- **Hard Cap Max Retries:** Xác nhận giá trị `maxFixingRetries` nằm trong khoảng hợp lệ từ 1 đến 5 (mặc định 3); cấm cấu hình giá trị vô hạn hoặc không có chốt chặn.
- **Token Budget Ceiling:** Đảm bảo mỗi job được gán hạn mức trần `maxJobTokens` / `maxTotalCost` trước khi kích hoạt quy trình thực thi; kích hoạt Emergency Budget Stop khi chạm trần.
- **Error Stagnation Watcher:** Kiểm tra cơ chế hash chữ ký lỗi (error signature hash) sẵn sàng so sánh giữa các chu kỳ `TESTING` thất bại để kích hoạt circuit breaker ngắt mạch kịp thời khi lỗi bế tắc.


### 4.7 Kiểm tra An toàn Truy vấn Cơ sở Dữ liệu & Quản trị Trạng thái PENDING (R-20, R-21)
- **Database Connection String Whitelist:** Xác nhận tuyệt đối không trỏ vào Staging/Production DB; bắt buộc dùng Test Sandbox DB (SQLite in-memory hoặc ephemeral isolated DB).
- **Database Transaction Rollback / Read-only Enforcement:** Xác nhận các câu query kiểm thử chạy trong transaction rollback hoặc kết nối read-only mode, ngăn chặn sửa đổi ngoài ý muốn.
- **PENDING Planning-Only Enforcement & Timeout Policy (R-21):** Xác nhận trạng thái PENDING chỉ được phép xảy ra duy nhất ở bước PLANNING nhằm loại bỏ hoàn toàn rủi ro nghẽn tiến trình (Deadlock / Process Blocking) trong chu trình TESTING ⇄ FIXING, đảm bảo pipeline chạy trơn tru không bị ngắt quãng; các bước sau bị cấm PENDING hoàn toàn. Thiết lập pendingTimeoutSeconds (15-30 phút), cơ chế timeout reminder hoạt động và tự động thu hồi tài nguyên nếu quá hạn.
---

## 5. Quy trình Xử lý Sự cố & Kế hoạch Khôi phục (Incident Response & Rollback Playbook)

### 5.1 Phân cấp Mức độ Sự cố (Incident Severity Levels)

- **SEV-1 (Khẩn cấp / Critical):**
  - Rò rỉ Secret/API Key doanh nghiệp ra log công khai hoặc giao diện.
  - Tiến trình Agent xóa nhầm mã nguồn ngoài sandbox hoặc sửa hỏng repo chính.
  - Máy chủ host bị treo hoàn toàn, CPU/RAM 100% không phản hồi.
- **SEV-2 (Nghiêm trọng / High):**
  - AI Agent bị kẹt vòng lặp làm tiêu tốn ngân sách token vượt ngưỡng dự kiến.
  - Một hoặc nhiều job bị kẹt trạng thái PENDING/RUNNING làm tắc nghẽn toàn bộ hàng đợi.
  - Git index bị lock khiến các job sau đều báo lỗi `index.lock exists`.
- **SEV-3 (Trung bình / Medium):**
  - Một runner cụ thể bị lỗi binary (ví dụ: `claude` CLI báo version mismatch).
  - Webhook hoặc WebSocket stream bị ngắt kết nối cục bộ nhưng job vẫn chạy nền.

---

### 5.2 Playbook Xử lý Khẩn cấp (Emergency Playbooks)

#### Kịch bản 1: AI Worker bị treo hoặc ngốn 100% CPU/RAM (Runaway Process Kill)
*Dấu hiệu:* Alert từ hệ thống giám sát báo tải CPU > 95% liên tục trong 5 phút; API server không phản hồi lệnh mới.

- **Bước 1: Kích hoạt Lệnh Dừng Khẩn cấp (Emergency Kill-All)**
  - Nếu API còn phản hồi: Gọi `POST /api/v1/jobs/abort-all` để gửi lệnh ngắt đến tất cả worker đang hoạt động.
  - Nếu API bị đơ, can thiệp trực tiếp từ terminal của máy host:
    - *Trên Windows (PowerShell):*
      ```powershell
      # Tìm và tiêu diệt toàn bộ cây tiến trình của các runner
      Get-Process -Name claude, opencode, omp, codex, antigravity -ErrorAction SilentlyContinue | Stop-Process -Force
      # Tiêu diệt các tiến trình con phổ biến hay bị mồ côi
      Get-Process -Name node, python, git -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ai-worker*" } | Stop-Process -Force
      ```
    - *Trên Linux / macOS (Bash):*
      ```bash
      # Tiêu diệt theo tên tiến trình
      pkill -9 -f "claude|opencode|omp|codex|antigravity"
      # Giải phóng các tiến trình node mồ côi trong workspace
      pkill -9 -f "\.workspaces/"
      ```
- **Bước 2: Thu hồi Tài nguyên Hàng đợi**
  - Khởi động lại daemon AI Worker: `npm run restart:daemon`.
  - Toàn bộ job đang ở trạng thái `RUNNING` sẽ được chuyển thành `FAILED_INTERRUPTED_BY_ADMIN`.

---

#### Kịch bản 2: Phát hiện Lộ lọt Secret trong Stream hoặc Log (Secret Leak Containment)
*Dấu hiệu:* Giám sát viên hoặc hệ thống SOC phát hiện chuỗi API Key (`sk-ant-`, `ghp_`, DB password) xuất hiện trên Web UI hoặc file log.

- **Bước 1: Cách ly Ngay lập tức**
  - Hủy ngay lập tức job đang chạy làm lộ secret: `POST /api/v1/jobs/{jobId}/cancel`.
  - Tạm thời vô hiệu hóa quyền truy cập giao diện web của job đó.
- **Bước 2: Xoay vòng Khóa (Key Revocation & Rotation)**
  - *Bắt buộc:* Coi như khóa bí mật đã bị lộ hoàn toàn ra bên ngoài.
  - Truy cập ngay dashboard của nhà cung cấp (Anthropic Console, OpenAI Platform, GitHub Settings) để **REVOKE (HỦY)** ngay lập tức API key cũ.
  - Tạo API key mới, cập nhật vào file cấu hình an toàn của server và khởi động lại daemon.
- **Bước 3: Dọn dẹp Dấu vết Log một cách An toàn**
  - Di chuyển các file log chứa secret vào thùng rác hệ thống (Recycle Bin / Trash), không lưu trữ trần trên ổ cứng.
  - Xóa sạch bộ nhớ đệm (in-memory buffer) của job đó trên server.

---

#### Kịch bản 3: Tác vụ Tự ý Sửa nhầm hoặc Xóa Tệp tin Dự án (File Recovery & Rollback)
*Dấu hiệu:* Sau khi chạy, phát hiện các file quan trọng trong dự án bị thay đổi sai lệch hoặc biến mất.

- **Bước 1: Xác định Tình trạng Kho Git**
  - Chuyển vào thư mục gốc của repository:
    ```bash
    git status
    ```
- **Bước 2: Phục hồi Tệp tin bị Xóa**
  - Do hệ thống tuân thủ quy tắc chuyển vào thùng rác:
    - Mở **Recycle Bin (Windows)** hoặc **Trash (Linux/macOS)** để tìm lại các file đã bị di chuyển.
    - Thực hiện khôi phục (Restore) các file về vị trí cũ nếu cần.
  - Nếu file nằm trong tầm kiểm soát của Git:
    ```bash
    # Khôi phục toàn bộ file bị xóa hoặc sửa đổi về trạng thái commit gần nhất
    git checkout HEAD -- .
    # Dọn dẹp các file rác mới sinh ra mà chưa track (chuyển vào thư mục backup trước)
    git clean -fd
    ```
- **Bước 3: Gỡ bỏ Worktree Lỗi**
  - Liệt kê các worktree đang tồn tại: `git worktree list`.
  - Gỡ bỏ worktree bị hỏng:
    ```bash
    git worktree remove --force .workspaces/<jobId>
    git worktree prune
    ```
  - Xóa nhánh rác cục bộ của job:
    ```bash
    git branch -D feature/ai-worker-<jobId>
    ```

---

#### Kịch bản 4: Hàng đợi Bị Nghẽn hoặc Sập Nguồn Bất ngờ (Queue Stagnation & Rehydration)
*Dấu hiệu:* Server bị tắt đột ngột do mất điện hoặc crash process; sau khi bật lại, các job cũ bị kẹt trạng thái không chạy tiếp.

- **Bước 1: Kiểm tra Tính toàn vẹn của File Dữ liệu Trạng thái**
  - Đọc file lưu vết trạng thái `storage/queue-state.json` (nếu dùng in-memory persistence).
- **Bước 2: Rehydration & Dọn dẹp Lock**
  - Quét thư mục gốc của repo xem có tồn tại tệp `.git/index.lock` hay không.
  - Nếu có tệp `.git/index.lock` bị bỏ lại do tiến trình chết đột ngột: Di chuyển tệp `.git/index.lock` này vào thùng rác (Recycle Bin), tuyệt đối không để lại gây khóa Git.
  - Đánh dấu tất cả các job có trạng thái `RUNNING` thành `FAILED_SERVER_RESTARTED`.
- **Bước 3: Khởi động lại Server và Kiểm tra Sức khỏe**
  - Chạy lệnh kiểm tra sức khỏe hệ thống:
    ```bash
    curl -X GET http://localhost:8080/api/v1/health
    ```
  - Xác nhận 5 Runner CLI đều trả về `available: true` trước khi mở cổng nhận job mới.

---

#### Kịch bản 5: Sự cố Web UI Crash hoặc Quá tải Kết nối Streaming (Web UI Crash / Connection Spike Recovery)
*Dấu hiệu:* Giao diện Web Dashboard không phản hồi, tab trình duyệt bị đơ/lag, log không stream, máy chủ báo lỗi `ERR_INSUFFICIENT_RESOURCES` hoặc ngốn RAM/CPU do số lượng kết nối SSE/WebSocket tăng đột biến; client liên tục reconnect dồn dập.

- **Bước 1: Ngắt Kết nối & Giảm Tải Streaming (Throttle & Shed Connections)**
  - Tạm thời ngắt và giới hạn các kết nối WebSocket / SSE đang hoạt động nếu số lượng vượt quá ngưỡng an toàn:
    - Kích hoạt cơ chế đóng kết nối client cũ với mã đóng thích hợp (`1008 Policy Violation` hoặc `1013 Try Again Later`).
  - Hạn chế hoặc tạm dừng gửi luồng log chi tiết tới các client không hoạt động (idle tabs).
- **Bước 2: Cô lập và Dọn dẹp Listener Mồ côi (Listener Leak Cleanup)**
  - Kiểm tra số lượng EventListener gắn với runner EventEmitter:
    - Nếu phát hiện số listener vượt quá ngưỡng cảnh báo (`MaxListenersExceededWarning`), thực hiện `removeListener` cho các socket/client đã disconnect.
  - Xóa bộ nhớ đệm log vòng (circular ring buffer) của các job đã hoàn thành hoặc bị huỷ để thu hồi heap memory cho Node.js process.
- **Bước 3: Khôi phục Giao diện Web và Điều hướng Client**
  - Khởi động lại luồng phục vụ Static Web UI Dashboard mà không làm gián đoạn các runner CLI đang chạy nền:
    - Nếu Single Server Node.js bị crash hoàn toàn: Khởi động lại daemon, khôi phục trạng thái jobs từ storage file.
  - Yêu cầu client Web UI tải lại (hard refresh `Ctrl + F5`) để khởi tạo lại instance xterm.js và Diff2Html sạch trong trình duyệt.
  - Kiểm tra tính năng sanitization (DOMPurify) trên trình duyệt để đảm bảo không có đoạn mã độc nào trong log stream làm crash frontend render engine.

---

#### Kịch bản 6: Khắc phục Sự cố Job Kẹt Vòng lặp TESTING <-> FIXING hoặc Lạm phát Token LLM (Infinite Fixing Loop & Token Burn Containment)
*Dấu hiệu:* Job luân chuyển liên tục giữa hai trạng thái `TESTING` và `FIXING` nhiều lần; số lượng token tiêu thụ tăng vọt bất thường; thông báo cảnh báo `MAX_FIXING_RETRIES_EXCEEDED`, `BUDGET_CEILING_EXCEEDED` hoặc `ERROR_STAGNATION_DETECTED` xuất hiện trên hệ thống; hoặc job không tự dừng dù bài test liên tục thất bại.

- **Bước 1: Ngắt Dừng Khẩn cấp Job Kẹt Vòng lặp**
  - Gửi lệnh hủy bỏ tác vụ ngay lập tức thông qua REST API:
    ```bash
    curl -X POST http://localhost:8080/api/v1/jobs/{jobId}/cancel \
      -H "Content-Type: application/json" \
      -d '{"reason": "Emergency abort: Infinite fixing loop or token burn detected"}'
    ```
  - Nếu API không phản hồi, thực hiện dừng tiến trình PTY/runner tương ứng của job thông qua Process Tree Watchdog hoặc PID trực tiếp.
- **Bước 2: Phân tích & Kiểm toán Tiêu thụ Token (Token Consumption Audit)**
  - Truy xuất báo cáo chi tiết về lượng token và chi phí tích lũy của job:
    ```bash
    curl -X GET http://localhost:8080/api/v1/jobs/{jobId}/metrics
    ```
  - Kiểm tra bảng thống kê token theo từng bước (Step Pipeline Breakdown):
    - Xác định bước nào (Implementing hay Fixing) và runner nào tiêu tốn lượng token đột biến.
    - Ghi nhận mã lỗi kiểm thử và stack trace của các lần test thất bại để tìm nguyên nhân gốc rễ (Root Cause: bài test bị flaky, môi trường test thiếu dependency, hay yêu cầu nghiệp vụ mâu thuẫn).
- **Bước 3: Điều chỉnh Cấu hình An toàn & Phục hồi**
  - Nếu bài test cần thêm lượt sửa đổi hợp lệ, người dùng có thể điều chỉnh cấu hình bước hoặc tăng nhẹ `maxFixingRetries` (tối đa không quá 5) và nâng `maxJobTokens` trực tiếp trên Web UI hoặc file cấu hình `config.json`.
  - Khôi phục workspace về commit sạch trước chu kỳ fixing lỗi bằng lệnh git checkout:
    ```bash
    git checkout HEAD -- .
    ```
  - Đảm bảo Error Stagnation Circuit Breaker được bật (`circuitBreakerEnabled: true`) để ngăn chặn việc chạy lại gặp đúng vòng lặp cũ.

---

## 6. Cam kết Tuân thủ Quy chuẩn An toàn (Safety Compliance Guarantee)

Hệ thống **AI Worker Server** được cam kết tuân thủ 100% các nguyên tắc an toàn vận hành:
1. **Bảo tồn Dữ liệu:** Không bao giờ thực thi lệnh xóa vĩnh viễn dữ liệu trên hệ thống host; mọi thao tác dọn dẹp đều thông qua Thùng rác (Recycle Bin / Trash).
2. **Minh bạch Hoạt động:** Toàn bộ lệnh shell, thao tác file và tương tác LLM đều được ghi log đầy đủ, hỗ trợ truy vết nguồn gốc (audit trail).
3. **Phòng thủ Đa tầng:** Áp dụng cơ chế bảo vệ kép từ cấp độ phân tích tham số (Ingestion), cấp độ cách ly không gian làm việc (Git Worktree Sandbox), cấp độ lọc luồng dữ liệu (Secret Scrubber) cho đến bộ giám sát tiến trình hệ thống (Process Tree Watchdog).
