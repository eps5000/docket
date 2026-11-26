---
name: docket-planner
description: Turn a goal into well-shaped Docket work. Covers epics and items with testable outcomes and acceptance criteria, dependency links with the right satisfied_when rule, labels, planning documents, early human review, and decision records. Use when asked to plan, break down or shape work in Docket, or to prepare items for Ready.
---

# Planning work in Docket

Good planning is what makes `ready_to_start` trustworthy. Workers then pick up items that are unblocked, clear and checkable, with no guessing.

**Planning belongs to the owner.** You draft, and the project's `AGENTS.md` says whether you may move items to Ready. If it doesn't say so, finish with `add_note` "Ready for your review in Planning", and stop.

Rare paths live in reference files: read one only when the table at the end says so.

## 1. Before creating anything

- **Check for duplicates:** `search_items { project, text: "<key words>" }`. Archived items are included, and Jira keys match too.
- **Read what applies:** `list_decisions { project }`, plus the label brief if the work belongs to an initiative. Follow owner decisions; plan inside them.

## 2. Shape

| Use                                             | For                                                                         | Not for                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Epic**                                        | A deliverable the owner would recognise ("Pantry")                          | A theme that spans several deliverables                      |
| **Exploration / Design / Implementation / Bug** | One outcome that needs its own blocker, owner or review                     | A step inside someone's work: use `set_plan`                 |
| **Release**                                     | The one closing ticket Docket creates with every epic                       | An intermediate rollout to Dev or another shared environment |
| **Label**, with a `brief_md`                    | An initiative across epics, with shared rules in its brief (`upsert_label`) | Status or priority                                           |

**Split a piece into its own item only when it needs its own blocker, owner or review.**

Every epic has one Release ticket. A deploy, cutover or flag change in a shared environment that other tickets wait for is its own **Implementation** ticket marked `rollout: true`, with links from its dependents. Read the ticket-types reference when choosing types or shaping an epic's Release.

**For every item:**

- `outcome_md`: one or two sentences on what's true for the user when it's done;
- `acceptance`: 2–6 lines, each checkable by an agent or a person, **and each one this ticket can finish on its own**. A check that needs another ticket's deploy, a feature flag it turns on, a cutover or an environment belongs on that ticket. If it must stay here, name it as a known gap (§7), so the implementer doesn't finish partly;
- `priority`: 1 means it unblocks or matters most;
- `effort` if you can estimate it (points or hours, whatever the project uses). It feeds the forecast. Leave dates to the owner unless asked.

**Example:**

```
create_item { project: "RCP", type: "Epic", title: "Pantry", status: "planning",
  outcome_md: "Users keep a pantry list and get recipe suggestions from what's at home." }
create_item { project: "RCP", type: "Design", title: "Pantry inventory schema", epic: "RCP-2",
  status: "planning", acceptance: ["Items have name, quantity, unit, expiry", "Migration is reversible"] }
create_item { project: "RCP", type: "Implementation", title: "Pantry-aware recipe suggestions", epic: "RCP-2",
  status: "planning", blocked_by: ["RCP-15"], acceptance: [...] }
```

## 3. Dependencies

- **Link only real dependencies.** "B can't start until A is finished" is a link: use `blocked_by` on create, or `link_items { type: "blocks" }`. "These are related" is `relates`, which is informational and never blocks.
- **Choose what "finished" means** for each `blocks` link with `satisfied_when`. Omit it to use the project default.

  | Rule       | Use when                                                                                     |
  | ---------- | -------------------------------------------------------------------------------------------- |
  | `done`     | B only needs A's decision or interface to exist                                              |
  | `merged`   | B builds on A's code: schemas, shared modules, migrations                                    |
  | `verified` | B is only worth doing once the owner has approved A by hand. A must have human review items. |

- **Check the shape** with `dependency_subgraph { id: <epic or key item>, depth: 3 }`:
  - no cycles (cycles are rejected anyway, with the path);
  - a sensible number of waves;
  - nothing important stuck behind a long chain.

  With planned dates, `delay_days` shows what a slip would push.

- **Prefer short, wide graphs.** Long chains serialise the agents.

## 4. Human review: declare it now

If the owner must check something by hand, `declare_human_review` during Planning. Use plain instructions they can follow in minutes ("On your phone, drag a recipe between days. Does it feel right?").

**If an epic ships as one PR,** declare it once on the epic, not on each child. See `docket-review-packet` for what makes a good item.

## 5. Planning documents and decisions

- **Planning docs:** add them as the project's `AGENTS.md` expects for the risk level, with `put_document { item_id, kind: "planning" }`. For example a short PRD for user-facing features, or a TDD for data-model changes. Uploading again under the same name makes a new version.
- **Conventions:** record conventions that the epic's workers must share (units, API shapes, naming) with `publish_decision`, scoped to the epic or label. That way every worker gets them through `get_context`.

**Forecast decisions while shaping.** In the planning document, separate the owner's expected outcomes, constraints and review points from choices the agents may make to reach them. Read the owner-expectations reference when shaping a new goal or when the approved boundary is unclear. Ask about genuine gaps and record the answer; don't turn every predicted choice into a question.

## 6. Shared changes: declare before Ready

Parallel items collide when they change the same table, model, endpoint or shared file. Before an item can move to Ready, declare what it will change with `declare_shared_changes`, or `none: true` when it changes no shared part; moving an undeclared item fails with `not_declared`. **Never leave a ticket undeclared.** Read the shared-changes reference before you declare, or when a problem needs a new plan.

## 7. Known gaps and epic readiness

**Work that joins a running epic lands in Inbox** and is marked added mid-flight. Its producer delegates bug investigation to a QA agent, then triages the evidence and recommendation into this epic or the epic it belongs in; a story goes to the owner (add, defer or drop). The epic can't close while one is untriaged. Don't create mid-flight tickets as Ready.

**An epic can't start while any of its tickets is in Inbox or Planning** (`epic_not_ready`). Inbox is an idea nobody is ready to plan; Planning still has gaps. Before an epic starts, make every ticket at least Ready: shape it, name its known gaps, move it to the epic it belongs in (`update_item { epic }`), or take it out (`update_item { epic: null }`).

**Known gaps** are the few things that are better settled during implementation, such as an exact limit or the wording of a message. A ticket can name up to 6:

```
update_item { id, expected_version, known_gaps: [{ gap: "Which retry limit to use" }] }
set_status { id, status: "ready" }
```

With open gaps, `set_status ready` is refused and **Docket asks the owner** ("Approve moving GF-1 to Ready with these gaps?"). Don't ask again with `ask_owner`. If they approve, Docket records their decision and moves the ticket to Ready; if not, keep shaping. A gap you've settled gets `settled: "<how>"` and no longer needs approval. Changing a gap clears an approval.

## 7a. Shaping a Needs shaping ticket

A producer sends you a ticket that **needs shaping**: read the needs-shaping reference and work through its checklist.

**Creating tickets yourself:** pass `outcome_md`, `acceptance` and `shared` (part keys, or `"none"`) to `create_item` so they arrive shaped.

## 8. Many writes at once

When a breakdown or an onboarding runs to dozens of items, documents or links, send them with `apply_batch`. Read the batch-writes reference first.

## 9. Hand back

1. Add one `add_note` on the epic: how you broke it down, what's blocked on what, and any open questions.
2. If a material choice remains outside the documented owner expectations or delegated bounds, `ask_owner` on the epic, with options and your recommendation. An approved design already settles choices within its stated bounds.
3. Move items to Ready (`set_status { status: "ready" }`) **only if the project allows it**. Even then, only items with acceptance criteria, the expected planning docs, their shared changes declared, and no open questions. Open known gaps go to the owner instead (§7).

## Don't

- Create tickets for steps a single worker will do. Those are checklist steps.
- Link everything to everything. Each unnecessary `blocks` link delays real work.
- Write acceptance criteria nobody can check ("works well", "is fast").
- Copy requirements into several items. Put shared rules in the epic, the label brief or a decision.

## References

| File                                                                   | Read when                                                                                                        | Don't read when                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`references/shared-changes.md`](references/shared-changes.md)         | You declare an item's shared changes, register a part, set design impact, or a problem needs a new plan.         | The item is declared and nothing about its parts has changed.                                    |
| [`references/needs-shaping.md`](references/needs-shaping.md)           | A producer sends you a ticket that needs shaping.                                                                | You're creating tickets yourself with an outcome, acceptance and `shared`.                       |
| [`references/batch-writes.md`](references/batch-writes.md)             | You send more than a handful of writes in one go with `apply_batch`, or add details to steps imported from Jira. | You make a few single calls.                                                                     |
| [`references/ticket-types.md`](references/ticket-types.md)             | You choose a ticket type, shape an epic's Release, or find a shared-environment rollout in acceptance.           | You only edit the checklist of an already typed ticket.                                          |
| [`references/owner-expectations.md`](references/owner-expectations.md) | You shape a new goal or cannot tell which choices the owner delegated.                                           | The approved design already states the outcome, constraints, review points and delegated bounds. |
