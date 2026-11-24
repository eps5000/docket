# Status moves and their gates

**Read when:** You move an item with `set_status` other than closing as done, or a move is refused.
**Don't read when:** You close with `set_status { status: "done" }` after your checks pass, or hand off with `submit_packet`.

## Allowed moves

| From                  | To              | Notes                                                                             |
| --------------------- | --------------- | --------------------------------------------------------------------------------- |
| Inbox                 | Planning        |                                                                                   |
| Planning              | Ready, and back | Only if the project's rules let agents move work to Ready                         |
| Ready                 | In progress     | `claim_lead` does this for you                                                    |
| In progress           | Ready           | Gives up the work: prefer `release_lead { reason, exit }`                         |
| In progress or Review | Done            | Not while a human review item is undecided, or items from a partial exit are left |
| Any open status       | Canceled        | `reason` required                                                                 |
| Done                  | In progress     | Reopens it; `reason` required                                                     |

Hand off for review with `submit_packet`, not `set_status`.

## What a move can be refused with

| Error            | Why                                                                                                             | What to do                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `not_declared`   | Moving to Ready before declaring shared changes, or closing with changed files in parts the item didn't declare | Declare with `declare_shared_changes` (see the shared-parts reference). On close, leave it: the owner decides. |
| `design_review`  | Starting or closing an item whose change to an approved design the owner hasn't approved                        | Take other work until they do.                                                                                 |
| `bugs_open`      | Review or Done on an epic's finish line while a bug in the epic is open                                         | Fix, move or cancel each bug; ask the producer before dropping one.                                            |
| `epic_not_ready` | Claiming in an epic with tickets still in Inbox or Planning                                                     | Tell your producer; it lists them.                                                                             |
| `project_paused` | The owner paused the project                                                                                    | See the waiting reference.                                                                                     |

**Moving to Ready with open known gaps** doesn't fail: Docket asks the owner to approve Ready with them. Don't ask again with `ask_owner`.

## Closing as done

Pass `changed_files` (every file changed: `git diff --name-only <main>...HEAD`) and `branch`. Closing ends your run and your leases. A Done item with acceptance items left is refused until you remove or move them (see the exit-reports reference).
