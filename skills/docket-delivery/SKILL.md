---
name: docket-delivery
description: Get finished work tested, merged and deployed quickly and safely, in any language, CI system or host. Use when you open or update a pull request, deal with CI, a required check or a merge queue, prepare a release or deployment, change CI or deployment config, or when delivery feels slow or stuck.
---

# Delivering finished work

How to take a change from "the code works" to "it's merged and running", without waiting on people you don't need and without weakening the checks that protect the main branch.

**The project's rules come first.** Its Workflow notes (the `workflow:` section of `get_context`), its `AGENTS.md` / `CLAUDE.md`, its required approvals and its protected-environment rules override everything here.

**This skill grants no authority.** It never gives you permission to merge, deploy or touch production. Where the project allows a step, do it yourself and go all the way through. Where it doesn't, or you can't tell, stop at the last step you're sure of, say exactly what's left, and ask with `ask_owner`.

**First, find out what this project has:**

- how CI runs, and which checks are required to merge;
- whether there's a merge queue, and how merges are made;
- how and where it deploys, and who may do it;
- what else depends on the systems you'd touch.

Read the config rather than assuming. **If the project lacks something** (a queue, staging, CI, a deploy step), use the closest equivalent below. If there's none, say so instead of implying the check happened.

Rare paths live in reference files: read one only when the table at the end says so.

## 1. Own it through delivery

- Take your task through tested, merged and deployed, as far as the project allows. An open PR isn't finished work.
- Don't wait on or coordinate with other implementers unless you truly share a resource, such as one database, test environment or deploy slot.
- Let the merge queue decide the order. Queue your PR when it's ready. If another lands first, the queue retests yours.
- **No queue?** Merge main into your branch, rerun the required checks, and merge while they're green.
- CI running is still your work. Stay with it until it has a result, then act on it.

## 2. Keep parallel work from colliding

- Keep PRs small, with one purpose each.
- Avoid shared sequence numbers and hand-maintained indexes that every PR edits. Prefer timestamps, one file per entry, or a generated index.
- If the project does use a sequence (migration numbers, for example), take the next number at merge time, not when you start.
- Update a pushed branch by **merging main**. Don't rebase or force-push history others may have built on, unless the project's rules ask for it.

## 3. Make CI faster

Before you change how CI runs (splitting jobs, sharding suites, caching, paid capacity), read the ci-speed reference. Measure before and after; keep a change only if it helps.

## 4. Fast feedback, full safety

- On PRs, run the fast checks and whatever the change affects.
- **Run everything** when you're unsure what's affected, or when shared code, config, CI, the build or dependencies change.
- **The full suite must pass on the exact combined code before merge:** your change on top of current main. A merge queue does this for you.
- **No queue?** Update from main and run the full suite right before merging.
- A flaky test is a bug. Don't retry until it's green and call that proof. Record it, and fix it or raise it.

## 5. Protect the gate

The gate is whatever actually stops a bad merge.

- Make required checks **aggregates**: one job that always runs and **fails if any job it depends on failed, was cancelled or was unexpectedly skipped**. Many CI systems treat a skipped job as passing.
- List intended skips explicitly, so an unexpected one fails.
- **When you change CI, prove the gate.** On a throwaway branch, plant a failure in each job in turn, and confirm the aggregate goes red and the merge is blocked. Then remove the failures.
- **Never queue something the gate can't actually stop.** If you can't show that it works, tell the owner first.
- Never skip, weaken or bypass a check to get a merge through.

## 6. Don't waste runs

- Cancel superseded runs on PR branches. **Never cancel merge-queue or main runs:** that can stall other people's work or leave main unverified.
- Don't retest a merge whose tree is identical to one that already passed. Compare the tree hash, and reuse the result only where the project's CI can do so safely.
- **Batch fixes before you push,** because each push can restart a long run. Reproduce a failure on its own first when you can.
- Read the failure before rerunning. Rerun unchanged only for a failure you've identified as infrastructure.

## 7. Deploy each merge promptly

Finished work held for a bundled release delays fixes and makes each release riskier. Where the project allows it, deploy each merge soon after it lands.

1. **Confirm** that you may deploy, and to which target.
2. **Pin an immutable version:** an image digest or exact commit, never a moving tag or branch name.
3. **Check preconditions as hard stops before each step:** the right host, a healthy service, enough disk, the expected current version. If one fails, stop.
4. **Back up first when data is involved,** and confirm the backup exists and is readable.
5. **Deploy.**
6. **Read back what's actually running:** version or digest, health, migration state. A command that exited cleanly proves nothing about what's live.
7. **Keep a rollback path:** the previous version and how to return to it. **If a migration makes rollback unsafe, say so before you deploy,** and state the real recovery (restore the backup, or fix forward).

**Nothing to deploy?** For a library or desktop app, publishing a release is the equivalent. The same rules apply.

## 8. Respect shared systems

- Before you restart, stop, migrate or clean up a service or machine, **check who else depends on it**.
- Never remove containers, volumes, caches or data you didn't create.
- For live data, prefer a coordinated quiet window.
- **When a precondition fails, stop and report it.** Don't guess, force it or work around it.

## 9. Test against reality

Fixtures written from the same assumptions as the code hide real bugs.

- Before trusting logic that interprets real data (imports, parsers, log readers, migrations, third-party responses), **run it read-only against a private copy of real data or real formats**, where the project permits that.
- Compare the result with the source yourself.
- **Then delete the copy.** Never commit it, or paste it into logs, tickets or fixtures.
- **No access to real data?** Use published format documentation or samples, and report the logic as unverified against the real thing.

## 10. Review where it counts

Get an independent review for:

- privacy and security;
- destructive actions;
- host or infrastructure changes;
- the merge gate itself.

Don't make review a queue for routine changes: tests and the gate cover those. If the project requires review for everything, follow that.

## 11. Weigh cost against time

**Moving to paid capacity is the owner's decision.** Don't turn it on yourself; bring measured numbers (see the ci-speed reference).

## 12. Report honestly

When you hand off or finish, say:

- **what ran,** on which commit, and the result;
- **what didn't run,** and why;
- **what was verified only on fixtures** or mocks;
- **what only the real environment can prove,** and who can check it;
- **what was deployed:** where, the version you read back, and how to roll it back.

Never report green from memory, from an old run or from a different commit. A skipped check is not a passed check.

## Tracking it in Docket

Keep following `docket-worker`: report each commit, stay live while CI runs, and close the item only when the project's definition of done is met.

## References

| File                                               | Read when                                                                                       | Don't read when                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`references/ci-speed.md`](references/ci-speed.md) | CI is slow, you change how CI jobs are split, sharded or cached, or you weigh paid CI capacity. | You only open a PR, wait for its checks or read a failure. |
