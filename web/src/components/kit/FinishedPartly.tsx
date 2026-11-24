/**
 * Implementers report how they finished (owner decision 61; UI_SPEC §5,
 * §6.3): a ticket whose lead finished partly says "Finished partly: N items
 * left", with each item's reason, instead of only "In progress, parked".
 * Always words, with a mark that isn't the only signal.
 */
import { Link } from 'react-router';
import {
  EXIT_SETTLE_TEXT,
  finishedPartlyText,
  type ExitReport,
  type Run,
  type WorkItem,
} from '@docket/shared';
import { paths } from '../../lib/paths';

/** `codex · orca-w1`, as on the run line (Cards imports this file, so it is not imported back). */
const runName = (r: Pick<Run, 'client' | 'label'>) =>
  r.label ? `${r.client} · ${r.label}` : r.client;

const Mark = () => <span aria-hidden="true">◐</span>;

/** On a card, which is one link: the reasons are its tooltip, never links. */
export function FinishedPartlyNote({
  partly,
}: {
  partly: NonNullable<WorkItem['finished_partly']>;
}) {
  return (
    <div
      className="meta src finished-partly"
      data-finished-partly={partly.left}
      title={partly.reasons.join('\n')}
    >
      {/* One flex item, so the mark stays with its words. */}
      <span>
        <Mark /> {finishedPartlyText(partly.left)}
      </span>
    </div>
  );
}

/** The lead run whose exit report the item page shows: the newest partial one, if any. */
export function latestPartialExit(runs: readonly Run[]): { run: Run; exit: ExitReport } | null {
  const partial = runs
    .filter((r) => r.is_lead && r.exit?.outcome === 'partial')
    .sort((a, b) => b.exit!.at.localeCompare(a.exit!.at));
  const run = partial[0];
  return run?.exit ? { run, exit: run.exit } : null;
}

/** On the item page: each item left, why, and what would finish it; then who acted on it. */
export function FinishedPartlyBlock({ runs }: { runs: readonly Run[] }) {
  const found = latestPartialExit(runs);
  if (!found) return null;
  const { run, exit } = found;
  const settled = exit.settled;
  return (
    <div
      className={`finished-partly-block${settled ? ' settled' : ''}`}
      data-finished-partly-block={settled ? 'settled' : 'open'}
    >
      <div className="src">
        <Mark /> <b>{finishedPartlyText(exit.left.length)}</b> · {runName(run)}
        {settled
          ? ` · Settled: ${EXIT_SETTLE_TEXT[settled.how]} (${settled.by})`
          : ' · waiting on its producer'}
      </div>
      {!settled && (
        <ol className="fp-left">
          {exit.left.map((l, i) => (
            <li key={i}>
              <span>{l.text}</span>
              <div className="src">
                Why: {l.why} · Needs: {l.needs}
                {l.item && (
                  <>
                    {' '}
                    ·{' '}
                    <Link className="mono" to={paths.item(l.item)}>
                      {l.item}
                    </Link>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
