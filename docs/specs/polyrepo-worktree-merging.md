# ĐẶC TẢ KIẾN TRÚC: POLYREPO WORKTREE CONCURRENCY & MERGING LIFECYCLE

## 0. Tổng quan & Mục tiêu

Tài liệu này đặc tả kiến trúc kỹ thuật để `ai-worker` hỗ trợ mô hình **1 dự án nhiều service (Polyrepo)**, trong đó mỗi service là một Git repository độc lập bên trong một thư mục workspace cha. 

Hệ thống cho phép:
1. **Tách Git Worktree theo từng task** để các task chạy song song hoàn toàn độc lập, không xung đột mã nguồn.
2. **Cấu hình Service Registry động theo Workspace**: Quét tự động thư mục cấp 1, nhận diện nhánh làm việc hiện tại (`dev_branch`) và nhánh triển khai (`deploy_branch`), cho phép người dùng thêm/sửa/xóa qua giao diện UI.
3. **Cấp phát Worktree động**: Bổ sung worktree cho các service phát sinh ngay tại các bước `TESTING` hoặc `FIXING` mà không cần xếp hàng slot concurrency (vì task đã giữ slot thực thi).
4. **Bổ sung bước `MERGING` vào vòng đời**:
   - Merge code từ branch task vào nhánh phát triển của từng service.
   - Nếu có conflict: AI tự động giải quyết conflict.
   - **Bắt buộc Re-test trực tiếp trên nhánh phát triển của repo gốc** dưới cơ chế **Khóa độc quyền đơn luồng (Exclusive Dev Lock)** trước khi hoàn tất task sang `DONE`.
5. **Nguyên tắc bất biến: Luôn pull code mới nhất về trước**:
   - Trước khi tạo worktree từ nhánh phát triển gốc (`baseDevBranch`): Bắt buộc pull code mới nhất về trước (`git pull origin <baseDevBranch>`).
   - Trước khi checkout và merge vào nhánh phát triển (`targetDevBranch`): Bắt buộc pull code mới nhất của nhánh phát triển về trước.
   - Khi tái sử dụng worktree: Luôn pull cập nhật nhánh task trước khi chạy agent.
---

## 1. Cấu trúc Workspace & Mô hình Composite Task Worktree

### 1.1. Cấu trúc Workspace gốc (Polyrepo)

```text
D:/Projects/MyProject/             ← Workspace root (Thư mục cha, không nhất thiết là git repo đơn)
├── docs/                          ← Git Repo: Tài liệu, spec, feature tracking (branch: main)
├── auth-service/                  ← Git Repo: Service xác thực (branch: develop)
├── order-service/                 ← Git Repo: Service đơn hàng (branch: develop)
├── payment-service/               ← Git Repo: Service thanh toán (branch: release/v2)
└── web-frontend/                  ← Git Repo: Giao diện Web (branch: main)
```

### 1.2. Thư mục ảo Composite Task Workspace (`.worktrees/`)

Mỗi khi một task được khởi tạo hoặc bắt đầu thực thi, hệ thống tạo một thư mục làm việc riêng biệt cho task:

```text
D:/Projects/MyProject/.worktrees/
├── TASK-101/                               ← Working Directory (CWD) độc lập của Task 101
│   ├── .task-manifest.json                 ← Cấu hình riêng của Task 101 (State tầng 2)
│   ├── docs/                               ← Git worktree từ ../../docs (branch: feature/TASK-101)
│   ├── order-service/                      ← Git worktree từ ../../order-service (branch: feature/TASK-101)
│   └── auth-service/                       ← [Tùy chọn] Symlink/Junction read-only về repo gốc nếu chỉ tham chiếu
│
└── TASK-102/                               ← Working Directory (CWD) độc lập của Task 102 (CHẠY SONG SONG)
    ├── .task-manifest.json
    ├── docs/                               ← Git worktree từ ../../docs (branch: feature/TASK-102)
    └── payment-service/                    ← Git worktree từ ../../payment-service (branch: feature/TASK-102)
```

### 1.3. Cơ chế Lưu trữ State: Phân cấp 3 tầng (Tuyệt đối không dùng 1 file JSON chung)

**Vấn đề của 1 file JSON chung ở root worker:**
Khi nhiều task chạy song song, việc cùng đọc/ghi vào một file `worktrees.json` chung sẽ gây ra **Race Condition**, lỗi **Lost Update** (tiến trình sau ghi đè mất dữ liệu của tiến trình trước), và lỗi `EBUSY / file locked` trên Windows.

**Mô hình 3 tầng chuẩn:**
- **Tầng 1: Source of Truth (Database SQLite `ai-worker.sqlite`)**:
  - Quản lý trạng thái lifecycle, lock hàng đợi, map task ↔ service ↔ worktree path.
  - Sử dụng chế độ WAL (`PRAGMA journal_mode = WAL; busy_timeout = 10000;`) đảm bảo tính ACID khi đa tiến trình truy cập.
- **Tầng 2: Per-Task Manifest (`.worktrees/<task-code>/.task-manifest.json`)**:
  - Đặt trực tiếp trong thư mục làm việc của từng task.
  - Model AI và Task Runner chỉ đọc/ghi vào file này của chính task đó, triệt tiêu 100% rủi ro đụng độ giữa các task.
- **Tầng 3: Global Snapshot (Read-Only Registry `worktrees/registry.json`)**:
  - Do Worker Server tự động tổng hợp và kết xuất sau mỗi sự kiện thay đổi.
  - Phục vụ Web Dashboard và CLI hiển thị trực quan; AI Model không ghi vào file này.

---

## 2. Quản lý Service Registry trong Cấu hình Workspace

### 2.1. Bảng dữ liệu SQLite: `workspace_services`

```sql
CREATE TABLE IF NOT EXISTS workspace_services (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  service_key TEXT NOT NULL,          -- Tên định danh (vd: auth-service, order-service)
  repo_path TEXT NOT NULL,            -- Đường dẫn tương đối hoặc tuyệt đối
  dev_branch TEXT NOT NULL,           -- Nhánh dùng để phát triển (vd: develop, main)
  deploy_branch TEXT,                 -- Nhánh dùng để deploy (vd: release/prod, main)
  is_enabled INTEGER DEFAULT 1,       -- Bật/tắt service trong pipeline
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);
```

### 2.2. Cơ chế Quét tự động (Auto-Scan Level 1)

Khi thêm mới hoặc bấm "Quét lại (Rescan)" một Workspace:
1. **Quét thư mục cấp 1:** Đọc các thư mục con trực tiếp bằng `fs.readdir(workspacePath, { withFileTypes: true })`.
2. **Kiểm tra Git:** Thư mục con nào chứa `.git` (thư mục `.git` hoặc file `.git` dạng worktree/submodule) được nhận diện là một Service.
3. **Nhận diện nhánh phát triển thực tế:**
   Chạy lệnh Git trực tiếp tại repo con:
   ```bash
   git -C <sub_dir_path> rev-parse --abbrev-ref HEAD
   ```
   Lệnh này trả về chính xác nhánh dev mà lập trình viên đang checkout tại máy local (ví dụ: `develop`, `sprint-24`, `main`).
4. **Nhận diện nhánh deploy (đề xuất):**
   Kiểm tra sự tồn tại của các nhánh `main`, `master`, `production`, `release/*` để gợi ý giá trị mặc định cho `deploy_branch`.
5. **Giao diện Người dùng (UI Dashboard):**
   Cung cấp bảng quản lý Service trong modal Workspace:
   - Thêm service thủ công (nếu nằm ở thư mục lồng sâu cấp 2+).
   - Sửa `dev_branch`, `deploy_branch`.
   - Bật / tắt checkbox `is_enabled` để tạm thời loại trừ service khỏi phạm vi quét của AI.
   - Xóa cấu hình service.

---

## 3. Cấp phát Worktree Động trong Vòng đời Task

### 3.1. Các kịch bản mở rộng Worktree

| Bước | Tình huống phát sinh | Hành vi của Hệ thống |
|---|---|---|
| **PLANNING** | AI đọc yêu cầu (`expect.md`) và bảng Service Registry, xác định danh sách service cần sửa ban đầu. | Tạo worktree ban đầu cho các service được chỉ định. |
| **IMPLEMENT** | AI viết mã nguồn, phát hiện cần thêm interface/DTO ở service phụ trợ. | Bổ sung worktree cho service phụ trợ ngay lập tức. |
| **TESTING** | Chạy integration test / E2E, phát hiện service thứ ba thiếu endpoint hoặc mock chưa chuẩn. | **Bổ sung worktree ngay trong lúc TESTING**, không cần kiểm tra slot concurrency chung vì task đang giữ slot. |
| **FIXING** | Sau khi `VERIFY` báo lỗi, AI sửa lỗi và phát hiện nguyên nhân gốc nằm ở service liên đới. | **Bổ sung worktree ngay trong lúc FIXING**, cập nhật code và re-test. |

### 3.2. Không kiểm tra slot Concurrency chung khi Mở rộng

- **Nguyên lý:** Task hiện tại đã được cấp 1 slot chạy (`runningJobs`) trong `TaskQueue`.
- Khi AI yêu cầu sửa thêm một service trong pha `TESTING` hoặc `FIXING`, việc tạo thêm worktree chỉ là:
  ```bash
  git -C <service_repo_path> worktree add -b feature/TASK-XXX <worktrees/TASK-XXX/service_name> <dev_branch>
  ```
- Thao tác này mở rộng không gian làm việc cục bộ của task, **không chiếm thêm slot của hệ thống**. Do đó tiến trình tiếp tục thực thi ngay mà không phải chờ đợi.

---

## 4. Vòng đời Nâng cấp & Bước `MERGING` Đơn luồng

### 4.1. Sơ đồ Chuyển đổi Trạng thái (Lifecycle State Machine)

```text
TO DO ──► PLANNING ──► IMPLEMENT ──► TESTING ──► VERIFY
                                                      │ (PASS)
                                                      ▼
                                                  [MERGING]
                                                      │
                                    ┌─────────────────┴─────────────────┐
                             (Clean Merge)                        (Có Conflict)
                                    │                                   │
                                    │                           [AI Phân giải Conflict]
                                    │                                   │
                                    │                       [BẮT BUỘC KHÓA ĐỘC QUYỀN 1 LUỒNG]
                                    │                                   │
                                    │                       [RE-TEST trên Nhánh Dev Gốc]
                                    │                                   │
                                    │                        ┌──────────┴──────────┐
                                    │                      (Pass)                (Fail)
                                    │                        │                     │
                                    ▼                        ▼                     ▼
                                  DONE                     DONE                 FIXING
```

### 4.2. Quy trình Chi tiết tại Bước `MERGING`

1. **Khởi động Merge:**
   - Với mỗi service có thay đổi trong task:
   - Đọc `target_dev_branch` từ cấu hình service (ví dụ `develop` hoặc `main`).
   - Thử nghiệm merge nhánh `feature/TASK-XXX` vào `target_dev_branch`.

2. **Trường hợp Clean Merge (Không conflict):**
   - Git tự động fast-forward hoặc tạo merge commit tự động không xung đột.
   - Nhả lock, dọn dẹp worktree của task.
   - Chuyển trạng thái sang `DONE`.

3. **Trường hợp Có Conflict (Code đụng độ):**
   - Kích hoạt AI giải quyết conflict:
     - AI đọc các conflict markers (`<<<<<<< HEAD`, `=======`, `>>>>>>>`).
     - AI phân tích ngữ cảnh 3 phía: code nhánh dev mới nhất + code tính năng mới + base commit.
     - AI chỉnh sửa code để dung hòa cả hai yêu cầu logic, xóa markers và stage file.
   - **RÀNG BUỘC KỸ THUẬT: Khóa Độc Quyền Đơn Luồng (Exclusive Dev Lock):**
     - Quá trình merge và re-test chạy **trực tiếp trên repo gốc và nhánh phát triển**.
     - Để ngăn 2 task chạy cùng lúc gây đè bẩn file, hỏng git index (`.git/index.lock`), hoặc gãy build của nhau: **Chỉ duy nhất 1 task được phép chiếm giữ repo gốc của service tại một thời điểm**.
   - **Bắt buộc Re-test trực tiếp trên Nhánh Phát Triển:**
     - Sau khi AI giải quyết conflict, bản code mới này **chưa từng được kiểm chứng**.
     - Bắt buộc kích hoạt lại bộ test suite của service trực tiếp tại repo gốc.
     - **Nếu Re-test PASS:** Hoàn tất merge commit, nhả lock độc quyền, chuyển sang `DONE`.
     - **Nếu Re-test FAIL:** 
       - Hủy merge ngay lập tức (`git merge --abort` hoặc `git reset --hard`) để bảo vệ nhánh phát triển gốc.
       - Nhả lock độc quyền.
       - Chuyển trạng thái task về lại `FIXING` bên trong worktree của nó để AI sửa lại giải pháp logic.

---

## 5. Bảng Rà soát Kỹ thuật (Self-Audit & Edge Cases)

Dưới đây là các góc khuất kỹ thuật đã được rà soát và phương án phòng ngừa tương ứng:

| STT | Rủi ro / Góc khuất kỹ thuật | Phân tích nguyên nhân | Giải pháp phòng ngừa bắt buộc |
|---|---|---|---|
| **1** | **Xung đột Git Index Lock** (`.git/index.lock`) | Nhiều tiến trình cùng gọi lệnh git trên cùng 1 repo gốc lúc merge. | Cơ chế `Exclusive Dev Lock` trong `TaskQueue`: Hàng đợi đơn luồng (Mutex) theo từng Service ở bước `MERGING`. |
| **2** | **Repo gốc không sạch (Dirty Working Tree)** trước khi Merge | Lập trình viên đang mở file sửa dở ngoài IDE ở repo gốc khi AI bắt đầu bước `MERGING`. | Trước khi checkout/merge ở repo gốc, Worker kiểm tra `git status --porcelain`. Nếu có uncommitted changes: Dừng bước merge, cảnh báo hoặc dùng `git stash` an toàn. |
| **3** | **Thiếu `node_modules` / build cache trong Worktree** | Worktree mới tạo không có `node_modules` (do nằm trong `.gitignore`), khiến test/build trong worktree bị lỗi. | Tự động tạo Directory Junction / Symlink cho `node_modules` (trên Windows dùng `mklink /J`) từ repo gốc sang worktree nếu `package.json` không đổi. |
| **4** | **Trùng cổng mạng (Port Collision) khi chạy song song** | Task 1 và Task 2 cùng khởi động service test trên port cố định (vd: 3000 hoặc 8080). | Cấp phát cổng động (`PORT=0` hoặc dãy port ngẫu nhiên theo Task ID, vd: `3000 + (jobIndex * 10)`) trong môi trường thực thi của từng worktree. |
| **5** | **Rò rỉ Worktree mồ côi (Orphan Worktrees)** | Task bị hủy (CANCELLED) hoặc crash giữa chừng, worktree không được dọn dẹp chiếm dung lượng ổ đĩa. | Watchdog cleanup khi worker khởi động hoặc khi job sang trạng thái kết thúc: Chạy `git worktree prune` và di chuyển thư mục thừa vào **Recycle Bin** theo đúng Quy tắc Tiên quyết. |
| **6** | **Xung đột tên branch** (`fatal: A branch named '...' already exists`) | Task chạy lại hoặc retry nhưng branch cũ chưa được xóa. | Kiểm tra branch trước khi tạo worktree; nếu đã tồn tại và thuộc chính task đó thì checkout lại, nếu là nhánh rác cũ thì dọn dẹp an toàn. |
| **7** | **Lỗi code cũ chưa cập nhật từ remote** | Tạo worktree hoặc merge trên phiên bản code cũ dẫn tới gãy build hoặc conflict không đáng có. | **Luôn tự động pull code mới nhất về trước** (`pullLatestCode`) trên nhánh nguồn trước khi tạo worktree và trên nhánh đích trước khi merge. Bỏ qua an toàn nếu repo local thuần túy hoặc offline. |
