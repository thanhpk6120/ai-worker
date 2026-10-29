---
feature: WORKTREE-MULTI-SERVICE
service: ai-worker
status: plan-review
owner: ThanhPK
updated_at: 2026-10-28
---

# Kế hoạch Kỹ thuật (dev_plan.md) — WORKTREE-MULTI-SERVICE

## 0. Tóm tắt Kiến trúc

Feature này nâng cấp `ai-worker` từ mô hình Single-Repo/Single-Workspace sang **Polyrepo Multi-Service Concurrency Engine** với cơ chế cách ly Git Worktree theo từng task và bổ sung bước `MERGING` đơn luồng an toàn.

---

## 1. Quyết định Kiến trúc (ADRs)

### ADR-1: Không dùng file JSON tập trung làm nơi ghi dữ liệu (Three-Tier State Architecture)
- **Vấn đề:** Đa tiến trình ghi vào 1 file `worktrees.json` sẽ gây Race Condition, Lost Update và lỗi file lock trên Windows.
- **Quyết định:**
  - **Tầng 1 (Source of Truth):** SQLite (`workspace_services`, `job_worktrees`). ACID-compliant, WAL mode.
  - **Tầng 2 (Per-Task Manifest):** `.worktrees/<task-code>/.task-manifest.json`. AI chỉ đọc/ghi file này, triệt tiêu 100% đụng độ.
  - **Tầng 3 (Global Snapshot):** `worktrees/registry.json` (Read-only, do server xuất tự động phục vụ UI).

### ADR-2: Quét nhánh phát triển thực tế bằng `git rev-parse --abbrev-ref HEAD`
- **Quyết định:** Khi quét thư mục cấp 1 của workspace, nhánh phát triển mặc định của từng service được lấy trực tiếp từ nhánh đang checkout trên máy local (`git rev-parse --abbrev-ref HEAD`).
- **Lý do:** Đảm bảo chính xác với môi trường làm việc thực tế của lập trình viên, không áp đặt tên nhánh cứng nhắc (`main`/`master`/`develop`).

### ADR-3: Không kiểm tra Concurrency Slot khi mở rộng Worktree ở TESTING/FIXING
- **Quyết định:** Khi AI yêu cầu sửa thêm service trong lúc `TESTING` hoặc `FIXING`, hệ thống tạo thêm worktree và mount vào task ngay lập tức mà không kiểm tra slot concurrency của server.
- **Lý do:** Task đó **đang giữ sẵn một slot chạy** trong `runningJobs`. Việc thêm worktree cho service phụ trợ chỉ mở rộng không gian đĩa cục bộ của task, không làm tăng số lượng tiến trình độc lập của hệ thống.

### ADR-4: Bổ sung bước `MERGING` và Khóa Độc Quyền Đơn Luồng (Exclusive Dev Lock)
- **Quyết định:** Thêm bước `MERGING` giữa `VERIFY` và `DONE`.
- **Luồng:**
  1. Thử merge branch task vào `target_dev_branch` của từng service.
  2. Nếu có conflict: Kích hoạt AI giải quyết conflict trực tiếp trên repo gốc.
  3. **Bắt buộc Re-test trên repo gốc:** Phải chạy test suite của service trên nhánh phát triển để đảm bảo bản merge không làm hỏng code.
  4. **Khóa Độc Quyền (Single-threaded Mutex):** Chỉ duy nhất 1 task được phép thao tác trên repo gốc của một service tại một thời điểm trong bước `MERGING`.

### ADR-5: Luôn pull code mới nhất về trước khi thao tác trên nhánh Git (Pull-Before-Action)
- **Quyết định:** Mọi thao tác tạo worktree từ nhánh dev hoặc checkout merge trên repo gốc đều tự động chạy `pullLatestCode`.
- **Cơ chế an toàn:**
  - Nếu repo đang checkout đúng nhánh mục tiêu: chạy `git pull --ff-only origin <branch>`.
  - Nếu repo đang checkout nhánh khác: chạy `git fetch origin <branch>:<branch>` để cập nhật đúng ref local của nhánh mục tiêu mà không merge nhầm vào nhánh `HEAD` đang checkout.
- **Lý do:** Đảm bảo mã nguồn luôn đồng bộ với remote trước khi làm việc, tránh conflict hoặc gãy build do chạy trên code cũ. Bỏ qua an toàn khi offline hoặc repo local không có remote.
---

## 2. Thiết kế Cơ sở Dữ liệu (Schema Migrations)

### 2.1. Bảng `workspace_services`
```sql
CREATE TABLE IF NOT EXISTS workspace_services (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  service_key TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  dev_branch TEXT NOT NULL,
  deploy_branch TEXT,
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);
```

### 2.2. Bảng `job_worktrees`
```sql
CREATE TABLE IF NOT EXISTS job_worktrees (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  service_key TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  task_branch TEXT NOT NULL,
  base_dev_branch TEXT NOT NULL,
  base_commit TEXT,
  status TEXT DEFAULT 'ACTIVE', -- ACTIVE, MERGED, CLEANED
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
);
```

---

## 3. Thiết kế API Endpoints

### 3.1. Nhóm Quản lý Service của Workspace
- `GET /api/v1/workspaces/:id/services`: Lấy danh sách service của workspace.
- `POST /api/v1/workspaces/:id/services/scan`: Quét thư mục cấp 1, nhận diện các repo git và nhánh hiện tại.
- `POST /api/v1/workspaces/:id/services`: Thêm service thủ công vào workspace.
- `PUT /api/v1/workspaces/:id/services/:serviceId`: Cập nhật cấu hình service (sửa `dev_branch`, `deploy_branch`, `is_enabled`).
- `DELETE /api/v1/workspaces/:id/services/:serviceId`: Xóa service khỏi cấu hình workspace.

### 3.2. Nhóm Điều phối Worktree của Task
- `GET /api/v1/jobs/:id/worktrees`: Lấy danh sách worktree đang mount cho task này.
- `POST /api/v1/jobs/:id/worktrees/expand`: AI hoặc Runner gửi yêu cầu bổ sung worktree trong các bước `IMPLEMENT`, `TESTING`, `FIXING`:
  ```json
  {
    "service_key": "payment-service",
    "reason": "Phát hiện thiếu DTO khi chạy integration test"
  }
  ```
  *Response:*
  ```json
  {
    "success": true,
    "worktree_path": "D:/Projects/MyProject/.worktrees/TASK-1024/payment-service",
    "branch": "feature/TASK-1024",
    "base_branch": "release/v2"
  }
  ```

---

## 4. Tinh chỉnh State Machine & TaskQueue

### 4.1. Cập nhật `src/state/stateMachine.js`
- Bổ sung trạng thái `MERGING`:
  ```javascript
  const JOB_STATUSES = {
    // ...
    VERIFY: 'VERIFY',
    MERGING: 'MERGING',
    FIXING: 'FIXING',
    DONE: 'DONE',
    // ...
  };
  ```
- Định nghĩa luồng chuyển đổi:
  - `VERIFY` ➔ `MERGING` (khi verification đạt 100% PASS).
  - `MERGING` ➔ `DONE` (khi merge thành công, re-test PASS).
  - `MERGING` ➔ `FIXING` (khi có conflict và re-test FAIL sau khi gỡ conflict).

### 4.2. Tinh chỉnh `src/queue/taskQueue.js`
- **Khóa mịn theo Service (Fine-grained Service Locking):**
  Trong pha `IMPLEMENT` đến `VERIFY`, các task có thể chạy song song nếu không yêu cầu ghi (`write`) trên cùng một service.
- **Khóa độc quyền nhánh gốc (Exclusive Dev Lock) cho bước `MERGING`:**
  ```javascript
  // Quản lý khóa độc quyền repo gốc
  devBranchLocks = new Map(); // serviceKey -> jobId

  acquireDevLock(serviceKey, jobId) {
    if (!this.devBranchLocks.has(serviceKey)) {
      this.devBranchLocks.set(serviceKey, jobId);
      return true;
    }
    return this.devBranchLocks.get(serviceKey) === jobId;
  }

  releaseDevLock(serviceKey, jobId) {
    if (this.devBranchLocks.get(serviceKey) === jobId) {
      this.devBranchLocks.delete(serviceKey);
      this._processNext();
    }
  }
  ```

---

## 5. Kế hoạch Kiểm thử & Kịch bản Tự rà soát (Verification Plan)

| Kịch bản | Mô tả kiểm thử | Tiêu chí đạt |
|---|---|---|
| **Test 1: Auto-Scan Services** | Quét workspace giả lập có 3 repo git con với các nhánh `develop`, `feature/sprint`, `main`. | API trả về đúng 3 service với đúng tên nhánh hiện tại của từng repo. |
| **Test 2: Parallel Worktree Isolation** | Tạo 2 task chạy cùng lúc trên 2 service khác nhau (`auth` và `order`). | 2 worktree được tạo độc lập tại `.worktrees/TASK-1` và `.worktrees/TASK-2`, 2 tiến trình chạy song song không block. |
| **Test 3: Dynamic Worktree Expansion** | Task đang chạy ở `TESTING` gọi expand thêm service `payment`. | Worktree cho `payment` được tạo ngay lập tức mà không bị kẹt hay chờ slot concurrency. |
| **Test 4: Clean Merge** | Task hoàn tất không có xung đột code với nhánh dev gốc. | Code được merge tự động vào nhánh dev gốc, worktree được dọn dẹp an toàn. |
| **Test 5: Conflict Resolution & Re-test** | Cố tình tạo conflict ở nhánh dev gốc trước khi task merge. | AI phát hiện conflict, gỡ conflict, re-test chạy trên repo gốc. Re-test pass ➔ sang `DONE`. |
| **Test 6: Exclusive Dev Lock Mutual Exclusion** | 2 task cùng chạm vào bước `MERGING` trên cùng 1 service. | Task 2 bị hoãn chờ Task 1 hoàn tất re-test và nhả lock, không xảy ra xung đột `index.lock`. |
