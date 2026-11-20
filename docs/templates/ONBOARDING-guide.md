# Onboard this repo into Docket project {{KEY}}

You turn the repo's planning into Docket items the owner can review. Work through the steps in order. Don't claim items, don't write code, and never move anything to Ready: the owner does that after reviewing.

Keep the `session_id` from `onboard_project`. Pass `idempotency_key` on every create so a retry can't duplicate.

**Batch your writes.** Send creates, enrichments, links and documents with `apply_batch`: up to 100 operations a call, each with the same arguments as its own tool. Each is checked and applied on its own, so read every result, fix the failures and resend only those. `"$1"` stands for the ID operation 1 created, such as an epic for its items. Pass `idempotency_key` on each batch. Never script a second connection.

## 1. Survey (read only)
Read these if they exist, and note each one's path:
- Spec Kit: `specs/*/spec.md`, `plan.md`, `tasks.md`, and the constitution (`.specify/memory/constitution.md`).
- ADRs and decision notes (`docs/adr/`, `docs/decisions/`).
- READMEs, `docs/`, open issues and `TODO`/`FIXME` comments that describe planned work.
- Build, test and branch conventions: `package.json` scripts, CI files, `CONTRIBUTING.md`.

Make one list of units of work, each with its source path (`specs/001-checkout/tasks.md#T003`), title, Jira key if one is written in it, and dependencies.

## 2. Reconcile first
The project may already hold items, from a Jira import or an earlier onboarding. For each unit, before creating anything:
1. Jira key in the text (like `GF-12`): `search_items {project: "{{KEY}}", text: "GF-12"}`, then confirm with `get_item {view: "summary"}` that its `jira` matches exactly.
2. No key: search by the title's distinctive words, then by the source path. A match is the same work, even if worded differently.
3. On a match, enrich it, never duplicate: `update_item` with what's missing (acceptance, outcome, labels, epic) and a description that keeps the existing text and adds `Source: <path>`. Leave its status alone.
4. Jira sub-tasks were imported as work steps on their parent (the step's `source` is the key). When a unit matches one, add to that step's details with `update_step` or `set_plan`: keep the current details at the start, then add `Source: <path>` and what the repo says. Don't create an item for it.
5. Not sure it's the same work: don't merge. Create it, and `link_items {type: "relates"}` to the candidate.

## 3. Create the rest
Everything goes in `status: "planning"` (or `inbox` when it's only an idea).
- **Epics** from features and specs: `create_item {type: "Epic"}`, one per spec or feature.
- **Items** from tasks: Story for user-facing work, Task otherwise, Bug for defects. Set `epic`, `acceptance` (testable lines), `outcome`, and a `description_md` whose last line is `Source: <path>`, so a second run can match it.
- **Dependencies:** `blocked_by` on create, or `link_items {from: <blocker>, to: <blocked>, type: "blocks"}`.
- **Labels** for cross-cutting areas (`auth`, `payments`): `labels` on create; brief them with `upsert_label`.
- **Planning documents:** attach each spec and plan with `put_document {item_id: <epic>, name: "001-checkout-spec.md", kind: "planning", content_text}`, named after its source path. Use `project` instead for repo-wide documents. A name the item already has adds a version to that document, so check the item's documents first and pick a new name unless it's the same file.
- **Shared parts:** the most-changed shared files in `git log --since=90.days --name-only --format=` (migrations, models, schemas, API contracts): register them with `declare_shared_changes` `new_parts` on the items that change them.
- **Decisions** from the constitution and ADRs: `publish_decision {project: "{{KEY}}", scope: {kind: "project"}}`, or scope them to an epic. Skip ones already listed by `list_decisions`.

Skip done work unless an open item depends on it. Never copy secrets or credentials into Docket.

## 4. Propose Workflow notes
`get_agent_files {project: "{{KEY}}", file: "workflow"}` for the current notes and their `version_id` (null when there are none). Write one `##` section per starter question, answered from what the repo shows; leave out what it doesn't show:
- **Moving work to Ready:** only the owner does.
- **Planning documents:** which changes need a PRD or design?
- **Human review:** what the owner must verify, and how "how to verify" steps read.
- **Blockers:** when a blocker counts as finished.
- **Branches and commits:** branch names, pull requests, commit style.
- **Checks to run:** the exact test, lint and type-check commands.
- **Decisions worth recording.**
- **Labels:** which exist, and when to add one.

Send the whole text with `propose_agent_file_change {project: "{{KEY}}", file: "workflow", content, reason, based_on_version_id}`. The owner approves it.

## 5. Ask
Ask only what the repo can't answer and the owner must decide (scope, priority, conflicting sources). Use `ask_owner` on the relevant epic: one open question per item, so combine related ones. Put the rest in `finish_onboarding`'s `questions`.

## 6. Finish
`finish_onboarding {session_id, summary, questions}`. The summary is honest and short:
- created: epics, items, documents, decisions;
- enriched: which existing items, and what you added;
- skipped: what and why (done work, duplicates, unclear sources);
- anything you couldn't read.

Then stop: tell the user the owner reviews it from Needs you.
