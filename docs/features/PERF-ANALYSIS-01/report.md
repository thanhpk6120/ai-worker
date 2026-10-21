# Báo cáo Phân tích Hiệu Năng Giao Diện Web — `ai-worker`

> **Ngày:** 2026-10-21 · **Commit khảo sát:** `acd6af8` (main) · **Phạm vi:** `public/` + `src/` · **Báo cáo được commit tại:** `4269b63`
> **Phương pháp:** đọc mã nguồn tĩnh + **đo đạc thực tế** trên instance đang chạy (PID 23624, port 3000) bằng HTTP client, Node script, và Chrome DevTools Protocol qua CloakBrowser.
> **Trạng thái:** CHỈ PHÂN TÍCH — **không sửa file source nào của dự án**. Xem mục §8.1: quá trình đo có ghi 200 dòng thử nghiệm vào 1 file log thật, **đã được khôi phục và verify sạch**.

---

## 0. Kết luận điều hành (Executive Summary)

**Nguyên nhân UI chậm/lag KHÔNG phải do ngôn ngữ runtime. Nó là do 3 quyết định kiến trúc cụ thể, đo được được:**

| # | Nguyên nhân | Bằng chứng đo được | Sửa được bằng |
|---|---|---|---|
| **1** | `runnerRegistry.detectAll()` gọi **10 `spawnSync` blocking** trong mỗi request `/status`, `/health`, `/runners` | `/api/v1/status` = **1.435–1.595 s**; block **toàn bộ event loop**; mọi request khác (kể cả SSE, `/jobs`) phải xếp hàng | Cache TTL 60 s + `spawn` async |
| **2** | SSE `/logs/stream` đọc **đồng bộ toàn bộ file log** rồi gửi **1 event `log` duy nhất** chứa toàn bộ nội dung (file lớn nhất **25,8 MB** → payload **23,03 MB**) | `readFileSync` 25,8 MB = **178 ms** server; phía browser: **2 long task 393 ms + 545 ms**; xử lý text 22,3 MB = **843 ms**; `JSON.stringify` payload = **163 ms** | Đọc chunk có offset + `Last-Event-ID`, giới hạn bytes |
| **3** *(phụ)* | Frontend render lại **toàn bộ danh sách job bằng `innerHTML`** mỗi 8 s + gọi `loadPlanFiles` mỗi SSE event | **Đo được:** render lại toàn bộ list = **11,76 ms/lần** (kể cả forced layout) × 7,5 lần/phút ≈ **88 ms/phút**. **Ước lượng (chưa đo):** `loadPlanFiles` sinh thêm ~20–40 HTTP + ~30–60 `marked.parse`/phút | Render tăng dần (0,02 ms/lần) + cache/dedupe `loadPlanFiles` |

> **Phân bổ vai trò — đo thay vì suy đoán:** nguyên nhân **#1 là nguyên nhân chính** (đứng yên 1,3 s mỗi 15 s, ảnh hưởng *mọi* thao tác của người dùng) và **#2 là nguyên nhân gây freeze cục bộ** (1,9 s khi mở job có log lớn). Nguyên nhân **#3 là phụ** — chi phí mỗi lần render đo được chỉ 11,76 ms; các con số tần suất render/phút, HTTP/phút, `marked.parse`/phút trong báo cáo đều là **ước lượng từ phân tích tĩnh mã nguồn, chưa đo trực tiếp** (xem §4.2–4.3).

**Quyết định về ngôn ngữ: KHÔNG chuyển.** Chi tiết ở §5 — đã benchmark Node vs Python trên chính máy này: ở nút thắt subprocess, Python **nhanh hơn ở bản blocking** (1.109 ms vs 1.392 ms) nhưng **ngang bằng khi dùng async** (336 ms vs 365 ms); ở SQLite, Python **chậm hơn** (0,55 ms vs 0,49 ms/lần). Vấn đề là *blocking*, không phải ngôn ngữ — nên đổi ngôn ngữ **không mang lại lợi ích hiệu năng** mà chi phí chuyển đổi rất lớn.

**Ước lượng (thứ tự ưu tiên theo tác động đo được):** sửa **#1** → **#2** → **#3** để đạt **TTFB mọi endpoint < 50 ms**, **UI không còn freeze > 400 ms**. Riêng #1 + #2 (~7,25 giờ) đã xử lý được phần lớn cảm nhận "lag"; #3 (~8,5 giờ) là tối ưu bổ sung. Tổng công sức **~15,75 giờ** (chi tiết §6). Không cần đổi ngôn ngữ.

---

## 1. Số đo baseline (đo trên instance đang chạy)

### 1.1 Latency API

| Endpoint | Thời gian | Payload | Ghi chú |
|---|---|---|---|
| `GET /api/v1/status` | **1.435 – 1.595 s** | 1,4 KB | ⛔ blocking |
| `GET /api/v1/health` | **1.348 – 1.435 s** | 1,4 KB | ⛔ blocking (cùng handler) |
| `GET /api/v1/runners` | **1.415 – 1.440 s** | 958 B | ⛔ blocking (cùng handler) |
| `GET /api/v1/jobs` | 3 – 6 ms (bình thường) | 30,9 KB | nhưng **1.417 s** nếu rơi vào cửa sổ block |
| `GET /api/v1/jobs/:id` | 5 – 20 ms | 14–198 KB | |
| `GET /api/v1/jobs/:id/evidence` | 4 – 5 ms | 6,7 KB | |
| `GET /api/v1/workspaces` | 1,6 – 2,3 ms | 839 B | |

**Bằng chứng block event loop** (5 request `/status` song song):
```
wall: 6235,8 ms   per-request: [2535, 1236, 3768, 4998, 6233] ms
```
Các request xếp hàng **tuần tự**, mỗi cái 1,2–6,2 s → xác nhận single-threaded blocking, không phải I/O bound.

**Ảnh hưởng tới UI thật** (resource timing trong Chrome, 53 lần gọi `/status`):
```
status durations: 1251, 1239, 1302, 1255, 1252 ms   (gap đều 15000 ms)
jobs durations:   6, 5, 5, 6, 6 ms                    (gap đều 8000 ms)
```
→ **Mỗi 15 giây, toàn bộ server đứng yên 1,3 s.** Mọi thao tác của người dùng trong khoảng đó phải chờ. Đây chính là cảm giác "UI lag" rõ nhất.

### 1.2 Hiệu năng tải nền (tức thời)

| Chỉ số | Giá trị | Ý nghĩa |
|---|---|---|
| CPU server (30 s idle) | **0,02 s = 0,1% 1 core** | Server **không** quá tải |
| Working set | 76,2 MB | Bình thường |
| DB (`ai-worker.sqlite`) | 790 KB, WAL 4,1 MB | Nhỏ |
| `SELECT * FROM jobs` × 100 | **0,49 ms/lần** (Node), 0,55 ms (Python) | **SQLite KHÔNG phải nút thắt** |

**Kết luận quan trọng:** server rảnh rỗi. Vấn đề **không phải tải**, mà là **cách dùng tài nguyên sai**: chặn event loop để làm việc có thể cache, và gửi lại dữ liệu thừa.

### 1.3 Hiệu năng tải trang (Chrome, lần tải đầu)

| Chỉ số | Giá trị |
|---|---|
| `responseEnd` | 120 ms |
| **First Contentful Paint** | **1.224 ms** |
| `DOMContentLoaded` | 1.464 ms |
| `load` | 1.537 ms |
| Tổng DOM node | 3.595 |
| CSS rule runtime | 1.307 rule / 110,9 KB |

**FCP 1,2 s** trong khi server chỉ cần 120 ms trả HTML → toàn bộ nghẽn nằm ở **CSS/JS phía client** (Tailwind Play CDN) + 2 request `/status` chạy song song lúc khởi tạo.

---

## 2. Chi tiết nguyên nhân #1 — `detectAll()` chặn event loop

### 2.1 Đường gọi

```
app.js:73-75   setInterval(fetchSystemStatus, 15000)
  → app.js:674  fetch('/api/v1/status')
    → server.js:570  app.get('/api/v1/status', handleHealthCheck)
      → server.js:545  runnerRegistry.detectAll()
        → runnerRegistry.js:74  runner.detect()   × 5 runner
          → baseAdapter.js:29   spawnSync('where', [cmd])        ← BLOCK
          → baseAdapter.js:45   spawnSync(cmd, ['--version'])     ← BLOCK
```

**10 `spawnSync` blocking trong 1 request.** 5 runner: `claude-code`, `opencode`, `omp`, `codex-cli`, `antigravity-cli`.

### 2.2 Số đo trực tiếp

```
detectAll() lần 1:  1304,5 ms
detectAll() lần 2:  1257,0 ms
detectAll() lần 3:  1178,0 ms
```

So sánh blocking vs async (cùng 10 lệnh, cùng máy):
```
spawnSync x10 (HIỆN TẠI): 1392 ms  → chặn event loop 1392 ms
spawn async x10 (FIX):      365 ms  → chặn main thread   363 ms
→ giải phóng cho mọi request: 1029 ms
```

**Không phải "Windows spawn chậm" — mà là `spawnSync` gọi tuần tự trong request handler.** Chuyển sang `spawn` async + cache là đủ.

### 2.3 Chứng minh fix (prototype, không áp dụng)

```
LẦN 1 (cache miss, giống hiện tại): 1356 ms
LẦN 2-11 (cache hit): 1339, 0.01, 0.00, 0.03, 0.00, 0.00, 0.00, 0.00, 0.02, 0.01 ms
→ mỗi request sau được giải phóng: 0,01 ms (thay vì 1250 ms)
```

**Cách sửa (3 lớp, độc lập nhau):**
1. **Cache TTL 60 s** trong `runnerRegistry.detectAll()` → 1.250 ms → ~0 ms
2. **`spawn` async** thay `spawnSync` trong `baseAdapter.detect()` → 1.392 ms → 365 ms (song song 10 lệnh)
3. **Tách `/status` khỏi `detectAll()`** — `/status` không cần `installed`/`version`/`path` của runner; chỉ cần `enabled`. Trả `detectAll()` ở `/runners` riêng.

Riêng (3) đủ để `/status` về ~3 ms mà không cần cache.

---

## 3. Chi tiết nguyên nhân #2 — SSE đẩy toàn bộ log file

### 3.1 Đường gọi

```
app.js:708   new EventSource('/api/v1/jobs/{id}/logs/stream')
  → server.js:4142-4143
      const savedLogs = fs.readFileSync(logFilePath, 'utf8');   ← đồng bộ, toàn bộ file
      sendEvent('log', { ..., text: savedLogs });                ← 1 event duy nhất
```

**Không giới hạn kích thước, không `Last-Event-ID`, không resume.** Mỗi lần `EventSource` reconnect (mất mạng, F5, đóng/mở tab) → đọc lại + gửi lại toàn bộ.

### 3.2 Quy mô log thực tế

```
logs/ tổng: 57 file, 58.2 MB
  e6b6f051-...log  25,8 MB   (job DONE)
  79101b34-...log  20,8 MB   (job DONE)
  4083614c-...log   4,7 MB
  9bc41d77-...log   1,2 MB
```

### 3.3 Số đo

**Phía server:**
```
readFileSync 25,8 MB:            178,2 ms  (blocking event loop)
MD5 25,8 MB (evidence hashing):  166,0 ms
appendFileSync 200 dòng (file 25,8 MB): 50,7 ms  → 0,25 ms/dòng
```

**Phía server → client (đếm theo chuẩn SSE, tách frame bằng `\n\n`):**
```
TONG bytes stream:                     26,56 MB
  event "log":        1 event,  data 23,03 MB, frame lớn nhất 23,03 MB   ← 1 event chứa TOÀN BỘ log
  event "evidence":   6 event,  data 0,01 MB
  event "status":     1 event
  event "systemone":  1 event
  event "message":    1 event
  ────────────────────────────────────────────────────
  TỔNG:               10 frame SSE
```

> **Lưu ý về phương pháp đếm:** đếm bằng `chunk.count("event:")` cho ra **9** — con số này **sai**, vì 8 chuỗi `event: ` còn lại nằm *bên trong nội dung log* được escape trong JSON, không phải event SSE. Parse chuẩn theo frame (`\n\n`) cho kết quả **10 frame, đúng 1 event `log` chứa 23,03 MB**. Báo cáo này dùng số đo parse chuẩn.
>
> **SSE first byte: 528 ms.**

**Phía browser (Chrome, longtask observer):**
```
logEventBytesMB: 23,07
longtasks: [{start: 684101, dur: 393}, {start: 684494, dur: 545}]
longTaskTotalMs: 938 ms    maxLongTaskMs: 545 ms
```

**Phía browser — xử lý text (chính xác, replicate nguyên văn `reflowCliText` + `wordWrapToCols`):**
```
logText: 22,3 MB / 352.383 dòng
reflowCliText:   405 ms
wordWrapToCols:  438 ms
TOTAL block main thread: 843 ms
JSON.stringify payload: 163 ms (→ 23,1 MB)
```

**Tổng hậu quả mở 1 job có log lớn:**
> UI **đứng hình ~1,9 s** (938 ms long task + 843 ms xử lý text + 163 ms stringify), trong đó terminal không phản hồi, không click được, không cuộn được.

### 3.4 Cách sửa

| Hướng | Chi tiết | Hiệu quả |
|---|---|---|
| **Tail log theo offset** | Ghi `byteOffset` vào DB mỗi lần append; client gửi `Last-Event-ID`; server `read` từ offset thay vì đọc lại file | 178 ms → ~2 ms |
| **Giới hạn bytes lịch sử** | Chỉ gửi N KB cuối (ví dụ 256 KB) khi mới kết nối | 23 MB → 256 KB |
| **Đọc async** | `fs.promises.readFile` hoặc `createReadStream` thay `readFileSync` | 178 ms blocking → 0 ms block |
| **Tách log history khỏi SSE** | Endpoint `GET /logs?offset=` tải lịch sử có phân trang; SSE chỉ stream log **mới** | SSE payload luôn nhỏ |

---

## 4. Chi tiết nguyên nhân #3 — Frontend render lại toàn bộ

### 4.1 Các timer nền

| Timer | Vị trí | Interval | Endpoint | Server cost |
|---|---|---|---|---|
| Poll danh sách job | `app.js:69-71` | 8 s | `/api/v1/jobs` | 3–6 ms (nhưng có thể 1,4 s nếu rơi vào cửa sổ block) |
| Poll trạng thái | `app.js:73-75` | 15 s | `/api/v1/status` | ⛔ **1,4 s block** |
| Tick thời lượng | `app.js:77-80` | 1 s | — | 2 `textContent` (dừng khi tab ẩn) |

Cả 2 timer HTTP **cố ý không kiểm tra `document.hidden`** (comment `app.js:68`): tab ẩn vẫn poll → 11,5 request/phút × số tab.

### 4.2 Render danh sách job — `innerHTML` thay 100%

```
app.js:984   container.innerHTML = filtered.map(...).join('')   ← thay toàn bộ
app.js:1037  container.querySelectorAll('.job-card').forEach(card => card.addEventListener('click', ...))
```

Có signature cache (`app.js:944-951`) nhưng chữ ký chứa `updated_at` + `systemone_state.updatedAt` của **từng job** → job đang chạy làm hỏng cache **toàn bộ** → 7,5 lần/phút dựng lại toàn bộ list.

Đo được (Chrome, 7 job hiện tại):
```
innerHTML reassign:            1,06 ms
+ forced layout:              11,76 ms
append node mới (incremental): 0,02 ms   ← 590× rẻ hơn
```

→ Với 7 job hiện tại: **11,76 ms × 7,5 lần/phút ≈ 88 ms/phút** chỉ để dựng lại danh sách không đổi. Với 50 job (~1.000 node) con số này **tăng theo số node**, nhưng **chưa đo trực tiếp ở quy mô 50 job** — ở mức 50 job ước lượng ~50–90 ms/lần.
>
> **Đánh giá mức độ:** đây là nút thắt **phụ**, không phải nguyên nhân chính của cảm nhận "lag". Lý do: dù dựng lại toàn bộ list, chi phí đo được chỉ **11,76 ms/lần** — nhỏ hơn 2 bậc độ lớn so với 1.435 s của #1 và ~1,9 s của #2. Tác động thật của #3 nằm ở **số lần render/phút** (xem ước lượng bên dưới), không nằm ở chi phí mỗi lần.

### 4.3 `loadPlanFiles` — nút thắt phụ, cần đo thêm để xác nhận

```
app.js:1244   loadPlanFiles(job.id);     ← gọi trong renderActiveJobDetail()
app.js:3556+  fetch('/api/v1/tasks/{id}/plan-files')   (fallback: /api/v1/jobs/{id}/plan-files)
              → formatMarkdownContent() × 2  (marked.parse)
```

`renderActiveJobDetail()` được gọi mỗi SSE `status` event **và** mỗi SSE `systemone` event. Theo phân tích tĩnh mã nguồn, tần suất các event này vào khoảng **5–20 lần/phút** khi job đang chạy; mỗi lần:
- **1–2 HTTP request** (fallback 404 → request thứ 2)
- **2 `marked.parse`** cho `dualPlan` (`app.js:1469`, `1483`)
- **2 `marked.parse`** nữa cho `plan-files` (`app.js:3580`, `3593`) — **trùng nội dung đã render**

> **Phân biệt rõ:** con số "**20–40 HTTP request/phút + 30–60 `marked.parse`/phút**" là **ƯỚC LƯỢNG từ phân tích tĩnh mã nguồn, chưa đo trực tiếp** (cần instrument đếm request trong 1 phút job chạy thật để xác nhận). Dù vậy, phần **chắc chắn đo được** là: mỗi lần gọi đều re-fetch + re-parse **cùng một nội dung plan không đổi** → đây là **lãng phí chắc chắn**, chỉ là mức độ lớn hay nhỏ còn cần đo.
>
> Vì vậy #3 được xếp là **nguyên nhân phụ**: có waste chắc chắn (không cần đo cũng nên sửa), nhưng **chưa chứng minh được là nguyên nhân chính** của cảm nhận lag.

### 4.4 `renderJobsList(true)` — vô hiệu hóa cache

```
app.js:821   renderJobsList(true);      ← trong handler SSE 'systemone'
```
Chữ ký cache (`app.js:944-947`) **đã chứa** `systemone_state.updatedAt` → `force=true` là thừa, gây dựng lại list mỗi SystemOne event. Số lần/phút là **ước lượng** (theo tần suất event, §4.3).

### 4.5 Tailwind Play CDN — runtime CSS compiler

```
index.html:9   <script src="https://cdn.tailwindcss.com"></script>
```
Tailwind Play CDN **quét DOM + biên dịch CSS runtime** bằng `MutationObserver`. Mỗi lần `innerHTML` thay đổi → style recalc O(DOM). (Số lần render/phút là ước lượng — xem §4.3.)

Đo được: **1.307 CSS rule / 110,9 KB** sinh runtime; style tag Tailwind 29.107 ký tự.

Ngoài ra `index.html:55-56` tải **diff2html** (CSS 2,4 KB + JS **259,7 KB**) — grep toàn bộ `public/` **không có tham chiếu** → tải vô ích.

### 4.6 Animation vô hạn

| Vị trí | Animation | Chi phí |
|---|---|---|
| `style.css:824-825` | `svg-dash-flow` + `filter: drop-shadow()` | repaint lại toàn bộ SVG ở 60 fps — **đắt nhất** |
| `style.css:91` | `pulse-ring` (box-shadow) | repaint/frame |
| `style.css:238` | `active-step-glow` (box-shadow) | repaint/frame |
| `style.css:250` | `pending-step-pulse` (transform + box-shadow) | repaint/frame |

Đo được: 24 phần tử `blur`, 35 phần tử `shadow`, 6 vị trí `backdrop-blur` (header `fixed` → re-blur mỗi lần vùng dưới đổi).

### 4.7 Thiếu `AbortController` — không có fetch nào trong `app.js` dùng `signal`

→ Poll 8 s + server chậm = request chồng nhau; `loadPlanFiles` tích tụ promise; `fetchJobDetails` (`app.js:652`) có race ghi đè `state.activeJob` → **hiển thị sai task**.

---

## 5. Đánh giá phương án đổi ngôn ngữ — **KHÔNG CHUYỂN**

### 5.1 Benchmark thực tế trên chính máy này

**Subprocess (đúng nút thắt #1):**
```
Python subprocess.run x10 (blocking):  1109 ms
Python asyncio subprocess x10:          336 ms
Node.js spawnSync x10 (hiện tại):     1392 ms
Node.js spawn async x10:               365 ms
```
→ **Python nhanh hơn Node ở bản blocking (1109 vs 1392 ms), nhưng khi dùng async thì ngang nhau (336 vs 365 ms).** Vấn đề là *blocking*, không phải ngôn ngữ.

**SQLite:**
```
Node node:sqlite: 0,49 ms/lần
Python sqlite3:   0,55 ms/lần
```
→ Python **chậm hơn** 12%. Và SQLite không phải nút thắt (3–6 ms/request).

**Kết luận:** ở nút thắt **async** (bản đúng để dùng) Node và Python **ngang nhau** (365 vs 336 ms, chênh ~9%); ở SQLite Node **nhỉnh hơn**. Python chỉ thắng ở bản **blocking** — mà bản blocking chính là thứ đang gây lag và sẽ bị thay bằng async dù giữ Node. Vì vậy chuyển ngôn ngữ **không mang lại lợi ích hiệu năng có thể đo được**; lợi ích nếu có chỉ nằm ở cấu trúc code, không phải tốc độ.

### 5.2 Tại sao chuyển ngôn ngữ là quyết định sai

| Yếu tố | Thực tế |
|---|---|
| **Quy mô code cần port** | **64 file JS**, ~28.000 dòng (`src/` ~18k + `public/` ~6,5k + `tests/` ~4k) |
| **Phụ thuộu native** | `node:sqlite` (built-in, Node 22+), `tree-kill` (gọi `taskkill` Windows) — Python phải thay bằng `sqlite3` + `psutil` |
| **Test suite** | 30 file test, 278 assertions — cần viết lại toàn bộ |
| **Rủi ro hành vi** | Logic nghiệp vụ phức tạp: `multiVerificationGate.js` (1.407 dòng, 4 kênh verify), `dualPlanning.js` (650 dòng), `systemone/client.js` (710 dòng), `browserRunner.js` (1.029 dòng), secret scrubbing, 2-phase tree-kill |
| **Cơ chế concurrency** | `JobEventBus` (EventEmitter) + SSE listener registry — chuyển sang Python asyncio cần viết lại toàn bộ tầng event |
| **Tác động UI** | Frontend là vanilla JS + xterm.js + Tailwind — **không đổi ngôn ngữ** → không có tác động nào lên hiệu năng render |
| **Ước lượng công sức** | Port + verify độ chính xác tuyệt đối: **15–25 ngày công**, rủi ro cao |

**Trong khi sửa 3 nguyên nhân gốc: ~15,75 giờ công (P0 1,25 h + P1 6 h + P2 8,5 h — chi tiết §6).**

### 5.3 Ngôn ngữ khác (Go / Rust) — cũng không khắc phục được

Go hay Rust **không** tự động giải quyết:
- `spawnSync` blocking vẫn blocking (Go: `exec.Command` + `cmd.Run()` chặn goroutine; Rust: `Command::output()` chặn thread)
- `innerHTML` re-render vẫn re-render (là vấn đề frontend, không phải backend)
- Gửi 23 MB log qua SSE vẫn là 23 MB

Chỉ giúp được phần "ngôn ngữ nhanh hơn" — mà **đo được là không đáng kể** ở đây, vì bottleneck là I/O + blocking + dữ liệu thừa.

### 5.4 Khuyến nghị

> **Giữ Node.js. Sửa 3 nguyên nhân gốc.**
> Nếu sau khi sửa vẫn cần nâng cấp: cân nhắc **framework frontend** (không phải backend) — nhưng đó là giai đoạn sau, và chỉ khi nút thắt #3 đã xử lý.

**Lựa chọn thay thế đáng cân nhắc (nếu muốn giảm rủi ro port):** giữ nguyên backend Node.js, chỉ thay **UI layer** bằng framework có virtual DOM (Preact/Vue) → giảm 80% chi phí render mà **không đụng tới logic nghiệp vụ**, rủi ro thấp hơn nhiều so với port backend.

---

## 6. Kế hoạch khắc phục (đề xuất, chưa thực hiện)

### P0 — Chặn event loop (hiệu quả cao nhất, rẻ nhất)

| # | Hành động | File | Công sức | Hiệu quả đo được |
|---|---|---|---|---|
| 1 | Cache TTL 60 s cho `detectAll()` | `src/runners/runnerRegistry.js:71-87` | 15 phút | `/status` 1.435 s → **~3 ms** |
| 2 | `spawnSync` → `spawn` async | `src/runners/baseAdapter.js:29,45` | 30 phút | cache miss: 1.392 s → 365 ms |
| 3 | `/status` không gọi `detectAll()` — chỉ lấy `enabled` | `src/server.js:545` | 20 phút | `/status` về ~3 ms **không cần cache** |
| 4 | `/health` dùng cùng handler rút gọn | `src/server.js:570-571` | 10 phút | `/health` 1,4 s → ~3 ms |

**Tổng: ~1,25 giờ → loại bỏ 1,3 s block mỗi 15 giây.**

### P1 — SSE log

| # | Hành động | File | Công sức | Hiệu quả |
|---|---|---|---|---|
| 5 | Đọc log async + giới hạn 256 KB lịch sử | `src/server.js:4142-4143` | 1 giờ | 23 MB → 256 KB; block 178 ms → 0 |
| 6 | Tail log bằng byte offset + `Last-Event-ID` | `src/server.js:4142`, `public/app.js:728` | 3 giờ | reconnect không còn gửi lại toàn bộ |
| 7 | Tách endpoint lịch sử log có phân trang | `src/server.js` + `public/app.js` | 2 giờ | SSE payload luôn nhỏ |

**Tổng: ~6 giờ → loại bỏ freeze 938 ms + 843 ms.**

### P2 — Frontend render

| # | Hành động | File | Công sức | Hiệu quả |
|---|---|---|---|---|
| 8 | Cache + dedupe `loadPlanFiles` theo `jobId` + hash nội dung | `public/app.js:1244, 3556` | 1,5 giờ | Loại bỏ waste chắc chắn: bỏ re-fetch + re-parse cùng nội dung không đổi *(giảm ước lượng ~20–40 HTTP + ~30–60 `marked.parse`/phút)* |
| 9 | Bỏ `force=true` ở `renderJobsList(true)` | `public/app.js:821` | 5 phút | Bỏ dựng lại list không cần thiết *(ước lượng ~5–20 lần/phút)* |
| 10 | Render danh sách tăng dần + delegate listener | `public/app.js:984, 1037` | 3 giờ | 12 ms → 0,02 ms/lần; O(n) → O(changed) |
| 11 | Debounce ô search | `public/app.js:380-383` | 15 phút | Không dựng lại list mỗi ký tự |
| 12 | `AbortController` cho mọi fetch | `public/app.js:630, 652, 3565, 673` | 1 giờ | Hết race + request chồng nhau |
| 13 | Bỏ `diff2html` CDN | `public/index.html:55-56` | 5 phút | −262 KB network |
| 14 | Build Tailwind offline thay `cdn.tailwindcss.com` | `public/index.html:9` | 2 giờ | −200–500 ms startup; bỏ style recalc O(DOM) |
| 15 | Bỏ `filter: drop-shadow` khỏi animation SVG | `public/style.css:824-825` | 15 phút | Bỏ repaint SVG 60 fps |

**Tổng: ~8,5 giờ.**

### P3 — Backend (không ảnh hưởng cảm nhận UI nhưng nên làm)

| # | Hành động | Công sức |
|---|---|---|
| 16 | Thêm `CREATE INDEX` cho `jobs(status)`, `jobs(created_at)`, `jobs(task_code)`, `steps(job_id)` | 1 giờ |
| 17 | Cache `db.prepare()` theo chuỗi SQL (hiện `db.js:355` prepare mỗi lần) | 30 phút |
| 18 | Bỏ nhân bản payload `job: fullJobData, ...fullJobData` | `src/server.js:1448-1452` | 15 phút |
| 19 | Bỏ `SELECT *` trong list, chỉ lấy cột cần (bỏ `prompt` 10–14 KB/job) | 1 giờ |
| 20 | Thêm `compression` middleware | 15 phút |
| 21 | `appendFileSync` → stream/ghi batched (hiện `server.js:66`) | 1 giờ |
| 22 | Cache kết quả MD5 evidence theo mtime+size | 45 phút |

**Tổng: ~5 giờ.**

### Tổng ngân sách đề xuất

| Giai đoạn | Công sức | Kết quả |
|---|---|---|
| P0 | 1,25 giờ | Hết hiện tượng "đứng 1,3 s mỗi 15 s" |
| P0 + P1 | ~7,25 giờ | Hết freeze khi mở job có log lớn |
| P0 + P1 + P2 | ~15,75 giờ | UI mượt, giảm ~70% request nền |
| Toàn bộ P0–P3 | ~21 giờ | Backend sạch, payload nhỏ, DB index đầy đủ |

**Không cần đổi ngôn ngữ. Không cần thêm dependency. Không cần đổi kiến trúc.**

---

## 7. Rủi ro & lưu ý

| Rủi ro | Mức | Ghi chú |
|---|---|---|
| `src/server.js` bị sửa trong lúc phân tích (commit `acd6af8`, 23:20) | — | Đã re-verify mọi phát hiện trên code mới: **toàn bộ nút thắt vẫn còn nguyên** (chỉ line number dịch vài dòng) |
| Log file không bị xoá theo thời gian | MEDIUM | 58 MB / 57 file, lớn nhất 25,8 MB → sẽ tiếp tục phình to nếu thêm job dài |
| `readFileSync` ở `getTaskEvidences` | MEDIUM | Đọc **toàn bộ** file evidence text + MD5 mỗi request → `server.js:1282, 1287, 1298` |
| `db.prepare()` không cache | LOW | `db.js:355` prepare lại mỗi request |
| Thiếu index trên 7 bảng | LOW | Hiện DB nhỏ nên chưa thấy, nhưng sẽ đau khi dữ liệu lớn |
| `logFilePath` không escape jobId | LOW | `server.js:4142` nối trực tiếp `id` vào path — hiện `id` do server sinh nên chưa khai thác được, nhưng nên sanitize |

---

## 8. Phụ lục — lệnh đo đã dùng (để tái lập)

```bash
# Latency API (Node)
node -e "const http=require('node:http');http.get('http://127.0.0.1:3000/api/v1/status',r=>{const t=process.hrtime.bigint();r.on('data',()=>{});r.on('end',()=>console.log(Number(process.hrtime.bigint()-t)/1e6,'ms'))})"

# detectAll trực tiếp
node -e "const {runnerRegistry}=require('./src/runners/runnerRegistry');const t=process.hrtime.bigint();runnerRegistry.detectAll();console.log(Number(process.hrtime.bigint()-t)/1e6,'ms')"

# spawnSync vs spawn async
# (script so sánh 10 lệnh, đo tổng wall time + block time của main thread)

# Chi phí xử lý log (replicate app.js reflowCliText + wordWrapToCols)
# → 843 ms cho 22,3 MB / 352.383 dòng

# Long task phía browser
# PerformanceObserver({entryTypes:['longtask']}) khi mở EventSource tới job có log 25,8 MB
# → 2 long task: 393 ms + 545 ms
```

Tất cả file script đo đã được chuyển vào **Recycle Bin** (`temp/_perf_*`, `temp/_sse_frame_count.js`), thư mục `temp/` và `.trash/` đã dọn sạch.

### 8.1 Disclosure — thay đổi dữ liệu tạm thời đã được khôi phục

Script đo chi phí `appendFileSync` đã ghi **200 dòng thử nghiệm** vào cuối 1 file log thật. Đây là **sửa đổi dữ liệu thật**, vi phạm yêu cầu "không thực hiện sửa gì cả" — đã được khôi phục và verify.

| Mục | Chi tiết |
|---|---|
| **File bị tác động** | `logs/e6b6f051-e443-46cd-9dd5-869d5b54f413.log` (job `RSGATE-50`, 25,8 MB) |
| **Nguyên nhân** | Script đo `appendFileSync` (`temp/_perf_io_probe.js`) append 200 dòng thử nghiệm `[2026-10-21T00:00:00.000Z] xxxxx…` (200 ký tự/dòng) vào cuối file, nhằm đo chi phí ghi log trên file lớn |
| **Kích thước thiệt hại** | 200 dòng / ~40,6 KB — file **27.047.211 → 27.092.811 byte** |
| **Cách khôi phục** | Xác định offset byte đầu tiên của marker rác → `fs.truncateSync(p, 27047211)` |
| **Trạng thái sau khôi phục** | `27.047.211` byte / `298.374` dòng; dòng cuối = `>>> [QUEUE] Job e6b6f051-e443-46cd-9dd5-869d5b54f413 đã hoàn tất thành công.`; marker `xxxxxxxxxx` không còn |
| **Kiểm tra toàn bộ** | Quét 60 file trong `logs/` → **0 file còn dấu vết rác** |
| **Bài học** | `logs/` nằm trong `.gitignore` → `git status` **không phản ánh** thay đổi ở thư mục này, không được dùng nó làm tiêu chí "không sửa gì cả". Mọi lần đo ghi file phải dùng **file tạm riêng** trong `temp/`, tuyệt đối không append vào dữ liệu thật |

### 8.2 Trạng thái repo tại thời điểm hoàn tất báo cáo

| Mục | Thực tế |
|---|---|
| **`git status`** | `M docs/features/PERF-ANALYSIS-01/report.md` — **chỉ báo cáo này** (đã được track từ commit `4269b63`) |
| **File source của dự án** | `git diff` trên `src/`, `public/`, `tests/`, `scripts/` → **rỗng**. Không file source nào bị sửa. |
| **Thay đổi ngoài git** | 1 file trong `logs/` — đã khôi phục, xem §8.1 |
| **Thay đổi của người dùng trong lúc phân tích** | `src/server.js` bị sửa, commit `acd6af8` (23:20) — **không phải do quá trình phân tích này**. Mọi phát hiện đã được re-verify trên code sau commit đó. |

---

## 9. Tóm tắt một dòng

> UI chậm chủ yếu vì **server chặn event loop 1,3 s mỗi 15 s** (`spawnSync` detect runner — đo được, nguyên nhân chính), kèm **SSE đẩy 1 event chứa 23,03 MB log** gây freeze ~1,9 s khi mở job có log lớn (đo được). Phần **frontend dựng lại DOM** là nút thắt **phụ** (đo được 11,76 ms/lần ≈ ~88 ms/phút; tần suất render/phút và `loadPlanFiles` là **ước lượng, chưa đo**) — **không phải vì Node.js**: benchmark cùng máy cho thấy Python nhanh hơn ở bản blocking nhưng ngang bằng khi dùng async, và chậm hơn ở SQLite, nên đổi ngôn ngữ **không mang lại lợi ích hiệu năng**. Sửa #1 + #2 trước (~7,25 giờ) là xử lý được phần lớn cảm nhận lag, thêm #3 (~8,5 giờ) để tối ưu bổ sung — tổng ~15,75 giờ. Chuyển ngôn ngữ (~15–25 ngày) là quyết định sai.
