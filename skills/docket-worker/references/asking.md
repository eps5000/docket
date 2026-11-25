# Asking the owner

**Read when:** A choice may exceed approved design or delegated bounds, carries new risk, or your open question is out of date.
**Don't read when:** The approved design or owner decision already covers the choice.

## Ask less

- **First check** decisions, the ticket, the plan and design docs, Workflow notes, the code and what other agents recorded.
- **Decide it yourself** when the approved design, owner decision or delegated bounds cover the choice. That includes product details needed to meet an already approved outcome. Record a consequential choice in a narrowly scoped `publish_decision` when others must follow it; otherwise use a short ticket note. Routine covered choices need no owner notification.
- **Ask** when the choice would change an approved outcome or constraint, owner decisions conflict, a material risk or cost is newly discovered, or a destructive or irreversible action lacks explicit authority. Privacy, security, production and external effects deserve this check against the actual approved bounds. Follow any project-specific approval gate even for a covered choice.
- **If the boundary is unclear,** state the proposed choice, why existing instructions may or may not cover it, its consequence and the smallest owner decision that would unblock it. Ask once; carry on with independent work.

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
