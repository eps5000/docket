# Asking the owner

**Read when:** You think only the owner can decide something, or your open question is out of date.
**Don't read when:** The choice is technical, reversible, inside an approved design or follows a decision.

## Ask less

- **First check** decisions, the ticket, the plan and design docs, Workflow notes, the code and what other agents recorded.
- **Decide it yourself** if it's technical, reversible, inside an approved design or follows a decision. Use `publish_decision` when others must follow it.
- **Ask only** about product behavior, privacy or security, cost, irreversible or outward-facing actions, conflicting owner decisions, or a real change to an approved design.

## Ask better

`ask_owner` with one plain `question`, its `context`, `why_it_matters`, two to four `options` with one recommended, and `recommendation_reason`.

- **Write for someone who hasn't seen the work:** no private decisions, branches or tooling, any needed term in everyday words, concrete things a user would notice.
- Offer real alternatives and state the recommended option's downside.
- IDs, paths and links go in `details`.

> Good: "Should recipe cards show nutrition per serving or per 100 g?" Per serving is easy to read, but portions differ between recipes.
>
> Bad: "Per dec_12, keep the v2 DTO for RCP-16?"

## After asking

- Your run shows needs input. **Stop only the work that depends on it**, and keep everything else moving.
- Ending the session? `finish_run` with a summary of what you wait for, and `exit`.
- The answer arrives in `get_item`, once.
- **Your open question is out of date?** `withdraw_decision { question_id, reason }` with your `run_id`, in plain words, then `ask_owner` again if you still need to.
