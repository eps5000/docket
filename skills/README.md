# Task Lite skills

These are agent skills that teach the **workflow** for using Task Lite well. The MCP tools explain each call on its own; these explain the order of calls, the habits that keep runs cheap and recoverable, and the judgement calls (owner decision 27).

| Skill | Status | Give it to |
|---|---|---|
| [`tasklite-worker`](tasklite-worker/SKILL.md) | Core | Every agent that works on items |
| [`tasklite-coordinator`](tasklite-coordinator/SKILL.md) | Core | Whatever dispatches agents: an Orca coordinator, a script, or you |
| [`tasklite-planner`](tasklite-planner/SKILL.md) | Optional | Agents that shape and break down work |
| [`tasklite-review-packet`](tasklite-review-packet/SKILL.md) | Optional | Workers on projects that use human review |
| [`tasklite-lead-subagents`](tasklite-lead-subagents/SKILL.md) | Optional | Leads that fan out to subagents |

## Install

**From Task Lite (recommended):** open **Agent files**, pick the project in the project switcher, and click *Install into <project>'s repo* (with All projects, *Install user-wide*). It installs the skills and the AGENTS.md block that project uses (its own copies where you customized a file, the defaults elsewhere), either by a copy-paste command (PowerShell or bash, single use, 10 minutes) or by writing them into a folder you've mounted (**Settings → One-click install**). Every install is logged with the exact version of each file, and *Check* (or the check command) shows whether an installed copy was edited by hand.

| Client | Skills (repo / user-wide) | The AGENTS.md block |
|---|---|---|
| Claude Code | `.claude/skills/<name>/` / `~/.claude/skills/<name>/` | `CLAUDE.md` / `~/.claude/CLAUDE.md` |
| Codex | `.codex/skills/<name>/` / `~/.codex/skills/<name>/` | `AGENTS.md` / `~/.codex/AGENTS.md` |

The block goes between `<!-- tasklite:begin -->` and `<!-- tasklite:end -->`; nothing else in the file changes. A `.tasklite-manifest.json` in `.claude/` or `.codex/` records what was sent.

**By hand:** each skill is a folder with a `SKILL.md`, in the standard skill format. Copy the folders you want into the agent's skills directory (this copies Task Lite's versions, without your edits in Agent files):

| Client | User-wide | One project |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `.claude/skills/` in the repo |
| Codex | `~/.codex/skills/` | see Codex's skills documentation |
| Orca workers | Orca starts the installed Claude Code or Codex, so the folders above apply | |

```bash
# Example: the core skills, user-wide, for Claude Code
cp -r skills/tasklite-worker skills/tasklite-coordinator ~/.claude/skills/
```

Claude Code's project path (`.claude/skills/`) is verified: the B18 skills eval ran with it, headless, and Claude Code invoked both core skills. The user-wide paths, Codex's, and whether Orca workers see user-wide skills are checked in the real-client smoke test (BUILD_SPEC §12, V7; `docker/smoke/OWNER-CHECKLIST.md`).

## Make them yours

They're plain Markdown, so edit them to fit your tooling: your orchestrator's commands, your branch rules, your test commands. Edit them in **Agent files**: the default (with All projects selected), or a project's own copy (*Customize for <project>*), with history and comparisons; then install again. Keep project-specific rules in the project's **Workflow notes**, which agents get in `get_context` for every item in the project ([starter](../docs/templates/WORKFLOW-starter.md)). The installed `AGENTS.md` / `CLAUDE.md` section ([block](../docs/templates/AGENTS-tasklite.md)) is the same for every project. The skills defer to the Workflow notes where they differ.

**Changes from agents, and edits by hand.** Agents don't edit their installed files: the skills tell them to read a file with `get_agent_files` and propose a change with `propose_agent_file_change`, which waits for your approval in Agent files (FR-128–FR-130). Each install also puts a `tasklite-check` script (`.sh` and `.ps1`) next to the manifest. Agents run it once per session and pass its one line of JSON as `instructions` on `claim_lead`: each file's hash, plus the text of any file that differs. That, and a scheduled check of folders Task Lite installed into (`TASKLITE_DRIFT_CHECK_INTERVAL`, 15 minutes by default), shows you "edited outside Task Lite" with a diff, and *Adopt*, *Restore Task Lite's version* or *Keep local*.

**Keep them in sync with the tools.** CI parses every `SKILL.md` and fails if it names a tool or a top-level input field that doesn't exist. If you add your own skills here, they get the same check.

## Not (yet) served over MCP

V1 ships skills as files only. Serving them as MCP prompts, so every connected client gets them automatically, is on the [roadmap](../docs/ROADMAP.md).
