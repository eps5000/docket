# Shared parts, conflicts and leases

**Read when:** You declare shared changes, change a part you didn't declare, set design impact, take a lease, hit a text conflict, or act on `problems:` or a conflict-radar note.
**Don't read when:** Your item declared its parts and nothing about them has changed.

A shared part is something several items may change: a table, model, endpoint or shared file. Docket orders work on the same part so parallel items don't collide.

## Declaring

- **`declare_shared_changes { id, changes: [{ part, change, note }] }`,** with `change` one of `add`, `change` or `remove`, or `none: true` when the item changes no shared part. Each call **replaces** the whole declaration, so send the full list.
- **Name parts by their keys** from `list_shared_parts`. Register a missing one in the same call with `new_parts: [{ key, paths }]`.
- **Name the member when you can** (`model:Token.expiresAt`): adding different members runs in parallel, while a bare part is sequenced.
- **Pass `branches`,** every branch the work is on (or `branch` for one), every time, also when you backfill a declaration for work already in progress. The list replaces the item's branches, and the conflict radar checks each one.
- **Change a shared part you didn't declare?** Add it now: the whole list again.
- **Filing a ticket?** Pass `outcome_md`, `acceptance` and `shared` (part keys or `"none"`) to `create_item`. Unsure? Leave them out: it Needs shaping, for a planner.

The result lists in-flight items on the same parts, each with its outcome. Moving to Ready without a declaration fails with `not_declared`.

## Changing an approved design

Set `design_impact: "changes_approved_design"` with a `design_note` naming the design, decision or acceptance criterion. It always goes to the owner, overlap or not, and **this item pauses until they approve it**: `claim_lead` and closing return `design_review`, and a packet is held.

- Stop the affected work and take other work from `ready_to_start`. Other items aren't affected.
- **Never** try to clear it by removing the flag.
- If the owner sends it back, follow their note, then declare again.
- You and another agent disagree about who owns a part? Set `disputed: true`; that reaches the owner too.

## Conflicts

- **Commit and report early** (`report_commit`, and your `branch`). The conflict radar only sees committed local branches. A clean trial merge means git can combine them, not that they work together.
- **A text conflict stops nobody.** Your context says who merges first. If you're second, keep working, then merge main once the first lands. If the merge isn't mechanical, or would change what the other work does, use `propose_resolution`.

## Single-writer parts

Such as a migrations snapshot: `take_lease { id, part }` **before** you generate or edit it; call again to renew. It lasts 2 hours and ends when the item is done or handed off. `release_lease` as soon as the change is committed and pushed. On `lease_held` (with holder and expiry), work on another step or item and call `take_lease` again later. **Never wait in a loop.**

## Problems

**`problems:` in your context, or a "Docket's conflict radar" note,** is yours to fix first: it says what's wrong, what fixes it and who acts. You have about a day before the owner sees it.

- **Routine fixes need no proposal:** merge main into a branch that's out of date, or drop an old draft branch from the item's branches with `declare_shared_changes`. Docket records both on the item.
- **A fix that changes the plan** (split the work, change its scope or its order): `propose_resolution { problem, kind, plan_md, reason }`, with `kind` one of `split`, `rescope`, `reorder` or `other` and the problem's ID from your context (or `id` for the item in general). Then work on what doesn't depend on it.
- The owner approves it, asks for a different way with a note, or acknowledges it. Their choice arrives as an owner note and in `get_context` `resolutions:`. After "go a different way", follow the note and propose again if you need to.

## Closing with undeclared files

Pass `changed_files` and `branch` when you close or hand off. Files in shared parts the item didn't declare: Docket adds the safe ones to the declaration and carries on. If one needs the owner, `submit_packet` returns `held_undeclared` and `set_status` fails with `not_declared`. Leave the item as it is; the owner decides.
