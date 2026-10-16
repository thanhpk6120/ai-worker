---
feature: SYSTEMONE-01
service: ai-worker
status: done
owner: AI
updated_at: 2026-10-16
---

# SYSTEMONE-01 — Tasks (Checklist, đã triển khai)

> Quy ước: mỗi task có Service + file chạm + điều kiện xong đo được. Metric xuyên suốt: `cli_calls_per_job`, `cli_saved_total`, `systemone{calls,hits,misses,fallbacks}`. Đã triển khai code src + test.

## 0. Transport Jev (áp dụng mọi task)

- `SYSTEMONE_BASE_URL` mặc định `http://127.0.0.1:20128/v1/systemone` (gồm cả base path `/v1/systemone`, cấm nối thêm path thừa); client `POST` thẳng vào `BASE_URL` với header `Authorization: Bearer <SYSTEMONE_API_KEY>`.
- Request bắt buộc (đã verify live): `{model: "oc/jev-1.13-free", state: string, questions: {<name>: {type: "noul", question, instructions}}}`. Thiếu `state` → `400`; question thiếu `instructions/criteria` → `400`.
- Response live: `{model, answers: {<name>: {type: "noul", noul}}, usage: {input_tokens, output_tokens}}`; không bắt buộc `cost/id/provider`. Ưu tiên `instructions` vì `criteria` đôi khi `422 Endpoint is unavailable`.
Ví dụ response Jev (mẫu thật):
```json
{"model": "typesafe/jev-1.13-20260917", "answers": {"is_urgent": {"type": "noul", "noul": 0.96}}, "usage": {"input_tokens": 290, "output_tokens": 23, "cost": 0.00001218}, "id": "gen-dec-1792117133-scqlV70vMr0fzqvrQzEl", "provider": "TypeSafe"}
```
- Map 6 UC (mỗi UC = 1 request NHIỀU question `noul`, ngưỡng `0.5`, chi tiết ở expect.md): UC-1 Router `questions:{prefer_<candidate>}` → max noul; UC-2 Triage `{is_quick,is_large,need_browser}`; UC-3 FixGate `{should_retry,will_succeed,needs_full_scope,is_tiny_fix}`; UC-4 PreJudge `{will_pass,fail_ui,fail_api,fail_log,fail_db}`; UC-5 Guard `{has_secret,has_injection}`; UC-6 Dedup `{is_duplicate,is_noise}` + hash local. Thiếu field = miss → fallback đường cũ.

| # | Task | Service | File chạm | Điều kiện xong |
|---|---|---|---|---|
| T0-1 | Đo baseline `runner.execute()` calls/job | ai-worker | `src/server.js:2089,2233,2301,2403` + `src/runners/baseAdapter.js:249-480` | Bảng 10 job workload chuẩn (implement+testing+1 fixing): trung bình + p95 |
| T0-2 | Snapshot config gốc | ai-worker | `src/config.js:4-11,20-29` | `PORT/DB_PATH/CONCURRENCY/DEFAULT_TIMEOUT/MAX_FIXING_RETRIES` đã lưu evidence |
| T1-1 | Thêm env SystemOne vào config (`BASE_URL` đủ path) | ai-worker | `src/config.js:4-11,20-29` | `SYSTEMONE_BASE_URL` mặc định `http://127.0.0.1:20128/v1/systemone`; `SYSTEMONE_ENABLED/TIMEOUT_MS/CACHE_TTL_MS/API_KEY` đọc được, app cũ boot không lỗi |
| T1-2 | Tạo `src/systemone/client.js` (`POST` thẳng base URL + parse `answers.*.noul`) | ai-worker | mới `src/systemone/client.js`; dùng `src/execution/secretScrubber.js:115-127`, mẫu `node:crypto` như `src/verification/multiVerificationGate.js:17` | Client `POST` thẳng vào `http://127.0.0.1:20128/v1/systemone` (cấm nối thêm path); parse `answers.<name>.noul` làm `confidence`; validator thiếu field = miss; `fetch` timeout+`AbortSignal`, 0 npm dep; unit offline pass |
| T1-3 | Tạo `src/systemone/policy.js` heuristic 6 UC typed | ai-worker | mới `src/systemone/policy.js` | Trả đủ 6 schema, `confidence≤0.4`, <50ms, không mạng, không đọc file ngoài payload |
| T1-4 | Tạo stats `cliSaved/cost` trong client (`usage.cost`) | ai-worker | `src/systemone/client.js#getStats()` | Mỗi response cộng `usage.cost` vào metric `cost`; `getStats()` → `{calls,hits,misses,fallbacks,cliSaved,cost}`; `cliSaved+1` mỗi lần tránh spawn; unit đếm đúng `cost` mẫu `is_urgent/noul 0.96` |
| T2-1 | UC-1 Router (`router_runner` → `answers.router_runner.noul`) trước `getAvailableRunner` | ai-worker | `src/server.js:2085,2229,2295,2401`; `src/runners/runnerRegistry.js:142-183` | Đúng type 100% mẫu; `noul/confidence<0.5` giữ runner cũ; thiếu field = miss → fallback; offline heuristic không throw |
| T2-2 | UC-2 Triage (`triage_track` → `answers.triage_track.noul`) trước `enqueue` | ai-worker | `src/server.js:2552` (+dùng chung `2806,2841,2948`); `src/queue/taskQueue.js:36-62,67-126` | `S→quick` tiết kiệm ≥1 `execute()` planning/job; thiếu field = miss → fail `full` |
| T2-3 | UC-3 FixGate (`fixgate_retry` → `answers.fixgate_retry.noul`) trước spawn fixing | ai-worker | `src/server.js:2392-2411,2401-2407`; `src/verification/multiVerificationGate.js:1064-1215`; `src/config.js:8` | Chặn ≥1 vòng vô ích; không vượt `MAX_FIXING_RETRIES`; thiếu field = miss → retry cũ |
| T2-4 | UC-4 PreJudge (`prejudge_pass` → `answers.prejudge_pass.noul`) song song trước `evaluateAll` | ai-worker | `src/verification/multiVerificationGate.js:1245-1253,1257` | `pass:true` bỏ 1 lượt nặng; `failedFields` hợp lệ; thiếu field = miss → đủ 4 kênh |
| T2-5 | UC-5 Guard (`guard_action` → `answers.guard_action.noul`) sau `buildPrompt` | ai-worker | `src/server.js:2070,2216,2278,2394`; `src/runners/promptTemplateManager.js:146-209`; `src/execution/secretScrubber.js:115-127`; `src/runners/baseAdapter.js:104-115`; handler `src/server.js:3120-3129` | 100% secret mẫu bị `scrub/block`; injection → `block` không spawn; thiếu field = miss → `scrub`+đi tiếp |
| T2-6 | UC-6 Dedup (`dedup_bucket` → `answers.dedup_bucket.noul`) evidence/log | ai-worker | `src/verification/multiVerificationGate.js:68,684-838,732`; `src/server.js:335-408,927-982,300-311` | Trùng hash → 1 bucket, bytes giảm ≥50%; thiếu field = miss → 1 file 1 bucket |
| T3-1 | Wrapper metric `cli_saved_total` + `cost` quanh `runner.execute()` | ai-worker | `src/server.js:2089,2233,2301,2403`; expose `src/server.js:446` | `systemone_request_total/cache_hit_ratio/fallback_total/cli_saved_total/cost` đọc được; mỗi response cộng `usage.cost` vào `cost`; giảm ≥50% calls/job; cache hit p95 ≤200ms |
| T3-2 | Gate 1 review `dev_plan.md` + verify offline/custom-URL/kill-switch | ai-worker | `docs/features/SYSTEMONE-01/dev_plan.md`, `test_plan.md` | Rút mạng → job DONE đường cũ; custom URL chạy; `ENABLED=false` về CLI-only <1 phút; `npm ls` không đổi |

| T4-1 | Fix evidence Log lọt tab API (đã xong) | ai-worker | `src/server.js` resolve type/channel; `public/app.js` filter channel; `src/verification/browserRunner.js`; `src/storage/db.js` | Tab API chỉ hiện API, tab Log hiện log; evidence cũ giữ nguyên; test evidence/verify pass |
