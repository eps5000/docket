# Agent files: updates, connecting and local edits

**Read when:** An `update:` line appears, a worker can't reach Docket or lacks `docket-worker`, or a run shows "edited locally".
**Don't read when:** The agent files are installed, current and unedited.

The owner installs the skills, their references and the project's `AGENTS.md` / `CLAUDE.md` section from Agent files, and the install log shows which versions each repo got.

## Taking a Docket update

Take it before dispatching, so new worktrees get current skills.

1. Run `docket-check`.
2. If the digest or a worker's claim has an `update:` line, on a new branch run `bash .claude/docket-update.sh` (`.codex/` for Codex; `docket-update.ps1` without bash; no script yet? use that line's command).
3. Ship that one change through the usual PR and CI. It never commits or pushes. It adds new skill files and references, and removes a reference Docket no longer ships unless it was edited locally.
4. Can't land it? Tell the owner and carry on.

## A worker that can't reach Docket

Start it with Docket connected for that session only: `claude --mcp-config .mcp.json`, or `codex -c "mcp_servers.docket.url='http://127.0.0.1:7420/mcp'"` (Codex skips the repo's file in an untrusted folder). **Never edit a user-level client config.** If it still can't, claim on its behalf with the same `workspace`, `orchestrator` and `brief`, and give it the `run_id`.

## A worker without `docket-worker`

Ask the owner to install the agent files there. Paste the skill into the brief only as a last resort.

## Instructions changed outside Docket

Workers pass the `docket-check` output as `instructions` on `claim_lead`, and Docket also checks folders it installed into. A hand edit shows the owner "… edited outside Docket" under Problems, and the run shows "edited locally". The remedies are the owner's, in Agent files: _Adopt_, _Restore Docket's version_ or _Keep local_. Mention it to the owner when a worker hits it; **don't restore or overwrite the files yourself.**
