---
name: tasklite-planner
description: Turn a goal into well-shaped Task Lite work. Covers epics and items with testable outcomes and acceptance criteria, dependency links with the right satisfied_when rule, labels, planning documents, early human review, and decision records. Use when asked to plan, break down or shape work in Task Lite, or to prepare items for Ready.
---

# Planning work in Task Lite

Good planning is what makes `ready_to_start` trustworthy. Workers then pick up items that are unblocked, clear and checkable, with no guessing.

**Planning belongs to the owner.** You draft, and the project's `AGENTS.md` says whether you may move items to Ready. If it doesn't say so, finish with `add_note` "Ready for your review in Planning", and stop.

## 1. Before creating anything

- **Check for duplicates:** `search_items { project, text: "<key words>" }`. Archived items are included, and Jira keys match too.
- **Read what applies:** `list_decisions { project }`, plus the label brief if the work belongs to an initiative. Follow owner decisions; plan inside them.

## 2. Shape

| Use                          | For                                                                         | Not for                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Epic**                     | A deliverable the owner would recognise ("Pantry")                          | A theme that spans several deliverables                                     |
| **Story / Task / Bug**       | One agent session to a few, usually one PR, with its own outcome            | A step inside someone's work: that's a checklist step, made with `set_plan` |
| **Label**, with a `brief_md` | An initiative across epics, with shared rules in its brief (`upsert_label`) | Status or priority                                                          |

**Split a piece into its own item only when it needs its own blocker, owner or review.**

**For every item:**

- `outcome_md`: one or two sentences on what's true for the user when it's done;
- `acceptance`: 2–6 lines, each checkable by an agent or a person;
- `priority`: 1 means it unblocks or matters most;
- `effort` if you can estimate it (points or hours, whatever the project uses). It feeds the forecast. Leave dates to the owner unless asked.

**Example:**

```
create_item { project: "RCP", type: "Epic", title: "Pantry", status: "planning",
  outcome_md: "Users keep a pantry list and get recipe suggestions from what's at home." }
create_item { project: "RCP", type: "Task", title: "Pantry inventory schema", epic: "RCP-2",
  status: "planning", acceptance: ["Items have name, quantity, unit, expiry", "Migration is reversible"] }
create_item { project: "RCP", type: "Story", title: "Pantry-aware recipe suggestions", epic: "RCP-2",
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

**If an epic ships as one PR,** declare it once on the epic, not on each child. See `tasklite-review-packet` for what makes a good item.

## 5. Planning documents and decisions

- **Planning docs:** add them as the project's `AGENTS.md` expects for the risk level, with `put_document { item_id, kind: "planning" }`. For example a short PRD for user-facing features, or a TDD for data-model changes. Uploading again under the same name makes a new version.
- **Conventions:** record conventions that the epic's workers must share (units, API shapes, naming) with `publish_decision`, scoped to the epic or label. That way every worker gets them through `get_context`.

## 6. Hand back

1. Add one `add_note` on the epic: how you broke it down, what's blocked on what, and any open questions.
2. If something needs an owner decision, `ask_owner` on the epic, with options and your recommendation.
3. Move items to Ready (`set_status { status: "ready" }`) **only if the project allows it**. Even then, only items with acceptance criteria, the expected planning docs, and no open questions.

## Don't

- Create tickets for steps a single worker will do. Those are checklist steps.
- Link everything to everything. Each unnecessary `blocks` link delays real work.
- Write acceptance criteria nobody can check ("works well", "is fast").
- Copy requirements into several items. Put shared rules in the epic, the label brief or a decision.
