# Task Lite: local agent work tracker

A Docker-hosted task tracker with a local MCP endpoint for AI agents and a web UI that shows the owner what agents did, what they're doing, and what needs the owner.

**Current phase: ready to build V1.** No container or MCP server has been implemented yet. V1 is built and verified with disposable sample work; a real pilot project is chosen afterward.

## Start here (builders)
1. [Build spec](docs/BUILD_SPEC.md): architecture, data model, domain rules, MCP tools, UI API, seed data, tests, milestones and the decisions log.
2. [UI spec](docs/UI_SPEC.md): screens, components, design tokens, states, motion and accessibility.
3. [Prototype](design/prototype.html): the clickable visual reference. Open it with `?selftest` to render every view.
4. [Sample data](design/sample-data.json): the seed dataset, exported from the prototype.

## Background
- [Requirements and owner decisions](docs/REQUIREMENTS_DRAFT.md)
- [UI design record](docs/UI_DESIGN.md): why the UI is the way it is, and its revision history
- [Jira capability research](docs/JIRA_RESEARCH.md)
