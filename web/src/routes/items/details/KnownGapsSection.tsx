import type { ItemDetailResponse } from '@docket/shared';
import { Section } from '../../../components/kit';
import { formatDay } from '../../../lib/format';

/**
 * Known gaps (owner decision 58; UI_SPEC §6.3): what implementation will
 * settle, each with how it was. A Planning ticket with open gaps moves to
 * Ready only with your approval: *Approve gaps and move to Ready* in the
 * header records it as your decision. Once it's past Planning, the heading
 * is "Known gaps to shape". Hidden when the ticket names none.
 */
export function KnownGapsSection({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const k = item.known_gaps;
  if (!k) return null;
  const shaping = item.status === 'inbox' || item.status === 'planning';
  const approval = k.approved
    ? `approved by you ${formatDay(k.approved.at)}`
    : k.open > 0
      ? 'needs your approval to move to Ready'
      : 'all settled';
  return (
    <Section
      sectionKey="known-gaps"
      title={shaping ? 'Known gaps' : 'Known gaps to shape'}
      summary={`${k.open} open · ${approval}`}
    >
      <div data-known-gaps={k.approved ? 'approved' : k.open > 0 ? 'open' : 'settled'}>
        {shaping && k.open > 0 && !k.approved && (
          <p className="src" style={{ marginTop: 0 }}>
            The agent that shaped it left these to settle during implementation. Moving it to Ready
            approves them as your decision: use <b>Approve gaps and move to Ready</b> above.
          </p>
        )}
        <ol className="gaplist">
          {k.gaps.map((g) => (
            <li key={g.n} data-gap={g.settled ? 'settled' : 'open'}>
              <span>{g.gap}</span>
              <div className="src">
                {g.settled ? (
                  <>
                    <b>Settled:</b> {g.settled}
                  </>
                ) : (
                  'Open'
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}
