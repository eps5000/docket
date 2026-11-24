# Epic readiness, bugs and the finish line

**Read when:** Before you claim an epic, or the digest or a claim shows `epic_not_ready`, `started unshaped`, `release held by bugs` or `no finish line`.
**Don't read when:** The epic is running, every ticket is at least Ready and no bug is open in it.

## Every ticket at least Ready

An epic starts only when every ticket is at least Ready. Before you claim it, `search_items { project, epic }` and check none is in Inbox or Planning (canceled ones don't matter). A claim that fails with `epic_not_ready` lists them. Resolve each one:

- **shape it** and move it to Ready (`docket-planner`);
- **name its known gaps** for the owner's approval: `update_item { known_gaps: [{ gap }] }`, then `set_status ready`, and Docket asks the owner;
- **move it** to the epic it belongs in (`update_item { epic }`);
- **take it out** of the epic (`update_item { epic: null }`).

An epic already In progress isn't blocked. If the digest shows it under `started unshaped`, resolve those tickets the same way.

## Bugs hold the release

Every open bug in the epic holds its release. The finish line (the release ticket nothing else in the epic depends on) can't go to Review or Done while one is open; the digest lists them under `release held by bugs`. Triage each new bug either way:

- **Ready in this epic:** it holds the release, so schedule the fix;
- **out of the epic:** a follow-up (`update_item { epic }`), or `set_status canceled` with a reason. Shipping without the fix is then a recorded choice.

## No finish line

If the digest says `no finish line`, mark the release ticket: `update_item { id: <epic>, finish_line: <ticket> }`.
