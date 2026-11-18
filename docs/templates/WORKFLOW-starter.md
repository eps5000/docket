## Moving work to Ready
- Only the owner moves items to Ready. When planning is done, `add_note` "Ready for your review in Planning" and stop.

## Planning documents
- Small fixes: none.
- User-facing features: a short PRD and UX notes.
- Data-model or migration changes: a technical design.
- Store them with `put_document` (kind `planning`) on the item.

## Human review
- Required for anything a user sees or touches, data migrations, and anything security-related. Declare it with `declare_human_review` during Planning.
- Not needed for internal refactors with passing tests, or docs-only changes. Close those yourself with `set_status` "done" once your checks pass.
- Write the packet's "how to verify" steps so the owner never has to ask: exact URLs or commands, and what to look at. Attach screenshots for UI changes.

## Blockers
- A blocking item counts as finished when it's done. Where one dependency needs more (for example a schema that must be merged first), set `satisfied_when` on that link.

## Branches and commits
- One branch per item, named `<item-id>-short-name`, with pull requests against `main`.
- Report every commit with `report_commit` on the item it belongs to.

## Checks to run
- Before `submit_packet` or "done": unit tests, lint and the type check; the end-to-end tests too for UI changes. Record them with `set_checks`.

## Decisions worth recording
- Record API shapes, naming conventions and library choices with `publish_decision`, scoped as narrowly as they apply. Routine implementation details don't need one.

## Labels
- Use `#regression` for bugs that broke something that used to work.
- Ask before creating a new label.
