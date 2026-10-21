---
feature: SYSTEMONE-01
service: ai-worker
status: done
owner: AI + QA
updated_at: 2026-10-16
---

# SYSTEMONE-01 — Test Plan (Kế hoạch kiểm thử đa kênh)

> Không kiểm thử sinh markdown. Chỉ kiểm thử 6 quyết định typed + fallback + metric.

## 1. Phạm vi

- 6 UC Router/Triage/FixGate/PreJudge/Guard/Dedup tại điểm chèn `src/server.js:2562,2586,2720,2737,2791,2812,2941,2988,3211` + `src/verification/multiVerificationGate.js:1245-1253,68,684-738`.
- Ràng buộc: offline, custom URL, zero dep, secret, metric `cliSaved/cost` từ `systemone.getStats()`.

## 2. Kênh kiểm thử

| Kênh | Áp dụng |
|---|---|
| API | `POST /api/v1/jobs` (`src/server.js:852`), `GET /api/v1/status` (`:554`), `GET /api/v1/runners` (`:643`), handler `src/execution/promptGuard.js:52-74` |
| Log | `LogScanner` (`:684-738`), `parseOutput/parseSummary` (`src/runners/baseAdapter.js:123-150,211-235`), SSE `src/server.js:36-169` (route `:3662`) |
| DB | `db.getJobById/updateJob`, `transition()` (`src/state/stateMachine.js:121-161`), `MAX_FIXING_RETRIES` (`src/config.js:89`) |
| UI/Evidence | `UiEvidenceCollector.verify` (`:68`), serve `src/server.js:438-507`, `getTaskEvidences:1162-1326`, `hashEvidenceBuffer:403-410` |

## 3. Testcase (typed-only)

- T-API-01 Router: mock SystemOne trả `{runner,confidence}` đúng type → `getAvailableRunner` nhận đúng runner; thiếu field → fallback runner cũ. Đo `cli_saved+1` khi tránh spawn thử sai.
- T-API-02 Triage: prompt S → `track:quick` bỏ 1 `runner.execute()` planning; prompt L → `full`; SystemOne down → `full` đường cũ; `needBrowser=true` → cờ evidence được gắn.
- T-API-03 FixGate: `attempt>=maxRetries` → `retry:false`, không spawn (`src/server.js:2988-2997` không gọi); `p_success<0.3+full` → dừng sớm FAILED sạch; fail → retry đường cũ, không vượt `MAX_FIXING_RETRIES`.
- T-API-04 PreJudge song song: `pass:true` → bỏ 1 lượt verify nặng; `pass:false+failedFields:["api","db"]` → chỉ chạy 2 kênh (dựa `Promise.allSettled` `:1257`); invalid `failedFields` → đủ 4 kênh.
- T-LOG-01 Guard: `sk-ant-/ghp_/Bearer/JWT/PEM` → `scrub/block`, log đã che; `ignore previous instructions` → `block`, `runner.execute()` không gọi; guard lỗi → `scrub` + đi tiếp, process không crash.
- T-DB-01 Dedup: 10 evidence trùng hash → 1 `bucketId`, bytes gửi giảm ≥50%; log 500 dòng trùng → 1 bucket; SystemOne fail → mỗi file 1 bucket, job đi tiếp.
- T-LOG-02 Offline: rút mạng/DNS fail/timeout → cả 6 UC về heuristic typed `confidence≤0.4`, job DONE đường cũ, `fallback+1`.
- T-API-05 Custom URL + kill-switch: `SYSTEMONE_BASE_URL` self-host vẫn chạy; `SYSTEMONE_ENABLED=false` → CLI-only <1 phút, không migrate DB.
- T-API-06 Metric: workload implement+testing+1 fixing ×10 job, so số lần gọi CLI-only vs SystemOne-first; đạt giảm ≥50%, cache hit p95 ≤200ms, `getStats()` (`cliSaved/cost/calls/hits/misses/fallbacks`) đọc được qua `GET /api/v1/runners`.

## 4. Pass criteria

- 100% testcase trên pass offline (không cần mạng thật, mock `fetch` + rút mạng thật cho T-LOG-02).
- 0 secret lọt, 0 crash process, 0 thêm `JOB_STATUSES`, `npm ls` không đổi.

## 5. Hạng mục gộp: evidence tab (đã xong)

- T-EVI-01: job có cả `*.log` + `02_api_verification.json` → tab API chỉ hiện API, tab Log hiện log.
- T-EVI-02: evidence cũ không `evidence_type` vẫn hiển thị đúng qua fallback `type` + đuôi file.
