<!--
The Docket section of a repo's AGENTS.md (Codex) or CLAUDE.md (Claude Code).
Docket installs it between its markers from Agent files. It is the same for every project:
each project's own rules live in its Workflow notes, which agents get with every item in get_context.
Keep it short: agents read it at the start of every session.
-->

## Work tracking: Docket

This project's work lives in Docket (MCP server `docket`). Track all work there; don't keep a separate task list. Follow the `docket-worker` skill for the full workflow.

**This project's rules** come with each item: `get_context` returns them as `workflow:` (the project's Workflow notes). Read them before you start. Where they differ from this section or the skill, they take precedence.

**Always:**
- **Claim before you work:** `claim_lead` the item, with the output of the installed `docket-check` (`.claude/` or `.codex/`) as `instructions` when it's there, and pass the returned `run_id` on every call while you work on it.
- **Push at every step:** push your work in progress at each checklist step, then `report_commit … pushed: true`. Unpushed work may be lost.
- **Park instead of going quiet:** waiting on another item, the coordinator or a person? `park_run` with what you're waiting on. A silent run looks stale and loses its claim.
- **Wait without polling:** block on the installed `docket-wait` script (next to `docket-check`), which costs no tokens until something changes. Never wait in a `sleep` loop.
- **Declare and release resources:** started a dev server, a session or a container? Declare it with `heartbeat resources_started`, and release it (`resources_released`) before you finish.
- **Ask, don't guess, on product decisions:** `ask_owner` with your recommendation, then stop the work that depends on it.
- **Propose instruction changes:** to change these instructions, use `get_agent_files` then `propose_agent_file_change`, and tell the user you've proposed it for the owner's approval. Don't edit installed files directly.
- **Close or hand off correctly:** when the work is done, `submit_packet` if it needs human review, otherwise `set_status` "done", then `finish_run`. Stopping before it's done? `release_lead` with a reason, so another agent can pick it up.
