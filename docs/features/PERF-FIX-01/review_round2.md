---
feature: PERF-FIX-01
service: ai-worker
status: plan-review
owner: AI
updated_at: 2026-10-22
---

# Rà soát lần 2 — Vấn đề còn sót ảnh hưởng hiệu năng & trải nghiệm

> Bổ sung cho [`dev_plan.md`](./dev_plan.md) · [`expect.md`](./expect.md) · [`tasks.md`](./tasks.md)
> Phân tích gốc: [`../PERF-ANALYSIS-01/report.md`](../PERF-ANALYSIS-01/report.md)
> **Ngày rà soát:** 2026-10-22 · **Commit:** `98ed9c4` (main) · **Phương pháp:** 3 lượt rà soát song song (frontend / backend / UX-a11y) + **đo đạc độc lập lại** trên instance đang chạy (PID 14400).
> **Chưa sửa code nào.** Mọi phát hiện dưới đây đã được **kiểm chứng lại bằng đo/grep**, không chỉ đọc code.

---

## 0. Tóm tắt

**Baseline vẫn đúng, và còn tệ hơn trước** (đo lại trên instance mới):

| Metric | Report gốc | Đo lại 2026-10-22 | Kết luận |
|---|---|---|---|
| `/api/v1/status` | 1,435–1,595 s | **avg 1.549 s / max 2.558 s** | ✔ xác nhận |
| `/api/v1/health` | 1,348–1,435 s | **avg 1.803 s / max 4.167 s** | ✔ **tệ hơn** |
| `/api/v1/runners` | 1,415–1,440 s | **avg 1.688 s / max 3.607 s** | ✔ xác nhận |
| 5 `/status` song song | wall 6,24 s | **wall 5.894 s** | ✔ xác nhận |
| `/api/v1/jobs` | 30,9 KB | **30,2 KB raw / 3,7 KB gzip** | ✔ xác nhận |
| `prompt` trong list | 5.283 B | **6.375 B** (37 job) | ✔ xác nhận |
| Raw sau khi bỏ `prompt` | — | **~24,0 KB** | AC A9 (< 28 KB) khả thi |
| Gzip | — | **3,7 KB** | AC A9b (< 10 KB) khả thi |

**Kết luận:** phân tích gốc đúng và còn hiệu lực. **Không có nút thắt hiệu năng lớn nào bị bỏ sót.** Nhưng rà soát phát hiện:

| Nhóm | Số lượng | Mức | Cần làm? |
|---|---|---|---|
| **Tác dụng phụ của fix đã plan** (rủi ro implement) | 4 | HIGH | ⚠️ **Bắt buộc xử lý trước khi code** |
| **Lỗi chức năng đang chạy** | 3 | HIGH/MEDIUM | ⚠️ Nên sửa |
| **UX / a11y** | 12 | MEDIUM–HIGH | 🔹 Đề xuất (P2) |
| **Perf vòng 2** (không đo được lần 1) | 3 | LOW–MEDIUM | 🔹 Tùy |

---

## 1. ⚠️ Tác dụng phụ của fix đã plan (rủi ro implement — sửa plan TRƯỚC khi code)

### 1.1 — Event delegation sẽ phá 2 hành vi phụ trên job card — **HIGH**

**Hiện trạng:** mỗi job card có **2 nút inline `onclick`**:
```
app.js:1010   onclick="event.stopPropagation(); window.aiWorker.archiveTask('${job.id}')"
app.js:1015   onclick="event.stopPropagation(); window.aiWorker.deleteTask('${job.id}')"
```

**Vấn đề khi làm T2.2 (event delegation):** listener gắn trên `#jobsListContainer` sẽ bắt **mọi** click, kể cả click nút phụ. Nếu không xử lý `stopPropagation` tương đương → **click "Xóa Task" sẽ vừa xoá task vừa chuyển sang job đang bị xoá** (2 hành vi chạy đồng thời).

**Cách sửa bắt buộc (bổ sung vào T2.1/T2.2):**
1. Chuyển 2 nút inline → `data-action="archive"` / `data-action="delete"` + `data-job-id`.
2. Handler delegation: `const btn = e.target.closest('[data-action]'); if (btn) { e.stopPropagation(); ... return; }` — **return sớm** trước logic mở job.
3. Inline `onclick` **không** dùng `replaceWith` để update được → phải dựng lại node khi `canDelete` đổi (`refs.deleteBtn.hidden = !canDelete`).

**Verify bổ sung cho T2.2:** click nút Lưu trữ → **chỉ** archive, **không** đổi job đang chọn. Click nút Xóa → **chỉ** xoá.

### 1.2 — SSE offset lệch khi chuyển sang write stream — **HIGH**

**Vấn đề:** plan T1.2 lấy offset từ `fs.statSync(path).size` **sau khi ghi**; nhưng T4.1 chuyển sang `fs.createWriteStream` → `stream.write()` là **bất đồng bộ**, dữ liệu còn nằm trong buffer userspace khi `statSync` chạy.

**Hệ quả:** `statSync().size` **nhỏ hơn** bytes thực đã ghi → `Last-Event-ID` lệch → reconnect nhận lại log cũ (duplicate) hoặc lệch ngược → **mất log**. Sai số có thể vài chục KB mỗi lần reconnect.

**Cách sửa:** offset lấy từ **counter byte tích luỹ trong chính bộ đệm** (`stream.bytesWritten`), cập nhật trong callback `stream.write(chunk, cb)`. **Không** dùng `statSync` làm nguồn offset. `statSync` chỉ dùng để phát hiện file bị truncate.

### 1.3 — Render tăng dần phải xử lý **reorder** và **node không còn khớp filter** — **HIGH**

**Hiện trạng:** `renderJobsList` (`app.js:937-1046`) luôn render theo thứ tự `state.jobs` (sort `priority DESC, created_at DESC` từ SQL). Khi dùng `Map<jobId, node>` + cập nhật tăng dần, thứ tự node trong DOM **không tự đải khi job đổi thứ tự**.

**Rủi ro:** job vừa ưu tiên cao nhưng vẫn nằm cuối danh sách → hiển thị sai thứ tự so với server.

**Cách sửa:** sau khi cập nhật nội dung, **re-append theo thứ tự** `filtered` (dùng `container.appendChild(node)` — thao tác này di chuyển node đã có, không tạo lại). Chi phí O(n) `appendChild` nhưng **không** parse HTML → vẫn rẻ hơn `innerHTML` nhiều.

**Rủi ro tương tự:** job không còn khớp filter (ví dụ chuyển `TO DO` → `ARCHIVED` khi filter `ALL`) → node phải bị **xoá khỏi DOM** (không chỉ ẩn), nếu không sẽ hiện job sai.

**Verify bổ sung cho T2.1:** đổi `priority` của 1 job → thứ tự trong list cập nhật đúng; archive 1 job khi filter `ALL` → card biến mất khỏi list.

### 1.4 — Bỏ `prompt` khỏi list payload sẽ làm **search sai** — **HIGH**

**Hiện trạng:** `app.js:965` và `app.js:1914` search bằng `(j.title || j.prompt || '')`. Nếu `prompt` chỉ còn 200 ký tự → search theo từ khóa **nằm sau ký tự 200 sẽ không ra kết quả** (hiện prompt dài 10–14 KB).

**Đã xử lý trong plan** (§2.3 của `dev_plan.md`) nhưng cần làm rõ: preview 200 ký tự **không đủ** cho search. → Phải dùng **`SUBSTR(prompt, 1, 200)` chỉ cho hiển thị**, còn search thì **không filter ở server** → cần giữ `prompt` **đầy đủ** hoặc thêm cột `prompt_search` (lowercased, đã cắt 1.000 ký tự) riêng.

**Cách sửa đề xuất:** thêm cột `prompt_search` (lowercase, 1.000 ký tự) vào bảng `jobs`, trả kèm list payload. Search dùng `prompt_search`; hiển thị dùng `title || SUBSTR(prompt,1,200)`.

**Verify bổ sung cho T3.3:** search bằng từ khóa **nằm ở giữa** prompt dài 10 KB → vẫn ra kết quả.

---

## 2. ⚠️ Lỗi chức năng đang chạy (không liên quan perf — nên sửa)

### 2.1 — UI **không bao giờ** hiện "Server Offline" — **HIGH**

```
app.js:686-690   catch (err) { state.systemStatus.online = true; renderSystemStatus(); }
```
Nhưng `renderSystemStatus` (`app.js:1846-1853`) **có** sẵn nhánh offline: dot đỏ + chữ "Server Offline".

→ Khi server chết, `fetch('/api/v1/status')` throw → catch set `online = true` → UI vẫn hiện **"Server Online" xanh nhấp nháy**. User không biết server đã chết, mọi thao tác sẽ fail im lặng.

**Cách sửa:** `catch` → `state.systemStatus.online = false` + hiện toast "Mất kết nối server" (1 lần, không spam mỗi 15 s).

### 2.2 — Poll danh sách job **nuốt lỗi im lặng** — **MEDIUM**

```
app.js:646-648   catch (e) { /* ignore in silent poll */ }
```
`fetchJobsListSilently` chạy mỗi 8 s; nếu server lỗi → danh sách **đóng băng ở trạng thái cũ**, không có bất kỳ dấu hiệu nào cho user. Đặc biệt nguy hiểm: nếu có job mới mà poll lỗi → user không thấy job đó.

**Cách sửa:** đếm số lần lỗi liên tiếp; ≥ 3 lần → hiện badge cảnh báo "Không tải được danh sách task" + nút thử lại.

### 2.3 — Lỗi API không có nút thử lại; filter rỗng không có nút xoá filter — **MEDIUM**

- `app.js:618-624`: khi `/api/v1/jobs` fail lần đầu → chỉ hiện "Không thể kết nối đến máy chủ API. Đang thử lại..." — **không có nút Retry**.
- `app.js:972-977`: filter không ra kết quả → "Không tìm thấy công việc phù phù." — **không có nút xoá filter**, user phải tự tìm ô search để xoá.

**Cách sửa:** thêm nút "Thử lại" (gọi `fetchJobsList()`) và nút "Xoá bộ lọc" (reset `statusFilter='ALL'`, `searchQuery=''`).

---

## 3. 🔹 UX / Accessibility (chưa có trong plan)

### 3.1 — **0 attribute a11y** trong toàn bộ UI — **MEDIUM–HIGH**

Đo: `grep -c "aria-\|role=\|tabindex"` trên `public/index.html`, `public/app.js`, `public/style.css` → **0 / 0 / 0**. Cũng **0** `sr-only`, **0** `focus-visible`, **0** `aria-live`.

Hệ quả cụ thể:
- **Screen reader** không đọc được trạng thái job, không biết modal nào đang mở, không nghe thay đổi trạng thái server.
- **Icon-only button** (nút lưu trữ/xoá trên card — `app.js:1010-1017`, nút evidence `app.js:1591-1597`) chỉ có `title` → screen reader đọc "button" trống.
- **Focus ring** bị xoá ở nhiều nơi → user điều hướng bằng bàn phím **không thấy** mình đang ở đâu.

**Cách sửa (tối thiểu, ~2 h):**
1. `role="dialog" aria-modal="true" aria-labelledby="..."` cho 7 modal.
2. `aria-label` cho mọi icon-only button.
3. `aria-live="polite"` cho `#systemStatusText` và `#jobsCountBadge`.
4. `:focus-visible` ring thay vì `outline: none`.
5. `aria-label` cho input (search, filter).

### 3.2 — Không có focus trap; Esc chỉ đóng 2/7 modal — **MEDIUM**

```
app.js:505-509   Escape → closeLightboxModal() + closeEvidenceDetailModal() + return
```
Còn lại: modal tạo job, settings, workspace, workspace manager, folder browser, clone task, edit task → **Esc không đóng được**, Tab thoát ra ngoài modal, focus không trả về phần tử đã bấm.

**Cách sửa:** helper `openModal(id)` / `closeModal(id)` quản lý focus trap (Tab cycle trong modal, focus trả về trigger khi đóng) + đăng ký Esc cho toàn bộ modal qua 1 listener.

### 3.3 — Sidebar **cố định** `w-80`, không ẩn trên mobile — **MEDIUM**

```
index.html:140   <aside class="w-80 md:w-88 shrink-0 ... flex flex-col h-full z-20">
```
Ở viewport 375 px, sidebar chiếm 320 px → gần hết màn hình, phần nội dung bị bóp. Evidence hub dùng `grid-cols-4` cố định → 4 tab tràn ngang.

**Cách sửa:** toggle sidebar ở `< md` (nút hamburger), evidence hub chuyển `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`.

### 3.4 — Không có cảnh báo khi job **thất bại** hoặc pipeline kết thúc — **MEDIUM**

Đo: `grep -c "Notification\|document.title\|requestPermission"` → **0**. Cũng **không có** toast khi pipeline chuyển `DONE`/`FIXING`.

User phải **canh màn hình** (hoặc mở tab) mới biết job xong/hỏng. Với job chạy 15–60 phút, đây là thiếu sót UX lớn nhất.

**Cách sửa:** (a) toast + `document.title` prefix `"(2) "` khi có job vừa kết thúc; (b) tab notification (cần user cho phép — phải hỏi, không tự bật).

### 3.5 — 9 `alert()` + 8 `confirm()` — **blocking** — **MEDIUM**

`alert()` dừng toàn bộ JS → UI đứng cho tới khi user bấm OK. Với 1 job chạy, đây là nguồn "đơ" mà không liên quan tới server.

**Cách sửa:** thay `alert()` bằng `showToast(type='error')`; `confirm()` → modal xác nhận (đã có sẵn pattern modal).

### 3.6 — Toast `success` **xoá sạch** mọi toast lỗi đang hiện — **LOW**

```
app.js:3262   container.innerHTML = '';    // trong showToast khi type==='success'
```
→ 1 thông báo thành công xoá luôn lỗi đang hiện → user mất thông tin lỗi.

**Cách sửa:** chỉ xoá toast cùng loại, hoặc giới hạn số toast (hiện **không có giới hạn** → 20 lỗi dồn sẽ chồng lên nhau).

### 3.7 — Thiếu filter theo runner / ngày / sort — **LOW**

`app.js:944` signature chỉ có `statusFilter` + `searchQuery`. Không có filter theo runner (dù `job.runner` có sẵn), không có sort tùy chọn, filter 1 chiều.

### 3.8 — Thiếu "Kanban Board" theo `AGENTS.md` §7 dòng 148 — **LOW (thay đổi phạm vi)**

`AGENTS.md` khai báo Frontend feature = "Kanban Board & Stepper Progress" nhưng UI hiện chỉ có **list + stepper**, không có Kanban. Đây là **lệch docs vs code**, không phải bug perf.

**Khuyến nghị:** ghi nhận vào `expect.md` §4 (out-of-scope của feature perf) hoặc mở ticket riêng — **không** gộp vào PERF-FIX-01.

### 3.9 — Không có phím tắt, không có command palette — **LOW**

Chỉ có Esc + ←/→ (điều hướng ảnh evidence). Không có phím tắt cho các thao tác thường (tạo job, refresh, focus search).

### 3.10 — Job detail thiếu: cảnh báo log bị cắt, thời lượng từng bước, nút tải lại — **LOW**

Sau khi T1.3 giới hạn 256 KB lịch sử, user **phải** được biết log còn N MB. Cần badge "Hiển thị 256 KB cuối / tổng 25,8 MB" + nút "Tải thêm".

### 3.11 — Contrast một số chỗ dưới 4.5:1 — **LOW**

`text-slate-500` / `text-slate-600` trên nền `surface-950` cho text nhỏ (`text-[11px]`) → dưới WCAG AA.

### 3.12 — Không highlight kết quả tìm kiếm — **LOW**

Search trả về danh sách card nhưng không highlight từ khóa.

---

## 4. 🔹 Perf vòng 2 (không đo được lần 1)

### 4.1 — `express.json({ limit: '20mb' })` — **MEDIUM**

```
server.js:261-262
```
20 MB body limit cho **mọi** request. Một client gửi nhiều request lớn liên tiếp → giữ nhiều buffer trong RAM cùng lúc. Cần hạ xuống (vd 2 MB) cho các route JSON thường, giữ 20 MB riêng cho `POST /api/v1/jobs` (prompt 10–14 KB × nhiều job).

### 4.2 — WAL file 4,1 MB, **không** có checkpoint thủ công — **LOW**

`db.js:29-31` chỉ bật WAL. Không có `wal_checkpoint(TRUNCATE)` định kỳ → WAL phình theo thời gian. Hiện 4,1 MB — chưa đáng kể, nhưng nên thêm checkpoint khi idle.

### 4.3 — `refreshEvidences` tải **toàn bộ** job detail chỉ để lấy evidence — **LOW**

```
app.js:2902-2908   fetch(`/api/v1/jobs/${jobId}`) → chỉ dùng data.evidence
```
Job detail 14–18 KB raw (1,2 KB gzip) → tải thừa ~10 KB/lần. Chỉ chạy sau khi user thao tác xoá/toggle evidence → không phải hot path. Nên thêm endpoint `GET /api/v1/jobs/:id/evidence` (đã có sẵn: đo được 4–5 ms, 6,7 KB).

### 4.4 — Job detail **không phải** nút thắt — **INFO**

Đo 12 job: raw 14,4–18,9 KB, gzip 1,1–1,6 KB, 15–58 ms. Sau khi gzip (T3.5) → không đáng kể. Không cần ưu tiên.

---

## 5. ❌ Các giả thuyết đã kiểm chứng và **loại bỏ**

| Giả thuyết | Kết quả kiểm chứng |
|---|---|
| `window.aiWorker` thiếu function → inline `onclick` ném TypeError | ❌ **Sai.** Browser xác nhận **14/14** function đã export, `missing: []`. `openEditModal` là alias hợp lệ của `openEditTaskModal` (`app.js:3944`). |
| Signature cache bỏ sót `title` → sửa title không cập nhật UI | ❌ **Sai.** `PUT /api/v1/jobs/:id` **có** bump `updated_at` (đo: `2026-10-21T02:27:25` → `2026-10-21T19:32:24`) → signature đổi → UI re-render đúng. Đã revert sạch. |
| Job detail 198 KB là nút thắt payload | ❌ **Sai.** Đo thực tế 14,4–18,9 KB raw / 1,1–1,6 KB gzip. Con số 198 KB là `transferSize` của **response đã gzip** ở lần đo trước (đọc nhầm cột). |
| SSE gửi 9 event log | ❌ **Sai.** Parse SSE chuẩn: **đúng 1 event `log` chứa 23,03 MB** (10 frame tổng). Con số 9 do đếm thường, 8 chuỗi `event: ` nằm trong nội dung log. |
| Leak listener SSE | ❌ **Sai.** `server.js:4383-4390` `removeListener` đủ 8/8 event. |

---

## 6. Đề xuất cập nhật plan

### 6.1 — Sửa ngay trong `dev_plan.md` / `tasks.md` (bắt buộc, không đổi phạm vi)

| # | Nội dung | Sửa ở đâu |
|---|---|---|
| P-1 | T2.1/T2.2: delegation phải xử lý `data-action` + `stopPropagation` tương đương | `dev_plan.md` ADR-3, `tasks.md` T2.1/T2.2 |
| P-2 | T2.1: render tăng dần phải **re-append theo thứ tự** + **xoá node** khi không còn khớp filter | `dev_plan.md` ADR-3, `tasks.md` T2.1 |
| P-3 | T1.2/T4.1: offset lấy từ `stream.bytesWritten`, **không** dùng `statSync` | `dev_plan.md` ADR-2/ADR-7, `tasks.md` T1.2/T4.1 |
| P-4 | T3.3: thêm cột `prompt_search` để **search không sai** khi preview bị cắt | `dev_plan.md` §2.3, `tasks.md` T3.3 |
| P-5 | Verify bổ sung cho T2.1/T2.2/T3.3 (3 kịch bản nêu ở §1) | `tasks.md` |

### 6.2 — Task mới (P2, ~6 h) — đề xuất, **cần user duyệt để thêm vào scope**

| Task | Nội dung | Ước lượng | Rủi ro |
|---|---|---|---|
| **T2.9** | Sửa `online = true` trong catch → `false` + toast 1 lần | 30 phút | Rất thấp |
| **T2.10** | Đếm lỗi poll liên tiếp → badge cảnh báo + nút "Thử lại" | 45 phút | Thấp |
| **T2.11** | Nút "Xoá bộ lọc" khi filter rỗng | 20 phút | Rất thấp |
| **T2.12** | Thay 9 `alert()` bằng `showToast` | 1 h | Thấp |
| **T2.13** | Giới hạn số toast đồng thời (≤ 5), không xoá toast lỗi khi có toast success | 30 phút | Thấp |
| **T2.14** | `aria-label` cho icon-only button + `aria-live` cho status | 1,5 h | Thấp |
| **T2.15** | `role="dialog"` + focus trap + Esc cho 7 modal | 2 h | **Trung bình** (cần test kỹ không kẹt focus) |
| **T3.6** | Hạ `express.json` limit + checkpoint WAL định kỳ | 45 phút | Thấp |
| | **Tổng P2** | **~8,25 h** | |

### 6.3 — Ngoài phạm vi (không gộp)

| Mục | Lý do |
|---|---|
| Kanban Board (F-08) | Lệch `AGENTS.md` §7 dòng 148 — mở ticket riêng |
| Notification API (F-01) | Cần user cho phép, phụ thuộc quyền browser |
| Filter runner/ngày/sort (F-07) | Tính năng mới, không phải fix |
| Command palette / phím tắt (F-09) | Tính năng mới |
| Highlight search (F-12) | Tính năng mới |

---

## 7. Ước lượng cập nhật

| Giai đoạn | Trước | Sau | Ghi chú |
|---|---|---|---|
| T0 | 1,75 h | 1,75 h | không đổi |
| T1 | 6 h | **6,5 h** | +0,5 h (offset chính xác qua write stream) |
| T2 | 8,5 h | **10 h** | +1,5 h (reorder + node removal + delegation an toàn) |
| T3 | 5 h | **5,75 h** | +0,75 h (cột `prompt_search`) |
| T4 | 1 h | 1 h | không đổi |
| T5 | 2 h | 2 h | không đổi |
| **Tổng fix hiện tại** | **24,25 h** | **~27 h** | +2,75 h |
| **P2 (UX/a11y) — nếu duyệt** | — | **+8,25 h** | |
| **Tổng nếu duyệt P2** | — | **~35,25 h** | |

---

## 8. Trạng thái

| Ngày | Ghi chú |
|---|---|
| 2026-10-22 | Rà soát lần 2. Baseline đo lại xác nhận phân tích gốc (tệ hơn ở `/health`: max 4,17 s). Phát hiện 4 tác dụng phụ của fix đã plan (HIGH), 3 lỗi chức năng đang chạy, 12 vấn đề UX/a11y, 3 vấn perf vòng 2. **Chưa sửa code nào.** Script đo đã vào Recycle Bin. |
