# Epic readiness and its Release

**Read when:** Before you claim an epic, or the digest or a claim shows `epic_not_ready`, `started unshaped` or a Release held by bugs.
**Don't read when:** The epic is running and its tickets are shaped.

## Every ticket at least Ready

An epic has exactly one Release, created with it. Shape that ticket during planning. The epic starts only when every ticket, including the Release, is at least Ready. Before you claim it, `search_items { project, epic }` and check none is in Inbox or Planning (canceled ones don't matter). A claim that fails with `epic_not_ready` lists them. Resolve each one:

- **shape it** and move it to Ready (`docket-planner`);
- **name its known gaps** for the owner's approval: `update_item { known_gaps: [{ gap }] }`, then `set_status ready`, and Docket asks the owner;
- **move it** to the epic it belongs in (`update_item { epic }`);
- **take it out** of the epic (`update_item { epic: null }`).

An epic already In progress isn't blocked. If the digest shows it under `started unshaped`, resolve those tickets the same way.

An Exploration may run before the epic is Ready if its findings are needed to shape the other tickets. It needs no shared-changes declaration.

## Bugs hold the release

Every open bug in the epic holds its Release, as does every other unfinished ticket. The Release can't go to Review or Done while one is open; the digest lists the bugs under `release held by bugs`. Triage each new bug either way:

- **Ready in this epic:** it holds the release, so schedule the fix;
- **out of the epic:** a follow-up (`update_item { epic }`), or `set_status canceled` with a reason. Shipping without the fix is then a recorded choice.

If the Release reports `release_gates`, read the release reference for the complete list of gates and the close path.
