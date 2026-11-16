import { Link } from 'react-router';
import type { ItemDetailResponse } from '@tasklite/shared';
import { HumanReviewChip, Icon, Provenance, Section } from '../../../components/kit';
import { paths } from '../../../lib/paths';
import { plural } from '../../../lib/format';
import type { ItemKind } from '../ItemPage';
import { AddRow } from './AddRow';

/**
 * Human review ("n items · packet ready · what you verify yourself"; *Open
 * packet* in the header when ready), with the notes under it (UI_SPEC
 * §6.3.1). US3 fills the rows and the edit mode.
 */
export function HumanReviewSection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const { item } = data;
  const hrs = item.checklist.human_review;
  const packet = data.open_packet;
  const open = !['done', 'canceled'].includes(item.status);
  const note = hrs.length
    ? packet
      ? open
        ? 'New items aren’t in the current packet; the agent includes them next round.'
        : null
      : open
        ? kind === 'epic'
          ? 'Epic-level review: verified once when the epic’s work is ready to merge.'
          : 'The agent writes a handoff packet when the work is built. This ticket can’t close until every item is decided.'
        : null
    : item.checklist.reviewed_with_epic
      ? `None on this ticket. It is reviewed with its epic: ◆ ${item.epic_title ?? item.checklist.reviewed_with_epic}`
      : kind === 'epic'
        ? 'None on the epic itself. Reviews, if any, live on its tickets.'
        : 'No human review declared. When its checks pass, the agent can close this without you.';
  return (
    <Section
      sectionKey="humanrev"
      title="Human review"
      summary={`${hrs.length ? plural(hrs.length, 'item') : 'none'}${packet ? ' · packet ready' : ''} · what you verify yourself`}
      extraHead={
        packet ? (
          <Link className="btn primary sm" to={paths.review(item.id, packet.round)}>
            <Icon name="packet" /> Open packet
          </Link>
        ) : undefined
      }
    >
      {hrs.map((h) => (
        <div className="ck" key={h.id}>
          <span className="sicon" aria-hidden="true">
            <Icon name="person" small />
          </span>
          <div>
            <b>{h.text}</b>{' '}
            <span className="hrby">
              {h.added_by === 'owner'
                ? 'added by you'
                : `added by ${h.added_by_client ?? 'an agent'}`}
            </span>
          </div>
          <HumanReviewChip state={h.state} />
          {h.last_decision?.note && (
            <div className="lastdec" style={{ gridColumn: 2 }}>
              <Provenance
                kind={
                  h.last_decision.kind === 'approve'
                    ? 'owner_approve'
                    : h.last_decision.kind === 'changes'
                      ? 'owner_changes'
                      : 'owner_defer'
                }
                label={`Round ${h.last_decision.round}`}
              />{' '}
              {h.last_decision.note}
            </div>
          )}
        </div>
      ))}
      {note && <div className="src">{note}</div>}
      {open && (
        <AddRow
          label="New human review item"
          placeholder={
            kind === 'epic'
              ? 'Add something you’ll verify, e.g. Walk through the whole feature before the PR merges'
              : 'Add something you’ll verify, e.g. Try it on your phone'
          }
        />
      )}
    </Section>
  );
}
