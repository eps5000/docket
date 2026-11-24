# Resolving partial exits

**Read when:** The digest shows `finished partly`, or an implementer reports a partial exit.
**Don't read when:** No partial exit is waiting.

A partial exit lists what's left, why this ticket couldn't do it, and what would finish each item. It stays in `finished partly` in every digest until someone acts, and your orchestrator may also pass it on to you.

Resolve each item:

- **another ticket can do it:** move it there (`update_item` that ticket's `acceptance`, and remove it here with an `add_note` saying which and why), or `link_items` the ticket that will finish it;
- **it needs a shared-environment deploy, cutover or flag change:** create a separate Implementation ticket marked `rollout: true` and link the dependent tickets to it;
- **it needs more work here:** dispatch another implementer (`claim_lead` starts it);
- **only the owner can decide:** `ask_owner` on the ticket or the epic;
- **it isn't needed:** close it with an `add_note` saying why.

Any of these clears it from the digest. An agent can't close the ticket as Done until then, and you can't close the epic with one unresolved.
