/**
 * The outside-dependency indicator (owner decision 54; UI_SPEC §6.2.5), on
 * epic cards and the epic page. Always words, with a mark for scanning.
 */
import { Fragment } from 'react';
import { Link } from 'react-router';
import type { EpicWait } from '@docket/shared';
import { paths } from '../../lib/paths';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "No outside dependencies", "Waits on 2 epics", or "Waits on 3 tickets with no epic". */
export function epicDepsText(waits: readonly EpicWait[]): string {
  if (waits.length === 0) return 'No outside dependencies';
  const epics = waits.filter((w) => w.epic !== null).length;
  const loose = waits.find((w) => w.epic === null)?.tickets ?? 0;
  const parts = [
    ...(epics > 0 ? [plural(epics, 'epic')] : []),
    ...(loose > 0 ? [`${plural(loose, 'ticket')} with no epic`] : []),
  ];
  return `Waits on ${parts.join(' and ')}`;
}

/** "Foundations (4 tickets), no epic (1 ticket)". */
export function epicDepsNames(waits: readonly EpicWait[]): string {
  return waits
    .map((w) => `${w.epic ? (w.title ?? w.epic) : 'no epic'} (${plural(w.tickets, 'ticket')})`)
    .join(', ');
}

const Mark = ({ clear }: { clear: boolean }) => <span aria-hidden="true">{clear ? '✓' : '⊘'}</span>;

/**
 * On an epic card, which is one link. The names are its tooltip and, through
 * `namesId`, the link's description, so another epic's name never becomes
 * part of this card's accessible name.
 */
export function EpicDepsNote({ waits, namesId }: { waits: readonly EpicWait[]; namesId: string }) {
  const clear = waits.length === 0;
  const names = epicDepsNames(waits);
  return (
    <span
      className="src epicdeps"
      data-epic-deps={clear ? 'none' : 'waits'}
      title={clear ? undefined : names}
    >
      <Mark clear={clear} /> {epicDepsText(waits)}
      {!clear && (
        <span id={namesId} hidden>
          Waits on {names}
        </span>
      )}
    </span>
  );
}

/** On the epic page: each epic it waits on is a link. */
export function EpicDepsLine({ waits }: { waits: readonly EpicWait[] }) {
  const clear = waits.length === 0;
  return (
    <div className="src epicdeps-line" data-epic-deps={clear ? 'none' : 'waits'}>
      <Mark clear={clear} /> {epicDepsText(waits)}
      {!clear && ': '}
      {waits.map((w, i) => (
        <Fragment key={w.epic ?? 'none'}>
          {i > 0 && ', '}
          {w.epic ? <Link to={paths.item(w.epic)}>{w.title ?? w.epic}</Link> : 'no epic'} (
          {plural(w.tickets, 'ticket')})
        </Fragment>
      ))}
    </div>
  );
}
