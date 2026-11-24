/**
 * Every epic has one Release (owner decision 67; UI_SPEC §6.2.5, §6.3), which
 * replaced decision 64's finish line and keeps its bug rules: the Release
 * waits for every other ticket in the epic, and its open bugs are counted.
 * Always words, with a mark.
 */
import { Fragment } from 'react';
import { Link } from 'react-router';
import {
  STATUS_LABELS,
  bugCount,
  ticketCount,
  waitingOnBugsText,
  type EpicRelease,
  type ReleaseDetail,
  type ReleaseHold,
} from '@docket/shared';
import { paths } from '../../lib/paths';

/** "Release RCP-30 · waits for 3 tickets · Waiting on 2 bugs", or "Release RCP-30 · ready to finish". */
export function epicReleaseText(r: EpicRelease): string {
  if (r.id === null) return 'No Release';
  const parts = [`Release ${r.id}`];
  const others = r.left - r.open_bugs;
  if (others > 0) parts.push(`waits for ${ticketCount(others)}`);
  if (r.open_bugs > 0) parts.push(waitingOnBugsText(r.open_bugs));
  if (r.left === 0) parts.push('nothing left before it');
  return parts.join(' · ');
}

/**
 * On an epic card, which is one link: plain text, only while bugs are open.
 * No ticket ID joins the link's name; the Release is its tooltip.
 */
export function EpicReleaseNote({ release }: { release: EpicRelease }) {
  if (release.open_bugs === 0) return null;
  return (
    <span
      className="src epicrelease"
      data-epic-release={release.id ?? 'none'}
      data-open-bugs={release.open_bugs}
      title={release.id ? `Release ${release.id}` : undefined}
    >
      <span aria-hidden="true">⚑</span>{' '}
      {`Release ${waitingOnBugsText(release.open_bugs).toLowerCase()}`}
    </span>
  );
}

const ids = (list: readonly string[], max = 6) =>
  list.slice(0, max).map((id, i) => (
    <Fragment key={id}>
      {i > 0 && ', '}
      <Link className="mono" to={paths.item(id)}>
        {id}
      </Link>
    </Fragment>
  ));

/** On the epic page: its Release, what it still waits for, and each open bug with its status. */
export function EpicReleaseLine({
  release,
  className = 'src epicrelease-line',
}: {
  release: ReleaseDetail;
  className?: string;
}) {
  const n = release.open_bugs.length;
  const others = release.left.filter((id) => !release.open_bugs.some((b) => b.id === id));
  return (
    <div
      className={`${className}${release.id === null ? ' none' : ''}`}
      data-release={release.id ?? 'none'}
      data-open-bugs={n}
      data-left={release.left.length}
    >
      <span aria-hidden="true">⚑</span>{' '}
      {release.id === null ? (
        <b>No Release</b>
      ) : (
        <>
          Release{' '}
          <Link className="mono" to={paths.item(release.id)} title={release.title ?? undefined}>
            {release.id}
          </Link>
          {release.status ? ` (${STATUS_LABELS[release.status]})` : ''}
        </>
      )}
      {others.length > 0 && (
        <>
          {' · waits for '}
          {ticketCount(others.length)}: {ids(others)}
          {others.length > 6 ? ` and ${others.length - 6} more` : ''}
        </>
      )}
      {n > 0 ? (
        <>
          {' · '}
          {waitingOnBugsText(n)}:{' '}
          {release.open_bugs.map((b, i) => (
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

/** On a Release's page: it waits for the rest of its epic to finish. */
export function ReleaseHoldLine({ hold }: { hold: ReleaseHold }) {
  const n = hold.open_bugs.length;
  return (
    <div
      className="src epicrelease-line releasehold"
      data-release-hold={hold.epic}
      data-left={hold.left}
    >
      <span aria-hidden="true">⚑</span> The Release of{' '}
      <Link className="mono" to={paths.item(hold.epic)}>
        {hold.epic}
      </Link>
      : it finishes after {ticketCount(hold.left)}: {ids(hold.waiting_on)}
      {hold.left > hold.waiting_on.length ? ` and ${hold.left - hold.waiting_on.length} more` : ''}
      {n > 0 ? ` · ${bugCount(n)} open` : ''}. Review and Done wait for them, with no open bugs,
      unsettled known gaps or partial exits, and its own checklist done.
    </div>
  );
}
