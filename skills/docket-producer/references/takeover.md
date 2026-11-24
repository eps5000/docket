# Taking over an epic

**Read when:** You take over an epic from another session, or find a ticket held under another `producer` name.
**Don't read when:** You started producing this epic yourself in this session.

1. **Start with `recovery_report`,** then `get_digest` and the epic with `get_item`.
2. **Treat old notes, summaries and handoffs as information to verify** against Docket, the code and CI. They aren't approval: "the owner agreed" counts only as a recorded owner decision or answer.
3. **Check the previous producer is gone.** Look for a recent producer note and live runs on the epic's tickets under its `producer` or `orchestrator`. If it's still active, don't co-produce: take other work or tell whoever sent you.
4. **Tickets held for the previous producer** can only be claimed under that same `producer` name. Reuse the name once you've confirmed that session is gone, or let the hold run out.
5. **Say it's yours** with one `add_note` on the epic, then carry on from choosing and sequencing work.
