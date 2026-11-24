/**
 * Open bugs hold back an epic's release (owner decision 64; UI_SPEC §6.2.5,
 * §6.3): the epic's finish line (its release ticket) and the open bugs that
 * hold it, or "No finish line" for the producer or you to mark. Always words,
 * with a mark.
 */
import { Fragment } from 'react';
import { Link } from 'react-router';
import {
  NO_FINISH_LINE,
  STATUS_LABELS,
  bugCount,
  waitingOnBugsText,
  type EpicRelease,
  type FinishLine,
} from '@docket/shared';
import { paths } from '../../lib/paths';

const openBugs = (n: number) => `${bugCount(n)} open`;

/** "Finish line RCP-22 · Waiting on 2 bugs", or "No finish line · 1 bug open". */
export function epicReleaseText(r: EpicRelease): string {
  if (r.finish_line === null) {
    return r.open_bugs > 0 ? `${NO_FINISH_LINE} · ${openBugs(r.open_bugs)}` : NO_FINISH_LINE;
  }
  return r.open_bugs > 0
    ? `Finish line ${r.finish_line} · ${waitingOnBugsText(r.open_bugs)}`
    : `Finish line ${r.finish_line}`;
}

/** On an epic card, which is one link: plain text, only while bugs are open. */
export function EpicReleaseNote({ release }: { release: EpicRelease }) {
  if (release.open_bugs === 0) return null;
  return (
    <span
      className="src epicrelease"
      data-epic-release={release.finish_line ?? 'none'}
      data-open-bugs={release.open_bugs}
    >
      <span aria-hidden="true">⚑</span> {epicReleaseText(release)}
    </span>
  );
}

/** On the epic page: the finish line and each open bug as a link, with its status. */
export function EpicReleaseLine({
  line,
  className = 'src epicrelease-line',
}: {
  line: FinishLine;
  className?: string;
}) {
  const n = line.open_bugs.length;
  return (
    <div
      className={`${className}${line.id === null ? ' none' : ''}`}
      data-finish-line={line.id ?? 'none'}
      data-open-bugs={n}
    >
      <span aria-hidden="true">⚑</span>{' '}
      {line.id === null ? (
        <b>{NO_FINISH_LINE}</b>
      ) : (
        <>
          Finish line{' '}
          <Link className="mono" to={paths.item(line.id)}>
            {line.id}
          </Link>
          {line.how === 'explicit' ? ' (marked)' : ''}
        </>
      )}
      {n > 0 ? (
        <>
          {' · '}
          {line.id === null ? openBugs(n) : waitingOnBugsText(n)}:{' '}
          {line.open_bugs.map((b, i) => (
            <Fragment key={b.id}>
              {i > 0 && ', '}
              <Link className="mono" to={paths.item(b.id)} title={b.title}>
                {b.id}
              </Link>{' '}
              ({STATUS_LABELS[b.status]})
            </Fragment>
          ))}
        </>
      ) : (
        ' · no open bugs'
      )}
    </div>
  );
}
