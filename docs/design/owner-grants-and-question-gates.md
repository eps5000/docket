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

The server validates typed fields and keeps the full prior record. A superseding owner record deactivates its predecessor atomically. A narrower ticket grant can refine an Epic grant but cannot silently override an Epic red line or protected-action limit. Conflicting applicable owner records produce `unknown_authority` and a targeted owner question. An expired or withdrawn record is visible in history but never authorizes work.

The worker context returns applicable active grants with provenance and expiry, plus rejected or conflicting candidates as bounded reasons. It never upgrades an agent proposal, agent note, old answer text, or a provider's identity into owner approval. Changing Codex to Claude, or starting a child run, does not invalidate a grant solely for that reason; the target, role, operation, limits, and current environment still have to match.

## Before an owner question

The caller describes a proposed choice with its ticket and, for a protected action, exact operation, target/environment fingerprint, actor role, and requested bounds. Docket resolves the current context and returns one of three outcomes:

1. `covered`: the matching owner grant ID/version and its applicable limits. The agent continues after action-time checks, records a scoped agent decision or ticket activity, and does not create a Needs You card.
2. `owner_choice_required`: the exact uncovered or changed field, applicable boundary, recommendation, options with consequences, and the item/run to wake. `ask_owner` creates one question only if the supplied gap still matches this current evaluation.
3. `hold_unknown`: stale context, conflicting records, unknown target or writer, missing provenance, private-output risk, or a failed action-time gate. The agent stops the affected action. Docket must not turn this into an approval question with a generic recommendation.

The evaluation is performed again inside the same write transaction as `ask_owner`; a stale evaluation cannot create a duplicate question. The existing one-open-question and unread-answer rules still apply. Equivalent questions deduplicate by canonical item, operation, target/environment fingerprint, uncovered field, and active grant versions. A changed field gets a new question only after the old one is answered or withdrawn. A genuine answer is delivered to the asking run and names its coordinator wake immediately; the agent re-evaluates against current state before acting. A timer is a fallback for failed delivery, not the normal wake path.

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
| GF-457 Ready Dev script install and c41 CI rerun with exact owner provenance | Continue once per granted operation and current writer/recovery checks, including after agent/provider change. |
| Changed host fingerprint, unknown writer, private-output leak, destructive request, expired grant | Stop with exact reason and next actor; ask only for a material uncovered owner choice. |
| Superseded grant or repeated equivalent question | Use only the active owner record; do not create a second Needs You card. |
| Owner answers a real question | Deliver answer to the parked run and immediately notify its named coordinator; re-evaluate before action. |

Synthetic tests must assert that agent notes, agent decisions, and provider changes cannot manufacture authority. Tests may use fake fingerprints and metadata; they must not require live Gameflow host changes or real credentials.

## Implementation children and delivery order

1. **Grant storage and context.** Add validated structured grants, owner-only creation/confirmation, immutable provenance and supersession, scope resolution, compact worker context, migration, and focused tests. Existing free-form decisions remain readable; no automatic conversion of their prose into protected authority.
2. **Question gate and wake.** Add typed proposal evaluation, transactional `ask_owner` recheck and deduplication, scoped agent-decision receipt, owner answer to named coordinator wake, and the GF-231/GF-457 synthetic replays. Preserve the current question form and one-open-question invariant.
3. **Owner UI and installed proof.** Show applicable grants and consequential questions with boundary and option effects, keep routine choices in activity, and verify the same journey against the installed service after exact-head CI, combined queue, resulting-main image, reviewed host update, and independent readback.

The implementation children need exact path ownership before editing. DKT-14 closes after independent design and child-scope review; DKT-5 and DKT-6 close only after the linked implementation and installed owner/worker journey are independently verified or the owner explicitly defers a child.
