# Contract index: MCP tools

**Authoritative**: [MCP_SPEC.md](../../../docs/MCP_SPEC.md). That file holds the description text,
schemas, errors and flows. This index maps the 38 tools to user stories and spec requirements, so
the tasks can be grouped by story. Change a tool only in MCP_SPEC.md, together with
`shared/mcp-copy.ts`.

| Tool | MCP_SPEC | User story | Requirements |
|---|---|---|---|
| `whoami`, `list_projects` | §5.1 | US1, US10 | FR-010 |
| `search_items` | §5.2 | US1, US4 | FR-011, FR-012, FR-025 |
| `get_item` | §5.2 | US1, US6 | FR-021, FR-025 |
| `get_context` | §5.2 | US5 | FR-040 |
| `dependency_subgraph` | §5.2 | US4 | FR-024 |
| `deferred_reviews` | §5.2 | US3 | FR-053 |
| `get_changes` | §5.2 | US1, US6 | FR-023 |
| `create_item`, `update_item`, `set_status` | §5.3 | US1, US7 | FR-001 to FR-005, FR-025 |
| `link_items`, `unlink_items` | §5.3 | US4 | FR-030 to FR-035 |
| `upsert_label` | §5.3 | US7 | FR-002 |
| `claim_lead`, `release_lead`, `start_run`, `heartbeat`, `finish_run` | §5.4 | US1 | FR-013 to FR-016 |
| `set_plan`, `update_step`, `log_subagent`, `set_checks`, `update_check` | §5.5 | US1 | FR-017, FR-018 |
| `declare_human_review`, `update_human_review` | §5.5 | US3 | FR-019 |
| `add_note`, `put_document`, `link_artifact`, `report_commit` | §5.6 | US1, US3, US4 | FR-018, FR-052, FR-070 |
| `submit_packet`, `get_review`, `ask_owner` | §5.7 | US3, US6 | FR-020 to FR-022 |
| `publish_decision`, `list_decisions`, `withdraw_decision` | §5.8 | US5 | FR-041, FR-042 |
| `park_run`; the recovery fields on `claim_lead`, `start_run`, `heartbeat` and `report_commit` | §3 (Workspaces, briefs and resources), §5.4, §5.6 | US11 | FR-110 to FR-114 |
| `recovery_report` | §5.9 | US11 | FR-115 |

**Cross-cutting**, from MCP_SPEC:
- connection and auth (§1);
- server instructions (§2);
- conventions: compact text, lean reads, patches, write checks (§3);
- errors (§6);
- owner-side effects (§8);
- contract tests (§10).

**Requirements:** FR-025 to FR-027, FR-100, FR-105, FR-108.
