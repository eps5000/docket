# Docket: the shared record your AI agents work from

*Formerly Task Lite. Upgrading? See [Moving from Task Lite](#moving-from-task-lite).*

Docket is the shared, enforced source of truth that AI agents work through: what work exists, what's eligible to start, who holds it, what it depends on, which decisions apply, and what the owner must verify. Agents use it over a local MCP endpoint; the server enforces the rules (claims and leases, dependencies, review gates), so agents don't have to remember them. A web UI lets the owner supervise: what agents did, what they're doing, and what needs the owner.

**Why it exists:**
- **Fewer tokens.** Each agent gets its context in one budgeted call, compact results and patch-style writes, instead of re-reading tickets and documents.
- **Dependencies agents don't track by hand.** Ready work is computed by the server from the dependency graph and each project's blocker rule.
- **Visibility.** Everything agents do goes through Docket, so the owner sees what actually happened.

It isn't an agent runner. Orca, or the owner, starts agents (owner decision 18), and Docket tells them what to do and records what they did.

**Current phase: building V1.** The container, the MCP server and the owner UI run today. V1 is built and verified with disposable sample work; a real pilot project is chosen afterward.

## Quick start

From a clean machine to a connected agent in about 10 minutes. You need [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows and macOS, or Docker Engine with Compose v2 on Linux) and git. Docket listens on `127.0.0.1:7420` only, so nothing outside this machine can reach it.

**1. Start it.** Run every `docker compose` command in this guide from the `docker/` folder.
```bash
git clone https://github.com/eps5000/docket.git
cd docket/docker
docker compose up -d --build --wait
```
The first build takes a few minutes. Your data lives in the `docket-data` volume, so it survives restarts and container replacement. To try it with sample work first, start it with `DOCKET_SEED=sample` (bash: `DOCKET_SEED=sample docker compose up -d --build --wait`). The seed only loads into an empty database.

Set `TZ` to your time zone, e.g. `America/Chicago`: copy `.env.example` to `.env` in the `docker/` folder, uncomment `TZ=` and set it, then run the `up` command again. A container's own zone is usually UTC, so without it the burn-down's days and the Timeline's Now line are in UTC. Storage is always UTC.

**2. Open the UI.** Open <http://127.0.0.1:7420/>. There is no unlock step and no token to copy: Docket uses **local trust** by default (owner decision 32), so anything running on this computer can use it, while websites and other computers can't. Every owner action records whether the browser or a script made it, and Activity shows a script's as "owner (script: curl/8.4.0)". Want a hard line between your agents and your own actions? See [Protected mode](#protected-mode).

**3. Create or import a project.** Settings → Projects → *New project* (a 2–5 letter key, a name, a colour and the blocker rule), or *Import from Jira…* in the same dialog. [Set up a new project](#set-up-a-new-project) has the full path, including onboarding a repo with an agent. (With `DOCKET_SEED=sample` you already have sample projects.)

**4. Install the agent files into the repo.** Open **Agent files** in the sidebar and pick your project in the project switcher. Write its **Workflow notes** (*Start from template* fills in suggested rules to edit), review the skills and the AGENTS.md block, then click *Install into <project>'s repo* and pick **Claude Code** or **Codex**:
- **A command:** Docket gives you a PowerShell and a bash one-liner. Run it from the repo folder. It works once, for 10 minutes, and needs nothing else installed.
- **One-click:** if you've mounted a code folder (**Settings → One-click install** walks you through it, and `docker/compose.yaml` has a commented example), Docket writes the files into the repo folder itself.

Either way it installs the skills, puts the AGENTS.md block between `<!-- docket:begin -->` and `<!-- docket:end -->` in `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex) without touching the rest of the file, writes the repo's **connection file**, and logs the exact version of every file:
- Claude Code: `.mcp.json`, with a `docket` server at `http://127.0.0.1:7420/mcp`;
- Codex: `.codex/config.toml`, with a `[mcp_servers.docket]` table.

Only the `docket` entry is added or updated: other servers and settings in the file stay as they are, a file that isn't valid JSON or TOML is refused (nothing is written), and the file never holds a token. You can commit it.

The install log's *Check* (or its check command) shows later whether an installed copy was edited by hand, including the `docket` entry of the connection file. Docket also watches for that itself: it checks folders it installed into every 15 minutes (`DOCKET_DRIFT_CHECK_INTERVAL`), and agents report their installed files' hashes when they claim work (the installed `docket-check` script), so an edit made outside Docket shows under Problems with a diff and *Adopt*, *Restore* or *Keep local* (the connection file has *Restore* and *Keep local*). Agents that want to change their instructions propose it instead, for your approval in Agent files. See the in-app help article "Agent files", or [skills/README.md](skills/README.md) for the paths.

**5. Approve Docket in the client.** Open Claude Code (or Codex) in the repo and approve Docket when it asks. It asks once:
- **Claude Code** finds the new MCP server in `.mcp.json` and asks whether to use it: approve `docket`. (`/mcp` shows it afterwards. Headless `claude -p` runs use the project's servers without asking.)
- **Codex** asks whether to trust the folder: trust it, and it reads `.codex/config.toml`. (Headless `codex exec` reads the project's file only once the folder is trusted, so open Codex there once first.)
- **Orca workers** start the installed Claude Code or Codex in the repo, so they pick up the same files.

**6. Check it.** Ask the agent to call the `whoami` tool. Settings → Connections then shows the client as last seen just now. It stays "Not verified" there until someone runs the [smoke kit](docker/smoke/README.md).

### Protected mode
For a hard boundary between agents and owner actions, turn on protected mode: set `DOCKET_PROTECTED_MODE=on` in `docker/.env` (copy `.env.example`), then `docker compose up -d --wait`. Then:
- **The browser asks for the owner key** once (30 days per browser). Print it with `docker compose exec docket docket owner-key`. Agents never get it. *Lock this browser* and *Rotate owner key* are in Settings → Connections.
- **Agents need the agent token.** Get it from Settings → Connections → *Reveal token* (it hides again after 30 s), or `docker compose exec docket docket agent-token`, and set it as `DOCKET_TOKEN` where your agent clients start (macOS or Linux: `export DOCKET_TOKEN="<token>"` in your shell profile; Windows: `setx DOCKET_TOKEN "<token>"`; then open a new terminal; no trailing newline or spaces).
- **Install the agent files again.** In protected mode the connection files name the variable, never the token: `.mcp.json` sends `Authorization: Bearer ${DOCKET_TOKEN}`, which Claude Code fills in from the environment, and `.codex/config.toml` adds `bearer_token_env_var = "DOCKET_TOKEN"`.

Agents can't change the mode: it's a setting, with no button, route or tool. To go back, set `DOCKET_PROTECTED_MODE=off` and restart. The in-app help article "Security and protected mode" has the details.

### A user-wide connection instead
To connect every repo without installing into each one ([MCP spec §11](docs/MCP_SPEC.md#11-client-setup); Settings → Connections → Client setup shows the same snippets):
- **Codex:** add to `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):
  ```toml
  [mcp_servers.docket]
  url = "http://127.0.0.1:7420/mcp"
  ```
  In protected mode, add `bearer_token_env_var = "DOCKET_TOKEN"` (the token is read from the environment on each connection).
- **Claude Code:**
  ```bash
  claude mcp add --transport http --scope user docket http://127.0.0.1:7420/mcp
  ```
  In protected mode, add `--header "Authorization: Bearer $DOCKET_TOKEN"` (PowerShell: `$env:DOCKET_TOKEN`). Your shell expands it, so Claude Code stores the token; run the command again if you rotate it.

`claude mcp list` should then show `docket … ✔ Connected`.

### Set up a new project
An agent can set a project up from what's already in its repo (Spec Kit specs, plans and tasks, the constitution, ADRs and READMEs), with no agent files installed yet:
1. **Create the project:** Settings → Projects → *New project* (a 2–5 letter key, a name, a colour and the blocker rule).
2. **Import its Jira tickets first, if it has any:** *Import from Jira…* in the same dialog, with a dry run before anything is written. Import before onboarding, so the agent enriches the imported tickets instead of duplicating them.
3. **Onboard it:** in the repo's folder, tell any connected agent "Onboard this repo into Docket as project GF, using onboard_project." (Clients with MCP prompts can run the `onboard` prompt; in Claude Code, `/mcp__docket__onboard GF`.) The agent gets the onboarding guide from Docket, matches the repo's tasks to existing items by Jira key, source path or title, creates the rest in Planning with dependencies, labels, decisions and planning documents, proposes Workflow notes, and finishes with a summary. Nothing is made Ready.
4. **Review it:** Needs you shows one card with what it created and enriched, its questions, the proposed Workflow notes, *Install agent files* and *Mark reviewed*.

Running it again later is safe: each item records its source path, so a second run matches what the first created. The guide itself is an agent file (*Onboarding guide*), editable in Agent files like the skills. See the in-app help article "Onboard a project".

### Moving from Task Lite
Docket was called Task Lite until B28. Nothing you already set up stops working, but rename these when you can:
- **Your data volume.** The compose file now uses `docket-data`; your data is still in `tasklite-data`, which Docket never touches automatically. Settings → Connections → Service health shows which volume is mounted. To move it, stop the old container (`docker stop tasklite`), build the new image (`docker compose build`), and copy the volume with one command:
  ```bash
  docker run --rm --user 0:0 -v tasklite-data:/from:ro -v docket-data:/to --entrypoint sh docket:local -c 'cp -a /from/. /to/'
  ```
  Then `docker compose up -d --wait`, and `docker rm tasklite` once you're happy. The database file keeps its old name, `tasklite.db`, and Docket keeps using it. Remove the old volume yourself (`docker volume rm tasklite-data`) only when you're sure the copy works. To keep using the old volume instead, add a `docker/compose.override.yaml` that gives the `docket-data` volume `name: tasklite-data`, and set `DOCKET_DATA_VOLUME: tasklite-data` for the `docket` service.
- **Settings.** Every `TASKLITE_*` setting is now `DOCKET_*` (`docker/.env.example` lists them). An old `TASKLITE_*` value still works while its `DOCKET_*` one is unset, and the server logs one warning per key at startup, for example "TASKLITE_PORT is deprecated; use DOCKET_PORT". It never logs the value.
- **MCP clients.** Rename your MCP server entry from `tasklite` to `docket` (Codex: `[mcp_servers.docket]`; Claude Code: `claude mcp remove tasklite`, then the `claude mcp add … docket …` command in [A user-wide connection instead](#a-user-wide-connection-instead), or install the agent files again for a project `.mcp.json`). The URL is unchanged, so the old entry keeps working until you do. If your clients read the token from `TASKLITE_TOKEN`, rename that variable too, or keep pointing the entry at it.
- **The CLI and the container** are `docket`: `docker compose exec docket docket owner-key`. In protected mode, the browser asks for the owner key once more, because the session cookie was renamed.
- **Installed agent files.** Install again from Agent files. The install replaces an old `<!-- tasklite:begin -->` section with the Docket markers, writes the `docket-*` skills, and removes the old `tasklite-*` skill folders it installed itself, only while they are unmodified. An old folder you edited is kept and shows in Agent files as "old name, edited locally", with *Adopt* or *Keep local*. The old `.tasklite-manifest.json` and `tasklite-check` scripts are left in place; delete them when you like.
- **Backups** taken before the rename (`tasklite-*.tar.gz`) are still listed, kept and restorable.

### Backups and restore
- **Nightly**, at 03:00 local time (`DOCKET_BACKUP_AT`), Docket writes a verified backup of the database and documents to `/data/backups` in its volume, and keeps 14 days of them (`DOCKET_BACKUP_KEEP`). Settings → Connections → Service health shows the last one.
- **Now:** `docker compose exec docket docket backup now`.
- **An extra copy on the host (optional).** The volume copy doesn't survive losing the volume, so you can also have each backup copied to a folder on this machine, kept for the same 14 days:
  1. Create the folder, for example `~/DocketBackups`. On Linux, let the container's user write to it: `sudo chown 10001:10001 ~/DocketBackups`.
  2. In `docker/compose.yaml`, uncomment the line `- ~/DocketBackups:/backups-extra`.
  3. Create `docker/.env` (copy `.env.example`) with `DOCKET_BACKUP_EXTRA_DIR=/backups-extra`.
  4. `docker compose up -d`, then `docker compose exec docket docket backup now`. Settings shows both locations. If the extra copy fails (folder missing, full or not writable), the backup in the volume still succeeds, and Needs you shows "Extra backup copy failed" until a copy works.
- **Restore** a backup (from either location; this replaces the current data, after checking the archive):
  ```bash
  docker compose stop docket
  docker compose run --rm docket docket restore docket-YYYYMMDD-HHMM.tar.gz
  docker compose up -d
  ```
  Restore refuses to run while the service is running. It prints item, event and document checksums that match the backup. Backups hold no tokens or keys, so restoring onto a new volume makes new ones (in protected mode, unlock with the new owner key and give agents the new token).
- **Stopping:** `docker compose down` keeps your data. `docker compose down --volumes` deletes the volume and everything in it, except backups you copied to the host.
- **Deleting a project** (Settings → Projects → *Delete…*, after typing its key) removes its items and documents together. Backups keep a copy until they age out.

### After an update or import: the UI sweep
After you update Docket or import a big project, run the read-only UI sweep against your instance. It opens every main screen (Needs you; Work as board, list, map and timeline; Agents; Agent files; Settings; Help), six sample items on each of their tabs, the palette and a step dialog, at 1024 px dark and 1440 px light. It only loads pages and opens and closes dialogs: it blocks anything that would write.
```bash
pnpm install                                            # once, from the repository root
pnpm --filter @docket/web exec playwright install chromium   # once
pnpm sweep                                              # http://127.0.0.1:7420
pnpm sweep -- --base http://127.0.0.1:7421 --items 10   # another instance, more items
```
It prints a table with each screen's load time and any sideways scroll, element spilling out of its box, empty progress bar, accessibility (axe) problem or console error, and exits non-zero when something failed. In protected mode, set `DOCKET_OWNER_KEY` first. [docker/smoke/OWNER-CHECKLIST.md](docker/smoke/OWNER-CHECKLIST.md) says what to do with a failure.

## Start here (builders)
Docket uses [Spec Kit](https://github.com/github/spec-kit) for spec-driven development. Agents get its skills (`/speckit-implement`, `/speckit-analyze` and the rest) from `.claude/skills/`.
- [Constitution](.specify/memory/constitution.md): the non-negotiable principles every PR is checked against.
- [Requirements of record](specs/001-task-lite-v1/spec.md): user stories, acceptance scenarios, functional requirements and success criteria.
- [Tasks](specs/001-task-lite-v1/tasks.md): 149 tasks, contracts first, then one user-story slice per batch. Read "How to run the build" before starting. Each batch is one agent session and one PR, so never run `/speckit-implement` across the whole list.
- [Plan](specs/001-task-lite-v1/plan.md) · [research](specs/001-task-lite-v1/research.md) · [data model](specs/001-task-lite-v1/data-model.md) · [contracts](specs/001-task-lite-v1/contracts/) · [quickstart](specs/001-task-lite-v1/quickstart.md)

The detailed design those point to:
1. [Build spec](docs/BUILD_SPEC.md): architecture, data model, domain rules, MCP tools, UI API, seed data, tests, milestones and the decisions log.
2. [MCP spec](docs/MCP_SPEC.md): the agent-facing contract (server instructions, every tool's description and schema, errors, worked flows, client setup). Agents are the primary users.
3. [UI spec](docs/UI_SPEC.md): screens, components, design tokens, states, motion and accessibility.
4. [Prototype](design/prototype.html): the clickable visual reference. Open it with `?selftest` to render every view.
5. [Sample data](design/sample-data.json): the seed dataset, exported from the prototype.

## Using it in a project
Install the [agent skills](skills/README.md) from **Agent files** (*Install into <project>'s repo*): `docket-worker` for every agent, and `docket-coordinator` for whatever dispatches them (Orca, a script, or you). The coordinator skill covers dispatching, parking, pruning safely and recovering after a crash. Three optional skills cover planning, review packets and subagents. The same install puts the [AGENTS.md block](docs/templates/AGENTS-docket.md) into the repo's `AGENTS.md` or `CLAUDE.md`: a short, generic section that points agents at Docket, the worker skill and the rules every agent keeps. Each project's own rules (who moves work to Ready, when human review is required, which planning docs are expected, branches, checks) go in its **Workflow notes**, which agents get with every item in `get_context`; the [starter](docs/templates/WORKFLOW-starter.md) has a suggested answer for each. Connect your agents ([MCP spec §11](docs/MCP_SPEC.md#11-client-setup)).

## Background
- [Requirements and owner decisions](docs/REQUIREMENTS_DRAFT.md)
- [UI design record](docs/UI_DESIGN.md): why the UI is the way it is, and its revision history
- [Jira capability research](docs/JIRA_RESEARCH.md)
- [Roadmap and references](docs/ROADMAP.md): the before-pilot checklist, what is deliberately not in V1 and why, and the TERSL/Tourbillon notes
