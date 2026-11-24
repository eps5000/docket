# Acceptance, known gaps and exit reports

**Read when:** An acceptance item needs something outside this ticket, your context shows `known gaps`, `finished partly:` or `release held:`, or you leave with work undone.
**Don't read when:** Every acceptance item is this ticket's own and you finish it all.

## Before you start

**Check each acceptance item.** Can this ticket alone do it? One that needs something outside it (another ticket's deploy, a flag, a cutover, an environment), perhaps a leftover from older work, gets clarified first:

- ask your producer;
- propose it as a known gap;
- or move it to the ticket that can do it (`create_item` with `split_from`).

**`finished partly:`** in your context lists what the last lead left. Settle those too.

**Known gaps to shape** in your context: settle each and record how with `update_item { known_gaps: [{ gap, settled }] }`, the same gaps in order.

**`release held:`** means you hold the epic's finish line. Check those bugs first: Review and Done are refused (`bugs_open`) until each is fixed, moved out or canceled. Ask the producer before dropping one.

## On every exit

Report how you finished on `finish_run`, `release_lead`, or `park_run` when your session ends:

- `exit: { outcome: "complete" }` when every acceptance item is done;
- else `outcome: "partial"` with `left: [{ text, why, needs, item? }]`: what's left, why this ticket couldn't do it, and what would finish it (that ticket in `item`).

Your producer hears about a partial exit and resolves each item. Closing as Done is a complete exit: with items left, remove them first (with an `add_note` saying which and why) or move them to the ticket that will do them.

## Stopping before the work is done

Push, `report_commit`, release your resources, then `release_lead { reason, exit }`. The item goes back to Ready with your plan and notes kept. Under a producer it waits for the next worker unless you pass `release_story: true`.
