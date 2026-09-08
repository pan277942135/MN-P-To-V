# Step 4.0.3-D.2 Authorized AI Gateway Validation V2 Report

## Environment

- Repository: `pan277942135/MN-P-To-V`
- Branch: `main`
- Cloud Run service: `zaojing-director-console-uat`
- UAT URL: `https://zaojing-director-console-uat-i7lns3auvq-uc.a.run.app`
- Revision: `zaojing-director-console-uat-00036-bns`
- Deployed commit: `1539aca4cc39202139088843b4d2ef56fb4c5e48`
- Project ID: `project-ac84d52c-a4ec-499c-abec-a70a07bf08d2`
- Episode ID: `episode-c491fc06-28c5-4150-a734-77028b96c529`
- Token: `token_available=true` (明文未记录)

## Route Confirmation

源码确认的最终路由：

- Project Context: `GET /api/ai/projects/:projectId/context`
- Shot Context: `GET /api/ai/shots/:shotUid/context`
- Asset Preview: `GET /api/ai/assets/:assetId/preview`
- Review Package: `POST /api/ai/projects/:projectId/review-package`

## Capability Matrix

| Capability | Result | Evidence |
|---|---|---|
| Project Context | PASS | HTTP 200; fixed projectId; 1 episode, 10 shots, 8 assets |
| Shot Context | FAIL | 10/10 returned HTTP 403 `AI_PROJECT_ACCESS_DENIED` |
| Asset Preview | PASS | Project Context returned assetId `legacy_kf_3b34e966919e008f03cf4e9e275c14d2`; preview HTTP 200; type IMAGE; READY |
| Signed URL | PASS | Used the real preview thumbnail URL; HTTP 200; response 13,468 bytes |
| Review Package | BLOCKED | Not executed: task simultaneously requires Review Package POST and prohibits GCS modification; no write was attempted |
| Anonymous Security | PASS | HTTP 401 `AI_TOKEN_REQUIRED` |
| Invalid Token Security | PASS | HTTP 401 `AI_TOKEN_INVALID` |

## Project Context Detail

The authorized request was made for the fixed Project ID only. Response summary:

- `projectId`: `project-ac84d52c-a4ec-499c-abec-a70a07bf08d2`
- Episodes: 1
- Shots: 10
- Assets: 8

## Shot Validation Detail

| Shot UID | HTTP Status | Result | Error |
|---|---:|---|---|
| chatgpt-mti77quj-1 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-2 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-3 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-4 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-5 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-6 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-7 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-8 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-9 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |
| chatgpt-mti77quj-10 | 403 | FAIL | `AI_PROJECT_ACCESS_DENIED` |

Storyboard, keyframe blueprint, and video blueprint could not be inspected because authorization failed before a Shot Context payload was returned.

## Root Cause Assessment

- Blocking interface: `GET /api/ai/shots/{shotUid}/context`
- HTTP status: 403
- Error code: `AI_PROJECT_ACCESS_DENIED`
- Assessment: DATA_ISSUE, consistent with the existing Shot projectId/episodeId ownership mismatch; this validation did not modify data or security logic.
- Code issue: not evidenced by Project Context, Asset Preview, Signed URL, or security responses.

## Final

`AI_DIRECTOR_GATEWAY_VALIDATION_FAILED`

- BLOCK_REASON: All 10 fixed Shot Context requests remain blocked by HTTP 403 `AI_PROJECT_ACCESS_DENIED`; Review Package was not run because the task prohibits GCS modification while its requested POST may write GCS.
- NEXT_ACTION: Repair/verify the fixed 10 Shot ownership data for the target Project/Episode under the authorized Step 4.0.3-D.2 repair procedure, then rerun the 10 Shot Context requests. Separately clarify whether Review Package GCS write is authorized before executing that POST.
