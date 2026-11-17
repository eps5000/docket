# Contract index: UI API

**Authoritative**: [BUILD_SPEC §7](../../../docs/BUILD_SPEC.md). Every route needs the owner session,
and mutations also need the `X-Tasklite-CSRF` header. This index groups the routes by user story.

| Routes (BUILD_SPEC §7) | User story | Requirements |
|---|---|---|
| `POST /api/session/unlock`, `POST /api/session/lock`, `POST /api/session/rotate-key`, `GET /healthz`, `GET /readyz` | US10 | FR-100 to FR-102 |
| `GET /api/bootstrap`, `GET /api/needs-you`, `GET /api/work`, `GET /api/items/:id`, `GET /api/agents`, `GET /api/search`, `GET /api/stream` | US2 | FR-060 to FR-063, FR-065 to FR-067 |
| `GET/POST /api/review/:id…`, `POST /api/deferred/:hrId/follow-up` | US3 | FR-050 to FR-054 |
| `DELETE /api/links/:linkId`, `PATCH /api/projects/:key {default_satisfied_when}` | US4 | FR-031 to FR-035 |
| `GET/POST /api/decisions…` (confirm, withdraw) | US5 | FR-043 |
| `POST /api/items/:id/answer`, `POST /api/items/:id/notes`, `POST /api/items/:id/release`, `POST /api/items/:id/return-to-ready`, `POST/DELETE` work, checks and human-review | US6 | FR-064 |
| `POST /api/items` (quick capture); `PATCH /api/items/:id` (priority, status, **title, description, outcome, acceptance**); archive and unarchive; `POST /api/items/:id/cancel` (owner decision 23); `GET /api/labels…` and move-to-ready; `GET /api/documents/:versionId/content` | US7 | FR-064, FR-064a, FR-070, FR-071 |
| `GET /api/work?layout=timeline`, `GET /api/burndown` | US8 | FR-080 to FR-082 |
| `POST /api/import/jira/dry-run`, `GET …/:id`, `POST …/:id/commit`, `DELETE …/:id` | US9 | FR-090 to FR-092 |
| `GET /api/settings`, `DELETE /api/projects/:key`, `GET /api/diagnostics/calls` | US10 | FR-103, FR-104, FR-107, FR-108 |
| `POST /api/mutations/:id/undo` | all | FR-062 |
| `GET /api/workspaces`, `POST /api/resources/:id/release`, `POST /api/runs/:runId/unpushed-handled` | US11 | FR-113, FR-114, FR-116 |
| `GET/PUT /api/agent-files…`, `GET/PUT /api/projects/:key/workflow`, `POST/GET /api/installs…`, `GET /api/push-target…`, `GET /install/:token` | US13 | FR-121 to FR-127 |

**Additions from the 2026-11-14 clarifications** (already in BUILD_SPEC §7):
- **Inline text editing** (decision 22): `PATCH /api/items/:id` accepts `title`, `description_md`, `outcome_md` and `acceptance[]`, with `expected_version`. A stale version returns `409` with `current`, and the UI renders the conflict callout.
- **Diagnostic log** (T21): `GET /api/diagnostics/calls?days=7` streams JSONL. It is metadata only.
- **Notifications** (decision 21) need **no** API: the browser derives them from `/api/stream` events of type `packet.submitted` and `question.asked` (see [events.md](events.md)).
