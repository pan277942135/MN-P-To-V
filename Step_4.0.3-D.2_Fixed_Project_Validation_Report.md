# Step 4.0.3-D.2 Fixed Project Validation Report

## Environment

```
Repository: pan277942135/MN-P-To-V
Branch: main
Cloud Run: zaojing-director-console-uat
Revision: zaojing-director-console-uat-00036-bns
Deployed commit: 1539aca4cc39202139088843b4d2ef56fb4c5e48
Project: project-ac84d52c-a4ec-499c-abec-a70a07bf08d2
Episode: episode-c491fc06-28c5-4150-a734-77028b96c529
Owner: director
```

## Fixed Scope

Only the exact Project ID `project-ac84d52c-a4ec-499c-abec-a70a07bf08d2` was selected. No same-name project was used.

## Capability Matrix

| Capability | Result | Evidence |
|---|---|---|
| Project Registry | PASS | `GET /api/director/projects` HTTP 200; exact target returned |
| Project Session | PASS | `GET /api/director/project-session/{targetProject}?episodeId={targetEpisode}` HTTP 200 |
| Project Context | BLOCKED | Authorized existing Token was not available in the execution context; anonymous request returned HTTP 401 `AI_TOKEN_REQUIRED` |
| Shot Context | BLOCKED | Authorized Token unavailable. The user-specified path with `/projects/{projectId}/shots/{shotUid}/context` returned HTTP 404 because deployed route contract is `/api/ai/shots/{shotUid}/context`; anonymous call to the actual route returned HTTP 401 `AI_TOKEN_REQUIRED` |
| Asset Preview | BLOCKED | Requires the existing authorized Token; anonymous call returned HTTP 401 `AI_TOKEN_REQUIRED` |
| Signed URL | NOT EXECUTED | Cannot obtain Asset Preview response without authorized Token |
| Review Package | BLOCKED | Requires the existing authorized Token; anonymous call returned HTTP 401 `AI_TOKEN_REQUIRED` |

## Registry Evidence

The exact target record was:

```json
{
  "projectId": "project-ac84d52c-a4ec-499c-abec-a70a07bf08d2",
  "title": "风从那年教室吹过 EP01 午睡风波",
  "status": "ACTIVE",
  "episodeCount": 1,
  "shotCount": 10,
  "assetCount": 8
}
```

The registry contained 3 projects, but no other project was used for validation.

## Session Evidence

The exact target Session returned:

- `project.projectId`: target Project ID
- `episode.episodeId`: target Episode ID
- 10 Shots
- 8 Assets
- Director Context schema: `zaojing.director.context.v1`

Returned Shot UIDs were exactly:

```
chatgpt-mti77quj-1
chatgpt-mti77quj-2
chatgpt-mti77quj-3
chatgpt-mti77quj-4
chatgpt-mti77quj-5
chatgpt-mti77quj-6
chatgpt-mti77quj-7
chatgpt-mti77quj-8
chatgpt-mti77quj-9
chatgpt-mti77quj-10
```

## Shot Validation Detail

| shotUid | Status | Error |
|---|---|---|
| chatgpt-mti77quj-1 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-2 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-3 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-4 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-5 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-6 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-7 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-8 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-9 | NOT VERIFIED | Authorized Token unavailable |
| chatgpt-mti77quj-10 | NOT VERIFIED | Authorized Token unavailable |

## Security Evidence

- Anonymous Project Context: HTTP 401 `AI_TOKEN_REQUIRED`
- Invalid Token Project Context: HTTP 401 `AI_TOKEN_INVALID`
- Anonymous actual Shot Context route: HTTP 401 `AI_TOKEN_REQUIRED`
- Anonymous Asset Preview: HTTP 401 `AI_TOKEN_REQUIRED`
- Anonymous Review Package: HTTP 401 `AI_TOKEN_REQUIRED`

No Token was created or modified.

## Final

`FIXED_PROJECT_VALIDATION_FAILED`

- Blocking location: AI Gateway authorized validation stage
- Error code: `AI_TOKEN_REQUIRED` for anonymous requests; authorized result not obtainable
- Data issue: not established by this run
- Code issue: not established by this run
- Additional contract note: the deployed Shot Context route is `/api/ai/shots/{shotUid}/context`, not the user-specified project-prefixed route

NEXT_ACTION: Provide or inject the already-authorized Token in the cloud-side validation command, then rerun the exact Project Context, 10 actual Shot Context routes, Asset Preview, Signed URL HTTP access, and Review Package checks. Do not create a new Token.
