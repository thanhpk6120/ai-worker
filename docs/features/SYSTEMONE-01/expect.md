---
feature: SYSTEMONE-01
service: ai-worker
status: done
owner: BA / User
updated_at: 2026-10-16
---

# SYSTEMONE-01 — Expect (Kỳ vọng nghiệp vụ)

> Jev (SystemOne): System-1 ra quyết định typed + calibrated probability. Không sinh văn bản tự do.

## 0. Ghi nhận lệch docs cũ [BẮT BUỘC ĐỌC TRƯỚC]

Đối chiếu `expect.md/plan.md/tasks.md` cũ (trước 2026-10-16) với định nghĩa Jev:

| UC cũ | Nội dung cũ | Phán định | Lý do sai |
|---|---|---|---|
| UC-1 cũ | Sinh dev_plan markdown qua SystemOne tại `src/pipeline/dualPlanning.js:32-218` | **SAI** | Sinh markdown tự do, không phải typed-decision. `dualPlanning.js` chỉ ghép template local, không spawn CLI. |
| UC-2 cũ | Sinh test_plan markdown + `verifyConsistency` | **SAI** | Sinh markdown tự do. Tiết kiệm CLI gắn sai chỗ (planning local không tốn CLI). |
| UC-3 cũ | Triage log Verify→Fixing trả `{severity, rootCause, suggestedFix}` text | **SAI một nửa** | Ý đúng (triage) nhưng schema tự do, thiếu `complexity/track/needBrowser/p_success` calibrated. Giữ ý, viết lại schema typed. |
| UC-4 cũ | Enrich fixing context pack xếp hạng evidence | **SAI** | Enrich/nén prompt tự do, không phải cổng quyết định typed `{retry, p_success, fixScope}`. |
| UC-5 cũ | Nén/rút gọn prompt `buildPrompt` ≥15% | **SAI** | Nén prompt tự do. Đúng phải là Guard `{hasSecret, hasInjection, action}` chặn trước spawn. |
| UC-6 cũ | Thay CLI runner khi `detectAll()` false hết | **SAI** | Thay CLI runner = sinh thực thi tự do. Đúng phải là Router `{runner, confidence}` chọn runner trước spawn, fallback đường cũ. |

Kết luận: xóa toàn bộ 6 UC cũ. Viết lại 6 UC dưới đây theo typed-decision. Không còn UC nào sinh markdown/dev_plan/test_plan/enrich/nén/thay-runner.

## 1. Bối cảnh + chứng cứ spawn CLI thật

- `src/pipeline/dualPlanning.js` **chỉ ghép template local**: `require('node:fs','node:path')`, class `DualPlanningGenerator`, `generateDevPlan:32-218`, `generateTestPlan:231-464`, `verifyConsistency:474-611`, `savePlans:623-645`. Không `fetch/spawn/exec/execute/http`. Không tốn CLI call. Gắn tiết kiệm CLI ở đây là sai.
- `src/server.js` **mới là nơi spawn CLI thật**:
  - `src/server.js:2070-2073` `buildPrompt(step:planning)` → `src/server.js:2085` `runnerRegistry.getAvailableRunner(planningAgent)` → `src/server.js:2089-2093` `runner.execute({prompt: planningPrompt})`
  - `src/server.js:2216` `buildPrompt(step:implement)` → `src/server.js:2229` `getAvailableRunner` → `src/server.js:2233-2236` `runner.execute`
  - `src/server.js:2278-2282` `buildPrompt(step:testing)` → `src/server.js:2295` `getAvailableRunner` → `src/server.js:2301-2306` `runner.execute(timeoutMs:900000)`
  - `src/server.js:2394-2398` `buildPrompt(step:fixing)` → `src/server.js:2401` `getAvailableRunner` → `src/server.js:2403-2407` `runner.execute`
  - `src/server.js:2552` `taskQueue.enqueue(job, ()=>runJobPipeline(id))` (điểm enqueue chính; thêm `2806,2841,2948` retry/probe enqueue; `881` đang comment-out)
  - `src/server.js:837-871` gọi `DualPlanningGenerator` local fallback (không CLI)
- Điều phối: `src/runners/runnerRegistry.js:142-175` `getAvailableRunner`, `:181-183` `resolveRunner`; thực thi: `src/runners/baseAdapter.js:249-480` `execute()`; hàng đợi: `src/queue/taskQueue.js:36-62` `enqueue`, `:67-126` `_processNext`, `:133-151` `cancel`; prompt: `src/runners/promptTemplateManager.js:146-209` `buildPrompt`; secret: `src/execution/secretScrubber.js:115-127` `maskSecrets`; verify: `src/verification/multiVerificationGate.js:1245-1253` `evaluateAll`, `:1257` `Promise.allSettled` 4 kênh, `:1064-1215` `FixingContextPackGenerator`.

→ Mọi điểm tiết kiệm CLI phải chèn quanh `src/server.js:2085,2229,2295,2401` (trước `runner.execute`) và `src/server.js:2552` (trước `enqueue`). Không chèn vào `dualPlanning.js`.

## 2. Actors + mục tiêu

- Actors: Job pipeline (`runJobPipeline`), Dev/QA, SystemOne service (HTTP).
- Mục tiêu P0: giảm số `runner.execute()` invocations/job bằng 6 quyết định typed rẻ (HTTP SystemOne / cache / heuristic) thay cho 1 lần spawn CLI đắt.
- M-01: giảm ≥50% `runner.execute()` calls/job workload chuẩn (implement + testing + 1 fixing).
- M-02: 100% SystemOne fail/offline → job đi tiếp đường cũ, không treo `TaskQueue`.
- M-03: 0 rò rỉ secret qua SystemOne.
- M-04: cache hit p95 ≤200ms.

## 3. Sáu UC đúng Jev typed-decision (schema bắt buộc)

- Contract vận chuyển (áp dụng mọi UC, đã verify live 2026-10-21): `SYSTEMONE_BASE_URL` **mặc định trong code = `http://127.0.0.1:20128/v1/systemone`** (self-host local, cấm hardcode domain); `.env` trỏ tới `https://9router.thanhpk.io.vn/v1/systemone`. Client `POST` thẳng vào `BASE_URL`, cấm nối thêm path thừa. Header `Authorization: Bearer <SYSTEMONE_API_KEY>`, `Content-Type: application/json`.
- Request bắt buộc: `{model, state, questions}`. `model` dùng `openrouter/typesafe/jev-1.13` (đã gọi live OK 2026-10-21, provider `TypeSafe`; **bỏ prefix `openrouter/` sẽ ra 400 "No credentials for provider: typesafe"**). `state` là string ngữ cảnh (thiếu → `400 Missing required field: state`). Mỗi question `noul` bắt buộc có `question` + (`instructions` hoặc `criteria`); thiếu → `400 Noul question must have criteria or instructions`.
- Response live: `{model, answers: {<name>: {type: "noul", noul: number}}, usage: {input_tokens, output_tokens}}` (`cost/id/provider` có thể vắng, không validator bắt buộc). Field `noul: number [0,1]` là calibrated probability, dùng làm `confidence`.
- Ví dụ gọi live thành công (`HTTP 200`, `model: openrouter/typesafe/jev-1.13` → provider `TypeSafe`, model thực `typesafe/jev-1.13-20260917`):
```json
{"model": "typesafe/jev-1.13-20260917", "answers": {"is_urgent": {"type": "noul", "noul": 0.96}}, "usage": {"input_tokens": 290, "output_tokens": 23, "cost": 0.00001218}, "id": "gen-dec-...", "provider": "TypeSafe"}
```
- Map 6 UC: mỗi UC = 1 request POST với NHIỀU question `noul` trong `questions:{...}` (vì mỗi answer `noul` chỉ trả 1 số thực [0,1]); client ánh xạ ngưỡng `noul` sang object typed. Thiếu field = miss → fallback đường cũ. Ngưỡng mặc định `0.5`, hiệu chỉnh ở dev_plan.
- Không sinh markdown tự do ở bất kỳ UC nào.

### UC-1 — Router chọn runner `{runner, confidence}`

- Vị trí: `src/server.js:2085,2229,2295,2401` trước `runnerRegistry.getAvailableRunner()`; logic trong `src/runners/runnerRegistry.js:142-183`.
- Schema:
```ts
type RouterReq = { taskCode: string; step: "planning"|"implement"|"testing"|"fixing"; candidates: string[]; jobId: string };
type RouterRes = { runner: string; confidence: number; reason: "history"|"capability"|"availability"|"heuristic"|"fallback"; cached: boolean };
```
- Validator: `runner ∈ candidates ∪ ["auto"]`, `0≤confidence≤1`. Invalid → dùng `getAvailableRunner(preferredName)` cũ.
- Jev mapping (multi-question, 1 request): `questions:{prefer_<candidate>:{type:"noul",question:"..."} }` cho mỗi candidate; `runner` = candidate có `noul` cao nhất; `confidence` = `noul` max đó; tất cả `<0.5` → fallback `getAvailableRunner(preferredName)` cũ.
- Acceptance: A1 router trả đúng type 100% request mẫu; A2 `confidence<0.5` → giữ runner cũ, vẫn đếm `cli_saved+1` nếu tránh được `detect()`+spawn thử sai; A3 offline → heuristic chọn `preferredName`, không throw.

### UC-2 — Triage trước enqueue `{complexity, track, needBrowser}`

- Vị trí: `src/server.js:2552` trước `taskQueue.enqueue()` (và `2806,2841,2948` dùng chung helper); hàng đợi `src/queue/taskQueue.js:36-62,67-126`.
- Schema:
```ts
type TriageReq = { taskCode: string; prompt: string; jobId: string };
type TriageRes = { complexity: "S"|"M"|"L"; track: "quick"|"full"; needBrowser: boolean; confidence: number; cached: boolean };
```
- Quy tắc: `S→quick` (bỏ planning CLI, đi fast-path), `M/L→full`. `needBrowser=true` → gắn cờ requireBrowserEvidence cho `LogScanner`/`UiEvidenceCollector`.
- Jev mapping (multi-question, 1 request): `questions:{is_quick:{type:"noul"}, is_large:{type:"noul"}, need_browser:{type:"noul"}}`; `is_quick≥0.5` → `S/quick`; `is_large≥0.5` → `L/full`; còn lại `M/full`; `needBrowser = need_browser≥0.5`; `confidence` = `max(noul)` tương ứng; thiếu field = miss → `track:full`.
- Acceptance: A1 phân loại đúng track ≥90% bộ prompt mẫu; A2 `S/quick` tiết kiệm ≥1 `runner.execute()` planning/job; A3 fail → `track:full` đường cũ.

### UC-3 — Cổng retry/fix `{retry, p_success, fixScope}`

- Vị trí: nhánh `FIXING` `src/server.js:2392-2411` trước `src/server.js:2401-2407` spawn fixing; dùng `FixingContextPackGenerator` `src/verification/multiVerificationGate.js:1064-1215` làm input; tôn trọng `MAX_FIXING_RETRIES` `src/config.js:8`.
- Schema:
```ts
type FixGateReq = { jobId: string; attempt: number; maxRetries: number; failures: object; files: string[] };
type FixGateRes = { retry: boolean; p_success: number; fixScope: "tiny"|"scoped"|"full"; confidence: number; cached: boolean };
```
- Quy tắc: `attempt>=maxRetries` → `retry:false`. `p_success<0.3 ∧ fixScope==full` → dừng sớm, mark FAILED sạch qua `transition()` thay vì spawn CLI vô ích.
- Jev mapping (multi-question, 1 request): `questions:{should_retry:{type:"noul"}, will_succeed:{type:"noul"}, needs_full_scope:{type:"noul"}, is_tiny_fix:{type:"noul"}}`; `retry = should_retry≥0.5`; `p_success = will_succeed.noul`; `fixScope = needs_full_scope≥0.5 ? full : is_tiny_fix≥0.5 ? tiny : scoped`; thiếu field = miss → retry đường cũ.
- Acceptance: A1 chặn ≥1 vòng fixing vô ích trên workload lỗi nặng; A2 không vượt `MAX_FIXING_RETRIES`; A3 fail → cho retry đường cũ.

### UC-4 — Pre-judge verification song song `{pass, failedFields}`

- Vị trí: trước `MultiVerificationGate.evaluateAll()` `src/verification/multiVerificationGate.js:1245-1253` (chạy `Promise.allSettled` 4 kênh tại `:1257`); gọi từ pipeline testing/fixing trong `src/server.js`.
- Schema:
```ts
type PreJudgeReq = { jobId: string; featureName: string; testPlan: object };
type PreJudgeRes = { pass: boolean; failedFields: string[]; confidence: number; cached: boolean };
```
- Quy tắc: `pass:true` → bỏ qua 1 lượt verify nặng/CLI probe; `pass:false` → chỉ chạy kênh trong `failedFields` (vd `["api","db"]`), không chạy cả 4.
- Jev mapping (multi-question, 1 request): `questions:{will_pass:{type:"noul"}, fail_ui:{type:"noul"}, fail_api:{type:"noul"}, fail_log:{type:"noul"}, fail_db:{type:"noul"}}`; `pass = will_pass≥0.5 ∧ mọi fail_*<0.5`; `failedFields = [k ∈ {ui,api,log,db} | fail_k≥0.5]`; rỗng khi pass; thiếu field = miss → đủ 4 kênh.
- Acceptance: A1 giảm ≥1 kênh verify/job khi pass; A2 `failedFields ⊆ ["ui","api","log","db"]`, rỗng khi pass; A3 fail → chạy đủ 4 kênh đường cũ.

### UC-5 — Guard prompt/secret `{hasSecret, hasInjection, action}`

- Vị trí: sau `buildPrompt()` `src/runners/promptTemplateManager.js:146-209` tại 4 điểm `src/server.js:2070,2216,2278,2394`, trước `runner.execute`; scrub bằng `maskSecrets` `src/execution/secretScrubber.js:115-127` + `BaseAdapter.maskSecrets` `src/runners/baseAdapter.js:104-115`.
- Schema:
```ts
type GuardReq = { jobId: string; step: string; prompt: string };
type GuardRes = { hasSecret: boolean; hasInjection: boolean; action: "allow"|"scrub"|"block"; confidence: number; cached: boolean };
```
- Quy tắc: `allow` → spawn; `scrub` → spawn bằng prompt đã `maskSecrets`; `block` → không spawn (`cli_saved+1`), job FAILED/CANCELLED sạch, log đã che.
- Jev mapping (multi-question, 1 request): `questions:{has_secret:{type:"noul"}, has_injection:{type:"noul"}}`; `hasSecret = has_secret≥0.5`; `hasInjection = has_injection≥0.5`; `action = (hasSecret∨hasInjection)≥0.8 ? block : (hasSecret∨hasInjection)≥0.5 ? scrub : allow`; thiếu field = miss → `scrub` + đi tiếp.
- Acceptance: A1 100% case `sk-ant-/ghp_/Bearer/JWT/PEM` → `scrub/block`, không lọt secret; A2 injection `ignore previous instructions` → `block`; A3 fail-closed an toàn: guard lỗi → `scrub` + đi tiếp đường cũ, không crash (`src/server.js:3120-3129`).

### UC-6 — Dedup + bucket evidence/log `{bucketId}`

- Vị trí: `UiEvidenceCollector.verify` `src/verification/multiVerificationGate.js:68`, `LogScanner` `:684-838` (mask tại `:732`), evidence serve `src/server.js:335-408`, `getTaskEvidences:927-982`, `hashEvidenceBuffer:300-311`.
- Schema:
```ts
type DedupReq = { jobId: string; kind: "evidence"|"log"; hash: string; bytes: number };
type DedupRes = { bucketId: string; confidence: number; cached: boolean };
```
- Quy tắc: cùng `hash` → cùng `bucketId`, chỉ gửi 1 mẫu đại diện lên SystemOne/CLI, còn lại trỏ bucket. Giảm payload fixing/testing.
- Jev mapping (kết hợp local+Jev, 1 request): `bucketId` tính cục bộ từ `hash` (cùng hash → cùng bucket); Jev chỉ hỏi `questions:{is_duplicate:{type:"noul"}, is_noise:{type:"noul"}}` để quyết định tái dùng bucket (`is_duplicate≥0.5` → trỏ bucket cũ) và giảm payload (`is_noise≥0.5` → bỏ mẫu); thiếu field = miss → mỗi file 1 bucket.
- Acceptance: A1 10 file trùng hash → 1 bucket, giảm bytes gửi ≥50%; A2 log 500 dòng trùng → 1 bucket; A3 fail → mỗi file 1 bucket riêng, đi tiếp.

## 4. Ràng buộc cứng

- R-01 fallback đường cũ: mọi UC lỗi/timeout/schema-invalid/offline → hành vi cũ (runner cũ, `track:full`, retry cũ, đủ 4 kênh, scrub+spawn, không dedup). Không thêm `JOB_STATUSES` (`src/state/stateMachine.js:3-15`), không phá `VALID_TRANSITIONS`.
- R-02 offline cache+heuristic: cache RAM TTL key=SHA256(payload đã scrub); miss+offline → heuristic local <50ms trả typed đủ field với `confidence≤0.4`, `cached:false`, `reason/fallback`.
- R-03 custom URL: `SYSTEMONE_BASE_URL` mặc định `http://127.0.0.1:20128/v1/systemone` (gồm cả base path `/v1/systemone`, cấm nối thêm path thừa); client `POST` thẳng vào `BASE_URL`. Cấm hardcode domain trong code. `SYSTEMONE_ENABLED=false` bypass toàn bộ về CLI-only <1 phút, không migrate DB.
- R-04 zero dep: chỉ `fetch` global Node24 + `node:crypto` + `AbortController`. Không thêm `package.json`. Timeout SystemOne < `DEFAULT_TIMEOUT` (`src/config.js:7`).
- R-05 metric tiết kiệm CLI: đếm tại điểm spawn `src/server.js` (wrapper quanh `runner.execute`), không sửa chữ ký `BaseAdapter/RunnerRegistry/TaskQueue`. Counters: `systemone_request_total{route}`, `systemone_cache_hit_ratio`, `systemone_fallback_total{reason}`, `cli_saved_total`. Mỗi response cộng `usage.cost` vào metric `cost` (kèm `cliSaved`).

## 5. Out-of-scope

- Không sinh markdown `dev_plan/test_plan` bằng SystemOne; `dualPlanning.js` giữ nguyên template local fallback.
- Không enrich/nén prompt tự do, không thay runner thực thi, không sửa pipeline lifecycle/status.

## 7. Hạng mục gộp đợt này: fix evidence Log lọt tab API (đã xong)

- Hiện tượng: evidence `.log/.txt` hiển thị nhầm ở tab evidence API do filter UI dùng `file_path.includes('api')` trong khi mọi `file_path` đều chứa `/api/v1/jobs/...`.
- Kỳ vọng: tab API chỉ hiện `API_TEST` đủ dáng runtime endpoint + method/status; tab Log hiện `LOG_TRACE` (`.log/.txt` luôn là log); evidence cũ không mất.
- Acceptance: job có cả log + API thì tab API không còn log; 31 test evidence/verify pass.