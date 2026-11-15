# Task Lite: local agent coordination

Task Lite is the shared, enforced source of truth that AI agents work through: what work exists, what's eligible to start, who holds it, what it depends on, which decisions apply, and what the owner must verify. Agents use it over a local MCP endpoint; the server enforces the rules (claims and leases, dependencies, review gates), so agents don't have to remember them. A web UI lets the owner supervise: what agents did, what they're doing, and what needs the owner.

**Why it exists:**
- **Fewer tokens.** Each agent gets its context in one budgeted call, compact results and patch-style writes, instead of re-reading tickets and documents.
- **Dependencies agents don't track by hand.** Ready work is computed by the server from the dependency graph and each project's blocker rule.
- **Visibility.** Everything agents do goes through Task Lite, so the owner sees what actually happened.

It isn't an agent runner. Orca, or the owner, starts agents (owner decision 18), and Task Lite tells them what to do and records what they did.

**Current phase: ready to build V1.** No container or MCP server has been implemented yet. V1 is built and verified with disposable sample work; a real pilot project is chosen afterward.

## Start here (builders)
1. [Build spec](docs/BUILD_SPEC.md): architecture, data model, domain rules, MCP tools, UI API, seed data, tests, milestones and the decisions log.
2. [MCP spec](docs/MCP_SPEC.md): the agent-facing contract (server instructions, every tool's description and schema, errors, worked flows, client setup). Agents are the primary users.
3. [UI spec](docs/UI_SPEC.md): screens, components, design tokens, states, motion and accessibility.
4. [Prototype](design/prototype.html): the clickable visual reference. Open it with `?selftest` to render every view.
5. [Sample data](design/sample-data.json): the seed dataset, exported from the prototype.

## Using it in a project
Connect your agents ([MCP spec §11](docs/MCP_SPEC.md#11-client-setup)), then paste [templates/AGENTS-tasklite.md](docs/templates/AGENTS-tasklite.md) into the project's `AGENTS.md` and/or `CLAUDE.md` and fill in its placeholders. It tells agents this project's rules: who moves work to Ready, when human review is required, and which planning docs are expected.

## Background
- [Requirements and owner decisions](docs/REQUIREMENTS_DRAFT.md)
- [UI design record](docs/UI_DESIGN.md): why the UI is the way it is, and its revision history
- [Jira capability research](docs/JIRA_RESEARCH.md)
- [Roadmap and references](docs/ROADMAP.md): the before-pilot checklist, what is deliberately not in V1 and why, and the TERSL/Tourbillon notes
