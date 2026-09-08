# Project First Navigation V2 Refactor Report

## Root Cause

The UAT root route did not redirect to `/projects`. In addition, the application mounted Director Cloud bootstrap and Project Session providers before a project was selected. The cloud bootstrap left the first screen in a long-running “正在连接 Director Cloud…” state.

A second, independent contract blocker was verified: the repository does not contain `GET /api/director/projects` or `POST /api/director/projects`. The frontend now calls that contract and renders a visible error when it is unavailable; no local history or fabricated project data is used.

## Modified Files

- `src/App.tsx`
  - Added root-to-`/projects` redirect.
  - Isolated Project List from Director Cloud and Project Session providers.
  - Mounted providers only after project workspace navigation.
  - Added route synchronization and Error Boundary integration.
- `src/context/ProjectSessionContext.tsx`
  - Removed the 5-second automatic `refreshSession` polling loop.
- `src/pages/ProjectHomePage.tsx`
  - Removed `readProjectBindingHistory()` and local project cards.
  - Added backend project-list loading, visible retry state, project cards, and create-project modal.
- `src/services/director/projectClient.ts`
  - Added GET/POST client for the existing required project API contract.
- `src/components/DirectorErrorBoundary.tsx`
  - Added visible render-error fallback with Reload and Back To Projects.
- `src/services/director/directorCloudPersistence.ts`
  - Existing bootstrap contract preserved after CI compatibility check; startup isolation is implemented at the route/provider boundary.

No Firestore, AI Gateway, Token, project-session API, Shot Context, Asset Registry schema, GCS, or production data was changed.

## Architecture Change

`Application → Project List → Project Workspace → Session Restore`

- `/` redirects to `/projects`.
- `/projects` renders the backend-backed Project List without Session Restore.
- `/projects/:projectId` mounts the existing providers and triggers `refreshSession(projectId)` on workspace entry.
- Session polling is removed; refresh remains explicit.

## API Change

Frontend contract consumed:

- `GET /api/director/projects`
- `POST /api/director/projects`

These server endpoints were not present in the repository at deployment time. They were intentionally not added because the task forbids backend/API changes.

## Test Result

- Director Console CI: PASS
- TypeScript: PASS
- Director / Episode regression tests: PASS
- Build: PASS
- Cloud Run deployment smoke: PASS

## UAT Result

- Root URL redirects to `/projects`: PASS
- Project List does not enter `project-session` on startup: PASS by route/provider isolation
- Project List renders a visible non-black error state: PASS
- `GET /api/director/projects`: BLOCKED — HTTP 404
- Project selection → Session Restore: NOT EXECUTED because no project card can be returned by the missing API
- Create Project: NOT EXECUTED because `POST /api/director/projects` is not deployed
- Shot / Asset / AI Gateway behavior: not modified

## Final

`PROJECT_CENTRIC_WORKSPACE_BLOCKED`

BLOCK_REASON: `/api/director/projects` GET/POST endpoints are absent from the deployed backend, while backend/API changes are explicitly forbidden.

NEXT_ACTION: Deploy the approved backend project-list/create contract separately, then rerun Project List, project selection, Session Restore, Shot, Asset, AI Director, and multi-project isolation UAT.
