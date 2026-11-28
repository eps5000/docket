# Owner grants and question gates (DKT-14)

Status: design proposal for [Docket #190](https://github.com/eps5000/docket/issues/190). This document defines the implementation boundary; it does not grant an operation or authorize a host, data, credential, or cleanup action.

## Outcome

An agent receives the owner's applicable, still valid choices with its ticket context. It proceeds with covered routine work and records the choice it made. It asks the owner only for a specific material choice that the record does not cover. A new agent or provider can reuse the same grant, while each protected operation still passes current identity, writer, capacity, recovery, privacy, and scope checks.

## Authority record

Store a structured record beside, rather than inferred from, a free-form decision or ticket note. An owner can create or confirm it; an agent can propose it but a proposal has no owner authority. A record contains:

| Field | Meaning |
| --- | --- |
| `id`, `version`, `status` | Stable identity; active, superseded, expired, or withdrawn state. |
| `project`, `scope` | Project, Epic, ticket, or an explicit set of descendants. No substring matching. |
| `required_outcome`, `red_lines` | What must be achieved and what must never be inferred from the grant. |
| `delegated_choices` | Reversible choices the agent may make and record without a new owner question. |
| `owner_only_choices` | Choices that remain with the owner. |
| `operation`, `target`, `environment`, `role` | The exact protected operation, target identity or pinned fingerprint, environment, and permitted actor role when the record covers such an operation. A wildcard cannot cover a protected operation. |
| `limits`, `expires_at` | Count, time, risk, resource, cost, or retry bounds. A missing expiry is not a perpetual protected-action grant. |
| `authority`, `provenance`, `confirmed_at` | Owner record or owner confirmation with the source decision, answer, Ready acceptance, or explicit instruction; never an agent note. |
| `supersedes_id`, `created_at` | Audit trail and deterministic precedence. |

The server validates typed fields and keeps the full prior record. A historical decision, Ready acceptance, or answer is **not** converted from its prose into a grant. The owner UI and authenticated owner API offer an explicit *Confirm grant* action that shows the source event ID/version, exact typed operation and limits, and the resulting grant before the owner confirms it. The confirmation event binds those bytes to the owner and the source version. An agent may prepare a candidate but cannot call that owner action, confirm a grant, or supply an owner provenance marker. If the source version changes before confirmation, the action refuses and requires a fresh read.

A superseding owner record deactivates its predecessor atomically. Withdrawal, undo of a confirmation or source event, a changed source version, and expiry invalidate the derived grant before another use; history remains readable. A narrower ticket grant can refine an Epic grant but cannot silently override an Epic red line or protected-action limit. Conflicting applicable owner records produce `unknown_authority` and a targeted owner question. An expired or withdrawn record is visible in history but never authorizes work.

The worker context returns applicable active grants with provenance and expiry, plus rejected or conflicting candidates as bounded reasons. Matching is deny first: active red lines and owner-only choices outrank allow records; then exact operation, environment, role, pinned target identity and descendant scope must all match; then limits and supersession are checked. A descendant is covered only when the record explicitly names that descendant or a server-validated descendant set, not because an item shares a textual prefix. Conflicting allow records or any unknown target detail hold. The server uses its own time for expiry. Before an external host, CI, or provider action, a worker reserves a bounded use under a stable idempotency key and short lease in one server transaction; concurrent workers cannot reserve the last use twice. The worker records the external receipt afterward. A timeout or unknown external outcome leaves the reservation held for reconciliation against the same operation and idempotency key; it is never silently released for a retry. A grant is not reusable merely because a prior read said it was valid. Docket cannot make an external action atomic with its database.

The context never upgrades an agent proposal, agent note, old answer text, or a provider's identity into owner approval. Changing Codex to Claude, or starting a child run, does not invalidate a grant solely for that reason; the target, role, operation, limits, and current environment still have to match.

## Before an owner question

Every `ask_owner` call supplies a server-validated typed gap, or an explicit `non_action` class with its material owner choice and boundary. A legacy free-form question without either class is rejected; the caller cannot self-label a protected action as routine to bypass evaluation. For an action, the caller describes its ticket, exact operation, target/environment fingerprint, actor role, and requested bounds. Docket resolves the current context and returns one of three outcomes:

1. `covered`: the matching owner grant ID/version and its applicable limits. The agent continues after action-time checks, records a scoped agent decision or ticket activity, and does not create a Needs You card.
2. `owner_choice_required`: the exact uncovered or changed field, applicable boundary, recommendation, options with consequences, and the item/run to wake. `ask_owner` creates one question only if the supplied gap still matches this current evaluation.
3. `hold_unknown`: stale context, conflicting records, unknown target or writer, missing provenance, private-output risk, or a failed action-time gate. The agent stops the affected action. Docket must not turn this into an approval question with a generic recommendation.

The evaluation is performed again inside the same write transaction as `ask_owner`; a stale evaluation cannot create a duplicate question. The existing one-open-question and unread-answer rules still apply, including the requirement to deliver an unread answer before another question. Legacy free-form callers receive a validation error naming the required typed gap or `non_action` class. Equivalent questions deduplicate by canonical item, operation, target/environment fingerprint, uncovered field, and active grant versions. A changed field gets a new question only after the old one is answered or withdrawn.

The current answer path leaves a run in `needs_input` until `get_item` delivers it; today any agent read can mark an answer read and reopen the asking run. The implementation binds answer delivery and that run-state transition to the asking run's authenticated context or its explicitly registered coordinator. Other readers can see a bounded answer status without consuming the one-time delivery. If the asking run has ended, its answer remains durably retrievable by its registered coordinator and a reviewed successor; it cannot disappear because another agent inspected the item. The implementation adds a durable relay record for the named coordinator at answer time, with delivery attempt, acknowledgment and retry state. Relay acknowledgment wakes the coordinator to read the answer; it does not mark the answer read, reopen the agent run, or authorize the action. Run-bound `get_item` remains the delivery and run-state transition, followed by a fresh grant/action-time evaluation. A timer is a fallback for a failed relay, not the normal wake path. Answer undo or withdrawal invalidates an undelivered relay and any derived grant.

## Action boundary

The record gives scope; it does not prove an action safe now. Before a host, database, credential, deployment, destructive, or other protected step, the executing worker verifies current target identity and fingerprint, exclusive writer, capacity, recovery/rollback assets, privacy boundary, and the exact operation's retry and expiry limits. A failed check stops only that operation and records the blocker. It does not erase authority for unrelated read-only inventory. An unexpected installed-script version can block a later install while a separately authorized metadata read continues.

A Ready ticket may carry an owner-approved execution grant when its acceptance and owner provenance identify the exact operation and limits. The word `Ready` alone does not grant a protected operation. If ticket text conflicts about approval, shaping resolves the conflict before Ready. No code infers a grant merely from a status, agent note, or an unanswered owner question.

## Owner and activity views

Needs You shows the consequential choice, recommendation, effect and downside of each option, and the existing boundary that requires the owner. Routine delegated choices appear in activity with the grant ID/version and a short reason. The owner can inspect the record's provenance, scope, expiry, supersession, and uses without seeing secret values or private scratch paths. An answer or grant change updates the named coordinator wake; it does not silently resume a worker or bypass its action-time checks.

## Acceptance replays

| Replay | Expected result |
| --- | --- |
| GF-231 private scratch preparation under approved isolated drill | Continue after exact path, ACL, capacity, and privacy checks; record the reversible choice. |
| GF-231 bounded host metadata read with old installed script | Continue authorized independent reads; retain the mismatch as an install blocker. |
| GF-457 Ready Dev script install and c41 CI rerun with exact owner provenance | Treat install and rerun as distinct protected operations. Continue each only within its own grant and current writer/recovery checks, including after agent/provider change. |
| Changed host fingerprint, unknown writer, private-output leak, destructive request, expired grant | Stop with exact reason and next actor; ask only for a material uncovered owner choice. |
| Superseded, withdrawn, expired, undone or concurrently spent grant; repeated equivalent question | Stop a stale use, preserve one open question and the unread-answer gate, and do not create a second Needs You card. |
| Owner answers a real question | Persist and acknowledge a named-coordinator relay, then deliver on `get_item`; re-evaluate before action. |

Synthetic tests must assert that agent notes, agent decisions, and provider changes cannot manufacture authority. Tests may use fake fingerprints and metadata; they must not require live Gameflow host changes or real credentials.

## Implementation children and delivery order

1. **Backend implementation child, delivered first.** Register exact server, shared and test paths before editing. Add typed grant schema/service/context, owner-only confirmation route with source event/version provenance, deny-first scope evaluation, server-time expiry, before-action reservation/lease and idempotent uncertain-outcome reconciliation, transactional typed-gap `ask_owner` recheck/dedup and run-bound answer delivery, and durable named-coordinator relay with acknowledgment. Cover GF-231/GF-457 races, provider change, undo, supersession and privacy in focused tests. Existing free-form decisions remain readable; no automatic conversion of their prose into protected authority.
2. **Owner UI implementation child, after the backend contract.** Register exact web and test paths before editing. Show grant confirmation and provenance, consequential question boundary and option effects, and routine choice activity. Update the existing QuestionAnswer wording that currently says delivery waits for the agent's next query: coordinator relay is immediate, while the answer is still delivered by `get_item`. Test the distinction and accessible owner flow.
3. **DKT-6 installed Release journey.** After both implementation children have independent review, exact-head CI, combined queue, resulting-main image and a reviewed host update, verify the same owner/worker journey against the installed service. DKT-6 alone owns the installed journey and owner Release decision.

The implementation children need exact path ownership before editing. DKT-14 closes after independent design and child-scope review; DKT-5 and DKT-6 close only after the linked implementation and installed owner/worker journey are independently verified or the owner explicitly defers a child.
