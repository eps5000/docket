# Declaring shared changes

**Read when:** You declare an item's shared changes, register a part, set design impact, or a problem needs a new plan.
**Don't read when:** The item is declared and nothing about its parts has changed.

## Declare

- **`list_shared_parts { project }` first,** and name parts by their registered keys (`model:Token`, `table:decks`, `endpoint:POST /decks/{id}/export`, `file:src/…/Snapshot.cs`).
- **`declare_shared_changes { id, changes: [{ part, change, note }] }`,** with `change` one of `add`, `change` or `remove` and a one-line note. Each call replaces the declaration.
- **Name the member when you can** (`model:Token.expiresAt`, `table:decks.title`): adding different members runs in parallel, while a bare part means "could touch anything in it" and is sequenced.
- **Register a missing part** in the same call with `new_parts: [{ key, paths }]`, giving the repo paths that belong to it.
- **An item that changes no shared part** declares `none: true`.
- **When the item already has branches** (work in progress, or a backfill), pass them as `branches` (or one as `branch`), so the conflict radar checks each.
- **Creating a ticket?** `shared` on `create_item` declares part keys (or `"none"`) in the same call. A key that isn't registered is registered with it; members, notes and `add` or `remove` go through `declare_shared_changes` afterwards.

## An approved design

If a change alters an approved design, set `design_impact: "changes_approved_design"` with a `design_note` naming it. That always reaches the owner, and the item can't start or close until they approve it; other items carry on.

## Two items on the same part

Docket decides. Safe overlaps run in parallel, the rest run in order (first claimed goes first), and the owner hears only about cycles and disputes. If you know which should go first, link them now (`link_items { type: "blocks" }`). "Add-only" doesn't prevent a merge conflict: two branches inserting at the same line still conflict, and the radar gives them a merge order.

## A problem that needs a new plan

An epic branch far behind main, or two items that keep colliding: propose it with `propose_resolution { problem, kind: "split" | "rescope" | "reorder" | "other", plan_md, reason }`, using the problem's ID from `get_context`, and wait for the owner's choice in `resolutions:`. Routine fixes (a rebase, dropping an old branch from the item's branches) need no proposal.
