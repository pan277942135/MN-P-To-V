# Project Registry API V1 Report

## Changed Files

- `src/server/repositories/firestoreDirectorProjectRepository.ts`: reused `director_projects`, added project listing aggregation and minimal project creation.
- `src/server/services/projectRegistryRouter.ts`: added `GET /api/director/projects` and `POST /api/director/projects`, with validation.
- `director-server.ts`: mounted the router at `/api/director`.
- `src/__tests__/projectRegistryRouter.test.ts`: added list, populated list, create, empty-state, and validation tests.

No AI Gateway, Token, Shot Context, Asset Preview, Project Session API, Firestore schema migration, or GCS behavior was changed.

## API Contract

### GET /api/director/projects

Returns HTTP 200 with `{ ok: true, projects: [] }` for an empty registry. Populated items include `projectId`, `title`, `cover`, `status`, `episodeCount`, `shotCount`, `assetCount`, and `updatedAt`.

### POST /api/director/projects

Request:

```json
{ "title": "测试项目", "format": "16:9" }
```

Returns HTTP 201 with `ok: true`, `projectId`, and the created project summary.

## Database

Data source: existing Firestore collection `director_projects`, project `xp-vertex-project`, database `ai-studio-0806-1d34279b-010b-4a28-8239-d080392dee29`.

Asset counts are read from the existing Asset Registry. No new Project collection was created. Existing project `project-ac84d52c-a4ec-499c-abec-a70a07bf08d2` remains readable.

## Tests

- Director Console CI: PASS
- TypeScript: PASS
- Director / Episode regression tests: PASS
- Formal React + Episode server build: PASS
- Project Registry API tests: PASS

## UAT

Cloud Run service: `zaojing-director-console-uat`

Revision: `zaojing-director-console-uat-00036-bns`

Public URL: https://zaojing-director-console-uat-i7lns3auvq-uc.a.run.app

- `GET /api/director/projects`: HTTP 200
- Target project returned: PASS
- Target counts: 1 Episode / 10 Shots / 8 Assets
- `POST /api/director/projects`: HTTP 201, returned projectId `project-7e382bf2-4c08-4cf8-8e95-f888dcf2e580`
- Target Project Session: HTTP 200
- Project Session returned project, episode, 10 shots, assets, and Director Context
- Existing Project Session API behavior: PASS
- No prohibited API or security behavior changed

## Final

`PROJECT_REGISTRY_API_COMPLETE`
