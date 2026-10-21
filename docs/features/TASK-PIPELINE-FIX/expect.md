# Đặc tả yêu cầu (expect.md)

## Task: TASK-PIPELINE-FIX - Sửa timeout/retry, hiệu quả SystemOne, Evidence realtime + vòng đời trạng thái

- **Mã Task:** `TASK-PIPELINE-FIX`
- **Người tạo:** User
- **Ngày tạo:** 2026-10-20
- **Thư mục Feature:** `D:\Thanhpk\AI\ai-worker\docs\features\TASK-PIPELINE-FIX`
- **Task nguồn phân tích:** `bd88ae0a-da46-4d35-af4e-49252e16dade` (RSGATE-44, FAILED sau 3h58m)

---

## 1. Yêu cầu nghiệp vụ (User Prompt)

> kiểm tra lại luồng của task #bd88ae0a-da46-4d35-af4e-49252e16dade, tạo feature để phân tích và xử lý các vấn đề sau:
> - thời gian timeout và số lần retry đang chưa được áp dụng đúng.
> - kiểm tra lại luồng hoạt động, log và phân tích xem tại sao lại xử lý lâu thế, 1 task nhỏ nhưng làm tận mấy tiếng chưa xong.
> - kiểm tra lại model systemone xem nó đang được áp dụng vào những bước nào, có tác dụng không, có hiệu quả tốt không, nên cải thiện thế nào.
> - dữ liệu evidence cần hiển thị/cập nhật realtime cả khi đang làm.
> - evidence ban đầu phải trạng thái NOT VERIFY, khi verify thành công mới thành PASS, verify lỗi thì thành FAILED.
> - các evidence phải được đặt tên và khi xem chi tiết thì phải có mô tả xem evidence đó là gì.
> - các evidence ảnh phải được sắp xếp theo thứ tự từng step test, có thể chuyển ảnh tiếp theo khi phóng to, có mô tả ảnh đó là gì, như thế nào là pass.

---

## 2. Kết quả phân tích task `bd88ae0a` (bằng chứng)

### 2.1 Dữ liệu job từ SQLite

| Trường | Giá trị |
|---|---|
| `status` | `FAILED` |
| `created_at` → `updated_at` | `2026-10-20T08:30:38Z` → `2026-10-20T12:28:35Z` (**3h58m**) |
| `runner` | `omp` |
| `pipeline_config` | `{"timeout":3600000,"max_retries":10,"maxRetries":10,"fix_attempt":3}` |
| `error_message` | `SystemOne fixGate dừng retry (attempt 3/3, p_success 0).` |
| `current_step` | `FIXING` |

### 2.2 Timeline từ log `logs/bd88ae0a-...log` (6009 dòng)

| # | Mốc log | Dòng | Ghi chú |
|---|---|---|---|
| 1 | `[SYSTEMONE-TRIAGE] complexity=S track=quick needBrowser=false confidence=0.3` | 3 | SystemOne trả confidence 0.3 = heuristic offline |
| 2 | `[1/5] [PLANNING]` (lần 1) | 7 | Agent `claude-code`, chạy tới dòng 482 |
| 3 | `[PLANNING] Đã ghi dev_plan.md và test_plan.md` | 482 | |
| 4 | `[PLANNING] Agent đã tạo câu hỏi làm rõ → PENDING` | 484 | Chờ user trả lời 3 câu |
| 5 | `[CLARIFICATION] Đã nhận câu trả lời` | 486 | |
| 6 | `[1/5] [PLANNING]` (lần 2 — **chạy lại toàn bộ**) | 489 | Tới dòng 843 |
| 7 | `[PLANNING -> IMPLEMENT]` | 845 | |
| 8 | `[IMPLEMENT] Hoan tat trien khai ma nguon` | 1815 | |
| 9 | `[TIMEOUT] ... vượt quá giới hạn thời gian (3600000ms)` | 2966 | **TESTING vượt timeout 1 giờ** |
| 10 | `[SYSTEMONE-FIXGATE] attempt=0/3 retry=true p_success=0.3 scope=scoped` | 2974 | maxRetries=**3**, không phải 10 |
| 11 | `[FIXING] Hoàn tất sửa lỗi` | 3328 | |
| 12 | `[TESTING] Hoàn tất kiểm thử qua Agent` | 4164 | |
| 13 | `[SYSTEMONE-PREJUDGE] pass=false failed=[ui,api,log,db] confidence=0.3` | 4169 | |
| 14 | `[SYSTEMONE-FIXGATE] attempt=1/3 retry=true p_success=0.3` | 4181 | |
| 15 | `[FIXING] Hoàn tất sửa lỗi` | 4688 | |
| 16 | `[SYSTEMONE-FIXGATE] attempt=2/3 retry=true p_success=0.3` | 5416 | |
| 17 | `[FIXING] Hoàn tất sửa lỗi` | 5695 | |
| 18 | `429 Service temporarily unavailable: all targets were skipped by pre-dispatch filters reset after 665h 47m 11s retry-after-ms=2396831000` | 5407, 5689, 5998 | **Rate limit từ provider**, retry-after ~27 ngày |
| 19 | `[SYSTEMONE-FIXGATE] attempt=3/3 retry=false p_success=0` | 6007 | Dừng ở 3/3 |
| 20 | `>>> [QUEUE] Job ... thất bại: Job FAILED` | 6009 | |

### 2.3 Root cause đã xác minh (file:line)

| # | Vấn đề | Bằng chứng |
|---|---|---|
| **RC-1** | **`max_retries` của job bị bỏ qua.** `server.js:2486` đọc `Number(config.MAX_FIXING_RETRIES) \|\| 3` (env, mặc định 3) thay vì đọc `pipeline_config.max_retries`. Job khai 10 nhưng thực tế dừng ở 3. | `src/server.js:2486`; log dòng 2974/4181/5416/6007 |
| **RC-2** | **SystemOne không hề được gọi thật.** `SYSTEMONE_BASE_URL=https://9router.thanhpk.io.vn/v1/systemone` trả `401 {"error":"API key required for remote API access"}`. Client `postJev` ném lỗi → `catch` → `policy.fixGateHeuristic()` trả cứng `confidence=0.3, p_success=0.3`. Probe thực tế: `stats = {calls:1, hits:0, misses:0, fallbacks:1}`. | `src/systemone/client.js:56-79` (postJev), `:154`/`:176`/`:338` (fallback), `src/systemone/policy.js:33-41` |
| **RC-3** | **`MultiVerificationGate` không chạy trong pipeline.** Class 4-kênh chỉ được `new` trong `tests/` và `scripts/`. `server.js` dùng `verifyTaskEvidence()` (`src/server.js:1723`) — cơ chế đơn giản hơn nhiều, không có UI/API/Log/DB gate thật. | `src/verification/multiVerificationGate.js:1221`, grep `new MultiVerificationGate` chỉ trong `tests/`, `scripts/` |
| **RC-4** | **Timeout là per-step, không phải per-job.** `jobTimeoutMs` (`src/server.js:2104`) truyền cho từng lần gọi adapter. 1 job = 5 step × N retry × 1h = nhiều giờ. Không có tổng ngân sách thời gian cho job. | `src/server.js:2104, 2152, 2301, 2374, 2501` |
| **RC-5** | **Không có backoff giữa các vòng retry.** 3 vòng FIXING chạy liên tiếp, mỗi vòng ~1h, không nghỉ. | log dòng 2974 → 4181 → 5416 |
| **RC-6** | **429 rate-limit không được xử lý.** Provider trả `retry-after-ms=2396831000` (~27 ngày). Agent exit code 1 ngay, không có logic "retry-after" ⇒ lãng phí 1 vòng FIXING + 1 vòng TESTING đầy đủ. | log dòng 5407-5408, 5689-5690, 5998-5999 |
| **RC-7** | **STALL chỉ cảnh báo, không kill.** `baseAdapter.js:253-273` chỉ ghi log 1 lần khi thought lặp 3 lần, không ngắt tiến trình. | `src/runners/baseAdapter.js:253-273` |
| **RC-8** | **Evidence không realtime.** `jobEventBus.emitJobEvidence` chỉ được gọi **1 lần duy nhất** tại `src/server.js:2465` (sau khi VERIFY pass). Trong lúc TESTING agent đang chụp ảnh, UI không nhận gì. | `src/server.js:82-91` (định nghĩa), `:2465` (call site duy nhất) |
| **RC-9** | **Evidence thiếu trạng thái NOT VERIFY.** `browserRunner.js:809` ghi `status: 'CAPTURED'`; `server.js:1493` map mọi thứ khác `FAILED` thành `PASS`. Không tồn tại trạng thái trung gian "chưa verify". | `src/verification/browserRunner.js:798-820`, `src/server.js:1493` |
| **RC-10** | **Bảng SQLite `evidence` là dead code.** `getEvidenceByJobId()` (`db.js:569`) không có caller nào; chỉ ghi 1 record tổng hợp khi VERIFY pass. Mọi route/UI đọc từ filesystem + `metadata.json`. | `src/storage/db.js:109-117, 543-566, 569` |
| **RC-11** | **Ảnh evidence không có thứ tự theo step.** `browserRunner.js:735` đặt tên file `${Date.now()}_${safeStep}.png` — timestamp epoch, không phải sequence theo test step. `metadata.json` có `stepName` nhưng UI sort không theo nó. | `src/verification/browserRunner.js:735, 798` |
| **RC-12** | **Modal ảnh không có next/prev.** `showEvidenceDetailModal` (`public/app.js:2193`) render 1 ảnh tĩnh, không có nút chuyển ảnh tiếp theo. | `public/app.js:2193-2270` |
| **RC-13** | **Kết quả FIXING bị bỏ qua.** `await runner.execute(...)` ở FIXING không kiểm tra `timedOut`/`exitCode` ⇒ một lượt FIXING dính timeout 1h vẫn log "Hoàn tất sửa lỗi" và vòng lặp vẫn chạy tiếp. | `src/server.js:2499-2504` |
| **RC-14** | **Double-normalize timeout** — `server.js:790` normalize lại giá trị đã normalize. *(Kiểm chứng: `normalizeTimeoutMs` giữ nguyên số ≥ 10000 nên **không** nhân đôi ⇒ không phải bug; chỉ sửa comment.)* | `src/server.js:790`, `src/config.js:60-65` |
| **RC-15** | **PENDING chờ người dùng không có timeout.** `clarificationManager.js:91-95` emit `pause_timeout` nhưng **không có listener nào** ⇒ job treo vô hạn ở PLANNING. | `src/execution/clarificationManager.js:91-95` |
| **RC-16** | **Job không bao giờ ở trạng thái `TIMED_OUT`.** `server.js:154-160` chỉ log; grep `status: 'TIMED_OUT'` trong `src/` → 0 kết quả. Job timeout bị ghi `FAILED`. | `src/server.js:154-160, 2319-2325` |
| **RC-17** | **UI đọc cột không tồn tại.** `public/app.js:1052` đọc `job.max_retries` — cột này không có trong schema `jobs` ⇒ luôn `undefined` ⇒ badge luôn hiện `/3`. | `public/app.js:1051-1053`, `src/storage/db.js:35-56` |
| **RC-18** | **Deadline trượt mãi ⇒ AC-1.3 vô hiệu.** `resolveDeadlineAt` đọc `job.started_at` — cột **không tồn tại** trong schema `jobs` ⇒ base = `now`. `executeStep()` chạy lại ở mỗi lần chuyển step ⇒ deadline luôn trượt tiếp. | `src/execution/jobPolicy.js:90`, `src/storage/db.js:35-56` |
| **RC-19** | **Rate-limit không bao giờ phát hiện ⇒ AC-1.5 vô hiệu.** `detectRateLimit(fixingResult.output)` — `runner.execute()` trả `{ stdout, stderr, exitCode, timedOut }`, **không có** field `output`. Log 429 của CLI nằm trong **stderr**. | `src/execution/processManager.js:305-316` (shape), `src/server.js` (2 call site) |
| **RC-20** | **`SecretScrubber` vô tác dụng.** `checkGuard` trả `promptToUse: original` ở **mọi** nhánh, kể cả `action='scrub'` ⇒ prompt vẫn chứa secret gốc. | `src/systemone/client.js:306-311` |
| **RC-21** | **Bảng `steps` gần như chết ⇒ không đo được "tại sao lâu".** `updateStep` (`db.js:441`) **không có caller nào** trong `src/`; chỉ 1 step `PENDING` tạo lúc tạo job ⇒ không có `started_at`/`finished_at`/`exit_code` theo bước. | `src/storage/db.js:77-90, 441` |
| **RC-22** | **`getEvidenceByJobId` mặc định PASS.** `db.js:588` map mọi `verdict` ≠ `'FAIL'` thành `'PASS'` ⇒ evidence chưa verify hiện PASS. | `src/storage/db.js:588` |

### 2.4 Kết luận phân tích "tại sao 1 task nhỏ mất 3h58m"

1. **PLANNING chạy 2 lần** (lần 1 → PENDING chờ user → lần 2 chạy lại toàn bộ): ~2 lần chi phí planning.
2. **TESTING lần 1 chạm timeout 1h** dù agent đã làm được phần lớn việc.
3. **3 vòng FIXING × ~1h** = ~3h, mỗi vòng đều chạy lại TESTING đầy đủ phía sau.
4. **429 rate-limit ở vòng cuối**: provider báo retry-after ~27 ngày, agent chết ngay → vòng FIXING + TESTING cuối cũng lãng phí. *Lưu ý: cơ chế detect 429 **cũ** đọc field không tồn tại (`output` thay vì `stdout`/`stderr`) ⇒ kể cả khi đã viết, nó cũng không bắt được (RC-19).*
5. **SystemOne không hoạt động** nên không có tín hiệu nào để cắt ngắn vòng retry sớm — mọi vòng đều chạy đủ. *Thêm: heuristic offline **vẫn được dùng để chặn retry** bằng số `p_success=0.3` giả ⇒ chính nó giết job ở attempt 3/3 (RC-2).*
6. **Không có cơ chế "cắt ngắn" nào**: không deadline tổng cho job (RC-4, RC-18), không backoff (RC-5), không stop khi rate-limit (RC-6, RC-19), kết quả FIXING timeout vẫn bị coi là thành công (RC-13).

**Không có "cắt ngắn" nào trong toàn bộ chuỗi.** Đây là nguyên nhân gốc.

**Vì sao không đo được "bước nào ăn hết thời gian":** bảng `steps` gần như chết — `updateStep` không có caller, chỉ 1 step `PENDING` tạo lúc tạo job, file log không có timestamp (RC-21). Nên cả 2 thứ này đã được sửa trong feature này để lần sau có số liệu thật.

---

## 3. Tiêu chí nghiệm thu

### 3.1 Timeout & Retry
- [ ] **AC-1.1** `max_retries` (và `maxRetries`) khai trong `pipeline_config` của job **được áp dụng thật** cho fixGate; giá trị env `MAX_FIXING_RETRIES` chỉ là fallback khi job không khai.
- [ ] **AC-1.2** Giá trị đang dùng được log ra rõ ràng mỗi vòng (nguồn: `job.pipeline_config` | `env` | `default`).
- [ ] **AC-1.3** Timeout áp dụng **theo từng step** vẫn giữ, **nhưng** có **tổng ngân sách thời gian cho job** (`job_timeout_ms` hoặc tương đương). Khi hết ngân sách tổng → job dừng với lý do rõ ràng, không chạy tiếp.
- [ ] **AC-1.4** Có **backoff** giữa các vòng retry (tăng dần, có cap), tránh 3 vòng liên tiếp dính nhau.
- [ ] **AC-1.5** Khi agent CLI trả lỗi **429 / rate-limit có `retry-after`**, pipeline **dừng ngay** với verdict "provider rate-limited" thay vì chạy tiếp vòng FIXING + TESTING đầy đủ.
- [ ] **AC-1.6** Log có timestamp để đo được thời gian từng step (hiện tại log không có timestamp per-line).
- [ ] **AC-1.7** Bảng `steps` ghi **timeline từng phase** (`started_at`, `finished_at`, `exit_code`) để lần sau có bảng thời gian thật để trả lời "bước nào ăn hết thời gian" — hiện `updateStep` không có caller nào.

### 3.2 SystemOne
- [ ] **AC-2.1** Có phát hiện rõ ràng khi SystemOne **rơi về heuristic** (fallback) — log cảnh báo + badge trạng thái trên UI, **không** im lặng dùng giá trị giả (`confidence 0.3`).
- [ ] **AC-2.2** Giá trị `p_success`/`confidence` từ heuristic **không được dùng** để quyết định retry như thể là model thật. FixGate heuristic phải fail-safe theo quy tắc rõ ràng.
- [ ] **AC-2.3** Có endpoint/probe kiểm tra kết nối SystemOne và trạng thái (live / fallback / disabled) hiển thị được.
- [ ] **AC-2.4** Tài liệu nêu rõ **model systemone (`openrouter/typesafe/jev-1.13`, provider TypeSafe) được áp dụng vào những bước nào**: ROUTER (chọn agent — *hiện không dùng trong pipeline*), TRIAGE (phân loại độ khó — có dùng), DEDUP, GUARD (scrub prompt — có dùng), PREJUDGE (gợi ý kênh — có dùng), FIXGATE (quyết định retry — có dùng).
- [ ] **AC-2.5** Khi GUARD quyết định `action='scrub'`, prompt truyền cho agent **phải là bản đã scrub** — hiện trả `original` ở mọi nhánh ⇒ `SecretScrubber` không có tác dụng.
- [ ] **AC-2.6** SystemOne có **bộ URL / API key / model riêng** (biến env `SYSTEMONE_*` tách khỏi `ANTHROPIC_*` của LLM), và **endpoint** typed-decision `/v1/systemone` khác endpoint LLM `/v1`. Key phải là key 9router hợp lệ (key cũ ⇒ `401 "API key required for remote API access"` ⇒ toàn bộ 6 quyết định rơi về heuristic). `SYSTEMONE_API_KEY` phải **không** lọt vào env của tiến trình agent CLI con.
- [ ] **AC-2.7** Model SystemOne **đọc được nội dung file** khi quyết định FIXING. Endpoint chỉ đọc `state` ⇒ phải nhúng nội dung file vào `state` (không gửi `files[]` — gateway bỏ qua). **Phải giới hạn context**: `state` ≤ 240KB (~60k tokens), model chịu ~180k tokens (2.7MB ⇒ `400 max_tokens_exceeded`). File bị cắt phải được báo cáo.
- [ ] **AC-2.8** Cả 3 script `start-worker.bat` / `start-worker-bg.bat` / `restart-worker.bat` phải xoá biến `SYSTEMONE_*` kế thừa từ shell cha trước khi spawn node, và **phải được test** bằng cách cố ý đặt biến sai rồi assert server nạp model mới.
- [ ] **AC-2.9** Badge trạng thái SystemOne phải là **dữ liệu của từng task** (`CHƯA GỌI` / `LIVE` / `FALLBACK`), không phải trạng thái global của server. Lưu theo job trong DB + SSE realtime + hiển thị trong job card và header chi tiết task.
- [ ] **AC-2.10** **Không lạm dụng SystemOne.** Chỉ gọi model ở nơi cần quyết định nhanh, có đáp án sẵn, input nhỏ. Cụ thể: (1) **GUARD** (phát hiện secret trong prompt 10-14KB) → thay bằng scrub **local**; (2) **DEDUP** (chỉ gán nhãn) → hash local; (3) **PREJUDGE** (chỉ ghi log, không quyết định) → bỏ. Giữ lại: TRIAGE (quyết định track), FIXGATE (quyết định retry). **Không được cắt bớt dữ liệu input để ép dùng SystemOne.**
- [ ] **AC-2.11** Badge chỉ phản ánh **quyết định từ model thật**. Kết quả không gọi model (`cached`, `source:'attempt-limit'`, `source:'heuristic-fast'` — quyết định tức thì bằng regex) **không** tính vào `calls` và **không** đổi badge ⇒ badge chỉ ghi `LIVE` khi model thật thực sự quyết định.
- [ ] **AC-2.12** TRIAGE phải **chọn lọc**: quyết định tức thì bằng regex khi prompt rõ ràng (task nhẹ / task lớn) — **không gọi model**; chỉ gọi model khi prompt mơ hồ, và chỉ hỏi **2** câu (`is_quick` + `is_large`) — bỏ `need_browser` vì kết quả chỉ ghi log, không quyết định gì. Heuristic phải phân loại **đúng**: task `migrate`/`refactor` không được nhầm là task nhẹ.

### 3.7 Hiệu năng & tự điều hướng
- [ ] **AC-7.1** Task nhẹ (SystemOne triage = S/quick, confidence ≥ 0.5) phải bật **chế độ NHANH** thật sự: dùng template `planning-quick.md` + `implement-quick.md` (plan ngắn, khảo sát tối đa, sửa tối thiểu) — **không** chỉ tăng priority.
- [ ] **AC-7.2** Chế độ nhanh phải **giới hạn thời gian step** (mặc định 5 phút) để task dễ không treo 15-60 phút/step. VERIFY vẫn chạy sau đó để kiểm chứng.
- [ ] **AC-7.3** Cờ chế độ nhanh phải lưu trong `pipeline_config.quick_track` để mọi lần chạy lại của step đều nhất quán.

### 3.3 Evidence realtime
- [ ] **AC-3.1** Evidence mới sinh ra trong lúc pipeline đang chạy **được đẩy tới UI realtime** qua SSE, không chỉ xuất hiện sau khi VERIFY pass.
- [ ] **AC-3.2** Có cơ chế phát hiện file evidence mới (watcher/poll) để đẩy event, không phụ thuộc agent gọi API riêng.
- [ ] **AC-3.3** UI tự cập nhật Evidence Hub khi nhận event realtime, không cần reload trang.

### 3.4 Vòng đời trạng thái evidence
- [ ] **AC-4.1** Evidence mới tạo có trạng thái **`NOT VERIFY`**.
- [ ] **AC-4.2** Chỉ khi **verify thành công** → `PASS`.
- [ ] **AC-4.3** **Verify lỗi** → `FAILED`.
- [ ] **AC-4.4** Trạng thái hiển thị đúng 3 giá trị trong API, `metadata.json` và UI; UI hiển thị badge 3 màu khác nhau (NOT VERIFY = slate/vàng, PASS = xanh, FAILED = đỏ).

### 3.5 Tên & mô tả evidence
- [ ] **AC-5.1** Mỗi evidence có **tên** hiển thị (`name`), không chỉ tên file.
- [ ] **AC-5.2** Mở chi tiết evidence → hiển thị **mô tả** là evidence đó là gì (description), kèm metadata (step, test case, URL, thời gian).
- [ ] **AC-5.3** Tên/mô tả được ghi vào `metadata.json` khi evidence sinh ra, và đọc lại được qua API.

### 3.6 Thứ tự ảnh & lightbox
- [ ] **AC-6.1** Ảnh evidence được **sắp xếp theo thứ tự từng step test** (step index trong test plan), không theo timestamp epoch.
- [ ] **AC-6.2** Khi phóng to ảnh, có nút **chuyển ảnh tiếp theo / trước đó**, đi theo đúng thứ tự đã sắp xếp.
- [ ] **AC-6.3** Mỗi ảnh có **mô tả** (caption) hiển thị trong modal.
- [ ] **AC-6.4** Modal hiển thị **cách ảnh đó được coi là PASS** (tiêu chí pass của ảnh đó).

---

## 4. Out of scope

- Không refactor lại toàn bộ `MultiVerificationGate` để đưa vào pipeline (task này chỉ ghi nhận RC-3 + đề xuất ở `dev_plan.md`; việc tích hợp 4-kênh gate là feature riêng).
- Không thay đổi contract của SystemOne service (`9router.thanhpk.io.vn`) — chỉ xử lý phía client và việc fallback. **Việc cấp lại API key cho remote là việc ngoài phạm vi code.**
- Không sửa job `bd88ae0a` đã FAILED trong DB (giữ nguyên làm bằng chứng lịch sử).
- Không thêm dependency mới.
- **RC-15** (`PENDING` chờ người dùng không có timeout) — ngoài phạm vi 3 nhóm yêu cầu; cần thiết kế riêng về SLA cho bước chờ người dùng.
- **RC-3** (`MultiVerificationGate` 4 kênh không chạy trong pipeline) — ghi nhận, cần feature riêng.
- **RC-10** (bảng SQLite `evidence` là dead-code) — giữ nguyên theo ADR-1 (filesystem + `metadata.json` là nguồn chân lý).
- **Không bật ROUTER của SystemOne** (`pickRunner` không có caller) — thay đổi hành vi chọn agent là việc riêng, cần đánh giá rủi ro.

---

## 5. Quy tắc bắt buộc về lưu trữ tệp (Storage Rules)
- **TẤT CẢ** tài liệu kỹ thuật (`dev_plan.md`, `test_plan.md`, `tasks.md`, `report.md`...) và tệp bằng chứng kiểm thử **BẮT BUỘC** nằm trong `D:\Thanhpk\AI\ai-worker\docs\features\TASK-PIPELINE-FIX`.
- Mọi file tạo mới: **UTF-8 without BOM**.
- Comment code và phản hồi: **tiếng Việt**.
