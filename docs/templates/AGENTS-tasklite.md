<!--
Template: paste the block below into a project's AGENTS.md (Codex) and/or CLAUDE.md (Claude Code).
Then replace every {{…}} placeholder and delete the option lines that don't apply.
Why it exists: the Task Lite MCP tools explain *how* to use the tracker; this block tells agents
*this project's* rules (who moves work to Ready, when human review is required, what planning docs
are expected). The tracker stores and shows these choices but never enforces them (owner decision 11).
Keep it short: agents read it at the start of every session.
-->

## Work tracking: Task Lite

This project's work lives in Task Lite (MCP server `tasklite`), project key **{{KEY}}**. Track all work there; don't keep a separate task list. The `tasklite-worker` skill has the full workflow; the rules below are this project's and take precedence.

**Starting a session**
- Call `whoami`. Then `search_items` with project `{{KEY}}`: first filter `resumable` (work sent back to you), then `ready_to_start`. Take the highest-priority item.
- Claim it with `claim_lead` (agent_label: your worker name, if you have one), and pass the returned `run_id` on every call while you work. Include `workspace` (worktree path, branch, base ref and SHA) and, if a coordinator briefed you, the `brief` and `orchestrator` IDs, so the work can be restarted after a crash.
- Call `get_context` next. It gathers the outcome, the decisions you must follow, the epic and label briefs, blockers and planning docs. Then `get_item` delivers the owner's notes, answers and review decisions.

**Planning** (Planning is the owner's stage)
- Planning documents expected here, by risk:
  - {{e.g. Small fixes: none. User-facing features: a short PRD and UX notes. Data-model or migration changes: a TDD.}}
- Store them with `put_document` (kind `planning`) on the item.
- Moving to Ready:
  - {{OPTION A: Only the owner moves items to Ready. When planning is done, add_note "Ready for your review in Planning" and stop.}}
  - {{OPTION B: You may move an item to Ready once its planning documents exist and it has no open questions.}}
- Break an epic into Stories, Tasks and Bugs only when a piece needs its own blocker, review or owner. Smaller steps go in the checklist (`set_plan`).
- Blockers in this project count as finished when: {{done | PR merged | verified by the owner}} (the project default in Task Lite). Where one dependency needs more, for example a schema that must be merged before others build on it, set `satisfied_when` on that link.

**Doing the work**
- Publish your plan with `set_plan` and keep it current with `update_step`. If the plan changes, revise it with a reason; don't silently drop steps.
- Record your own verification with `set_checks` / `update_check`: {{e.g. unit tests, lint, type check, e2e for UI changes}}.
- Subagents: use `start_run` if they connect to Task Lite themselves; otherwise `log_subagent` (provenance `relayed` unless you saw their output directly).
- Report every commit with `report_commit` on the item it belongs to. Branch naming: {{e.g. <item-id>-short-name}}.
- **Push work in progress at every checklist step**, then `report_commit … pushed: true`. A pushed commit survives a crash or a pruned worktree; an unpushed one may not.
- Started something long-lived (a dev server, a session, a container)? Declare it with `heartbeat resources_started`, and release it (`resources_released`) before you finish.
- Have to wait on another item, the coordinator or a person? `park_run` with what you're waiting on. Don't just go quiet: a silent run looks stale and loses its claim; a parked run keeps it.
- Need a product decision? `ask_owner` with your recommendation, then stop work that depends on it.
- Made a choice other agents must follow (a convention, an interface rule, a design choice)? Record it with `publish_decision`, scoped as narrowly as it applies. Owner decisions are authoritative: follow them, and use `ask_owner` to challenge one. Record here: {{e.g. API shapes, naming conventions, library choices; not routine implementation details}}.
- Change only what changed: `set_plan`, `set_checks` and `update_item` patch, so send just the steps or fields you're changing.

**Human review** (what the owner verifies by hand)
- Declare it with `declare_human_review` during Planning for: {{e.g. anything a user sees or touches; data migrations; anything security-related}}.
- Not needed for: {{e.g. internal refactors with passing tests; docs-only changes}}.
- {{If epics here ship as one PR: declare human review once on the epic, not on each child.}}
- When the work is built and your checks pass, `submit_packet`. Write the "how to verify" steps so the owner never has to ask you anything: exact URLs or commands, what to look at, how long it takes. Attach screenshots or recordings for UI changes.
- With no human review items, close the item yourself with `set_status` "done" once your checks pass.

**Finishing**
- Call `finish_run` when you stop, whether the work is finished or not. If you're stopping before it's done, use `release_lead` with a reason instead, so another agent can pick it up.
- Labels: {{e.g. use #regression for bugs that broke working features; ask before creating new labels}}.
- Cleanup sessions: check `deferred_reviews` for checks the owner deferred.
