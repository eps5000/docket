# Crash recovery and re-dispatch

**Read when:** After a crash or restart, `recovery_report` lists interrupted, stale, parked or orphaned entries, or work is left in an ended run's worktree.
**Don't read when:** `recovery_report` lists nothing to act on.

The pruning rules in the skill always apply: prune only `safe_to_prune`, never `in_use`, `parked` or `at_risk`, and treat `unknown` as not safe.

## A restart alone

A Docket restart keeps open runs open. Leave a `stale` run whose `lease_expires_at` is still ahead: if it never returns, the lease ends it and it shows as interrupted.

## After a crash

Call `recovery_report { include_briefs: true }`. Then, for each interrupted entry, and each stale entry whose lease has run out. Skip entries with no workspace and no brief: you didn't dispatch them, so leave them to the owner.

1. **Find the code:**
   - if the worktree at `workspace.path` still exists, reuse it;
   - if it's gone, recreate it from `pushed_sha` on its `branch`;
   - if `dirty` was true or `head_sha` was ahead of `pushed_sha`, work may be lost. Say so in the new brief. The owner already sees it under Problems.
2. **Re-dispatch** with the **stored brief, unchanged**, plus: "Resume from the checklist: `claim_lead` first, then `get_context` and `get_item`." Have the worker pass `brief_document_version_id` from the report rather than the text, so the same stored version is reused instead of copied. Start the new prompt with the stored brief exactly as the report gives it, and put everything you add (the resume line, the lost-work warning) after it. **Never edit lines inside it.**
3. **Clean up** that run's unreleased resources: everything in its `run.resources` that has no `released_at`.

## Parked entries

A parked run keeps its claim through a crash, so a new worker's `claim_lead` would get `conflict`.

- If `resume_ready` is true and the worker's process is still alive, send it more work.
- If the process is gone, re-dispatch a worker with the parked run's **`run_id`** from the report, and tell it: "Don't claim. Continue under run `<run_id>`: call `heartbeat` with it first, which resumes the parked run; then `get_context` and `get_item`."
- Otherwise leave it: it's waiting on purpose.

## Orphaned resources

Stop every entry in `orphaned_resources`, using its locator. The resumed run, or the owner, marks it released. A resource only counts as orphaned 15 minutes after its run ended, so right after a crash look at the interrupted runs' own unreleased `run.resources` too.

## Work left in an ended run's worktree

It comes to you in `get_digest` problems. Commit and push it, or say it can go. **Never push work on a canceled item:** that's the owner's call.

## Finally

Call `recovery_report` again. Nothing interrupted should be left un-dispatched, and nothing should be orphaned.
