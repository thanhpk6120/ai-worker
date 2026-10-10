# Thiết kế kỹ thuật chi tiết (plan.md)
## Feature: Create-AI-Worker — Server Quản lý & Điều phối Headless AI Agent Code

- **Feature ID:** `Create-AI-Worker`
- **Tài liệu tham chiếu:** `feature/Create-AI-Worker/expect.md`
- **Mục tiêu kỹ thuật:** Thiết kế kiến trúc Single Server chạy hoàn toàn trên JavaScript/Node.js, phục vụ đồng thời REST API, Server-Sent Events (SSE)/WebSocket và Giao diện Web UI Dashboard tích hợp tại một cổng duy nhất (`http://localhost:3000`). Hệ thống điều phối linh hoạt 5 nền tảng AI Agent CLI cốt lõi (Claude Code, OpenCode, OMP, Codex CLI, Antigravity CLI) theo mô hình Multi-Agent Pipeline. Vòng đời xử lý chuẩn hóa 100%: `TO DO` -> `PLANNING` (Dual Planning: Dev Plan & Test Plan, trạng thái `PENDING` giới hạn duy nhất tại bước này để làm rõ yêu cầu) -> `IMPLEMENT` -> `TESTING` (Khởi chạy Local Service qua Host Child Process + Multi-Verification Evidence Gate gồm 4 kênh: UiEvidenceCollector qua MCP CloakBrowser, ApiTestRunner, LogScanner, DatabaseVerifier) -> nếu chưa đạt -> `FIXING` (Handoff đầy đủ context ảnh, console errors, logs, stack trace, DB/API diff) -> `TESTING` -> nếu TẤT CẢ tiêu chí đạt -> `DONE`. Sau khi bước `PLANNING` hoàn tất và chốt kế hoạch, hệ thống chuyển sang chế độ tự hành hoàn toàn (fully autonomous execution), tuyệt đối không bao giờ rơi vào `PENDING` ở các bước sau.
- **Trạng thái:** APPROVED / SPEC-DRIVEN UPDATED
- **Phiên bản:** 5.0.0
- **Ngôn ngữ triển khai:** 100% JavaScript / Node.js (TypeScript runtime qua tsx / compiled ESM)

---

## 1. Kiến trúc tổng thể hệ thống Single Server (Single Server Architecture Blueprint)

Hệ thống được thiết kế theo mô hình **Single Server Unified Architecture** chạy trên nền tảng Node.js. Khác với các hệ sinh thái phức tạp đòi hỏi phải chạy tách biệt Backend Server và Frontend Dev Server, hệ thống này tích hợp toàn bộ các năng lực vào một tiến trình Node.js duy nhất lắng nghe trên 1 cổng mạng duy nhất:

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                   SINGLE NODE.JS SERVER INSTANCE (PORT 3000 - HTTP / WS / SSE)                   │
│                                                                                                  │
│  ┌────────────────────────────────────────────────────────┐  ┌────────────────────────────────┐  │
│  │              EMBEDDED WEB UI DASHBOARD (SPA)           │  │      REST API & REALTIME HUB   │  │
│  │  - Single Page Application (public/index.html + JS/CSS)│  │  - Express / Fastify Framework │  │
│  │  - Dual Planning View Tabs (Dev Plan & Test Plan)      │  │  - REST Endpoints (/api/v1/*)  │  │
│  │  - Stepper trạng thái: TO DO..DONE & PENDING Dialogue  │  │  - Server-Sent Events (SSE) Hub│  │
│  │  - Multi-Verification Evidence Gallery (UI/API/Log/DB) │  │  - WebSocket PTY Tunnel        │  │
│  │  - Local Service Health & Console Monitor Panel        │  │  - Static Evidence File Server │  │
│  │  - Live Terminal xterm.js (ANSI colors, stream, copy)  │  │  - Clarification REST Handler  │  │
│  └────────────────────────────────────────────────────────┘  └────────────────────────────────┘  │
│                                              │                                                   │
│                                              ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                    CORE ORCHESTRATION & STATE MACHINE ENGINE                               │  │
│  │  - SQLite Database (better-sqlite3) lưu Jobs, Steps, Dual Plans, Evidences, Questions       │  │
│  │  - Agent Registry: Quản lý 5 CLI Agents (claude-code, opencode, omp, codex-cli, antigravity)│  │
│  │  - Pipeline Router: Ánh xạ linh hoạt từng bước xử lý sang Agent cụ thể                     │  │
│  │  - ClarificationManager: Xử lý trạng thái PENDING, tạm dừng/phục hồi timeout, hỏi đáp UI   │  │
│  │  - Safe Git Worktree Manager: Cô lập môi trường làm việc, dọn dẹp bằng Thùng rác (Trash)   │  │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                              │                                                   │
│                                              ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                      MULTI-VERIFICATION EVIDENCE GATE ENGINE                               │  │
│  │  - Local Service Process Manager (Khẳng định duy nhất: Host Child Process + Healthcheck)   │  │
│  │  - UiEvidenceCollector (Khẳng định duy nhất: MCP CloakBrowser automation & screenshots)    │  │
│  │  - ApiTestRunner: HTTP status assertions & JSON payload schema validator                   │  │
│  │  - LogScanner: Phân tích file log tiến trình cục bộ tìm runtime error, stack trace         │  │
│  │  - DatabaseVerifier: Kết nối DB thực tế (PostgreSQL/MySQL/SQLite/MongoDB) xác thực dữ liệu │  │
│  │  - Multi-Channel Gatekeeper: Điều kiện tiên quyết 100% tiêu chí đạt mới cho phép DONE      │  │
│  │  - Fixing Context Handoff Pack Generator: Đóng gói đa kênh Evidence + Log + DB cho FIXING  │  │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Các nguyên tắc thiết kế bất biến (Architectural Invariants):
1. **Single Port Supremacy:** Toàn bộ hệ thống lắng nghe trên đúng 1 cổng mạng (`PORT=3000` mặc định), không chia tách cổng giữa backend API và frontend web.
2. **Standardized Technology Stacks:**
   - **Browser Automation Engine:** Khẳng định duy nhất **MCP CloakBrowser**.
   - **Local Service Manager:** Khẳng định duy nhất **Host Child Process**.
3. **Dual Planning Invariant:** Bước `PLANNING` bắt buộc sinh ra song song 2 bản kế hoạch: `DevPlan` (kế hoạch mã nguồn, kiến trúc, APIs) và `TestPlan` (kịch bản kiểm thử, dữ liệu test, các bước browser, checkpoint UI, API assert, Log assert, DB verify).
4. **Multi-Verification Evidence Gate:** Bước `TESTING` bắt buộc kiểm chứng đa kênh đồng thời:
   - 📸 **UI Screenshot Evidence**: Chụp qua MCP CloakBrowser lưu tại `feature/<feature-name>/evidence/`.
   - 🌐 **API Test Results**: Gửi HTTP requests, assert HTTP status code, validate JSON response payload.
   - 📋 **Log Verification**: Quét console & service logs tìm runtime errors, stack trace, unhandled exception.
   - 🗄️ **Database Query Verification**: Thực hiện truy vấn DB thực tế xác nhận dữ liệu đã insert/update/delete đúng nghiệp vụ.
   - Chỉ khi TẤT CẢ 4 kênh thẩm định đều thành công thì task mới được coi là `DONE`. Bất kỳ lỗi nào cũng kích hoạt `FIXING`.
5. **Human-in-the-Loop Clarification via PENDING State:** Trạng thái `PENDING` (chờ tương tác và trả lời của người dùng) **CHỈ ĐƯỢC PHÉP XẢY RA DUY NHẤT Ở BƯỚC `PLANNING`**. Khi ở bước `PLANNING`, nếu Agent khảo sát yêu cầu, kiến trúc và sinh Dual Plan nhưng cần hỏi làm rõ, hệ thống chuyển sang `PENDING`. Khi người dùng trả lời, hệ thống quay lại `PLANNING` tiếp tục. **Một khi `PLANNING` đã chốt và chuyển sang `IMPLEMENT`, hệ thống bước vào chế độ tự hành hoàn toàn (fully autonomous execution).** Tuyệt đối không cho phép chuyển sự cố sang `PENDING` từ `IMPLEMENT`, `TESTING`, hoặc `FIXING`. Nếu Agent gọi Ask Tool ở các bước sau `PLANNING`, runner sẽ tự động bypass và ép bám sát kế hoạch.
6. **Live Terminal Streaming View:** Cung cấp giao diện xterm.js truyền trực tiếp stdout/stderr terminal với mã màu ANSI, auto-scroll, sao chép log và xem raw stream.
7. **Safe Loop Breaker:** Vòng lặp `TESTING` <-> `FIXING` được kiểm soát chặt chẽ bằng tham số `maxFixingRetries` (mặc định 3 lần), tuyệt đối không lặp vô hạn.
8. **Zero Unsafe Deletion (Mandatory Prerequisite):** Mọi thao tác dọn dẹp worktree hoặc tệp tin rác bắt buộc sử dụng cơ chế di chuyển vào Thùng rác (Recycle Bin / Trash), tuyệt đối cấm xóa vĩnh viễn (`rm -rf` hoặc `fs.rmSync`).

---

## 2. Vòng đời Xử lý Job & State Machine Chuẩn hóa (State Machine & Feedback Loop)

### 2.1 Danh sách trạng thái đầy đủ của JobRecord

Hệ thống quản lý trạng thái của Job theo State Machine chuẩn mực:

| Mã trạng thái | Loại trạng thái | Ý nghĩa kỹ thuật |
|---|---|---|
| `TO DO` | Khởi tạo (Initial) | Yêu cầu đã được tiếp nhận, cấp phát định danh Job ID, tạo bản ghi trong SQLite và cấp phát thư mục Git Worktree sandbox. |
| `PLANNING` | Kế hoạch kép (Dual Planning) | AI Agent được phân công phân tích prompt và sinh song song `DevPlan` (kế hoạch code) và `TestPlan` (kịch bản kiểm thử đa kênh UI/API/Log/DB). |
| `IMPLEMENT` | Thực thi mã nguồn (Implementation) | AI Agent lập trình nhận Dev Plan, thực hiện chỉnh sửa mã nguồn, bổ sung tệp và sinh mã trong worktree sandbox. |
| `TESTING` | Kiểm thử đa kênh (Multi-Verification) | Khởi chạy Local Service qua Host Child Process, thực thi đồng thời UiEvidenceCollector (MCP CloakBrowser), ApiTestRunner, LogScanner và DatabaseVerifier. |
| `FIXING` | Sửa lỗi có ngữ cảnh (Fixing Loop) | Kích hoạt khi TESTING phát hiện bất kỳ lỗi nào từ 4 kênh thẩm định. Agent nhận `FixingContextPack` (ảnh UI, console error, stack trace, API response sai, DB diff, git diff) để sửa mã, sau đó chuyển lại `TESTING`. |
| `PENDING` | Tương tác chờ làm rõ (Clarification) | Kích hoạt DUY NHẤT từ bước `PLANNING` khi Agent gọi công cụ hỏi người dùng (Ask Tool) hoặc cần lựa chọn/phê duyệt phương án. Tạm dừng timer, chờ người dùng trả lời qua Web UI/API rồi quay lại bước `PLANNING` để hoàn thiện kế hoạch. Tuyệt đối không cho phép kích hoạt từ `IMPLEMENT`, `TESTING`, `FIXING`. |
| `DONE` | Hoàn thành xuất sắc (Completed) | Tất cả các tiêu chí kiểm thử đa kênh (UI 100% Pass, API 100% Pass, Logs sạch không lỗi, DB verified) đều thành công, hoàn tất job. |
| `FAILED` | Thất bại an toàn | Job gặp lỗi không thể khắc phục hoặc vượt quá số lần sửa tối đa (`maxFixingRetries`) trong vòng lặp `FIXING` <-> `TESTING`. Bảo toàn toàn bộ evidence và git diff để lập trình viên phân tích. |
| `CANCELLED` | Người dùng hủy | Người dùng chủ động hủy Job từ Web UI hoặc API. Tiến trình agent và local service bị dừng an toàn, worktree được đưa vào Thùng rác. |
| `TIMED_OUT` | Quá thời gian quy định | Một bước thực thi hoặc toàn bộ Job vượt quá ngưỡng thời gian tối đa cho phép (thời gian ở trạng thái `PENDING` không tính vào timeout). |

---

### 2.2 Sơ đồ Chuyển dịch Trạng thái (State Transition Diagram)

```text
 ┌─────────┐
 │  TO DO  │  (Tiếp nhận yêu cầu, cấp phát Git Worktree sandbox)
 └────┬────┘
      │
      ▼
 ┌──────────┐ ◄─────────────────────────────────────────┐
 │ PLANNING │ ──(Cần hỏi làm rõ / lựa chọn)──┐          │ (Người dùng trả lời ->
 └────┬─────┘                                │          │  Hoàn thiện Dual Plan)
      │ (Kế hoạch đã chốt ->                 ▼          │
      │  Tự hành 100%, KHÔNG PENDING)   ┌───────────┐   │
      │                                 │  PENDING  │───┘
      │                                 │ (Timer PAUSED)
      ▼                                 └───────────┘
 ┌───────────┐
 │ IMPLEMENT │  (Thực thi lập trình bám sát Dev Plan, tự động hoàn toàn)
 └────┬──────┘
      │
      ▼
 ┌───────────┐
 │  TESTING  │  (Kiểm thử tự động đa kênh)
 │  - Start Local Service (Host Child Process)
 │  - UiEvidenceCollector (MCP CloakBrowser)
 │  - ApiTestRunner (HTTP & JSON Assert)
 │  - LogScanner (Runtime Error & Stack Trace)
 │  - DatabaseVerifier (Query Assertions)
 └────┬──────┴─┬────────────────────────────────┐
      │        │                                │
 (Tất cả kênh) │ (Bất kỳ kênh nào thất bại)     │
   ĐẠT 100%    ▼                                │
      │   ┌──────────┐                          │
      │   │  FIXING  │                          │
      │   │ (Sửa mã) │ (Tự hành bám sát Plan)   │
      │   └────┬─────┘                          │
      │        │ (Hoàn tất sửa mã -> Re-test)   │
      │        └───────────────────────► Quay lại TESTING
      ▼
 ┌─────────┐
 │  DONE   │  (Hoàn tất: UI Pass + API Pass + Logs Sạch + DB Verified)
 └─────────┘
```

---

### 2.3 Điều kiện Chuyển dịch Trạng thái (State Transition Rules)

1. **`TO DO` -> `PLANNING`:**
   - Điều kiện: Cấp phát thành công worktree sandbox, khởi tạo record trong SQLite.
   - Thao tác: Kích hoạt Agent lập kế hoạch (mặc định `claude-code`).
2. **`PLANNING` -> `IMPLEMENT`:**
   - Điều kiện: Cả `DevPlan` và `TestPlan` đều đã sinh thành công, cú pháp JSON hợp lệ, được lưu vào database.
   - Thao tác: Kích hoạt Agent lập trình (mặc định `opencode` hoặc `omp`).
3. **`IMPLEMENT` -> `TESTING`:**
   - Điều kiện: Agent lập trình kết thúc phiên làm việc, mã nguồn được ghi vào worktree, git diff ghi nhận có thay đổi.
   - Thao tác: Kích hoạt bộ kiểm thử đa kênh.
4. **`TESTING` -> `DONE`:**
   - Điều kiện TIÊN QUYẾT: **TẤT CẢ** 4 tiêu chí thẩm định đều vượt qua:
     + 📸 `UiEvidenceCollector`: 100% các checkpoint chụp ảnh giao diện qua MCP CloakBrowser đều PASS.
     + 🌐 `ApiTestRunner`: 100% HTTP status code khớp kỳ vọng và JSON payload đúng schema.
     + 📋 `LogScanner`: 0 runtime error, 0 unhandled exception, 0 stack trace nguy hiểm trong log.
     + 🗄️ `DatabaseVerifier`: 100% câu truy vấn kiểm tra dữ liệu DB trả về đúng giá trị kỳ vọng.
5. **`TESTING` -> `FIXING`:**
   - Điều kiện: Có ít nhất một tiêu chí trong 4 kênh thẩm định bị thất bại VÀ số lần thử sửa `fixingRetries < maxFixingRetries`.
   - Thao tác: Tăng biến đếm `fixingRetries = fixingRetries + 1`, sinh gói `FixingContextPack` chứa toàn diện dữ liệu lỗi, kích hoạt Agent sửa lỗi.
6. **`FIXING` -> `TESTING`:**
   - Điều kiện: Agent sửa lỗi kết thúc lượt can thiệp mã nguồn.
   - Thao tác: Tái khởi động Host Child Process nếu cần, chạy lại toàn bộ quy trình kiểm thử đa kênh.
7. **Duy nhất bước `PLANNING` -> `PENDING` (Giới hạn nghiêm ngặt):**
   - **Bất biến kiến trúc (State Invariant):** Trạng thái `PENDING` **chỉ được phép kích hoạt DUY NHẤT từ bước `PLANNING`**. Các bước `IMPLEMENT`, `TESTING`, `FIXING` tuyệt đối **KHÔNG BAO GIỜ** được chuyển sang `PENDING`. Sau khi kế hoạch (`dev_plan.md` & `test_plan.md`) đã chốt, hệ thống tự hành 100%. Nếu agent gọi công cụ hỏi người dùng ở các bước sau `PLANNING`, runner sẽ tự động bypass và ép bám sát kế hoạch.
   - Điều kiện: Agent ở bước `PLANNING` gọi công cụ đặt câu hỏi (`ask_user`, `clarify_question`) hoặc gặp rẽ nhánh kiến trúc/lựa chọn thư viện cần xác nhận.
   - Thao tác:
     + Ghi nhận `QuestionPayload` vào bảng `questions` trong SQLite.
     + Chuyển trạng thái Job thành `PENDING`, lưu `previousStep = 'PLANNING'`.
     + Tạm dừng bộ đếm thời gian (Pause Job Timeout Timer).
     + Bắn sự kiện SSE `event: question_asked` tới Web UI hiển thị popup/card tương tác.
8. **`PENDING` -> Quay lại bước `PLANNING`:**
   - Điều kiện: Người dùng gửi câu trả lời qua API `POST /api/v1/jobs/{jobId}/clarify` hoặc Web UI.
   - Thao tác:
     + Lưu `AnswerPayload` vào database.
     + Đưa nội dung câu trả lời trở lại context của Agent CLI qua stdin hoặc prompt resume.
     + Phục hồi bộ đếm thời gian (Resume Timeout Timer).
     + Chuyển trạng thái Job quay lại bước `PLANNING` để tiếp tục hoàn thiện kế hoạch Dual Plan.
     + Bắn sự kiện SSE `event: question_answered` và `event: status`.
9. **`TESTING` -> `FAILED`:**
   - Điều kiện: Vẫn còn lỗi sau khi đã sử dụng hết số lần thử sửa cho phép (`fixingRetries >= maxFixingRetries`).

---

## 3. Thiết kế Cơ chế Trạng thái `PENDING` & Human-in-the-Loop Clarification

### 3.1 Khối Điều phối Làm rõ `ClarificationManager`

Khối `ClarificationManager` đóng vai trò cầu nối tương tác giữa Agent chạy headless và người dùng thông qua giao diện Web:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               CLARIFICATION MANAGER                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Question Interceptor & Event Listener                                               │
│    - Bắt sự kiện Ask Tool / Clarification Request từ Agent CLI stream                  │
│    - Chỉ chặn và kích hoạt PENDING khi currentJobStatus === 'PLANNING'                 │
│    - Ngoài PLANNING (IMPLEMENT/TESTING/FIXING): Tự động bypass với chỉ thị bám sát     │
│      dev_plan.md & test_plan.md đã duyệt, tuyệt đối không tạm dừng chờ người dùng      │
│    - Trích xuất cấu trúc: câu hỏi, danh sách lựa chọn có sẵn, cho phép nhập văn bản   │
│                                                                                        │
│ 2. State & Timer Controller                                                            │
│    - Lưu vết trạng thái hiện tại (previousStep: 'PLANNING' duy nhất)                   │
│    - Chuyển Job sang PENDING, tạm dừng Job Execution Timeout Timer                     │
│    - Lưu câu hỏi vào SQLite (QuestionRecord)                                           │
│                                                                                        │
│ 3. Realtime Notification Dispatcher                                                    │
│    - Phát sự kiện SSE: `event: question_asked` kèm QuestionPayload                     │
│    - Web UI hiển thị Dialog Popup Modal hoặc Notification Card làm rõ                  │
│                                                                                        │
│ 4. Answer Ingestion & Agent Resume                                                     │
│    - Nhận câu trả lời từ API `POST /api/v1/jobs/{id}/clarify`                          │
│    - Định dạng câu trả lời theo khuôn mẫu chuẩn cho Agent CLI                          │
│    - Khởi động lại tiến trình Agent, resume timeout timer, chuyển về bước PLANNING      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Đặc tả Schema Câu hỏi & Câu trả lời

#### QuestionPayload Schema:
```typescript
export interface QuestionOption {
  id: string;               // Mã định danh lựa chọn (ví dụ: "opt-1", "opt-postgresql")
  label: string;            // Nhãn hiển thị ngắn gọn (ví dụ: "Dùng PostgreSQL")
  description?: string;     // Giải thích chi tiết hệ quả kỹ thuật của lựa chọn
  isDefault?: boolean;      // Tùy chọn mặc định được chọn sẵn
}

export interface QuestionPayload {
  questionId: string;       // Định danh câu hỏi duy nhất (UUID)
  jobId: string;            // Khóa ngoại liên kết tới Job
  stepName: 'PLANNING';         // Duy nhất ở bước PLANNING (ngoài PLANNING tự động bypass)
  question: string;         // Nội dung câu hỏi cụ thể cần làm rõ
  contextSummary?: string;  // Tóm tắt ngắn gọn lý do vì sao Agent cần hỏi
  options: QuestionOption[]; // Danh sách các lựa chọn có sẵn (Radio / Checkbox)
  allowMultiple?: boolean;  // Cho phép chọn nhiều lựa chọn (mặc định false - Single Choice)
  allowCustomText: boolean; // Cho phép người dùng nhập văn bản chat tự do bổ sung
  createdAt: string;        // Thời điểm phát sinh câu hỏi (ISO 8601)
  status: 'AWAITING_INPUT' | 'ANSWERED' | 'EXPIRED';
}
```

#### AnswerPayload Schema:
```typescript
export interface AnswerPayload {
  questionId: string;           // Khóa ngoại tham chiếu câu hỏi
  jobId: string;                // Khóa ngoại Job
  selectedOptionIds: string[];  // Danh sách các ID lựa chọn được người dùng tích chọn
  customText?: string;          // Nội dung văn bản tùy chỉnh người dùng gõ vào
  answeredBy?: string;          // Định danh người dùng (mặc định "developer")
  answeredAt: string;           // Thời điểm phản hồi (ISO 8601)
}
```

---

## 4. Chi tiết các Khối Kiến trúc Kỹ thuật Cốt lõi

### 4.1 Quản lý Nền tảng Agent CLI (Agent Registry & CLI Drivers)

Hệ thống hỗ trợ 5 Agent CLI headless thông qua bộ adapter hướng đối tượng:
1. **Claude Code Adapter (`claude-code`):** Lệnh CLI: `claude -p "<prompt>" --output-format json` hoặc chế độ streaming.
2. **OpenCode Adapter (`opencode`):** Lệnh CLI: `opencode --headless --prompt "<prompt>"`.
3. **OMP Adapter (`omp`):** Lệnh CLI: `omp run --interactive=false --task "<prompt>"`.
4. **Codex CLI Adapter (`codex-cli`):** Lệnh CLI: `codex exec --prompt "<prompt>"`.
5. **Antigravity CLI Adapter (`antigravity-cli`):** Lệnh CLI: `antigravity run --mode headless --instruction "<prompt>"`.

---

### 4.2 Local Service Process Manager & Healthcheck Watcher (Host Child Process)

Hệ thống quản lý dịch vụ cục bộ **duy nhất thông qua Host Child Process**:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        LOCAL SERVICE PROCESS MANAGER (HOST CHILD PROCESS)              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Port Allocation & Collision Check                                                   │
│    - Tự động cấp phát cổng khả dụng kế tiếp nếu cổng mặc định bị chiếm dụng            │
│    - Inject biến môi trường PORT vào tiến trình con                                    │
│                                                                                        │
│ 2. Background Process Spawn & Log Monitor                                              │
│    - Khởi chạy bằng child_process.spawn trên môi trường máy chủ cục bộ (Host)         │
│    - Bắt stdout/stderr, đẩy vào LogScanner và xterm.js Live Terminal                   │
│                                                                                        │
│ 3. HTTP Readiness Probe Polling                                                        │
│    - Polling HTTP GET <probeUrl> mỗi 500ms cho đến khi nhận status code 200..399       │
│    - Đạt trạng thái READY trong tối đa startupTimeoutMs (mặc định 30s)                 │
│                                                                                        │
│ 4. Graceful Shutdown & Process Tree Cleanup                                            │
│    - Sử dụng tree-kill dọn sạch toàn bộ tiến trình con khi kết thúc test               │
│    - Giải phóng cổng mạng và bộ nhớ an toàn                                            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 4.3 Multi-Verification Evidence Gate Engine

Hệ thống thiết lập hàng rào thẩm định đa kênh bắt buộc tại bước `TESTING`:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                         MULTI-VERIFICATION EVIDENCE GATE ENGINE                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 📸 1. UiEvidenceCollector (Browser Engine: MCP CloakBrowser Duy nhất)                 │
│    - Điều khiển MCP CloakBrowser thực thi các hành động (click, fill, navigate...)    │
│    - Chụp ảnh màn hình Viewport / Fullpage tại mỗi Checkpoint                         │
│    - Lưu tệp: feature/<feature-name>/evidence/<timestamp>_<checkpointId>.png          │
│    - Bắt lỗi window.onerror và browser console.error                                  │
│                                                                                        │
│ 🌐 2. ApiTestRunner (HTTP & JSON Schema Verification)                                  │
│    - Gửi HTTP Request (GET, POST, PUT, DELETE) tới các endpoint của Local Service     │
│    - Assert HTTP Status Code (ví dụ: 200 OK, 201 Created)                             │
│    - Validate cấu trúc dữ liệu JSON response khớp với Schema kỳ vọng                  │
│                                                                                        │
│ 📋 3. LogScanner (Runtime Error & Stack Trace Sniffer)                                 │
│    - Phân tích toàn bộ luồng log stdout/stderr từ Host Child Process                  │
│    - Quét regex các mẫu lỗi: /Error:/, /Exception:/, /UnhandledPromiseRejection/,     │
│      /SyntaxError/, /TypeError/, /FATAL/                                              │
│    - Ghi nhận chi tiết dòng log vi phạm và stack trace kèm theo                       │
│                                                                                        │
│ 🗄️ 4. DatabaseVerifier (Direct Data Query Verification)                               │
│    - Kết nối trực tiếp tới CSDL dự án (PostgreSQL, MySQL, SQLite, MongoDB)            │
│    - Chạy truy vấn SQL / Query để xác thực dữ liệu thay đổi thực tế                   │
│    - So sánh kết quả truy vấn với kỳ vọng: record đã được insert, update đúng giá trị  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ GATE DECISION RULE:                                                                    │
│  - PASS: UiEvidence 100% PASS && ApiTest 100% PASS && LogScanner CLEAN && DB VERIFIED  │
│  - FAIL: Bất kỳ kênh nào không đạt -> Chuyển sang FIXING kèm đầy đủ bằng chứng 4 kênh │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Chi tiết 4 thành phần thẩm định:

1. **`UiEvidenceCollector` (MCP CloakBrowser Engine):**
   - Sử dụng các MCP tools: `navigate`, `click`, `fill`, `screenshot`, `wait_for_selector`, `wait_for_text`.
   - Mỗi checkpoint sinh ra tệp ảnh PNG và tệp JSON metadata mô tả ngữ cảnh kiểm thử.
2. **`ApiTestRunner`:**
   - Thực thi các bài kiểm tra API độc lập hoặc kiểm tra chuỗi dữ liệu sau khi tương tác UI.
   - Kiểm tra mã phản hồi HTTP (`expectedStatus`) và so sánh payload thực tế (`actualPayload`) với cấu trúc kỳ vọng (`expectedSchema`).
3. **`LogScanner`:**
   - Lắng nghe luồng dữ liệu log của Host Child Process từ thời điểm khởi động cho tới khi kết thúc kiểm thử.
   - Nhận diện các lỗi tiềm ẩn không hiển thị trên giao diện (ví dụ: unhandled background exceptions).
4. **`DatabaseVerifier`:**
   - Hỗ trợ kết nối thông qua các driver phổ biến (`pg`, `mysql2`, `better-sqlite3`, `mongodb`).
   - Thực thi câu lệnh truy vấn kiểm chứng (ví dụ: `SELECT status FROM jobs WHERE id = ?`).
   - Đảm bảo dữ liệu nghiệp vụ thực sự được lưu trữ bền vững, loại bỏ hiện tượng UI "mock ảo".

---

### 4.4 Multimodal Visual Verifier & Multi-Channel Gatekeeper

Khối `MultiChannelGatekeeper` tích hợp kết quả từ 4 kênh thẩm định và đưa ra phán quyết cuối cùng:

```typescript
export interface MultiVerificationResult {
  overallVerdict: 'PASS' | 'FAIL';
  uiEvidencePassed: boolean;
  apiTestsPassed: boolean;
  logsClean: boolean;
  databaseVerified: boolean;
  summary: string;
  failedComponents: string[];
}
```

---

### 4.5 Fixing Context Handoff Engine (Đóng gói Ngữ cảnh Đa Kênh)

Khi có bất kỳ tiêu chí nào thất bại, khối `FixingContextPackGenerator` tổng hợp toàn diện ngữ cảnh gửi tới Agent sửa lỗi:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        FIXING CONTEXT HANDOFF PACK (MULTI-CHANNEL)                     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Failed Channels Summary: Chỉ rõ kênh nào thất bại (UI, API, Log, hay DB)           │
│ 2. UI Evidence: Đường dẫn ảnh screenshot lỗi + Đánh giá thị giác + Console error       │
│ 3. API Failures: Danh sách HTTP endpoint sai status code hoặc sai JSON payload         │
│ 4. Log Stack Traces: Các dòng log báo lỗi runtime trích xuất từ LogScanner            │
│ 5. DB Inconsistencies: Dữ liệu thực tế trong DB không khớp với kỳ vọng                │
│ 6. Git Diff Hiện tại: Toàn bộ thay đổi mã nguồn đã thực hiện trong worktree           │
│ 7. Gợi ý khắc phục (Suggested Fix Hints) từ bộ phân tích ngữ cảnh                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Đặc tả API RESTful, Server-Sent Events (SSE) & WebSocket

### 5.1 Quản lý Vòng đời Job (`/api/v1/jobs`)

#### `POST /api/v1/jobs` — Khởi tạo Job mới
- **Request Body:**
  ```json
  {
    "featureName": "user-authentication",
    "prompt": "Xây dựng chức năng đăng nhập và lưu JWT vào cookie an toàn",
    "repositoryPath": "./",
    "baseBranch": "main",
    "pipelineConfig": {
      "stepsMapping": {
        "planning": "claude-code",
        "implement": "opencode",
        "testing": "claude-code",
        "fixing": "claude-code"
      },
      "maxFixingRetries": 3
    }
  }
  ```
- **Response `201 Created`:** Trả về đối tượng `JobRecord` với `status: "TO DO"`.

#### `GET /api/v1/jobs/{jobId}` — Xem thông tin chi tiết Job
- **Response `200 OK`:** Trả về đầy đủ thông tin Job, bao gồm trạng thái hiện tại, kế hoạch kép, danh sách bằng chứng và lịch sử sửa lỗi.

#### `GET /api/v1/jobs/{jobId}/evidence` — Lấy danh sách bằng chứng đa kênh
- **Response `200 OK`:**
  ```json
  {
    "jobId": "job-1024",
    "uiEvidences": [
      {
        "checkpointId": "chk-login-ui",
        "title": "Giao diện Form Đăng nhập",
        "fileName": "20261008_chk-login-ui.png",
        "verdict": "PASS"
      }
    ],
    "apiTestEvidences": [
      {
        "testId": "api-login-post",
        "endpoint": "/api/v1/auth/login",
        "method": "POST",
        "expectedStatus": 200,
        "actualStatus": 200,
        "verdict": "PASS"
      }
    ],
    "logEvidences": {
      "hasErrors": false,
      "scannedLines": 142,
      "errorCount": 0
    },
    "databaseEvidences": [
      {
        "query": "SELECT count(*) AS total FROM users WHERE email = 'test@example.com'",
        "expectedResult": 1,
        "actualResult": 1,
        "verdict": "PASS"
      }
    ]
  }
  ```

---

### 5.2 API Cơ chế Trạng thái PENDING & Clarification

#### `GET /api/v1/jobs/{jobId}/questions` — Lấy danh sách câu hỏi đang chờ trả lời
- **Response `200 OK`:**
  ```json
  {
    "jobId": "job-1024",
    "status": "PENDING",
    "activeQuestion": {
      "questionId": "q-8842",
      "stepName": "PLANNING",
      "question": "Bạn muốn lưu trữ session đăng nhập vào Redis hay trực tiếp vào JWT Token?",
      "contextSummary": "Dự án hiện có cấu hình Redis, nhưng yêu cầu ban đầu đề cập tới cookie an toàn.",
      "options": [
        {
          "id": "opt-jwt",
          "label": "Lưu trữ Stateless JWT trong Cookie (HttpOnly, SameSite=Strict)",
          "description": "Không cần hạ tầng Redis, triển khai nhanh và bảo mật",
          "isDefault": true
        },
        {
          "id": "opt-redis",
          "label": "Lưu Session ID vào Cookie và quản lý Session Data tại Redis",
          "description": "Thu hồi token tức thì được, cần kết nối Redis máy chủ"
        }
      ],
      "allowMultiple": false,
      "allowCustomText": true,
      "createdAt": "2026-10-08T10:15:00.000Z"
    }
  }
  ```

#### `POST /api/v1/jobs/{jobId}/answer` — Gửi câu trả lời làm rõ
- **Request Body:**
  ```json
  {
    "questionId": "q-8842",
    "selectedOptionIds": ["opt-jwt"],
    "customText": "Hãy sử dụng thời hạn token là 7 ngày kèm refresh token rotation."
  }
  ```
- **Response `200 OK`:**
  ```json
  {
    "success": true,
    "jobId": "job-1024",
    "resumedStep": "PLANNING",
    "message": "Câu trả lời đã được nạp thành công vào Agent. Tiến trình tiếp tục chạy."
  }
  ```

---

### 5.3 Realtime Streaming qua Server-Sent Events (SSE) & WebSocket

- **Endpoint SSE:** `GET /api/v1/jobs/{jobId}/events`
- **Headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`

#### Danh mục các Sự kiện SSE:
1. **`event: status`** — Cập nhật trạng thái tổng thể của Job (`PLANNING`, `IMPLEMENT`, `TESTING`, `FIXING`, `PENDING`, `DONE`).
2. **`event: question_asked`** — Bắn `QuestionPayload` khi Agent chuyển sang trạng thái `PENDING`.
3. **`event: question_answered`** — Xác nhận câu hỏi đã được trả lời và tiến trình được phục hồi.
4. **`event: service_starting`** — Khởi chạy Local Service qua Host Child Process.
5. **`event: service_ready`** — Local Service sẵn sàng trên cổng mạng chỉ định.
6. **`event: test_step_progress`** — Tiến độ thực thi kiểm thử đa kênh.
7. **`event: verification_verdict`** — Kết quả thẩm định đa kênh (UI, API, Log, DB).
8. **`event: fixing_cycle`** — Bắt đầu chu kỳ sửa lỗi trong bước `FIXING`.
9. **`event: log`** — Dòng log terminal thời gian thực có mã màu ANSI gửi tới xterm.js.
10. **`event: diff`** — Cập nhật thống kê git diff.
11. **`event: end`** — Kết thúc Job (`DONE` hoặc `FAILED`).

---

## 6. Mô hình Dữ liệu TypeScript hoàn chỉnh (Data Models & Schemas)

```typescript
export type JobStatus =
  | 'TO DO'
  | 'PLANNING'
  | 'IMPLEMENT'
  | 'TESTING'
  | 'FIXING'
  | 'PENDING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

export type AgentId =
  | 'claude-code'
  | 'opencode'
  | 'omp'
  | 'codex-cli'
  | 'antigravity-cli';

export type PipelineStepName =
  | 'planning'
  | 'implement'
  | 'testing'
  | 'fixing';

export interface StepAgentMapping {
  planning: AgentId;
  implement: AgentId;
  testing: AgentId;
  fixing: AgentId;
}

export interface AgentPipelineConfig {
  pipelineId?: string;
  name?: string;
  description?: string;
  stepsMapping: StepAgentMapping;
  maxFixingRetries: number;
  fallbackAgent?: AgentId;
  stepTimeouts?: {
    planningMs?: number;
    implementMs?: number;
    testingMs?: number;
    fixingMs?: number;
  };
}

// Model Question & Answer cho trạng thái PENDING
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface QuestionPayload {
  questionId: string;
  jobId: string;
  stepName: 'PLANNING'; // Giới hạn duy nhất ở bước PLANNING (ngoài PLANNING tự động bypass)
  question: string;
  contextSummary?: string;
  options: QuestionOption[];
  allowMultiple?: boolean;
  allowCustomText: boolean;
  createdAt: string;
  status: 'AWAITING_INPUT' | 'ANSWERED' | 'EXPIRED';
}

export interface AnswerPayload {
  questionId: string;
  jobId: string;
  selectedOptionIds: string[];
  customText?: string;
  answeredBy?: string;
  answeredAt: string;
}

// Model Kế hoạch Phát triển (DevPlan)
export interface DevPlanModule {
  moduleName: string;
  responsibility: string;
  dependencies: string[];
}

export interface DevPlanFileChange {
  filePath: string;
  purposeOrChanges: string;
  isNew: boolean;
}

export interface DevPlanApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
}

export interface DevPlan {
  planId: string;
  featureName: string;
  architectureOverview: string;
  moduleDecomposition: DevPlanModule[];
  filesToCreate: DevPlanFileChange[];
  filesToModify: DevPlanFileChange[];
  apiEndpoints: DevPlanApiEndpoint[];
  implementationSequence: Array<{
    order: number;
    title: string;
    details: string;
  }>;
}

// Model Kế hoạch Kiểm thử Đa Kênh (TestPlan)
export type BrowserActionType =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'scroll'
  | 'wait_for_selector'
  | 'wait_for_text'
  | 'press_key'
  | 'evaluate';

export interface TestStepAction {
  stepId: string;
  order: number;
  name: string;
  actionType: BrowserActionType;
  selector?: string;
  value?: string;
  timeoutMs?: number;
  description: string;
  captureScreenshotAfter?: boolean;
  screenshotCheckpointId?: string;
}

export interface ScreenshotCheckpoint {
  checkpointId: string;
  stepId: string;
  evidenceFileNamePattern: string;
  title: string;
  visualAssertionCriteria: string;
  expectedDomElements?: string[];
}

export interface ApiTestRequirement {
  testId: string;
  name: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  expectedStatus: number;
  expectedJsonSchema?: Record<string, unknown>;
}

export interface DatabaseTestRequirement {
  queryId: string;
  name: string;
  dbType: 'postgresql' | 'mysql' | 'sqlite' | 'mongodb';
  queryString: string;
  expectedResultPattern: unknown;
  description: string;
}

export interface TestPlan {
  testPlanId: string;
  featureName: string;
  testScope: string;
  serviceConfig: {
    startCommand: string;
    defaultPort: number;
    readinessProbePath: string;
    startupTimeoutMs: number;
  };
  mockDataRequirements: Array<{
    entity: string;
    mockDataJson: string;
    description: string;
  }>;
  testSteps: TestStepAction[];
  screenshotCheckpoints: ScreenshotCheckpoint[];
  apiTestRequirements: ApiTestRequirement[];
  databaseTestRequirements: DatabaseTestRequirement[];
}

// Model Bằng chứng Thẩm định Đa Kênh (Multi-Verification Evidence)
export interface UiEvidenceRecord {
  evidenceId: string;
  stepId: string;
  checkpointId: string;
  title: string;
  fileName: string;
  filePath: string;
  imageUrl: string;
  timestamp: string;
  verdict: 'PASS' | 'FAIL' | 'PENDING';
  visualAssertionCriteria: string;
  visualDiscrepancies: string[];
  browserConsoleErrors: string[];
}

export interface ApiTestResultRecord {
  testId: string;
  endpoint: string;
  method: string;
  expectedStatus: number;
  actualStatus: number;
  statusMatch: boolean;
  schemaMatch: boolean;
  actualPayload: unknown;
  verdict: 'PASS' | 'FAIL';
  errorMessage?: string;
}

export interface LogScanResultRecord {
  scannedLines: number;
  hasErrors: boolean;
  errorCount: number;
  detectedErrors: Array<{
    lineNumber: number;
    logText: string;
    errorType: string;
    stackTrace?: string;
  }>;
  verdict: 'PASS' | 'FAIL';
}

export interface DatabaseVerificationRecord {
  queryId: string;
  name: string;
  dbType: string;
  queryString: string;
  actualResult: unknown;
  expectedMatch: boolean;
  verdict: 'PASS' | 'FAIL';
  errorMessage?: string;
}

export interface MultiVerificationEvidencePack {
  jobId: string;
  timestamp: string;
  overallVerdict: 'PASS' | 'FAIL';
  uiEvidences: UiEvidenceRecord[];
  apiTestResults: ApiTestResultRecord[];
  logScanResult: LogScanResultRecord;
  databaseResults: DatabaseVerificationRecord[];
}

export interface FixingContextPack {
  jobId: string;
  featureName: string;
  fixingCycle: number;
  maxFixingCycles: number;
  failedChannels: Array<'UI' | 'API' | 'LOG' | 'DATABASE'>;
  evidencePack: MultiVerificationEvidencePack;
  terminalLogsSummary: string;
  currentGitDiff: string;
  originalDevPlanSummary: string;
  suggestedFixHints: string[];
}

export interface LocalServiceInfo {
  status: 'STOPPED' | 'STARTING' | 'PROBING' | 'READY' | 'ERROR';
  pid: number | null;
  port: number;
  url: string;
  probePath: string;
  startedAt: string | null;
  uptimeSeconds: number;
  lastLogs: string[];
}

export interface GitDiffData {
  raw: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface JobRecord {
  jobId: string;
  featureName: string;
  prompt: string;
  status: JobStatus;
  previousStepBeforePending?: 'PLANNING' | null;
  repository: {
    path: string;
    baseBranch: string;
    targetBranch: string;
    worktreePath: string | null;
  };
  pipelineConfig: AgentPipelineConfig;
  currentStep: {
    name: PipelineStepName;
    assignedAgent: AgentId;
    stepIndex: number;
  } | null;
  activeQuestion: QuestionPayload | null;
  questionHistory: Array<{ question: QuestionPayload; answer: AnswerPayload }>;
  devPlan: DevPlan | null;
  testPlan: TestPlan | null;
  localService: LocalServiceInfo | null;
  multiVerificationEvidence: MultiVerificationEvidencePack | null;
  fixingRetries: number;
  maxFixingRetries: number;
  lastFixingContext: FixingContextPack | null;
  gitDiff: GitDiffData | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
```

---

## 7. Thiết kế Chi tiết Giao diện Web UI Dashboard (Frontend Components)

Giao diện Web UI Dashboard được nhúng trực tiếp vào Single Server (`public/index.html`) hỗ trợ toàn diện các yêu cầu kỹ thuật mới:

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                             WEB UI DASHBOARD INTEGRATED LAYOUT                                   │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ HEADER: Logo AI Worker | Active Job Status Badge [PENDING] | Port: 3000 | New Job Button         │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ VISUAL TIMELINE STEPPER:                                                                         │
│   [ TO DO ] ──► [ PLANNING ] ────────────► [ IMPLEMENT ] ──► [ TESTING ] ◄──► [ FIXING ] ──► [ DONE ] │
│                   ▲      │                                                                       │
│     (Submit/Resume)│      │ (Cần làm rõ)                                                          │
│                   └──────┴────────► [ PENDING: Human Input ] (Chỉ ở bước PLANNING)               │
├────────────────────────────────────────────────────────────────┬─────────────────────────────────┤
│ KHỐI TRÁI: DUAL PLANNING & LIVE TERMINAL                       │ KHỐI PHẢI: MULTI-VERIFICATION   │
│                                                                │            & LOCAL SERVICE      │
│ [Tab 1: Dev Plan] [Tab 2: Test Plan] [Tab 3: Live Terminal]    │                                 │
│ ┌────────────────────────────────────────────────────────────┐ │ ┌─────────────────────────────┐ │
│ │ LIVE TERMINAL STREAMING VIEW (xterm.js):                   │ │ │ LOCAL SERVICE STATUS:       │ │
│ │ - ANSI color codes support (\u001b[32m, \u001b[31m...)     │ │ │ URL: http://localhost:3000  │ │
│ │ - Auto-scroll theo luồng log thời gian thực                │ │ │ Status: [ READY (Health OK)]│ │
│ │ - Khả năng bôi đen copy text & nút xem raw stdout/stderr   │ │ └─────────────────────────────┘ │
│ └────────────────────────────────────────────────────────────┘ │                                 │
│                                                                │ MULTI-VERIFICATION GATE TABS:   │
│ ┌────────────────────────────────────────────────────────────┐ │ [📸 UI] [🌐 API] [📋 Log] [🗄️ DB] │
│ │ PENDING INTERACTION CARD (Khi Agent ở bước PLANNING cần hỏi làm rõ): │ │
│ │ ❓ Câu hỏi: Bạn muốn lưu session ở đâu?                    │ │ │ [UI Photo 1] │ [UI Photo 2] │ │
│ │ (•) Stateless JWT Cookie (Khuyên dùng)                     │ │ │ Pass: PASS   │ Pass: PASS   │ │
│ │ ( ) Redis Session Store                                    │ │ ├──────────────┴──────────────┤ │
│ │ [ Nhập trả lời bổ sung...                                ] │ │ │ API Results: 5/5 PASSED    │ │
│ │ [ Nút: Gửi Trả Lời & Tiếp Tục Chạy ]                       │ │ │ Service Logs: CLEAN (0 err) │ │
│ └────────────────────────────────────────────────────────────┘ │ │ DB Assert: 2/2 VERIFIED     │ │
│                                                                │ └─────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┴─────────────────────────────────┘
```

### 7.1 Thành phần Giao diện Trạng thái PENDING & Clarification
- Khi trạng thái là `PENDING`, Web UI kích hoạt **Clarification Modal Dialog** nổi bật hoặc **Pending Action Card**:
  - Tiêu đề câu hỏi rõ ràng, có ngữ cảnh tóm tắt tại sao Agent cần hỏi.
  - Danh sách các tùy chọn có sẵn (Radio Buttons cho lựa chọn đơn, Checkboxes cho đa lựa chọn).
  - Khung văn bản (Textarea) để người dùng gõ thêm chỉ dẫn chi tiết nếu muốn.
  - Nút bấm `Xác nhận & Tiếp tục` gửi payload đến `POST /api/v1/jobs/{id}/answer`, tự động đóng dialog và hiển thị trạng thái chuyển tiếp mượt mà.

### 7.2 Thành phần Live Terminal Streaming View (xterm.js)
- Tích hợp thư viện `xterm.js` và `xterm-addon-fit`.
- Hiển thị đầy đủ mã màu ANSI từ luồng stdout/stderr của cả Agent CLI và Local Service.
- Tự động cuộn xuống dưới cùng khi có dòng log mới (Auto-scroll), có nút tạm dừng cuộn để người dùng đọc log cũ.
- Hỗ trợ sao chép text chuẩn xác và nút chuyển đổi sang chế độ xem raw text.

### 7.3 Thành phần Multi-Verification Evidence Inspector
- Tab chuyển đổi 4 kênh kiểm chứng:
  1. **Tab UI Evidence:** Grid ảnh chụp màn hình MCP CloakBrowser, nhấp vào xem phóng to Lightbox kèm console error.
  2. **Tab API Test:** Bảng danh sách các request HTTP kèm status code mong đợi vs thực tế và JSON response viewer.
  3. **Tab Service Log:** Hiển thị kết quả quét log, tô đỏ các dòng có chứa lỗi hoặc exception.
  4. **Tab Database Verification:** Hiển thị câu query SQL/MongoDB, kết quả trả về và so khớp dữ liệu.

---

## 8. Chiến lược Xử lý Sự cố, Ma trận An toàn & Thu dọn Thùng rác (Safety Matrix)

| Tình huống sự cố | Dấu hiệu nhận biết | Giải pháp kỹ thuật xử lý tự động |
|---|---|---|
| **Vòng lặp sửa lỗi vô hạn** | Test kiểm thử liên tục fail, bước `FIXING` lặp lại nhiều lần. | Cơ chế đếm `fixingRetries`. Nếu chạm ngưỡng `maxFixingRetries` (mặc định 3 lần), dừng ngay lập tức, chuyển `FAILED`, bảo toàn ảnh evidence và git diff để lập trình viên phân tích. |
| **Local Service không khởi động được** | Healthcheck probe `GET /` hoặc `/health` bị timeout sau 30 giây. | Gửi `SIGTERM` dọn dẹp tiến trình Host Child Process, trích xuất stdout log lỗi qua LogScanner, chuyển ngay sang bước `FIXING` kèm log crash của máy chủ. |
| **Xung đột cổng mạng (Port Conflict)** | Cổng mặc định 3000 hoặc 5173 đã bị chiếm dụng bởi tiến trình khác trên máy. | Port Allocation tự động quét cổng khả dụng tiếp theo (ví dụ: 3001, 5174), inject biến môi trường `PORT` vào Host Child Process và cập nhật URL cho UiEvidenceCollector và ApiTestRunner. |
| **Agent cần làm rõ câu hỏi nhưng bị treo** | Agent phát sinh câu hỏi trong quá trình chạy mà không có terminal tương tác. | Nếu ở bước `PLANNING`: ClarificationManager bắt event Ask Tool, chuyển ngay sang `PENDING`, ngắt timeout, hiển thị câu hỏi lên Web UI chờ người dùng trả lời. Nếu ở các bước ngoài `PLANNING` (`IMPLEMENT`/`TESTING`/`FIXING`): Runner tự động bypass với chỉ thị bám sát kế hoạch `dev_plan.md` và `test_plan.md` đã duyệt, không tạm dừng chờ người dùng. |
| **Dọn dẹp tệp tin rác & Sandbox Worktree** | Hoàn thành, hủy hoặc thất bại Job cần giải phóng dung lượng đĩa. | **BẮT BUỘC** sử dụng thư viện `trash` để di chuyển thư mục tạm hoặc tệp rác vào Recycle Bin / Trash hệ điều hành. **TUYỆT ĐỐI CẤM** dùng `rm -rf` hoặc `fs.rmSync`. |
| **Agent CLI bị tắt hoặc thiếu binary** | Agent được chỉ định trong pipeline có trạng thái `enabled: false` hoặc không tìm thấy binary trong PATH. | Pipeline Router tự động chuyển giao bước đó sang `fallbackAgent` (mặc định Claude Code) và ghi chú cảnh báo trong event log. |

---

## 9. Kế hoạch Triển khai Kỹ thuật theo Giai đoạn (Implementation Roadmap)

### Giai đoạn 1: Core Engine, Single Server & Agent Registry
- Khởi tạo project Node.js / Express, thiết lập cấu trúc mã nguồn TypeScript và SQLite persistence (`better-sqlite3`).
- Xây dựng Agent Registry hỗ trợ bật/tắt và kiểm tra binary cho cả 5 AI Agent CLI.
- Triển khai Sandbox Git Worktree Manager với cơ chế dọn dẹp an toàn chuyển vào Thùng rác (Trash only).

### Giai đoạn 2: Dual Planning Engine & State Machine Mở rộng
- Xây dựng `DualPlanningEngine` sinh song song `DevPlan` và `TestPlan` trong bước `PLANNING`.
- Cấu hình State Machine đầy đủ: `TO DO` -> `PLANNING` (hỗ trợ `PENDING` duy nhất ở bước này) -> `IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE` (tự hành hoàn toàn, không `PENDING`).
- Triển khai `ClarificationManager` xử lý câu hỏi, tạm dừng timer và tích hợp API `GET /questions`, `POST /answer`.

### Giai đoạn 3: Host Child Process & Multi-Verification Evidence Gate
- Xây dựng `LocalServiceProcessManager` quản lý Host Child Process, port allocation và HTTP healthcheck.
- Xây dựng `UiEvidenceCollector` điều khiển duy nhất MCP CloakBrowser thực thi các action và chụp ảnh screenshot kèm metadata JSON.
- Xây dựng `ApiTestRunner`, `LogScanner` và `DatabaseVerifier` tạo thành bộ tứ thẩm định nghiệm thu.

### Giai đoạn 4: Multi-Channel Gatekeeper & Fixing Context Handoff Engine
- Triển khai `MultiChannelGatekeeper` kiểm tra điều kiện tiên quyết 100% 4 kênh đạt mới cho phép chuyển `DONE`.
- Triển khai `FixingContextPackGenerator` đóng gói toàn bộ context đa kênh chuyển cho Fixing Agent.

### Giai đoạn 5: REST API, SSE Realtime Hub & Web UI Dashboard
- Hoàn thiện toàn bộ các endpoint `/api/v1/jobs`, `/api/v1/jobs/{jobId}/questions`, `/api/v1/jobs/{jobId}/evidence`.
- Xây dựng giao diện Web UI Dashboard tích hợp tại `public/`:
  - Visual Timeline Stepper hỗ trợ trạng thái `PENDING` (chỉ rẽ nhánh tại `PLANNING`).
  - Clarification Popup & Action Card trả lời câu hỏi.
  - Live Terminal xterm.js hiển thị màu sắc ANSI và auto-scroll.
  - Multi-Verification Evidence Tabs (UI, API, Log, DB).

### Giai đoạn 6: Kiểm thử Toàn diện & Nghiệm thu
- Kịch bản 1 (Happy Path): Chạy trơn tru từ TO DO đến DONE với đầy đủ bằng chứng 4 kênh đạt 100%.
- Kịch bản 2 (Human Clarification): Kích hoạt `PENDING` duy nhất tại bước `PLANNING` -> Người dùng trả lời qua Web UI -> Hoàn thiện kế hoạch -> Chuyển sang `IMPLEMENT` tự hành hoàn toàn đến `DONE`.
- Kịch bản 3 (Multi-Channel Failure & Fixing): Giả lập lỗi API và UI -> Gatekeeper chặn chuyển DONE -> Chuyển FIXING với gói ngữ cảnh đa kênh -> Sửa thành công -> Re-test ĐẠT -> DONE.
