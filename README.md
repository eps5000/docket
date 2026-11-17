# Task Lite: local agent coordination

Task Lite is the shared, enforced source of truth that AI agents work through: what work exists, what's eligible to start, who holds it, what it depends on, which decisions apply, and what the owner must verify. Agents use it over a local MCP endpoint; the server enforces the rules (claims and leases, dependencies, review gates), so agents don't have to remember them. A web UI lets the owner supervise: what agents did, what they're doing, and what needs the owner.

**Why it exists:**
- **Fewer tokens.** Each agent gets its context in one budgeted call, compact results and patch-style writes, instead of re-reading tickets and documents.
- **Dependencies agents don't track by hand.** Ready work is computed by the server from the dependency graph and each project's blocker rule.
- **Visibility.** Everything agents do goes through Task Lite, so the owner sees what actually happened.

It isn't an agent runner. Orca, or the owner, starts agents (owner decision 18), and Task Lite tells them what to do and records what they did.

**Current phase: building V1.** The container, the MCP server and the owner UI run today. V1 is built and verified with disposable sample work; a real pilot project is chosen afterward.

## Quick start

From a clean machine to a connected agent in about 10 minutes. You need [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows and macOS, or Docker Engine with Compose v2 on Linux) and git. Task Lite listens on `127.0.0.1:7420` only, so nothing outside this machine can reach it.

**1. Start it.** Run every `docker compose` command in this guide from the `docker/` folder.
```bash
git clone https://github.com/eps5000/task-lite.git
cd task-lite/docker
docker compose up -d --build --wait
```
The first build takes a few minutes. Your data lives in the `tasklite-data` volume, so it survives restarts and container replacement. To try it with sample work first, start it with `TASKLITE_SEED=sample` (bash: `TASKLITE_SEED=sample docker compose up -d --build --wait`). The seed only loads into an empty database.

Set `TZ` to your time zone, e.g. `America/Chicago`: copy `.env.example` to `.env` in the `docker/` folder, uncomment `TZ=` and set it, then run the `up` command again. A container's own zone is usually UTC, so without it the burn-down's days and the Timeline's Now line are in UTC. Storage is always UTC.

**2. Unlock the UI.** Open <http://127.0.0.1:7420/> and paste the owner key, which this prints:
```bash
docker compose exec tasklite tasklite owner-key
```
Agents never get this key. The browser stays unlocked for 30 days from its last use. *Lock this browser* and *Rotate owner key* are in Settings → Connections.

**3. Put the agent token where your agents run.** Get it from Settings → Connections → *Reveal token* (it hides again after 30 s), or:
```bash
docker compose exec tasklite tasklite agent-token
```
Set it as `TASKLITE_TOKEN` in the environment your agent clients start from:
- macOS or Linux: add `export TASKLITE_TOKEN="<token>"` to your shell profile, then open a new terminal.
- Windows: `setx TASKLITE_TOKEN "<token>"`, then open a new terminal.

Don't include a trailing newline or spaces: they break auth.

**4. Connect your agents** ([MCP spec §11](docs/MCP_SPEC.md#11-client-setup); Settings → Connections shows the same snippets).
- **Codex:** add this to `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`). The token is read from the environment on each connection, never stored in the file:
  ```toml
  [mcp_servers.tasklite]
  url = "http://127.0.0.1:7420/mcp"
  bearer_token_env_var = "TASKLITE_TOKEN"
  ```
- **Claude Code** (user scope, so every project gets it):
  ```bash
  claude mcp add --transport http --scope user tasklite http://127.0.0.1:7420/mcp \
    --header "Authorization: Bearer $TASKLITE_TOKEN"
  ```
  In PowerShell, use `--header "Authorization: Bearer $env:TASKLITE_TOKEN"`. Your shell expands the variable, so Claude Code stores the token itself; run the command again if you rotate the token. For one repo only, use a project `.mcp.json` instead (MCP spec §11).
- **Orca workers** start the installed Codex or Claude Code, so the setup above applies as long as they inherit your user config and environment.

**5. Check it.** `claude mcp list` should show `tasklite … ✔ Connected`, and `/mcp` inside Codex or Claude Code lists its tools. Ask the agent to call the `whoami` tool. Settings → Connections then shows the client as last seen just now. It stays "Not verified" there until someone runs the [smoke kit](docker/smoke/README.md).

**6. Install the skills.** Copy at least `tasklite-worker` and `tasklite-coordinator` into your agents' skills folder (see [skills/README.md](skills/README.md) for Codex and project paths):
```bash
cp -r ../skills/tasklite-worker ../skills/tasklite-coordinator ~/.claude/skills/
```
Then paste [templates/AGENTS-tasklite.md](docs/templates/AGENTS-tasklite.md) into the project's `AGENTS.md` or `CLAUDE.md` (see "Using it in a project" below).

### Backups and restore
- **Nightly**, at 03:00 local time (`TASKLITE_BACKUP_AT`), Task Lite writes a verified backup of the database and documents to `/data/backups` in its volume, and keeps 14 days of them (`TASKLITE_BACKUP_KEEP`). Settings → Connections → Service health shows the last one.
- **Now:** `docker compose exec tasklite tasklite backup now`.
- **An extra copy on the host (optional).** The volume copy doesn't survive losing the volume, so you can also have each backup copied to a folder on this machine, kept for the same 14 days:
  1. Create the folder, for example `~/TaskLiteBackups`. On Linux, let the container's user write to it: `sudo chown 10001:10001 ~/TaskLiteBackups`.
  2. In `docker/compose.yaml`, uncomment the line `- ~/TaskLiteBackups:/backups-extra`.
  3. Create `docker/.env` (copy `.env.example`) with `TASKLITE_BACKUP_EXTRA_DIR=/backups-extra`.
  4. `docker compose up -d`, then `docker compose exec tasklite tasklite backup now`. Settings shows both locations. If the extra copy fails (folder missing, full or not writable), the backup in the volume still succeeds, and Needs you shows "Extra backup copy failed" until a copy works.
- **Restore** a backup (from either location; this replaces the current data, after checking the archive):
  ```bash
  docker compose stop tasklite
  docker compose run --rm tasklite tasklite restore tasklite-YYYYMMDD-HHMM.tar.gz
  docker compose up -d
  ```
  Restore refuses to run while the service is running. It prints item, event and document checksums that match the backup. Backups hold no tokens or keys, so restoring onto a new volume makes new ones (step 2 and 3 again).
- **Stopping:** `docker compose down` keeps your data. `docker compose down --volumes` deletes the volume and everything in it, except backups you copied to the host.
- **Deleting a project** (Settings → Projects → *Delete…*, after typing its key) removes its items and documents together. Backups keep a copy until they age out.

## Start here (builders)
Task Lite uses [Spec Kit](https://github.com/github/spec-kit) for spec-driven development. Agents get its skills (`/speckit-implement`, `/speckit-analyze` and the rest) from `.claude/skills/`.
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
Install the [agent skills](skills/README.md): `tasklite-worker` for every agent, and `tasklite-coordinator` for whatever dispatches them (Orca, a script, or you). The coordinator skill covers dispatching, parking, pruning safely and recovering after a crash. Three optional skills cover planning, review packets and subagents. Connect your agents ([MCP spec §11](docs/MCP_SPEC.md#11-client-setup)), then paste [templates/AGENTS-tasklite.md](docs/templates/AGENTS-tasklite.md) into the project's `AGENTS.md` and/or `CLAUDE.md` and fill in its placeholders. It tells agents this project's rules: who moves work to Ready, when human review is required, and which planning docs are expected.

## Background
- [Requirements and owner decisions](docs/REQUIREMENTS_DRAFT.md)
- [UI design record](docs/UI_DESIGN.md): why the UI is the way it is, and its revision history
- [Jira capability research](docs/JIRA_RESEARCH.md)
- [Roadmap and references](docs/ROADMAP.md): the before-pilot checklist, what is deliberately not in V1 and why, and the TERSL/Tourbillon notes
