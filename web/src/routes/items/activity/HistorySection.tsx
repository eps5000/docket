import { useId, useRef, useState } from 'react';
import { TEXT_LIMITS, type ItemDetailResponse } from '@docket/shared';
import { Button, EmptyState, Section } from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { formatAge, isoTitle, plural } from '../../../lib/format';
import { showToast } from '../../../lib/undo';
import { useSteer } from '../../shared/steer';
import type { ItemKind } from '../ItemPage';
import { HelpLink } from '../../../help/HelpLink';

/**
 * History (summary "n updates"), with the *note for the agent* box at the
 * top (UI_SPEC §6.3). Rows are the item's events, newest first, with who
 * did it. *Add note* leaves the note for whoever works on the item next;
 * it is delivered once, on the agent's next `get_item` (BUILD_SPEC §5.7),
 * and the box says how many are still unread.
 */
export function HistorySection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const noteId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const steer = useSteer(data.item.id);
  const who = kind === 'epic' ? 'agents' : 'agent';
  const rows = data.activity;
  const unread = data.notes_unread;

  const add = async () => {
    const note = text.trim();
    if (!note) {
      showToast('Write a note first.');
      ref.current?.focus();
      return;
    }
    setBusy(true);
    const res = await steer(
      () => apiClient['items.addNote']({ params: { id: data.item.id }, body: { text: note } }),
      `Note left on ${data.item.id}. The ${who} ${kind === 'epic' ? 'see it on their' : 'sees it on its'} next query.`,
    );
    setBusy(false);
    if (res) setText('');
  };

  return (
    <Section
      sectionKey="history"
      title="History"
      summary={plural(rows.length, 'update')}
      extraHead={<HelpLink anchor="item.history" />}
    >
      <div className="row notebox">
        <label className="sr" htmlFor={noteId}>
          Note for the {who}
        </label>
        <textarea
          id={noteId}
          ref={ref}
          value={text}
          maxLength={TEXT_LIMITS.note}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void add();
            }
          }}
          placeholder={`Leave a note for the ${who} working on this. ${kind === 'epic' ? 'They see it on their' : 'It sees it on its'} next query.`}
        />
        <Button size="sm" disabled={busy} onClick={() => void add()}>
          Add note
        </Button>
      </div>
      {unread > 0 && (
        <div className="src notes-unread" data-notes-unread={unread}>
          {plural(unread, 'note')} not read yet
        </div>
      )}
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
              {/* Decision 32: an owner action made by a script, not the browser. */}
              {a.actor_kind === 'owner' && a.actor !== 'owner' && (
                <span className="src" data-owner-via="script">
                  {' '}
                  · {a.actor}
                </span>
              )}
            </span>
          </div>
        ))
      )}
    </Section>
  );
}
