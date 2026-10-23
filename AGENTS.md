# AGENTS.md — Root Project Agent Guide

## 0. File metadata [REQUIRED]

```yaml
project: ai-worker
doc_version: 1.0.0
updated_at: 2026-10-11
owner: ThanhPK
docs_repo: https://github.com/thanhpk6120/ai-worker.git
ticket_prefix: TASK
language_for_ai_replies: Vietnamese
```

---

## 1. Project overview [REQUIRED]

**ai-worker** là Hệ thống Quản lý, Điều phối & Thực thi Headless AI Agent Code với Web Dashboard Trực quan, Live Terminal, Dual Planning, Trạng thái PENDING Tương Tác (Chỉ trong Planning) & Multi-Verification Evidence Gate.

**Business goal:** Cung cấp nền tảng Single Server tập trung điều phối các AI Agent CLI (Claude Code, Antigravity CLI, OMP, Codex, OpenCode) chạy trực tiếp trên Host OS phục vụ tự động hóa chu trình phát triển phần mềm chuẩn mực.

**Main capabilities:**
- Quản lý vòng đời chuẩn hóa: `TO DO` -> `PLANNING` -> `IMPLEMENT` -> `TESTING` -> `FIXING` -> `DONE`.
- Trạng thái `PENDING` tương tác Human-in-the-Loop độc quyền tại pha `PLANNING`.
- Điều phối Child Process an toàn: cơ chế nạp prompt qua `.task_prompt.txt` UTF-8 chống tràn buffer cmd.exe trên Windows, `SecretScrubber` lọc che giấu bí mật, Watchdog Timeout và 2-Phase Safe Tree-Kill (`SIGTERM` grace period 5000ms -> `SIGKILL`).
- Live Terminal Streaming thời gian thực qua Server-Sent Events (SSE `/api/v1/jobs/:id/logs/stream`) cho giao diện `xterm.js`.
- Lập kế hoạch song song Dual Planning (`dev_plan.md` + `test_plan.md`) và cổng nghiệm thu đa kênh (`MultiVerificationGate`: UI Screenshots, API Test, Log Scan, DB Assertions).

**Customer / stakeholders:** AI Engineers, Software Implementers, Automation Testers, Technical Leads.

**Out of scope for this workspace:** Quản lý hạ tầng đám mây phân tán, Container Docker/Kubernetes (hệ thống vận hành trực tiếp trên Host OS).

---

## 2. Session start protocol [REQUIRED]

Đọc theo đúng thứ tự này **trước khi** lập kế hoạch, viết code, kiểm thử hoặc review:

1. Chạy `git pull` bên trong thư mục `docs/`.
2. File này (`AGENTS.md`).
3. `docs/README.md` — quy trình spec-driven workflow.
4. `docs/ARCHITECTURE.md` — kiến trúc hệ thống, cổng mạng, giao tiếp liên service.
5. `docs/specs/<domain>.md` — đặc tả nghiệp vụ liên quan đến task.
6. `docs/rules/<rule>.md` — quy tắc làm việc tương ứng với loại task.
7. `docs/DESIGN.md` — nếu task có thay đổi UI/UX.
8. `docs/features/<TICKET-ID>/` — nếu task gắn với ticket cụ thể.

**Không viết code trước khi hoàn thành các bước 1–6.**

---

## 3. Workspace layout [REQUIRED]

```text
D:/Thanhpk/AI/ai-worker/             ← parent folder (workspace root)
├── AGENTS.md                        ← file hướng dẫn agent gốc
├── package.json                     ← cấu hình Node.js dependencies & scripts
├── ai-worker.sqlite                 ← cơ sở dữ liệu SQLite chính
├── docs/                            ← tài liệu dự án — nguồn chân lý (source of truth)
│   ├── README.md                    ← workflow đặc tả
│   ├── ARCHITECTURE.md              ← kiến trúc tổng thể
│   ├── DESIGN.md                    ← thiết kế UI/UX
│   ├── COMMANDS.md                  ← catalog lệnh tắt
│   ├── specs/                       ← đặc tả nghiệp vụ từng domain
│   ├── rules/                       ← quy tắc vận hành AI agent
│   └── features/                    ← theo dõi theo ticket (TASK-XXXX)
├── public/                          ← giao diện Web Dashboard SPA (HTML, CSS, JS, xterm.js)
├── scripts/                         ← kịch bản kiểm thử E2E và tiện ích
│   └── verify-subprocess-pipeline.js
├── src/                             ← mã nguồn máy chủ ai-worker (Node.js CommonJS)
│   ├── server.js                    ← Express 5 HTTP REST API & SSE Server
│   ├── index.js                     ← bootstrap entry point
│   ├── config.js                    ← cấu hình cổng, timeouts, thư mục
│   ├── execution/                   ← quản lý tiến trình con, secret scrubber, timeout
│   ├── queue/                       ← TaskQueue (Priority FIFO, Concurrency)
│   ├── state/                       ← StateMachine quản lý trạng thái vòng đời
│   ├── runners/                     ← Runner Adapters (Base, Claude, Antigravity, OMP, Codex, OpenCode)
│   ├── storage/                     ← SQLite db layer (node:sqlite) & fileManager
│   └── verification/                ← MultiVerificationGate & BrowserRunner
└── tests/                           ← bộ kiểm thử tự động (node:test, node:assert)
    ├── mocks/                       ← mock-agent-cli.js
    ├── processManager.test.js
    ├── runnerRegistry.test.js
    ├── stateMachine.test.js
    ├── taskQueue.test.js
    └── verificationGate.test.js
```

**Naming rule [REQUIRED]:** Tên thư mục cục bộ là **tên canonical** dùng xuyên suốt trong tài liệu, plan, task và report: `ai-worker`. Khi có xung đột, **mã nguồn thực tế thắng** và phải ghi nhận vào `docs/ARCHITECTURE.md`.

---

## 4. Service registry [REQUIRED]

### 4.1 Canonical Service Tags
`ai-worker`, `docs`

### 4.2 Service Registry Table
|service-key (canonical)|Repo path|Git repository|Role|Runtime / port|Datastore|
|---|---|---|---|---|---|
|`ai-worker`|`./`|`https://github.com/thanhpk6120/ai-worker.git`|Single Server Orchestration, Execution & Dashboard|Node.js 22+ (Express 5) / port 3000 (hoặc dynamic)|SQLite (`ai-worker.sqlite`)|
|`docs`|`./docs`|`https://github.com/thanhpk6120/ai-worker.git`|Documentation source of truth|Markdown|—|

**Hạ tầng dùng chung:**
- Cơ sở dữ liệu: SQLite (`node:sqlite` tích hợp sẵn trong Node.js, tệp `ai-worker.sqlite`)
- Lưu trữ file/đối tượng: Local File System (`D:/Thanhpk/AI/ai-worker/`)
- Hàng đợi / Message broker: In-memory Priority FIFO `TaskQueue` với EventEmitter nội bộ
- Cache: In-memory Memory Cache
- Tích hợp chuyên biệt: Host OS Child Process CLI execution (`tree-kill`, `.task_prompt.txt`), MCP CloakBrowser cho Browser Evidence

### 4.3 Quy tắc định vị service [REQUIRED]
1. Service mục tiêu phải được **chỉ định rõ ràng** theo thứ tự ưu tiên: `plan.md` front-matter `service:` → cột `Service` trong `tasks.md` → chỉ thị trực tiếp từ người dùng. Mặc định là `ai-worker`.
2. Tuyệt đối không đoán service bằng grep/glob.
3. Chỉ thao tác trên các file thuộc `Repo path` được ánh xạ từ bảng trên.
4. Nếu chưa xác định được service: **DỪNG LẠI VÀ HỎI**.

---

## 5. Tech stack [REQUIRED]

|Service|Framework / version|Language / version|Auth|Build & run|
|---|---|---|---|---|
|`ai-worker`|Express 5.2.1, Node.js 22+|JavaScript (CommonJS)|Local / Internal API|`npm start` (`node src/index.js`)|
|`tests`|`node:test`, `node:assert/strict`|JavaScript (Node.js 22+)|—|`npm test` (`node --test tests/**/*.test.js`)|
|`pipeline-e2e`|Tích hợp sẵn trong script Node.js|JavaScript (Node.js 22+)|—|`npm run test:pipeline`|

---

## 6. Source-of-truth map [REQUIRED]

|Vấn đề cần tìm / thay đổi|Tài liệu cần đọc trước|
|---|---|
|Kiến trúc, dịch vụ, điều phối tiến trình|`docs/ARCHITECTURE.md`|
|Đặc tả chi tiết nghiệp vụ pipeline|`docs/specs/pipeline-spec.md`|
|Đặc tả giao diện Web Dashboard & Terminal|`docs/DESIGN.md`|
|Ticket hoặc tính năng cụ thể|`docs/features/<TICKET-ID>/`|
|Quy tắc vận hành của Agent|`docs/rules/*.md`|
|Danh mục lệnh tắt thực thi dự án|`docs/COMMANDS.md`|

---

## 7. Business domain map

|#|Domain|Backend module / service|Frontend feature|Spec file|
|---|---|---|---|---|
|1|Subprocess Execution & CLI Runners|`src/execution/`, `src/runners/`|Live Terminal View (`xterm.js`)|`docs/specs/execution-spec.md`|
|2|Pipeline Lifecycle & Task Queue|`src/state/`, `src/queue/`|Kanban Board & Stepper Progress|`docs/specs/pipeline-spec.md`|
|3|Dual Planning & Interactive Clarification|`src/pipeline/`, `src/execution/clarificationManager.js`|Pending Question Modal / Custom Chat|`docs/specs/planning-spec.md`|
|4|Multi-Verification Evidence Gate|`src/verification/`|Evidence Hub Tab (4 kênh)|`docs/specs/verification-spec.md`|

---

## 8. Feature workflow [REQUIRED]

### 8.1 Feature folder model

Mỗi hạng mục công việc được quản lý tại `docs/features/<TICKET-ID>/` (ví dụ `TASK-E2E-VERIFIED/`):

|File|Owner|Nội dung|
|---|---|---|
|`expect.md`|BA / User|Yêu cầu nghiệp vụ, actors, tiêu chí nghiệm thu (acceptance criteria), out-of-scope|
|`dev_plan.md`|DEV + AI|Thiết kế kỹ thuật; bắt buộc duyệt Gate 1 trước khi viết code|
|`test_plan.md`|AI + QA|Kế hoạch kiểm thử đa kênh (UI, API, Log, DB)|
|`tasks.md`|DEV + AI|Danh sách checklist công việc theo service, có cột `Service` và trạng thái|
|`report.md`|AI|Danh sách file thay đổi thực tế và kết quả kiểm thử thực tế|
|`deploy.md`|DEV|Hướng dẫn cấu hình/DB/deployment nếu có thay đổi hạ tầng|

### 8.2 Lifecycle and gates

```text
draft ──► plan-review ──► approved ──► in_progress ──► testing ──► done
                                              │
                                              └──► blocked / cancelled
```

- **Gate 1 — Plan review:** `dev_plan.md` phải được kiểm tra và duyệt trước khi viết code.
- **Gate 2 — Docs update review:** Thay đổi tại `docs/specs/` và `docs/ARCHITECTURE.md` phải được duyệt trước khi merge.

### 8.3 Front matter của tasks.md

```md
---
feature: TASK-0000
service: ai-worker
status: in_progress
owner: AI
updated_at: 2026-10-11
---
```

---

## 9. Rule index [REQUIRED]

|Rule file|Khi nào chạy|Input|Output|
|---|---|---|---|
|`docs/rules/init-docs.md`|Khởi tạo hoặc đồng bộ lại toàn bộ docs|Mã nguồn toàn bộ các service|`ARCHITECTURE.md`, `DESIGN.md`, `specs/*.md`|
|`docs/rules/create-plan.md`|Đã có `expect.md`|`expect.md` + base docs|`dev_plan.md`, `test_plan.md`, `tasks.md`|
|`docs/rules/implement-task.md`|Plan đã duyệt (Gate 1)|`tasks.md`|Code + `report.md` + `deploy.md` + docs diff|
|`docs/rules/create-testcase.md`|Sau plan, trước khi code|`expect.md`|`test_plan.md` / testcases|

---

## 10. Service quick rules [REQUIRED]

### 10.1 Layer Read Order
- **Node.js / Express (ai-worker):** `src/server.js` (routes/SSE) → `src/queue/` (TaskQueue) → `src/state/` (StateMachine) → `src/execution/` (ProcessManager) → `src/runners/` (Adapters) → `src/storage/db.js` (SQLite) → `src/config.js`
- **Dashboard Web UI:** `public/index.html` → `public/app.js` → `public/styles.css`

### 10.2 Service Quick Matrix & Verification Commands

|Service|Thứ tự đọc source code|Lệnh xác thực|Ràng buộc kỹ thuật|
|---|---|---|---|
|`ai-worker`|`server.js` → `taskQueue.js` → `stateMachine.js` → `processManager.js` → `db.js`|`npm test` & `npm run test:pipeline`|Không để lộ secret key ra log; 2-phase safe tree-kill bắt buộc; nạp prompt qua file UTF-8|

### 10.3 Deploy & release commands

|Service|Build artifact|Kịch bản / Lệnh deploy|Rollback|Hiện trạng CI/CD|
|---|---|---|---|---|
|`ai-worker`|Source code Node.js|`start-worker.bat` hoặc `npm start`|Dừng tiến trình node|Standalone Host OS Service|

---

## 11. Agent working rules [REQUIRED]

### 11.1 Project Configuration Defaults
- **DB docs path:** `docs/database/` (Schema SQLite được khởi tạo tự động trong `src/storage/db.js`).
- **Impact tool:** Git diff và source tracing theo Layer Read Order.
- **I18N requirement:** `false` (Giao diện và thông báo sử dụng tiếng Việt làm ngôn ngữ chính).
- **Integration surfaces:**
  - REST APIs (`/api/v1/jobs`, `/api/v1/workspaces`, `/api/v1/health`)
  - Server-Sent Events (`/api/v1/jobs/:id/logs/stream`)
  - Host OS Subprocess Spawn qua `ProcessManager`
  - MCP CloakBrowser integration cho Browser UI Evidence
- **Status vocabulary:** `TO DO` → `PLANNING` (`PENDING`) → `IMPLEMENT` → `TESTING` → `VERIFY` (`FIXING`) → `DONE` (`FAILED`, `CANCELLED`, `TIMED_OUT`)
- **Task format:** `checklist`

### 11.2 Phạm vi từng bước (Step Scope Control) & An toàn
- **PLANNING:** Chỉ phân tích yêu cầu & mã nguồn hiện tại, làm rõ vướng mắc (PENDING), lập `dev_plan.md` + `test_plan.md` và tự verify plan. Tuyệt đối không sửa code, không chạy test, không tạo evidence.
- **IMPLEMENT:** Chỉ sửa mã nguồn và viết/chạy unit test cho toàn bộ hàm, class, biến liên quan đến thay đổi. Tuyệt đối không tạo file trong `evidence/`.
- **TESTING:** Chạy kiểm thử theo đúng `test_plan.md` và thu thập đầy đủ evidence (ảnh màn hình, log, api json). Không cần tự verify ở bước này (mọi evidence ban đầu mang trạng thái `NOT VERIFY`).
- **VERIFY:** Chỉ verify các evidence, thực hiện verify hoàn toàn bằng AI Vision (không dùng OCR). Truyền ảnh + expect cần đạt, AI trả về JSON pass/fail cho từng ảnh. Thẩm định thành công chuyển thành `PASS`, không đạt chuyển thành `FAILED`.
- **FIXING:** Chỉ fix lỗi theo đúng báo cáo từ VERIFY, sau đó unit test đúng phần vừa fix rồi chuyển trạng thái sang `VERIFY` để đối soát lại.
- **Stepper Connectors:** Nếu luồng đã chạm vào `FIXING` (`had_fixing: 1`), đường nối stepper bắt buộc nối xuyên qua FIXING rồi mới tới DONE.
- **SystemOne Display:** Bỏ phần "SystemOne: CHƯA GỌI" của cả worker chung. Trong từng task/job nếu có sử dụng SystemOne thì hiển thị quyết định SystemOne đã chọn (ẩn khi chưa dùng). Không hiển thị "CHƯA GỌI/LIVE" ở thẻ task/job.
- Tuyệt đối không commit hoặc ghi secrets, API keys, password vào code hoặc tài liệu.
- Không chỉnh sửa file build artifact (`node_modules/`, `*.sqlite-wal`, `*.sqlite-shm`).
- **QUY TẮC TIÊN QUYẾT:** TẤT CẢ các lệnh xoá file/thư mục BẮT BUỘC phải dùng cách di chuyển nó vào thùng rác (Trash / Recycle Bin), TUYỆT ĐỐI KHÔNG ĐƯỢC xoá vĩnh viễn.
### 11.3 Quy chuẩn code
- Tuân thủ cấu trúc phân tầng Node.js CommonJS.
- Mọi file tạo mới phải ở định dạng **UTF-8 without BOM**.
- Phản hồi và comment code bằng **Vietnamese**.

---

## 12. Git rules [REQUIRED]

### 12.1 Branch convention
- Tên branch: `feature/TASK-<NUMBER>-<slug>` (ví dụ: `feature/TASK-E2E-VERIFIED`).
- Kiểm tra branch trước khi làm việc: `git status`.
- Tuyệt đối không chuyển branch khi working tree chưa sạch.

### 12.2 Commit & Push
1. `git status` để kiểm tra thay đổi.
2. Kiểm tra `git diff`.
3. Format commit message: `TASK-<NUMBER>: <mô tả ngắn gọn>` (ví dụ `TASK-E2E-VERIFIED: hoàn thiện bộ test và verify pipeline`).
4. **Agent không tự ý commit/push/merge trừ khi được người dùng yêu cầu rõ ràng.**

---

## 13. Do not modify unless explicitly requested [REQUIRED]

- `node_modules/`, `.git/`, `.idea/`, `.vscode/`
- `.env*`, `ai-worker.sqlite*` trực tiếp ngoài các thao tác qua API/db module
- Log files, caches, tạm thời

---

## 14. Quick links [REQUIRED]

- [docs/README.md](docs/README.md) — Tổng quan tài liệu
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Kiến trúc hệ thống
- [docs/DESIGN.md](docs/DESIGN.md) — Thiết kế giao diện UI/UX
- [docs/COMMANDS.md](docs/COMMANDS.md) — Catalog lệnh tắt
- [docs/features/](docs/features/) — Quản lý tickets/features
