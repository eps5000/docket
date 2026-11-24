# Many writes with apply_batch

**Read when:** You send more than a handful of writes in one go with `apply_batch`, or add details to steps imported from Jira.
**Don't read when:** You make a few single calls.

`apply_batch` takes up to 100 `operations` a call, each naming a tool (`create_item`, `update_item`, `link_items`, `upsert_label`, `set_plan`, `update_step`, `put_document`, `publish_decision`) with the arguments you would give it.

- **Each operation is checked and applied on its own,** in order. One that fails changes nothing and doesn't stop the rest, so read every result and resend only the failures.
- **`"$1"` in an argument is the ID operation 1 wrote,** so an epic and its items fit in one batch: `epic: "$1"`.
- **Pass `idempotency_key` on each batch:** a retry then replays what succeeded and runs only what failed.
- **Created tickets that need shaping** are listed on one line at the end of the result; a planner shapes them.

**Steps imported from Jira** (they have a `source`): you may add to their details, keeping the current text at the start. Their text stays the owner's.
