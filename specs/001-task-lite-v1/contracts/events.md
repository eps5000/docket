# Contract: events, change feed and live stream

There is one append-only event log (BUILD_SPEC §5.11). Two readers share its cursor (`events.seq`):
- agents, via the `get_changes` MCP tool;
- the UI, via the `/api/stream` server-sent events.

## Event types
These match the `EventType` union in [MCP_SPEC §4](../../../docs/MCP_SPEC.md):

| Group | Types |
|---|---|
| Items | `item.created`, `item.updated` (including owner text edits), `item.status_changed`, `item.archived`, `item.unarchived` |
| Links and projects | `link.added`, `link.removed`, `link.updated`, `project.updated`, `label.upserted` |
| Checklist | `plan.updated`, `step.updated`, `subagent.logged`, `checks.updated`, `check.updated`, `human_review.declared`, `human_review.updated`, `human_review.removed` |
| Claims and runs | `claim.granted`, `claim.rejected`, `claim.released`, `run.started`, `run.ended` (heartbeats are **not** events) |
| Recovery (US11) | `run.parked`, `run.resumed`, `run.unpushed_handled`, `resource.declared`, `resource.released`. A heartbeat that declares or releases resources appends these events; the heartbeat itself still doesn't. |
| Review | `packet.submitted`, `packet.stale`, `packet.withdrawn`, `review.decided` |
| Messages | `question.asked`, `question.answered`, `owner_note.added`, `note.added` |
| Evidence | `document.added`, `commit.reported`, `artifact.linked` |
| Decisions | `decision.published`, `decision.confirmed`, `decision.superseded`, `decision.withdrawn` |
| Agent setup (decision 29) | `agent_file.updated` (an owner edit, or a new bundled version at startup, actor system), `agent_file.reverted`, `workflow.updated`, `install.recorded` (a push install, or a command install's download; B24: a command install also records one when its command is created, so `data.stage` is `pushed`, `command_issued` or `downloaded`, and the summaries read "Installed by push: …", "Install command created: …" and "Installed by command: …"). Their stream `objects[]` use the kinds `agent_file`, `project` and `install`; none touches an item. |

## Event row
`{ cursor, at, actor, actor_kind: owner|agent|system, item_id, project, type, summary }`.
- `summary` is the one line shown in Activity.
- `data` (old and new values) is stored, but never sent to agents.
- **Undo** has no event type of its own. It is recorded with the inverse's type, `data.undo_of = <mutation_id>`, and the summary "Undid: <original summary>", so agents see the resulting state change in the normal way.

## Live stream (`GET /api/stream`)
- **Message format:** `event: change`, with `id: <seq>` and `data: {"seq":…, "type":…, "objects":[{"kind":"item","id":"RCP-12"}], "for_you": true|false}`.
- **Resume:** the client resumes with `Last-Event-ID`.
- **Keep-alive:** a comment line every 25 s.
- **Cache invalidation:** the client invalidates the TanStack Query keys for the listed objects, and refetches the for-you count when `for_you` is true.
- **`for_you`** is `true` only for `packet.submitted` (the item now has a ready packet) and `question.asked`. The browser uses exactly these to raise desktop notifications (decision 21), de-duplicated by `seq` per browser.

## Agent change feed (`get_changes`)
Same rows, ordered by `seq`. Up to 200 per page; `next_cursor` is the last `seq`. With no cursor,
it returns the latest cursor and no events. Filters: `project`, `item_id` and `types[]`.
