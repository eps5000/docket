# Contract index: UI API

**Authoritative**: [BUILD_SPEC §7](../../../docs/BUILD_SPEC.md). Every route needs the owner session,
and mutations also need the `X-Docket-CSRF` header, except `POST /api/session/unlock`,
`/agent-upload` (the agent bearer token) and `GET /install/:token` (its single-use token; decision 29).
This index groups the routes by user story.

| Routes (BUILD_SPEC §7) | User story | Requirements |
|---|---|---|
| `POST /api/session/unlock`, `POST /api/session/lock`, `POST /api/session/rotate-key`, `GET /healthz`, `GET /readyz` | US10 | FR-100 to FR-102 |
| `GET /api/bootstrap`, `GET /api/needs-you`, `GET /api/work`, `GET /api/items/:id`, `GET /api/agents`, `GET /api/search`, `GET /api/stream` | US2 | FR-060 to FR-063, FR-065 to FR-067 |
| `GET/POST /api/review/:id…`, `POST /api/deferred/:hrId/follow-up` | US3 | FR-050 to FR-054, FR-154 to FR-157 |
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
| `GET /api/install-state` (decision 34); `POST /api/installs` with `clients` | US17 | FR-149, FR-150 |
| `GET /api/agent-file-proposals`, `POST …/:id/approve`, `POST …/:id/decline`, `GET /api/drift`, `POST /api/drift/:id/adopt`, `…/restore`, `…/keep-local` | US14 | FR-128 to FR-133 |
| `POST /api/projects`, `GET /api/onboarding`, `POST /api/onboarding/:id/reviewed` | US15 | FR-135, FR-139, FR-140 |
| `GET`/`POST /api/projects/:key/shared-parts`, `PATCH /api/shared-parts/:id`, `GET`/`PUT /api/items/:id/shared`, `PUT /api/items/:id/shared/branch` (B40), `POST /api/overlaps/:id/decide`, `POST /api/undeclared-holds/:id/decide`, `POST /api/leases/:id/release`, `GET`/`PUT /api/projects/:key/radar`, `POST /api/projects/:key/radar/run` | US18 | FR-158–FR-164 |
| `PATCH /api/items/:id/work/:stepId/details` | US16 | FR-145, FR-146 |
| `GET /api/items/:id/work/:stepId` | US16 | FR-146 |

**Additions from the 2026-11-14 clarifications** (already in BUILD_SPEC §7):
- **Inline text editing** (decision 22): `PATCH /api/items/:id` accepts `title`, `description_md`, `outcome_md` and `acceptance[]`, with `expected_version`. A stale version returns `409` with `current`, and the UI renders the conflict callout.
- **Diagnostic log** (T21): `GET /api/diagnostics/calls?days=7` streams JSONL. It is metadata only.
- **Agent setup** (decision 29; contracts in B21): request and response shapes are in `shared/src/api/agent-setup.ts`. `GET /install/:token` sits outside `/api`, takes no session, CSRF or bearer token, and stays behind the Host and Origin guards (loopback only); unknown, expired and used tokens all answer `404`. The edits, reverts and Workflow notes are undoable; installs, checks and the push *Test* are not.
- **Proposals and drift** (decision 30; contracts in B26): shapes are in `shared/src/api/agent-proposals.ts`. Every route needs the owner session, and the POSTs need CSRF. *Approve* (optionally with edited content) and *Adopt* are undoable; *Decline*, *Restore* and *Keep local* are not. *Restore* reinstalls, so it runs in two steps like an install. Existing responses gain optional fields: Needs you's `agent_file_proposals` count, the `agent_files_drift` Problems row with `drift_id`, and the ticket's `run_instructions`.
- **New project and onboarding** (decision 31; contracts in B29): shapes are in `shared/src/api/onboarding.ts`. Every route needs the owner session, and the POSTs need CSRF. `POST /api/projects` sits in the Settings group and follows the key and tombstone rules of the Jira import; neither it nor *Mark reviewed* is undoable. Existing responses gain optional fields: Needs you's `onboarding_reviews` (the sessions ready for review), and `created_by` on project rows (the agent, until one of the project's onboardings is reviewed; then null). B30 contract changes: `GET /api/work` takes optional `onboarding` (`onb_…`) and `onboarding_change` (`created` or `enriched`), the review card's links; the agent file routes accept the key `guide:onboarding` (kind `guide`).
- **Step details** (decision 33; contracts in B33): `PATCH /api/items/:id/work/:stepId/details` `{details, expected_version}` edits a step's details from the step dialog (UI_SPEC §6.3.1a). It sits with the other owner work-step routes (`/work/:stepId`), in the steer group. `details` is Markdown, at most 10,000 characters; `null` or empty clears it. `expected_version` is the step's `details_version`: a stale one is `409` with `current` (the step with its details). It is undoable, runs the write checks like any owner text edit, and records `step.updated` with `details_version: {old, new}` and `via`. B33 implemented it (not a 501 placeholder). Work steps in every response gain `source` and `has_details`; the item page (`GET /api/items/:id`, the full view) also carries `details_md` and `details_version`.
- **The step dialog's contents** (B34): `GET /api/items/:id/work/:stepId` returns `{step, history, jira_site}`: the step with its details and history exactly as `get_step` reads them (one implementation; a removed step is still readable, any other is `404 not_found`), and `jira_site`, the normalised origin of the project's latest Jira import (`https://example.atlassian.net`; never a path or an account), or null. Read-only, steer group.
- **Shared changes** (decision 36; contracts in B38): shapes are in `shared/src/api/shared-changes.ts`, in the new `shared` group. Every route needs the owner session, and the mutations need CSRF. Parts are addressed by `spt_…` ID. Registry and declaration edits are undoable; overlap and hold decisions, lease release and the radar are not. `PATCH /api/items/:id` takes `override_reason` with `status: ready` (the Ready gate's override). Needs you gains optional `overlaps`, `undeclared_holds` and `radar_findings`. B38 implements the registry, the declaration and the reads; the decisions, lease release and the radar's settings and run answer 501 until B39.
- **Notifications** (decision 21) need **no** API: the browser derives them from `/api/stream` events of type `packet.submitted`, `question.asked` and `onboarding.finished` (B30; see [events.md](events.md)).
- **Approve with notes** (decision 35; B37): in `POST /api/review/:id/decisions`, an `approve` verdict takes an optional `note` and, only with a note, `keep` (`item`, `epic` or `project`); the "Not used for approve" refusal is gone. The packet's verdicts gain `keep` and `decision_id` (both null unless an approval had a note), and Activity rows gain an optional `decision_ids` (a review that kept notes as decisions). Shapes are in `shared/src/api/review.ts` and `shared/src/api/types.ts`.
