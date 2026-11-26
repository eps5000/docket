# docket-sync

A small Node process on the host that collects data for Docket (owner decision 49, B62, BUILD_SPEC §5.35). Docket runs in a container and can't use the host's tools, so this bridges the two. It needs Node 22 and has no dependencies.

It is separate from `tools/docket-relay`. Docket starts and works fully without it.

**It stores no GitHub token and never asks for one.** The GitHub source uses the `gh` login already on this computer, and only reads. It never comments, labels, merges or writes to GitHub. `GH_TOKEN` and `GITHUB_TOKEN` are removed from `gh`'s environment, so only that login is used.

## The source contract

Each file in `sources/<name>.mjs` is one source. It exports:

```js
export const name = 'github';        // lower-case letters, digits and hyphens
export const intervalMs = 300_000;   // how often it runs
export const enabled = (settings) => settings?.enabled === true;
export const collect = async ({ state, log, signal, settings, docket }) => ({
  records: [{ key: 'stable-id', ...fields }],
  state: { anything: 'to keep for next time' },
});
```

A source may also export `batchSize`, a smaller batch than 200 for large records (the git source sends 50). A default export of the same object works too.

| `collect` receives | What it is |
| --- | --- |
| `state` | What this source returned last time, or `{}`. A private copy. |
| `log(event, fields)` | Writes one line. Pass names, counts and error codes only, never content. |
| `signal` | Aborted when the collector is stopping. Pass it to anything slow. |
| `settings` | This source's settings, from `GET /api/sync/<name>`. |
| `docket` | `{ get(path, { signal }) }`: read-only JSON from Docket's `/api/`. |

The runner then:

1. Posts `records` in batches of 200 (or the source's smaller `batchSize`) to `POST /api/sync/<name>`, as `{ records, run: { ok, partial, error?, interval_ms } }`.
2. Saves the returned `state` **only after every batch was accepted**. After a failure the next run starts from the old state.
3. Treats `key` as the record's identity, so sending the same record twice changes nothing.

To fail a run, throw an error with a short `code` such as `network`. The code goes to Settings, and the message is never read, because it could quote output.

**To add a source:**

1. Add `sources/<name>.mjs`.
2. Give it a server side. Either add a handler to `HANDLERS` in `server/src/domain/sync.ts` (its `settings`, how to check a record with `clean`, how to store it with `ingest`), or register its own `GET` and `POST /api/sync/<name>` before the general route, in the same `{ settings, status }` and `{ records, run }` shapes, as `usage` does. Until then Docket answers 404 and the runner skips the source.
3. Add the file to `$script:SourceFiles` in `manage.ps1`.

## The sources

- **`github`** (below): pull requests through `gh`.
- **`usage`** (B63, BUILD_SPEC §5.34): token use from the local Codex and Claude Code logs. Off by default, and with it off no log file is opened.
- **`worktrees`** (B68, BUILD_SPEC §5.32): what each project's worktrees hold, read with git on this computer. It runs whenever the helper runs and a project has a repository folder.
- **`git`** (B76, BUILD_SPEC §5.35): every other git read Docket needs: the conflict radar's trial merges, branch discovery, commit activity, the worktree check and Docket's install manifest on main. Docket runs no git itself, so without this source the radar says it's waiting for the host helper.
- **`orca-presence`**: every 30 seconds, reads working local Orca chats and sends only session ID, client, one ticket key and worktree path. Docket marks an open run live and renews its lease only on a unique exact ticket/client/path match. Missing or incomplete observations expire; messages and titles never leave the collector.
- **`orca-audit`**: every minute, rotates through at most 80 Docket runs with exact recorded Orca dispatch IDs, auditing up to 16 per pass. It reads `worker-show`, the worktree and live terminal count, a bounded host process candidate count, and git status/unique-commit counts. Only status categories and counts leave the host. A matching process command line is a **candidate**, never proof of dispatch parentage. The source never stops a process, releases a worker, closes a terminal, changes a worktree or deletes an artifact. Orca's own settled-worker retention and automatic release remain the agent-resource mechanism. If the target list exceeds 80 or Orca cannot be read, the source reports an error; no missing row is treated as stopped. Docket's digest lists active, parked and recently completed dispatches with a six-row cap, queued work and the coordinator admission limits (four active globally, two per Epic). Coordinators must check those limits before calling Orca `worker-start`.

## The GitHub source

About once a minute, for each project's repository, it reads open PRs and whatever changed since the last run. The runner checks due sources every 30 seconds, so a change may take a little longer than a minute to appear. It sends the number, title, branch, state, draft flag, head SHA, merge time, CI result, and the ticket keys named in the title or body. **The PR body itself is never sent, logged or stored.** Mergify's temporary `merge queue:` PRs are left out.

GitHub's 5,000 points per hour are shared with your other tools, so it:

- uses GraphQL, at most **20 requests per run** and 6 pages per query;
- takes repositories in turn, so a busy one can't use the whole budget;
- stops below **500** points left and waits for the reset;
- backs off from 1 minute up to 30 on failure, and at least 15 minutes on a rate limit;
- makes no GitHub request while Docket is down, or while the connection is off.

## The worktrees source

Docket's container runs no git (B76), and couldn't follow a worktree whose `.git` file names a Windows path anyway, so without this source the Worktree view waits for the helper. Every 3 minutes this source reads each project's worktrees with the host's git and posts the facts.

- **It only reads.** `GIT_OPTIONAL_LOCKS=0`, no fetch (including a partial clone's lazy fetch), no content filters, filesystem monitor or signature checks, and no shell. Git runs from its own folder with `-C`, so a `git.exe` inside a worktree can't stand in for it. Git's `safe.directory` check stays on.
- **It sends** paths, branch names, SHAs, counts, booleans and timestamps. `git status` output is counted and dropped, so **a file name is never kept, sent or logged**.
- **It's bounded:** two worktrees at a time, 20 seconds each, 2 minutes per pass. A read with no answer is sent as timed out, which Docket shows as Unknown. A pass that runs out of time is marked partial, so Docket removes nothing because of it, and the next pass carries on from where it stopped.
- **UNC and device paths are never touched,** because reading one would make Windows connect to that host.

Docket uses these facts only while they're under 10 minutes old. **To pick this source up on an installed helper, run the update steps below.**

## The git source

Docket's container runs no git (B76). Every 3 minutes this source reads, for each project with a repository folder, what Docket asks for in its settings (`GET /api/sync/git`), and posts the facts. Docket keeps all the judging.

- **What it reads:** each in-flight item's branches, or for an item with none the local branches that name its key (skipping any the owner said aren't active); each branch's trial merge with main and whether it has merged; a trial merge for each pair of different items' branches that share a declared part or a changed file; commits on a run's branches since a time; whether a run's commit is on main or a remote, and how many commits are on neither; and Docket's own install manifest on main.
- **It only reads.** The same rules as the worktrees source: `GIT_OPTIONAL_LOCKS=0`, no fetch, no checkout, no lazy fetch, no gc, filesystem monitor or signature checks, a short allowlisted environment, no shell, and `safe.directory` left on. A trial merge (`git merge-tree --write-tree`) writes its trees into a throwaway folder set as `GIT_OBJECT_DIRECTORY`, with the repository's objects as alternates; the folder is removed after the pass, so nothing is written to the repository.
- **The one kind of file name it sends:** the conflicting files a trial merge reports with `--name-only`, and only for a real conflict. At most 50 per merge, each at most 300 characters with no control characters; `more` says some were left out. **No other file name leaves this computer:** the files a branch changed are used here to decide which pairs to merge and are never sent, stored or logged, and nothing `git status` lists is read. **No file contents are sent.** From the install manifest it sends only Docket's install ID, keys, version IDs and hashes, parsed here.
- **Everything else it sends:** branch names, commit SHAs, times, counts and booleans.
- **It never reads through a link.** A repository folder or worktree whose path goes through a symbolic link or junction is reported unreadable, here and in the worktrees source: the link is looked at with `lstat`, never followed.
- **It's bounded:** 30 seconds a call, 2½ minutes a pass, two reads at a time, at most 300 pair merges a pass, and after three reads with no answer a project's pass stops asking. What a pass didn't reach is left out and the pass is marked incomplete, so Docket changes nothing because of it.
- **Either order of update works.** A Docket that doesn't know this source answers 404, and the runner skips it. A Docket that asks for less gets less read.

Docket uses these facts only while they're under 10 minutes old (about three passes); older, its radar says they're out of date and clears nothing. **To pick this source up on an installed helper, run the update steps below, after Docket itself is updated.**

## Install on Windows

Docket's **Settings → Connections → GitHub** has these steps too. Run them in PowerShell from an up-to-date checkout of `main`. Install copies the tool to `%LOCALAPPDATA%\docket-sync\app`, so worktree cleanup can't remove it, and registers a per-user task at logon. **It doesn't start the task.**

```powershell
gh auth login
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\docket-sync\manage.ps1 -Action Install
Start-ScheduledTask -TaskName 'Docket Sync'
node "$env:LOCALAPPDATA\docket-sync\app\docket-sync.mjs" status
```

To update, run `-Action Stop` from the installed copy, then `-Action Install` from the checkout, and start the task.

### Stop, disable, verify and remove

```powershell
$manage = "$env:LOCALAPPDATA\docket-sync\app\manage.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Stop
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Disable
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Verify -Expect Stopped   # or Disabled, Removed
powershell -NoProfile -ExecutionPolicy Bypass -File $manage -Action Remove
```

- **Nothing ever kills a process.** Stop asks the collector over its pipe to finish and exit, then waits. If it doesn't exit in time, Stop reports failure and changes nothing else.
- **The collector is identified only by the PID it records at start**, with that process's start time, executable and script path. Any other process is neither touched nor counted.
- **Every action ends with a proof**, and a failed proof exits 1.
- **Remove** unregisters the task, then deletes only the known file names, then those folders if they're empty. It never deletes recursively. If any entry is a link or isn't a known file, it deletes nothing, lists the entry and exits 1.

### Check after installing

Only the real host can prove these, and the tests don't claim them:

1. `status` shows a last success after the first run, and Settings says **Connected**.
2. The task runs hidden in your session, and that session can use your `gh` login.
3. `-Action Stop` passes its proof, and the task leaves `Running` by itself.

## Running and checking it

```text
node docket-sync.mjs start            Run in the foreground; one instance per state folder
node docket-sync.mjs once             Run every source once, then exit (1 if any failed)
node docket-sync.mjs status [--json]  Each source's last result, with no content
node docket-sync.mjs stop             Finish the current step and exit
```

| Setting | Default |
| --- | --- |
| `DOCKET_SYNC_URL` | `http://127.0.0.1:7420` |
| `DOCKET_SYNC_HOME` | `%LOCALAPPDATA%\docket-sync` |

`state.json` holds each source's state and last result, written atomically. If it's damaged, it's kept as `state.json.corrupt-<ms>` and the sources read again from scratch, which is safe because records are idempotent. `sync.log` is capped at 256 KB with one rotation. `instance.json` identifies the running collector and holds its stop token.

**Docket needs local trust.** In protected mode the collector has no owner session, so its calls get 401. `status` shows `needs_local_trust`, and Settings shows the helper as not running.
