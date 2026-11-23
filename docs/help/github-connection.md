---
title: GitHub connection
summary: See branches, pull requests and CI on tickets. Optional, read-only, and Docket never holds a GitHub token.
group: Operations
order: 3
anchors:
  - settings.github
  - item.github
related:
  - connect-an-agent
  - security-and-protected-mode
  - workspaces-and-pruning
---

Docket works fully without GitHub. If you turn this on, each ticket shows its branch, pull request, CI result and merge, and Overview's **Merged** count comes from GitHub instead of what agents remembered to record.

**Docket stores no GitHub token and never asks for one.** A small helper on your computer reads through the `gh` login you already have. It only reads: it never comments, labels, merges or changes anything on GitHub.

## Turn it on

1. In **Settings → Connections → GitHub**, turn on **Connect to GitHub**.
2. Add each project's repository, such as `acme/web-app`, and choose **Save**.
3. Follow the steps on the card to sign in with `gh` and install the helper. The install doesn't start anything until you do.

The card tells you where things stand:

| Status | What it means |
| --- | --- |
| **Off** | Docket isn't reading GitHub. |
| **Needs a repository** | Add a repository to a project. |
| **Helper not running** | The helper hasn't reported recently. Start it, or install it. |
| **GitHub CLI not found** | Install `gh` on this computer. |
| **gh not signed in** | Run `gh auth login`. |
| **Waiting for GitHub's limit** | The helper paused to stay under the hourly limit, and resumes by itself. |
| **Can't reach GitHub** | It retries by itself. |
| **Connected** | Pull requests are syncing. |

Anything older than a few sync rounds is marked **Out of date**, and Docket doesn't treat it as current.

The helper can't report to Docket while [protected mode](/help/security-and-protected-mode) is on, because it has no owner session. It works with local trust.

## Name branches after the ticket

A branch looks like `owner/GF-243-short-description`, with **one** ticket key, and its worktree folder has the same name. When an agent claims a ticket, Docket tells it the name to use.

Each project has a **Branch naming** setting:

- **Warn** (the default): Docket tells the agent when a branch doesn't name its ticket, and shows that on the ticket.
- **Off**: Docket says nothing.

It **never blocks** a claim, a hand-off or a merge. **Exempt branches** skip the check. The defaults are `mergify/*`, `main` and `*docket-agent-files*`, and `*` means any text.

## How pull requests attach to tickets

- **The ticket's pull request** is the one whose **branch** names it. The key must match exactly, so `GF-243` never matches `GF-2430`. An imported Jira key counts too.
- **Related** pull requests only mention the ticket in their title or description. A PR that names several tickets is related to each of them and is never the main PR for all of them.
- Mergify's temporary `merge queue:` pull requests are left out.

## The Merged count

With GitHub connected, **Merged** on Overview counts merges from GitHub. Without it, it counts the pull requests agents recorded. The note under the chart says which, and a pull request is never counted twice.
