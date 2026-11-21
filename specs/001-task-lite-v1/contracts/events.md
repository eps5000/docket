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
| Decisions | `decision.published`, `decision.confirmed`, `decision.superseded`, `decision.withdrawn`, `decision.acknowledged` (decision 38; B44: the owner kept an agent's project decision without confirming it; owner only; on the project; objects kind `decision`; undoable) |
| Agent setup (decision 29) | `agent_file.updated` (an owner edit, or a new bundled version at startup, actor system), `agent_file.reverted`, `workflow.updated`, `install.recorded` (a push install, or a command install's download; B24: a command install also records one when its command is created, so `data.stage` is `pushed`, `command_issued` or `downloaded`, and the summaries read "Installed by push: …", "Install command created: …" and "Installed by command: …"; decision 34: an install for several clients records one per client, each with `data.clients` listing the group). Their stream `objects[]` use the kinds `agent_file`, `project` and `install`; none touches an item. |
| Agent proposals and drift (decision 30) | `agent_file.proposed` (an agent's `propose_agent_file_change`), `agent_file.proposal_decided` (the owner approved, edited then approved, or declined; `data.decision` says which), `drift.detected` (a report differs from its install's manifest: a scheduled push-folder check, actor system, or an agent's `claim_lead`), `drift.resolved` (*Adopt*, *Restore* or *Keep local*). Their stream `objects[]` use the new kinds `agent_file_proposal` and `drift`, plus `project`, `agent_file` and `install`; a proposal or report from a run also lists its `item`. None is `for_you`: Needs you shows proposals as one line, and drift as a Problems row. |
| Onboarding (decision 31) | `project.created` (the owner's *New project*, an agent's `onboard_project` on a free key, or the Jira import opening a new project, which wrote `project.updated` before B30; the import's summary event stays `project.updated`), `onboarding.started` (`onboard_project` started a session; a same-client call that resumes one writes nothing new), `onboarding.finished` (`finish_onboarding`: ready for the owner's review), `onboarding.reviewed` (the owner's *Mark reviewed*). Their stream `objects[]` use the new kind `onboarding` plus `project`; none touches an item. Events written during a session carry `data.onboarding_session`, so the review card can count them. **`onboarding.finished` is `for_you`**: the owner has something to review, so it raises the badge (B29). |
| Shared changes (decision 36) | `shared_part.saved` (a part registered by an agent's `new_parts` or the owner, or edited, archived or restored by the owner; objects kind `shared_part`, no item), `shared.declared` (an item's declaration replaced, or none declared), `overlap.raised` and `overlap.decided` (kind `overlap`), `lease.taken` and `lease.ended` (kind `lease`), `undeclared.held` and `undeclared.decided` (kind `undeclared_hold`), `radar.found` and `radar.cleared` (kind `radar_finding`). B38 writes the first two; B39 the rest. None is `for_you` yet: B39 decides with the Needs you cards (T185). B40 adds `branch.reported` (an item's branch for the radar reported by `declare_shared_changes`, or set or cleared by the owner; undoable for the owner) and `branch.discovered` (the radar found one local branch naming the item, several, or no longer one; data `source: discovered`, `branch`, `matches`). B41: `branch.reported` also records `declare_shared_changes`' `branches` (replace or clear) and the owner's add or remove (data `op`, `branches`, `previous`); `radar.found` and `radar.cleared` summaries name both branches. |
| Problems (decision 37; B42) | `problem.acknowledged` (the owner acknowledged a problem; objects kind `problem_ack`; undoable), `resolution.proposed` (an agent's `propose_resolution`; kind `resolution`; data `problem_id`, `kind`, `superseded`) and `resolution.decided` (the owner's *Approve*, *Go a different way* or *Acknowledge*, with the owner note it posts and the acknowledgement; undoable). None is `for_you`: a proposal is a Needs you card without a desktop notification. The radar's note on new findings is an `owner_note.added` with data `from: radar`; a finding cleared by a change of the item's branches is a `radar.cleared` in that change's write. |

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
- **`for_you`** is `true` only for `packet.submitted` (the item now has a ready packet), `question.asked`, and `onboarding.finished` (an onboarding is ready for review; decision 31, B29). The browser raises desktop notifications for all three (decision 21; the onboarding one since B30, T165), de-duplicated by `seq` per browser.

## Agent change feed (`get_changes`)
Same rows, ordered by `seq`. Up to 200 per page; `next_cursor` is the last `seq`. With no cursor,
it returns the latest cursor and no events. Filters: `project`, `item_id` and `types[]`.
