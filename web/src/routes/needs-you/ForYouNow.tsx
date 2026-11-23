import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ForYouRow } from '@docket/shared';
import { Button, Card, CardHeader, EmptyState, Icon } from '../../components/kit';
import { paths } from '../../lib/paths';
import { AnswerBox } from '../shared/AnswerBox';
import { QuestionAnswer, RecommendedLine } from '../shared/QuestionAnswer';
import { HelpLink } from '../../help/HelpLink';

const rowKey = (r: ForYouRow) => `${r.kind}:${r.item_id}`;

/**
 * For you now · N (UI_SPEC §6.1): packet rows (*Open packet*, and "out of
 * date" when code changed after the packet) and question rows (*Answer*
 * opens an inline reply: the question, a textarea, *Send answer*, *Cancel*
 * and "codex reads it on its next query"). Rows have an amber
 * tint, clicking one opens the item, and rows that arrive while the page is
 * open get a 1 s highlight (UI_SPEC §7; none under reduced motion).
 */
export function ForYouNow({ rows }: { rows: readonly ForYouRow[] }) {
  // Rows present on the first render are not new; later arrivals are (until the next change).
  const keys = rows.map(rowKey);
  const joined = keys.join('|');
  const [track, setTrack] = useState(() => ({
    joined,
    seen: new Set(keys),
    fresh: new Set<string>(),
  }));
  if (track.joined !== joined) {
    setTrack({
      joined,
      seen: new Set([...track.seen, ...keys]),
      fresh: new Set(keys.filter((k) => !track.seen.has(k))),
    });
  }
  const fresh = track.fresh;
  return (
    <Card data-card="for-you">
      <CardHeader
        title={`For you now · ${rows.length}`}
        extra={<HelpLink anchor="needs-you.for-you" />}
      />
      {rows.length === 0 ? (
        <EmptyState text="Nothing to verify. Agents will hand off when work is built." />
      ) : (
        rows.map((r) => <ForYouRowView key={rowKey(r)} row={r} fresh={fresh.has(rowKey(r))} />)
      )}
    </Card>
  );
}

function ForYouRowView({ row, fresh }: { row: ForYouRow; fresh: boolean }) {
  const navigate = useNavigate();
  const [replying, setReplying] = useState(false);
  const answerRef = useRef<HTMLButtonElement>(null);
  const wasReplying = useRef(false);
  useEffect(() => {
    // Closing the reply puts focus back on *Answer*.
    if (!replying && wasReplying.current) answerRef.current?.focus();
    wasReplying.current = replying;
  }, [replying]);
  const line =
    row.kind === 'packet'
      ? `Round ${row.round} packet · ${row.to_verify} to verify · about ${row.estimate}`
      : `${row.asked_by} asks: “${row.text}”`;
  // Decision 47: a question with the new contract answers in the dialog; older ones reply inline.
  const form = row.kind === 'question' ? (row.form ?? null) : null;
  const stale = row.kind === 'packet' && row.stale;
  const full = stale ? `${line} · out of date: code changed after it was written` : line;
  return (
    <div
      className={fresh ? 'att fresh' : 'att'}
      data-row={row.kind}
      data-item={row.item_id}
      onClick={(e) => {
        // The row opens the item; its links, buttons, inline reply and answer dialog (a portal,
        // whose clicks still bubble here through React) do their own thing.
        if ((e.target as HTMLElement).closest('a, button, .reply, .ov')) return;
        navigate(paths.item(row.item_id));
      }}
    >
      <div className="ico ico-warn" aria-hidden="true">
        <Icon name={row.kind === 'packet' ? 'packet' : 'question'} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ minWidth: 0 }}>
          <Link to={paths.item(row.item_id)} className="tt">
            {row.title}
          </Link>
          <span className="mono muted">{row.item_id}</span>
        </div>
        <div className={form ? 'why' : 'why one'} title={full}>
          {line}
          {stale && (
            <>
              {' · '}
              <b className="stale">out of date: code changed after it was written</b>
            </>
          )}
        </div>
        {form && <RecommendedLine form={form} />}
        {row.kind === 'question' && replying && (
          <>
            <div className="src prewrap">“{row.text}”</div>
            <AnswerBox
              itemId={row.item_id}
              questionId={row.question_id}
              agent={row.asked_by}
              label={`Your answer to ${row.asked_by}`}
              placeholder="e.g. Per serving; put the 100 g values in a footnote."
              hint={`${row.asked_by} reads it on its next query.`}
              autoFocus
              onCancel={() => setReplying(false)}
              onSent={() => setReplying(false)}
            />
          </>
        )}
      </div>
      {row.kind === 'packet' ? (
        <Link className="btn sm primary" to={paths.review(row.item_id)}>
          Open packet
        </Link>
      ) : form ? (
        <QuestionAnswer
          key={row.question_id}
          itemId={row.item_id}
          questionId={row.question_id}
          question={row.text}
          form={form}
          agent={row.asked_by}
          buttonLabel={`Answer ${row.asked_by} on ${row.item_id}`}
        />
      ) : replying ? (
        <span />
      ) : (
        <Button
          ref={answerRef}
          size="sm"
          variant="primary"
          aria-label={`Answer ${row.asked_by} on ${row.item_id}`}
          onClick={() => setReplying(true)}
        >
          Answer
        </Button>
      )}
    </div>
  );
}
