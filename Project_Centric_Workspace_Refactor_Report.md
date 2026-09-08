# Project-Centric Workspace Refactor V1 Report

## Changed

- Added a first-level `/projects` Project Home.
- Added project cards using existing browser binding history and current Project Session data.
- Added `/projects/:projectId` project workspace entry.
- Added persistent Project Context Bar with project name, episode, current section, and AI Director entry.
- Sidebar is now rendered only inside a selected project workspace.
- Existing pages remain available inside the project workspace.
- Project selection restores the selected binding before entering the workspace.
- Legacy URLs redirect when the current project is known:
  - `/shots/:shotUid` → `/projects/:projectId/shots/:shotUid`
  - `/assets/:assetId` → `/projects/:projectId/assets/:assetId`
  - `/episodes/:episodeId` → `/projects/:projectId/episodes/:episodeId`

## Routes

| Route | Purpose |
|---|---|
| `/projects` | Project List |
| `/projects/:projectId` | Project Workspace / Director |
| `/projects/:projectId/shots/:shotUid` | Project-scoped Shot entry |
| `/projects/:projectId/assets/:assetId` | Project-scoped Asset entry |
| `/projects/:projectId/episodes/:episodeId` | Project-scoped Episode entry |
| `/projects/:projectId/ai-director` | Project-scoped AI Director Context entry |

## Screens

- Project Home: project cards, status, episode/shot/asset counts where the active session is available.
- Project Workspace: project context header plus existing production navigation.
- AI Director: opened from the project context bar and remains project-scoped.

## Context

- Project identity is derived from `ProjectSessionContext`.
- Project restore uses the existing binding flow.
- AI Gateway, Token, Firestore schema, Shot Context logic, and production data were not modified.
- No new Firestore collection or migration was introduced.

## Validation

- GitHub Actions Director Console CI: PASS.
- TypeScript: PASS.
- Director / Episode regression suite: PASS.
- 120 tests: PASS.
- Changed files: `src/App.tsx`, `src/pages/ProjectHomePage.tsx`, `src/components/ProjectContextBar.tsx`.
- Branch: `feature/project-centric-workspace-v1`.
- Pull Request: #119.
- UAT deployment: NOT RUN in this change; merge/deploy remains a separate release action.

## Final

PROJECT_CENTRIC_WORKSPACE_IMPLEMENTED

Release status:
READY_FOR_REVIEW
