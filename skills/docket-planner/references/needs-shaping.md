# Shaping a Needs shaping ticket

**Read when:** A producer sends you a ticket that needs shaping.
**Don't read when:** You're creating tickets yourself with an outcome, acceptance and `shared`.

An agent created it unshaped, or the owner asked for a planner from a refused Move to Ready. `get_item` says what it lacks and any note from the owner ("needs shaping: … · the owner asked: …"). Work through this checklist, in order:

1. **Read it and its epic:** the description, the owner's note, the epic's outcome and decisions. Check for a duplicate with `search_items`.
2. **Outcome:** `update_item { outcome_md }`, one or two sentences.
3. **Acceptance:** `update_item { acceptance }`, 2–6 checkable lines, each one this ticket can finish on its own.
4. **Links:** real `blocks` dependencies only, and `relates` for the rest.
5. **Known gaps,** if a few things are better settled while building: `update_item { known_gaps }`. The owner approves Ready with them.
6. **Shared changes, last:** `declare_shared_changes` with the parts it changes, or `none: true` when it changes none (see the shared-changes reference). Never leave it undeclared.

Shaped, it stops being Needs shaping on its own. Move it to Ready if the project allows it; with open known gaps, Docket asks the owner for you. Don't send it to the owner to shape.
