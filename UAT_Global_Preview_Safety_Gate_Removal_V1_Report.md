# UAT Global Preview Safety Gate Removal V1 Report

## Environment

- Repository: `pan277942135/MN-P-To-V`
- Branch: `main`
- GCP Project: `xp-vertex-project`
- Cloud Run service: `zaojing-director-console-uat`
- UAT URL: `https://zaojing-director-console-uat-i7lns3auvq-uc.a.run.app`
- Final deployed Revision: `zaojing-director-console-uat-00045-b7b`
- Final source commit: `3d153fe0d576d628b6076eef198e52997c5bc813`

## Changed

- Removed the environment-level Preview Read Only middleware from `episode-server.ts`.
- Removed the Preview dependency from `isProductionRunEnabled()`; Episode Production is no longer blocked by the Preview environment.
- Changed UAT deployment variables to:
  - `PUBLIC_PREVIEW_READ_ONLY=0`
  - `DIRECTOR_PRODUCTION_RUN_ENABLED=1`
- Updated capability smoke expectations to `readOnlyPreview=false` and `productionRunEnabled=true`.
- Updated obsolete unit-test assertions that expected the removed Preview gate.

Preserved:

- Firestore task persistence
- Task State Machine
- Idempotency and duplicate Veo submission protection
- Project/Shot ownership checks
- Token and AI Gateway security
- IAM/model/parameter validation
- GCS persistence and Identity QA

## Results

| Capability | Result | Evidence |
|---|---|---|
| Preview global Middleware | Disabled | Non-safe API requests now reach their route-level business validation |
| `PUBLIC_PREVIEW_READ_ONLY` | Open | UAT deployed with value `0` |
| `DIRECTOR_PRODUCTION_RUN_ENABLED` | Open | UAT deployed with value `1` |
| Capabilities | PASS | HTTP 200; `readOnlyPreview=false`; `productionRunEnabled=true` |
| Compute Connection | PASS | HTTP 200; ADC; Vertex project `xp-vertex-project` |
| Project List | PASS | HTTP 200; 3 records returned |
| Project Session | PASS | HTTP 200; fixed target project; 10 shots; 8 assets |
| Storyboard | PASS | Real Provider call HTTP 200; 3 shots returned |
| Keyframe Image | PASS | Real Provider call HTTP 200; PNG output returned |
| Episode Production gate | PASS | Not blocked by `EPISODE_PRODUCTION_DISABLED`; reached business validation and returned `EPISODE_NOT_FOUND` for the supplied Episode input |
| Studio `/api/videos/start` gate | PASS | First request reached business validation with `identity_reference_missing`; no `PREVIEW_READ_ONLY` |
| Studio 4-second Veo submission | PASS | HTTP 200; `accepted=true`; `serverPersisted=true`; taskId and operationName present; model `veo-3.1-fast-generate-001` |
| Firestore task persistence | PARTIAL / BLOCKED | Submission was persisted; subsequent task listing showed the task, but final artifact metadata was absent |
| Veo → GCS → QA finalization | FAIL | Status polling HTTP 500: illegal state transition `completed -> qa_pending` |
| Project Create | NOT RUN | Not executed to avoid creating an unneeded persistent test project without a cleanup requirement |
| Director Persistence write | NOT RUN | Not executed against the production target snapshot because no safe non-destructive fixture was available |

## Real Studio Failure

The environment gate was successfully bypassed. The real 4-second task entered the Veo path, but finalization exposed a business-state error:

```text
[State Machine] Illegal transition for task vtask_1788872104202_adof4:
completed -> qa_pending
```

The task list reported `completed` while `outputBucket`, `outputObjectPath`, and `artifactPersisted` were not present. This is not a Preview safety error and was not changed or hidden.

## Final

UAT_GLOBAL_PREVIEW_GATES_REMOVED is NOT issued because the full requested production chain did not reach a valid final GCS/QA state.

BLOCK_REASON:

- Environment-level Preview gates are removed and capabilities are correctly open.
- Full Studio video finalization is blocked by a real Task State Machine / artifact finalization inconsistency: `completed -> qa_pending`.

NEXT_ACTION:

- Investigate the duplicate/late Veo completion handling and make task finalization idempotent so a terminal `completed` task cannot be transitioned back to `qa_pending`.
- Then rerun the same fixed UAT flow with a new idempotency key/task input and verify Firestore artifact metadata, GCS object, Identity QA, and final task state.
