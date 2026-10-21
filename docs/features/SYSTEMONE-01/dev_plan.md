---
feature: SYSTEMONE-01
service: ai-worker
status: done
owner: DEV + AI
updated_at: 2026-10-16
---

# SYSTEMONE-01 — Dev Plan (Thiết kế kỹ thuật)

> Gate 1: duyệt file này trước khi viết code. Không sinh markdown tự do. Chỉ quyết định typed.

## 1. Objective

Chèn 6 quyết định Jev typed trước điểm spawn CLI thật trong `src/server.js`, tiết kiệm `runner.execute()` calls, fallback 100% về đường cũ khi SystemOne fail/offline.

## 2. Architecture overview

- Thêm duy nhất `src/systemone/client.js` (CommonJS, zero dep): `fetch` global + `AbortController` timeout + cache RAM TTL (key SHA256 payload đã scrub) + `stats {calls,hits,misses,fallbacks,cliSaved}` + validator 6 schema UC + pipeline wire (`pickRunner/checkGuard/checkTriage/checkFixGate/checkPreJudge/checkDedup/getFixAttempt/withFixAttempt` gộp trong cùng file, không tách `wire.js`).
- Extend `src/config.js:4-11,20-29` thêm env (không đổi key cũ, không đổi chữ ký exports).
- Không sửa chữ ký public `RunnerRegistry/BaseAdapter/TaskQueue/DualPlanningGenerator/MultiVerificationGate/PromptTemplateManager`. Chỉ chèn nhánh `if (systemoneEnabled) try→validate→dùng catch→fallback` tại `src/server.js`.
- Luồng chuẩn mỗi UC: `maskSecrets` → check cache → `POST` thẳng vào `SYSTEMONE_BASE_URL` (`https://9router.thanhpk.io.vn/v1/systemone`, cấm nối thêm path thừa) với body `{model?, questions: {<name>: {type, question/context}}}` + timeout → validate `answers.<name>.noul` → ghi cache + `stats` (cộng `usage.cost` vào metric `cost`) → trả kết quả. Lỗi bất kỳ bước nào → cache cũ → heuristic → đường cũ.

## 3. Config env

- File chạm: `src/config.js:4-11` hằng, `src/config.js:20-29` exports.
- `SYSTEMONE_ENABLED` mặc định `true`; `false` = bypass toàn bộ.
- `SYSTEMONE_BASE_URL` mặc định `http://127.0.0.1:20128/v1/systemone` (self-host local — **không hardcode domain vào source** theo R-03; chỉ `.env` trỏ tới `https://9router.thanhpk.io.vn/v1/systemone`); client `POST` thẳng vào `BASE_URL`. Custom self-host, cấm hardcode.
- `SYSTEMONE_TIMEOUT_MS` mặc định `8000`, bắt buộc < `DEFAULT_TIMEOUT` (`src/config.js:7`).
- `SYSTEMONE_CACHE_TTL_MS` mặc định `3600000`.
- `SYSTEMONE_API_KEY` tùy chọn; gửi `Authorization: Bearer`, che khi log.

## 4. Điểm chèn thật (file:line đã đọc)

| # | UC | Chèn tại | Logic cũ giữ nguyên |
|---|---|---|---|
| 1 | Router `{runner,confidence}` | `src/server.js:2085,2229,2295,2401` trước `getAvailableRunner()`; policy trong `src/runners/runnerRegistry.js:142-183` | `getAvailableRunner(preferredName)` là fallback |
| 2 | Triage `{complexity,track,needBrowser}` | `src/server.js:2552` trước `taskQueue.enqueue()` (dùng chung cho `2806,2841,2948`); queue `src/queue/taskQueue.js:36-62,67-126` | fail → `track:full` |
| 3 | Fix gate `{retry,p_success,fixScope}` | `src/server.js:2392-2411` trước spawn fixing `2401-2407`; input từ `src/verification/multiVerificationGate.js:1064-1215`; tôn trọng `MAX_FIXING_RETRIES` `src/config.js:8` | fail → retry đường cũ |
| 4 | Pre-judge `{pass,failedFields}` | trước `evaluateAll()` `src/verification/multiVerificationGate.js:1245-1253` (song song 4 kênh `:1257`) | fail → đủ 4 kênh |
| 5 | Guard `{hasSecret,hasInjection,action}` | sau `buildPrompt()` tại `src/server.js:2070,2216,2278,2394`, trước `execute`; scrub `src/execution/secretScrubber.js:115-127` + `src/runners/baseAdapter.js:104-115` | guard lỗi → `scrub` + đi tiếp; handler `src/server.js:3120-3129` không crash |
| 6 | Dedup `{bucketId}` | `UiEvidenceCollector.verify` `:68`, `LogScanner` `:684-838` (mask `:732`), serve `src/server.js:335-408`, `getTaskEvidences:927-982`, `hashEvidenceBuffer:300-311` | fail → 1 file 1 bucket |

Không chèn vào `src/pipeline/dualPlanning.js` (template local, không CLI). `src/server.js:837-871` giữ nguyên fallback local.

## 5. Transport + Schema typed (validator trong `client.js`, thiếu field = miss)

- Transport (đã verify live 2026-10-21): `POST` thẳng vào `SYSTEMONE_BASE_URL` — **default trong code = `http://127.0.0.1:20128/v1/systemone`** (self-host local, không hardcode domain theo R-03); `.env` trỏ tới `https://9router.thanhpk.io.vn/v1/systemone`. Client `POST` thẳng vào `BASE_URL`, cấm nối thêm path. Header `Authorization: Bearer <SYSTEMONE_API_KEY>`.
- **Tách bạch khỏi LLM**: `SYSTEMONE_BASE_URL` / `SYSTEMONE_API_KEY` / `SYSTEMONE_MODEL` là bộ env riêng, **không trùng endpoint** với LLM (LLM đi qua `ANTHROPIC_BASE_URL=https://omniroute.thanhpk.io.vn/v1` + `ANTHROPIC_AUTH_TOKEN` trong `~/.claude/settings.json`; SystemOne đi `https://9router.thanhpk.io.vn/v1/systemone` typed-decision). *Lưu ý:* key 9router hiện tại **trùng** `ANTHROPIC_AUTH_TOKEN` — đã gỡ `SYSTEMONE_API_KEY` khỏi env tiến trình agent con (`processManager.js`) để không rò rỉ; tách key thật cần tạo key riêng trên dashboard 9router.
- Request bắt buộc: `{model: "openrouter/typesafe/jev-1.13", state: string, questions: {<name>: {type: "noul", question, instructions|criteria}}}`. Thiếu `state` → `400`; question thiếu `instructions/criteria` → `400`; thiếu/sai key → `401`.
- Response live: `{model, answers: {<name>: {type: "noul", noul}}, usage: {input_tokens, output_tokens}}`; không bắt buộc `cost/id/provider`. Field `noul: number [0,1]` dùng làm `confidence`.
- Ví dụ live `HTTP 200` (2026-10-21, model `openrouter/typesafe/jev-1.13`): `{"model": "typesafe/jev-1.13-20260917", "answers": {"is_urgent": {"type": "noul", "noul": 0.96}}, "usage": {"input_tokens": 290, "output_tokens": 23, "cost": 0.00001218}, "id": "gen-dec-...", "provider": "TypeSafe"}`.
- Map 6 UC: mỗi UC = 1 request POST với NHIỀU question `noul` (mỗi answer chỉ 1 số thực [0,1]); ánh xạ ngưỡng sang typed, ngưỡng mặc định `0.5`. Router: `questions:{prefer_<candidate>}` → max noul; Triage: `{is_quick,is_large,need_browser}`; FixGate: `{should_retry,will_succeed,needs_full_scope,is_tiny_fix}`; PreJudge: `{will_pass,fail_ui,fail_api,fail_log,fail_db}`; Guard: `{has_secret,has_injection}`; Dedup: `{is_duplicate,is_noise}` + hash local. Thiếu field = miss → fallback.
- **Lưu ý prefix provider của 9router (rất dễ sai)**:
  - `openrouter/typesafe/jev-1.13` → `HTTP 200`, provider `TypeSafe` ✅ (model đang dùng)
  - `oc/jev-1.13-free` → `HTTP 200`, model `jev-1.13-free` ✅ (model free, cũng chạy được với key hiện tại)
  - `typesafe/jev-1.13-20260917` (thiếu prefix `openrouter/`) → `HTTP 400 "No credentials for provider: typesafe"` ❌
  - `9r/openrouter/typesafe/jev-1.13` (thừa prefix `9r/`) → `HTTP 400 "No credentials for provider: 9r"` ❌
  - `criteria` đôi khi trả `422 Endpoint is unavailable` → ưu tiên `instructions`.
- **Probe endpoint (thêm 2026-10-21)**: `GET /api/v1/systemone/probe` gọi thẳng 1 request `noul` tối thiểu qua `systemone.probe()` — bypass cache, không cần tạo job. Trả `{success, live, model, baseUrl, error, noul, status}`. Dùng để verify endpoint/key/model đang nạp sau khi đổi `.env`.
- **Cạm bẫy env**: `config.js` **không** ghi đè biến đã có sẵn trong `process.env` (dòng 20). Nếu shell cha đã set `SYSTEMONE_*` (VD: server được start từ 1 shell cũ), `.env` sẽ bị bỏ qua ⇒ server chạy sai model mà **không** có log cảnh báo. `start-worker-bg.bat` phải xoá 4 biến `SYSTEMONE_*` trước khi `Start-Process`.
-
 
*
*
N
G
U
Y
Ê
N
 
T
Ắ
C
:
 
k
h
ô
n
g
 
l
ạ
m
 
d
ụ
n
g
 
S
y
s
t
e
m
O
n
e
*
*
 
(
2
0
2
6
-
1
0
-
2
1
)
.
 
C
h
ỉ
 
g
ọ
i
 
m
o
d
e
l
 
ở
 
n
ơ
i
 
c
ầ
n
 
*
*
q
u
y
ế
t
 
đ
ị
n
h
 
n
h
a
n
h
*
*
,
 
*
*
c
ó
 
đ
á
p
 
á
n
 
s
ẵ
n
*
*
,
 
*
*
i
n
p
u
t
 
n
h
ỏ
*
*
.
 
T
u
y
ệ
t
 
đ
ố
i
 
*
*
k
h
ô
n
g
 
c
ắ
t
 
b
ớ
t
 
d
ữ
 
l
i
ệ
u
 
i
n
p
u
t
*
*
 
đ
ể
 
é
p
 
d
ù
n
g
 
S
y
s
t
e
m
O
n
e
.


 
 
|
 
U
C
 
|
 
I
n
p
u
t
 
|
 
Q
u
y
ế
t
 
đ
ị
n
h
 
|
 
T
r
ạ
n
g
 
t
h
á
i
 
|


 
 
|
-
-
-
|
-
-
-
|
-
-
-
|
-
-
-
|


 
 
|
 
T
R
I
A
G
E
 
|
 
p
r
o
m
p
t
 
(
≤
2
K
B
)
 
|
 
c
h
ọ
n
 
t
r
a
c
k
 
q
u
i
c
k
/
f
u
l
l
 
|
 
✅
 
g
i
ữ
 
—
 
1
 
c
a
l
l
/
j
o
b
,
 
q
u
y
ế
t
 
đ
ị
n
h
 
t
h
ậ
t
 
|


 
 
|
 
F
I
X
G
A
T
E
 
|
 
f
a
i
l
u
r
e
s
 
(
1
.
5
K
B
)
 
+
 
f
i
l
e
 
c
o
n
t
e
x
t
 
|
 
r
e
t
r
y
 
/
 
s
c
o
p
e
 
|
 
✅
 
g
i
ữ
 
—
 
1
 
c
a
l
l
/
v
ò
n
g
 
F
I
X
I
N
G
,
 
q
u
y
ế
t
 
đ
ị
n
h
 
t
h
ậ
t
 
|


 
 
|
 
G
U
A
R
D
 
|
 
p
r
o
m
p
t
 
1
0
-
1
4
K
B
 
|
 
c
ó
 
s
e
c
r
e
t
?
 
|
 
❌
 
*
*
b
ỏ
*
*
 
→
 
`
s
r
c
/
e
x
e
c
u
t
i
o
n
/
p
r
o
m
p
t
G
u
a
r
d
.
j
s
`
 
s
c
r
u
b
 
l
o
c
a
l
 
(
n
h
a
n
h
,
 
m
i
ễ
n
 
p
h
í
,
 
g
i
ữ
 
n
g
u
y
ê
n
 
1
0
0
%
 
n
ộ
i
 
d
u
n
g
)
 
|


 
 
|
 
D
E
D
U
P
 
|
 
p
r
o
m
p
t
 
|
 
g
á
n
 
n
h
ã
n
 
l
o
g
 
|
 
❌
 
*
*
b
ỏ
*
*
 
→
 
`
s
y
s
t
e
m
o
n
e
.
l
o
c
a
l
D
e
d
u
p
(
)
`
 
h
a
s
h
 
S
H
A
1
6
 
l
o
c
a
l
 
|


 
 
|
 
P
R
E
J
U
D
G
E
 
|
 
s
u
m
m
a
r
y
 
1
K
B
 
|
 
g
ợ
i
 
ý
 
k
ê
n
h
 
(
c
h
ỉ
 
l
o
g
)
 
|
 
❌
 
*
*
b
ỏ
*
*
 
—
 
`
v
e
r
i
f
y
T
a
s
k
E
v
i
d
e
n
c
e
`
 
m
ớ
i
 
l
à
 
n
g
u
ồ
n
 
s
ự
 
t
h
ậ
t
,
 
p
r
e
-
j
u
d
g
e
 
k
h
ô
n
g
 
đ
ổ
i
 
h
à
n
h
 
v
i
 
g
ì
 
|


 
 
|
 
R
O
U
T
E
R
 
|
 
—
 
|
 
c
h
ọ
n
 
a
g
e
n
t
 
|
 
❌
 
`
p
i
c
k
R
u
n
n
e
r
`
 
k
h
ô
n
g
 
c
ó
 
c
a
l
l
e
r
 
—
 
d
e
a
d
 
c
o
d
e
 
|




 
 
K
ế
t
 
q
u
ả
:
 
g
i
ả
m
 
*
*
3
 
n
e
t
w
o
r
k
 
c
a
l
l
/
s
t
e
p
*
*
 
(
g
u
a
r
d
 
×
4
 
+
 
d
e
d
u
p
 
+
 
p
r
e
j
u
d
g
e
 
→
 
0
)
 
m
à
 
*
*
k
h
ô
n
g
*
*
 
c
ắ
t
 
b
ớ
t
 
d
ữ
 
l
i
ệ
u
 
n
à
o
.


- **Model KHÔNG tự đọc file** — endpoint `/v1/systemone` chỉ đọc `state` (string) + `questions`. Probe 2026-10-21: thêm `files[]` / `file` / `content` / `attachments` vào body ⇒ `input_tokens` **không đổi** (286 vs 286) ⇒ gateway bỏ qua các field đó. Muốn model "đọc file" phải truyền **nội dung file** qua `state`.
- **Giới hạn context (bắt buộc)**: model chịu ~180k input tokens; 2.7MB ⇒ `400 max_tokens_exceeded`. `postJev` cắt `state` ở `MAX_STATE_CHARS = 240000` (~60k tokens, đo thực tế HTTP 200 trong ~1.7s < timeout 8s). `src/systemone/fileContext.js` gom nội dung file theo budget, cắt theo dòng, bỏ qua `node_modules`/build/binary, và báo cáo file bị cắt.
- **Chọn file nào đưa vào context**: `listChangedFiles()` dùng `git status --porcelain` (gồm file **untracked** — chính là output của bước IMPLEMENT; `git diff` bỏ sót) + ưu tiên file có tên trong stack trace `failures.error` + sắp theo mtime giảm dần (file vừa sửa).
- **Bất đồng bộ (chặn event loop)**: `listChangedFiles`/`collectFileContext` dùng `execFile` + `fs.promises` (không `execFileSync`/`readFileSync`) vì `executeStep` chạy trong server phục vụ SSE live terminal cho mọi job. File lớn (log hàng trăm MB) chỉ đọc **một phần** qua fd + `Buffer.alloc` — không nạp toàn bộ vào RAM.
- **Guard workspace**: dùng `path.relative` để kiểm tra file nằm trong workspace. `startsWith` SAI vì `C:\a\ws` là tiền tố của `C:\a\ws-evil` (test `ws-evil` bắt được).
- **Cache key**: `decideFixGate` dùng `sha256(fileContext)` (16 hex) trong payload — cắt 2000 ký tự đầu sẽ gộp 2 bộ file khác nhau vào cùng cache key ⇒ trả quyết định cũ cho nội dung mới.
- **3 script start/restart**: `start-worker.bat`, `start-worker-bg.bat`, `restart-worker.bat` đều `call clear-systemone-env.bat` (xoá 4 biến `SYSTEMONE_*` kế thừa từ shell cha) trước khi spawn node, và dùng `ping -n` thay `timeout /t` (vì `timeout` đọc stdin ⇒ lỗi "Input redirection is not supported" khi stdin bị redirect). `config.js` **không** ghi đè `process.env` sẵn có ⇒ thiếu bước xoá env là server chạy sai model **không log cảnh báo**.

### 5.1 NGUYÊN TẮC: không lạm dụng SystemOne (2026-10-21)

Chỉ gọi model ở nơi cần **quyết định nhanh**, **có đáp án sẵn**, **input nhỏ**. Tuyệt đối **không cắt bớt dữ liệu input** để ép dùng SystemOne.

| UC | Input | Quyết định | Trạng thái |
|---|---|---|---|
| TRIAGE | prompt (≤2KB) | chọn track quick/full | ✅ giữ — **chọn lọc**: `policy.triageSignals()` (regex, tức thì) quyết định trước; task rõ ràng (quick/large) **không gọi model**; chỉ prompt mơ hồ mới gọi, và chỉ hỏi **2** câu (`is_quick`+`is_large`) — bỏ `need_browser` (kết quả chỉ ghi log) |
| FIXGATE | failures (1.5KB) + file context | retry / scope | ✅ giữ — 1 call/vòng FIXING, quyết định thật |
| GUARD | prompt 10-14KB | có secret? | ❌ **bỏ** → `src/execution/promptGuard.js` scrub local (nhanh, miễn phí, giữ nguyên 100% nội dung) |
| DEDUP | prompt | gán nhãn log | ❌ **bỏ** → `systemone.localDedup()` hash SHA16 local |
| PREJUDGE | summary 1KB | gợi ý kênh (chỉ log) | ❌ **bỏ** — `verifyTaskEvidence` mới là nguồn sự thật, pre-judge không đổi hành vi gì |
| ROUTER | — | chọn agent | ❌ `pickRunner` không có caller — dead code |

Kết quả: giảm **3 network call/step** (guard ×4 + dedup + prejudge → 0) mà **không** cắt bớt dữ liệu nào. Thêm triage chọn lọc (0 call cho task rõ ràng).

**Bug heuristic phát hiện qua test (2026-10-21)**: `triageHeuristic` check `quick` **trước** `large` ⇒ prompt ngắn chứa "migrate/refactor" (<200 ký tự, không chứa `fix|bug|error`) bị phân loại nhầm là **quick** ⇒ bật chế độ nhanh cho task phức tạp. Đã sửa: check `large` trước, thêm `fold()` (bỏ dấu + lowercase) để regex khớp cả text tiếng Việt không dấu.

## 9. Kết quả probe endpoint (2026-10-16 local, 2026-10-21 remote)

- `GET http://localhost:20128/` → `302 /dashboard`; `GET /dashboard` → `302 /login` (gateway Next.js, có trang login, không public API key).
- `GET http://localhost:20128/v1/systemone` → `405` (chỉ cho `POST, OPTIONS` qua CORS).
- `POST http://localhost:20128/v1/systemone` body `{}` không key → `401 {"error":{"message":"Missing API key","type":"authentication_error","code":"invalid_api_key"}}`; sai key → `401 Invalid API key`.
- `GET http://localhost:20128/v1/models` (không key) liệt kê model, gồm `or/openrouter/typesafe/jev-router`, `or/9r/oc/jev-1.13-free`, `oc/jev-1.13-free`.
- **Remote `https://9router.thanhpk.io.vn/v1/systemone` (2026-10-21)**:
  - Key **cũ** (`sk-878d6bd1…`) → `401 {"error":"API key required for remote API access"}` cho **mọi** biến thể header (`Authorization: Bearer`, `x-api-key`, `api-key`, `X-Api-Key`, raw `Authorization`) và mọi path (`/v1/models`, `/api/v1/systemone`, `?api_key=`, `?key=`) ⇒ lỗi ở tầng gateway, không phải format header.
  - Key **mới** (`sk-bd802b6b…`) → `HTTP 200` với `openrouter/typesafe/jev-1.13` (provider `TypeSafe`) và `oc/jev-1.13-free` ⇒ đây là key 9router hợp lệ.
  - `9r/…` và `typesafe/…` (thiếu/thừa prefix) → `HTTP 400 "No credentials for provider: <prefix>"`.
- Kết luận: đường dẫn gọi model là `POST {SYSTEMONE_BASE_URL}` với header auth API key (lấy từ dashboard `/login`, không hardcode vào spec/code). Implement phải đọc key từ `SYSTEMONE_API_KEY` env và che khi log.

```ts
RouterRes = { runner: string; confidence: number; reason: "history"|"capability"|"availability"|"heuristic"|"fallback"; cached: boolean };
TriageRes = { complexity: "S"|"M"|"L"; track: "quick"|"full"; needBrowser: boolean; confidence: number; cached: boolean };
FixGateRes = { retry: boolean; p_success: number; fixScope: "tiny"|"scoped"|"full"; confidence: number; cached: boolean };
PreJudgeRes = { pass: boolean; failedFields: string[]; confidence: number; cached: boolean };
GuardRes = { hasSecret: boolean; hasInjection: boolean; action: "allow"|"scrub"|"block"; confidence: number; cached: boolean };
DedupRes = { bucketId: string; confidence: number; cached: boolean };
```

- Range: `0≤confidence,p_success≤1`; `failedFields ⊆ ["ui","api","log","db"]`; `runner ∈ candidates∪["auto"]`; guard `block` → không spawn.
- Mọi request/response log qua `maskSecrets` trước.

## 6. Offline cache + heuristic (`policy.js`)

- `getCachedOrHeuristic(route,payload)`: cache TTL còn hạn → dùng; hết → heuristic:
  - router: trả `preferredName`, `confidence:0.3`, `reason:"fallback"`.
  - triage: `complexity:"M",track:"full",needBrowser:false,confidence:0.3` (regex `S` khi prompt <200 ký tự và không có `fix|bug|error`; `L` khi có `migrate|refactor|multi-module`).
  - fixGate: `{retry: attempt<maxRetries, p_success:0.3, fixScope:"scoped", confidence:0.3}`.
  - preJudge: `{pass:false, failedFields:["ui","api","log","db"], confidence:0.3}` (fail-open chạy đủ kênh).
  - guard: `{hasSecret:false,hasInjection:false,action:"scrub",confidence:0.3}` (fail-closed an toàn: scrub rồi spawn).
  - dedup: `bucketId = sha256(hash)[:16]`, `confidence:0.3`.
- Không mạng, <50ms, không dep.

## 7. Metric tiết kiệm CLI

- Wrapper đếm quanh `runner.execute()` tại 4 điểm `src/server.js` (không sửa `BaseAdapter`): `cli_calls_per_job`, `cli_saved_total` (+1 mỗi lần router-guard-fixGate-preJudge-dedup tránh được spawn hoặc kênh verify).
- `client.js#getStats()` → `{calls,hits,misses,fallbacks,cliSaved,cost}`; mỗi response cộng `usage.cost` vào `cost`; log kèm `jobId`; expose `GET /api/v1/status` (`src/server.js:446`) hoặc log.
- Benchmark: cùng workload implement+testing+1 fixing ×10 job CLI-only vs SystemOne-first; đạt M-01 ≥50%.

## 8. Files to create / modify

- Tạo: `src/systemone/client.js`, `src/systemone/policy.js` (chỉ 2 file, không tạo `src/systemone/wire.js`).

## 11. Fix review 2026-10-16 (Guard scrub + PreJudge không bypass)

- Guard: `checkGuard` luôn trả `promptToUse` đã qua `maskSecrets`; `allow` chỉ giữ prompt gốc khi `hasSecret=false ∧ hasInjection=false`; `scrub` dùng prompt đã scrub. `src/server.js` 4 điểm planning/implement/testing/fixing truyền `guard.promptToUse` vào `runner.execute()`.
- PreJudge: nhánh VERIFY luôn chạy `verifyTaskEvidence()` thật; PreJudge chỉ log gợi ý lọc kênh, không bypass DONE.
- Sửa: `src/config.js:4-11,20-29`; `src/server.js` 6 điểm trên (chỉ thêm nhánh, không đổi chữ ký); `src/server.js:446` expose stats (tùy, không bắt buộc).
- Không sửa: `dualPlanning.js`, `runnerRegistry.js`, `baseAdapter.js`, `taskQueue.js`, `promptTemplateManager.js`, `multiVerificationGate.js`, `stateMachine.js` (chỉ đọc).

## 10. Hạng mục gộp: fix evidence Log lọt tab API (đã xong, giữ nguyên sau wiring SystemOne)

- Root cause: filter tab API dùng `file_path.includes('api')` nên mọi log đều match; serve xếp `.json`/tên chứa `api` thành API.
- Fix: `src/server.js` thêm `normalizeEvidenceTypeHint/hasApiRuntimeShape/hasDbShape/resolveEvidenceType/evidenceChannelOf` (`.log/.txt` luôn `LOG_TRACE`, `.json` chỉ `API_TEST` khi đủ dáng runtime), gắn `evidence_type/channel`; `public/app.js` filter theo `channel` + basename; `src/verification/browserRunner.js` gắn `UI_SCREENSHOT/ui`; `src/storage/db.js:getEvidenceByJobId` map thêm `evidence_type/channel`.
