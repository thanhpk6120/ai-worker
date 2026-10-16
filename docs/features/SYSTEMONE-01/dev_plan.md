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
- Luồng chuẩn mỗi UC: `maskSecrets` → check cache → `POST` thẳng vào `SYSTEMONE_BASE_URL` (`http://127.0.0.1:20128/v1/systemone`, cấm nối thêm path thừa) với body `{model?, questions: {<name>: {type, question/context}}}` + timeout → validate `answers.<name>.noul` → ghi cache + `stats` (cộng `usage.cost` vào metric `cost`) → trả kết quả. Lỗi bất kỳ bước nào → cache cũ → heuristic → đường cũ.

## 3. Config env

- File chạm: `src/config.js:4-11` hằng, `src/config.js:20-29` exports.
- `SYSTEMONE_ENABLED` mặc định `true`; `false` = bypass toàn bộ.
- `SYSTEMONE_BASE_URL` mặc định `http://127.0.0.1:20128/v1/systemone` (gồm cả base path `/v1/systemone`, cấm nối thêm path thừa); client `POST` thẳng vào `BASE_URL`. Custom self-host, cấm hardcode.
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

- Transport (đã verify live 2026-10-16): `POST` thẳng vào `SYSTEMONE_BASE_URL` mặc định `http://127.0.0.1:20128/v1/systemone` (gồm cả base path `/v1/systemone`, cấm nối thêm path thừa). Header `Authorization: Bearer <SYSTEMONE_API_KEY>`.
- Request bắt buộc: `{model: "oc/jev-1.13-free", state: string, questions: {<name>: {type: "noul", question, instructions|criteria}}}`. Thiếu `state` → `400`; question thiếu `instructions/criteria` → `400`; thiếu/sai key → `401`.
- Response live: `{model, answers: {<name>: {type: "noul", noul}}, usage: {input_tokens, output_tokens}}`; không bắt buộc `cost/id/provider`. Field `noul: number [0,1]` dùng làm `confidence`.
- Ví dụ live `HTTP 200`: `{"model": "jev-1.13-free", "answers": {"is_quick": {"type": "noul", "noul": 0.38}, "need_browser": {"type": "noul", "noul": 0.91}, "has_secret": {"type": "noul", "noul": 0.95}}, "usage": {"input_tokens": 328, "output_tokens": 56}}`.
- Map 6 UC: mỗi UC = 1 request POST với NHIỀU question `noul` (mỗi answer chỉ 1 số thực [0,1]); ánh xạ ngưỡng sang typed, ngưỡng mặc định `0.5`. Router: `questions:{prefer_<candidate>}` → max noul; Triage: `{is_quick,is_large,need_browser}`; FixGate: `{should_retry,will_succeed,needs_full_scope,is_tiny_fix}`; PreJudge: `{will_pass,fail_ui,fail_api,fail_log,fail_db}`; Guard: `{has_secret,has_injection}`; Dedup: `{is_duplicate,is_noise}` + hash local. Thiếu field = miss → fallback.
- Lưu ý model: `typesafe/jev-1.13-20260917` báo `No credentials for provider: typesafe`; `or/9r/oc/jev-1.13-free` và `or/openrouter/typesafe/jev-router` trả `HTTP 500` rỗng. Chỉ `oc/jev-1.13-free` gọi live OK nên chốt model này; `criteria` đôi khi vẫn `422 Endpoint is unavailable`, ưu tiên dùng `instructions`.

## 9. Kết quả probe endpoint local (2026-10-16)

- `GET http://localhost:20128/` → `302 /dashboard`; `GET /dashboard` → `302 /login` (gateway Next.js, có trang login, không public API key).
- `GET http://localhost:20128/v1/systemone` → `405` (chỉ cho `POST, OPTIONS` qua CORS).
- `POST http://localhost:20128/v1/systemone` body `{}` không key → `401 {"error":{"message":"Missing API key","type":"authentication_error","code":"invalid_api_key"}}`; sai key → `401 Invalid API key`.
- `GET http://localhost:20128/v1/models` (không key) liệt kê model, gồm `or/openrouter/typesafe/jev-router`, `or/9r/oc/jev-1.13-free`, `oc/jev-1.13-free`.
- Kết luận: đường dẫn gọi model là `POST {SYSTEMONE_BASE_URL}` với header auth API key (lấy từ dashboard `/login`, không hardcode vào spec/code). Chưa có key thật nên chưa gọi Jev mẫu được; implement phải đọc key từ `SYSTEMONE_API_KEY` env và che khi log.

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
