import { useId } from 'react';
import type { ItemDetailResponse } from '@tasklite/shared';
import { Button, EmptyState, Section } from '../../../components/kit';
import { formatAge, isoTitle, plural } from '../../../lib/format';
import type { ItemKind } from '../ItemPage';

/**
 * History (summary "n updates"), with the *note for the agent* box at the
 * top (UI_SPEC §6.3). Rows are the item's events, newest
 * first, with who did it; US6 wires *Add note*.
 */
export function HistorySection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const noteId = useId();
  const who = kind === 'epic' ? 'agents' : 'agent';
  const rows = data.activity;
  return (
    <Section sectionKey="history" title="History" summary={plural(rows.length, 'update')}>
      <div className="row notebox">
        <label className="sr" htmlFor={noteId}>
          Note for the {who}
        </label>
        <textarea
          id={noteId}
          placeholder={`Leave a note for the ${who} working on this. ${kind === 'epic' ? 'They see it on their' : 'It sees it on its'} next query.`}
        />
        <Button size="sm" disabled title="Lands with US6">
          Add note
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState text="No activity yet." />
      ) : (
        rows.map((a) => (
          <div className="act" key={a.cursor}>
            <span className="src mono" title={isoTitle(a.at)}>
              {formatAge(a.at)}
            </span>
            <span>
              {a.summary}
              {a.actor_kind === 'agent' && !a.summary.startsWith(a.actor.split(' · ')[0]!) && (
                <span className="src"> · {a.actor}</span>
              )}
            </span>
          </div>
        ))
      )}
    </Section>
  );
}
