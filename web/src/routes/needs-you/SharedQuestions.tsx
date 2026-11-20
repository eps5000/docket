import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { OverlapRow, UndeclaredHoldRow } from '@docket/shared';
import { Button, Card, CardHeader, Chip, StatusChip } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { errorText } from '../agent-files/install-common';
import { partsText } from '../shared/sharedChanges';
import { ProblemLines, WarningMark } from '../shared/problems';

/**
 * The shared-changes questions on Needs you (UI_SPEC §6.3.6; owner decision
 * 36): a card per undecided overlap ("GF-240 and GF-312 both change model
 * Token": *Run one after the other*, *They're compatible* with an optional
 * note, *Open both*), and a card per held hand-off ("GF-312 changed shared
 * parts it didn't declare: table decks": *Add to the declaration*, *Send
 * back*). Each counts as for you. Decisions reach agents at once, so they
 * aren't undoable.
 */
export function SharedQuestions({
  overlaps,
  holds,
}: {
  overlaps: readonly OverlapRow[];
  holds: readonly UndeclaredHoldRow[];
}) {
  if (overlaps.length === 0 && holds.length === 0) return null;
  return (
    <div className="mb shared-qs" data-card="shared-questions">
      {overlaps.map((o) => (
        <OverlapCard key={o.id} overlap={o} />
      ))}
      {holds.map((h) => (
        <HoldCard key={h.id} hold={h} />
      ))}
    </div>
  );
}

function useDecide() {
  const qc = useQueryClient();
  const { scope } = useShell();
  const [busy, setBusy] = useState(false);
  const run = async <T extends { mutation_id: string }>(fn: () => Promise<T>, success: string) => {
    setBusy(true);
    try {
      await runOwnerMutation(fn, {
        success,
        refetch: [queryKeys.needsYou({ scope }), queryKeys.bootstrap()],
      });
      await qc.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** One overlap question; `banner` places it on the item's page with the warning icon (decision 37). */
export function OverlapCard({
  overlap: o,
  banner = false,
}: {
  overlap: OverlapRow;
  banner?: boolean;
}) {
  const { busy, run } = useDecide();
  const { openTab } = useShell();
  const navigate = useNavigate();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const titleId = useId();
  const noteId = useId();
  const [first, other] = o.items;
  const title = `${first.id} and ${other.id} both change ${partsText(o.parts)}`;
  const sequence = () =>
    void run(
      () => apiClient['overlaps.decide']({ params: { id: o.id }, body: { decision: 'sequence' } }),
      `${other.id} now waits until ${first.id} is merged.`,
    );
  const compatible = () =>
    void run(
      () =>
        apiClient['overlaps.decide']({
          params: { id: o.id },
          body: { decision: 'compatible', ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      `Marked ${first.id} and ${other.id} compatible.`,
    );
  return (
    <Card className="sq-card" data-overlap={o.id} data-problem-id={banner ? o.id : undefined}>
      <CardHeader
        title={
          <span className="row" style={{ gap: 6 }}>
            {banner && <WarningMark label="Problem" />}
            <span id={titleId}>{title}</span>
          </span>
        }
        extra={<HelpLink anchor="needs-you.shared-questions" />}
      />
      <div className="pad" style={{ paddingTop: 0 }}>
        <ul className="sq-items" aria-label="The two items">
          {o.items.map((it, i) => (
            <li key={it.id} className="lrow">
              <Link to={paths.item(it.id)} className="mono">
                {it.id}
              </Link>
              <span className="one grow">{it.title}</span>
              <StatusChip status={it.status} />
              {i === 0 ? (
                <span className="src">claimed first</span>
              ) : (
                <Chip kind="warn">waiting</Chip>
              )}
            </li>
          ))}
        </ul>
        {o.explanation ? (
          <ProblemLines e={o.explanation} />
        ) : (
          <p className="src" style={{ margin: '6px 0 0' }}>
            An agent tried to start {other.id} while {first.id} is in flight; it picked other work.
            Run them one after the other ({other.id} waits until {first.id} is merged), or let them
            run together.
          </p>
        )}
        {noting && (
          <div className="sq-note">
            <label className="f" htmlFor={noteId}>
              Note for both agents (optional)
            </label>
            <textarea
              id={noteId}
              className="input"
              rows={2}
              maxLength={1000}
              // The button that opened it stays mounted; the note takes focus (B34).
              autoFocus
              value={note}
              placeholder="Who owns which part of the change"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="cardfoot">
        <Button
          size="sm"
          variant="ghost"
          aria-describedby={titleId}
          onClick={() => {
            openTab(other.id);
            openTab(first.id);
            void navigate(paths.item(first.id));
          }}
        >
          Open both
        </Button>
        <div className="row wrap" style={{ gap: 6 }}>
          {noting ? (
            <Button
              size="sm"
              disabled={busy}
              aria-describedby={titleId}
              onClick={compatible}
              data-confirm-compatible=""
            >
              Mark compatible
            </Button>
          ) : (
            <Button size="sm" aria-describedby={titleId} onClick={() => setNoting(true)}>
              They’re compatible
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            aria-describedby={titleId}
            onClick={sequence}
          >
            Run one after the other
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** One held hand-off; `banner` places it on the item's page with the warning icon (decision 37). */
export function HoldCard({
  hold: h,
  banner = false,
}: {
  hold: UndeclaredHoldRow;
  banner?: boolean;
}) {
  const { busy, run } = useDecide();
  const [backing, setBacking] = useState(false);
  const [note, setNote] = useState('');
  const titleId = useId();
  const noteId = useId();
  const title = `${h.item.id} changed shared parts it didn’t declare: ${partsText(h.parts)}`;
  return (
    <Card className="sq-card" data-hold={h.id} data-problem-id={banner ? h.id : undefined}>
      <CardHeader
        title={
          <span className="row" style={{ gap: 6 }}>
            {banner && <WarningMark label="Problem" />}
            <span id={titleId}>{title}</span>
          </span>
        }
        extra={<HelpLink anchor="needs-you.shared-questions" />}
      />
      <div className="pad" style={{ paddingTop: 0 }}>
        <div className="lrow">
          <Link to={paths.item(h.item.id)} className="mono">
            {h.item.id}
          </Link>
          <span className="one grow">{h.item.title}</span>
          <StatusChip status={h.item.status} />
        </div>
        {h.explanation && <ProblemLines e={h.explanation} />}
        <p className="src" style={{ margin: '6px 0 4px' }}>
          {h.explanation
            ? ''
            : h.via === 'submit_packet'
              ? 'Its packet waits: you can review it once you decide. '
              : 'It tried to close; it stays open until you decide. '}
          Files:
        </p>
        <ul className="sq-files mono" aria-label="Changed files that map to undeclared parts">
          {h.files.slice(0, 6).map((f) => (
            <li key={f}>{f}</li>
          ))}
          {h.files.length > 6 && <li className="src">and {h.files.length - 6} more</li>}
        </ul>
        {backing && (
          <div className="sq-note">
            <label className="f" htmlFor={noteId}>
              Note for the agent (optional)
            </label>
            <textarea
              id={noteId}
              className="input"
              rows={2}
              maxLength={1000}
              // The button that opened it stays mounted; the note takes focus (B34).
              autoFocus
              value={note}
              placeholder="What to do about those changes"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="cardfoot">
        <span className="src">{h.via === 'submit_packet' ? 'Held packet' : 'Refused close'}</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {backing ? (
            <Button
              size="sm"
              disabled={busy}
              aria-describedby={titleId}
              onClick={() =>
                void run(
                  () =>
                    apiClient['undeclaredHolds.decide']({
                      params: { id: h.id },
                      body: {
                        decision: 'send_back',
                        ...(note.trim() ? { note: note.trim() } : {}),
                      },
                    }),
                  `Sent ${h.item.id} back.`,
                )
              }
            >
              Send it back
            </Button>
          ) : (
            <Button size="sm" aria-describedby={titleId} onClick={() => setBacking(true)}>
              Send back
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            aria-describedby={titleId}
            onClick={() =>
              void run(
                () =>
                  apiClient['undeclaredHolds.decide']({
                    params: { id: h.id },
                    body: { decision: 'add' },
                  }),
                `Added ${partsText(h.parts)} to ${h.item.id}’s declaration.`,
              )
            }
          >
            Add to the declaration
          </Button>
        </div>
      </div>
    </Card>
  );
}
