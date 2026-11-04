# ĐẶC TẢ: PORT LEASE, CHỜ PORT & XÁC MINH BUILD (RUNTIME PROVENANCE)

## 0. Mục tiêu

Chuẩn hoá cách `ai-worker` cấp port cho service đích trong bước `TESTING`/`FIXING`, đảm bảo:

1. **Không có 2 task dùng chung một service/port cùng lúc.** Task thứ hai phải **chờ**, không được cấp port khác.
2. **Không test trên bản build cũ.** Service phải được khởi động lại và phục vụ đúng mã nguồn của worktree.
3. Khi port bị chiếm quá lâu, job **tạm dừng** (không FAILED) và có cơ chế tự chạy lại hoặc cho người dùng thử lại ngay.

## 1. Port lease (`src/execution/portLeaseManager.js`)

| Khái niệm | Quy định |
|---|---|
| Pool | `FE 3010–3019`, `BE 8081–8089`, `MOCK 8090–8099`, `OTHER 8110–8119` (override `AIWORKER_PORT_POOLS`) |
| Khoá độc quyền | Mỗi `service_key` chỉ **một** lease (unique index). |
| Port ổn định | Port suy ra từ hash `service_key` ⇒ cùng service luôn cùng port giữa các lần chạy. |
| TTL / heartbeat | TTL 10 phút, heartbeat 60 giây để **không hết hạn giữa bước chạy dài**. |
| Cấp phát | Bind thử port trước khi cấp (bỏ qua port còn process rác). |
| Giải phóng | Tự động khi kết thúc step; khi job terminal thì dọn luôn service rác trong worktree. |
| Thu hồi khi restart | Boot xoá toàn bộ lease (mọi tiến trình con đã bị kill). |

### Cấu hình

| Key | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT_WAIT_TIMEOUT_MINUTES` | `60` | Thời gian chờ port tối đa trước khi tạm dừng job |
| `PORT_WAIT_TIMEOUT_MS` | `3600000` | Ưu tiên cao hơn biến phút |
| `PORT_WAIT_AUTO_RESUME` | `true` | Tự chạy lại khi port được nhả |
| `pipeline_config.port_wait_timeout_minutes` | — | Override theo từng job |

## 2. Chờ port (exclusive waiting)

```
Job A giữ service  ──► Job B: log [PORT-WAIT] mỗi 15s, UI hiện banner "đang chờ port"
Job A nhả          ──► Job B nhận đúng port cũ, chạy tiếp
Quá 60 phút        ──► Job B: PAUSED + pause_kind=PORT_WAIT
                       - backoff tự chạy lại: 1,2,4,8,16,32,64 phút (tối đa 12 lần)
                       - người dùng có thể bấm "Thử lại ngay" bất kỳ lúc nào
```

Không bao giờ tự kill job đang giữ port. Không bao giờ tự đổi sang port khác.

### Trạng thái phụ (không thêm status mới)

Khi đang chờ, job vẫn ở status hiện tại (`TESTING`/`FIXING`) nhưng SSE phát kèm:

```json
{ "waiting": true, "waiting_for": "PORT", "waiting_ms": 252000, "waiting_holders": "bankhub-admin-fe:3010 (PHUB-679)" }
```

UI chỉ cập nhật banner, **không fetch lại chi tiết job** (tránh tải payload lớn mỗi 15s).

## 3. Runtime provenance (chống test trên bản cũ)

Ba lớp:

1. **Build hash**: `HEAD` + `git status` + `git diff` + hash lockfile → 16 ký tự.
2. **Marker trong build**: worker ghi `__aiworker_build.json` (chứa hash) vào static dir của worktree (`public/`, `src/main/resources/static/`…), đồng thời thêm vào `.git/info/exclude` để không bị commit/merge. Marker nằm trong đầu vào build ⇒ muốn phục vụ marker mới thì buộc phải build lại.
3. **Verify sau bước**: gọi `GET /__aiworker_build.json` trên từng port, so hash; đồng thời kiểm tra process đang listen được sinh ra **sau** thời điểm bắt đầu bước.

| Kết quả | Ý nghĩa |
|---|---|
| `PASS` | Đúng hash + process vừa start |
| `BUILD_HASH_MISMATCH` | Service đang chạy build cũ |
| `MARKER_NOT_SERVED_NOT_REBUILT` | Chưa build lại (marker không được phục vụ) |
| `NO_LISTENER` | Không có service trên port |
| `REUSED_OLD_PROCESS` | Dùng lại instance cũ |

`RUNTIME_PROVENANCE_MODE`: `strict` (mặc định, chặn) | `warn` (chỉ log) | `off`.
Trên nền tảng không phải Windows, bước kiểm tra process bị bỏ qua và chỉ dựa vào marker hash.

## 4. Chạy lại / tiếp tục

`POST /api/v1/jobs/:id/rerun` với `{ "mode": "resume" | "restart" }`:

- `resume`: giữ plan + evidence + `fix_attempt`, chạy tiếp từ bước đang dở, cấp lại ngân sách thời gian.
- `restart`: xoá marker plan/implement + `fix_attempt`, chạy lại từ `PLANNING`.

Lỗi trả về: `409` khi job đang chạy/queued, sai trạng thái, hoặc không có AI CLI sẵn sàng (`RUNNER_UNAVAILABLE`).

## 5. Merge message

Commit merge từ nhánh task vào nhánh phát triển dùng **nội dung đã làm của task**:

- Subject: `[<TASK_CODE>] <summary hoặc title>`
- Body: nội dung `docs/features/<TASK_CODE>/report.md` (bỏ front-matter, tối đa 4000 ký tự)

## 6. Kiểm thử

| File | Nội dung |
|---|---|
| `tests/portLeaseManager.test.js` | Độc quyền, chờ, timeout, heartbeat, release, contract |
| `tests/buildProvenance.test.js` | Hash đổi theo mã nguồn, marker, mismatch, no-listener, process cũ |
| `tests/runtimeProvenanceFlow.test.js` | Luồng tích hợp: lease → marker → verify → job 2 chờ → release → nhận đúng port |
