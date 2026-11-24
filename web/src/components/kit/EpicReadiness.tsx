/**
 * An epic starts only when its tickets are ready (owner decision 58; UI_SPEC
 * §6.2.5, §6.3): "Not ready to start: 2 unshaped tickets" before it starts,
 * a quiet "Started with 1 unshaped ticket" after. Always words, with a mark.
 */
import { Fragment } from 'react';
import { Link } from 'react-router';
import { STATUS_LABELS, epicReadinessText, type EpicReadiness } from '@docket/shared';
import { paths } from '../../lib/paths';

const Mark = ({ state }: { state: EpicReadiness['state'] }) => (
  <span aria-hidden="true">{state === 'not_ready' ? '◌' : '·'}</span>
);

/** On an epic card, which is one link: the tickets are its tooltip, never links. */
export function EpicReadinessNote({ readiness }: { readiness: EpicReadiness }) {
  return (
    <span
      className={`src epicready ${readiness.state}`}
      data-epic-readiness={readiness.state}
      title={readiness.unshaped.map((t) => `${t.id} ${t.title}`).join('\n')}
    >
      <Mark state={readiness.state} /> {epicReadinessText(readiness)}
    </span>
  );
}

/** On the epic page and Pick next epic: each unshaped ticket is a link, with its status. */
export function EpicReadinessLine({
  readiness,
  className = 'src epicready-line',
}: {
  readiness: EpicReadiness;
  className?: string;
}) {
  return (
    <div className={`${className} ${readiness.state}`} data-epic-readiness={readiness.state}>
      <Mark state={readiness.state} /> {epicReadinessText(readiness)}:{' '}
      {readiness.unshaped.map((t, i) => (
        <Fragment key={t.id}>
          {i > 0 && ', '}
          <Link className="mono" to={paths.item(t.id)} title={t.title}>
            {t.id}
          </Link>{' '}
          ({STATUS_LABELS[t.status]})
        </Fragment>
      ))}
    </div>
  );
}
