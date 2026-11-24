/**
 * Tickets added to an epic after it started (owner decision 62; UI_SPEC
 * §6.2.5, §6.3): "Added since it started: 3 tickets · 2 untriaged" on the
 * epic card, and on the epic page with each ticket linked, its status, and
 * "untriaged" while it is still in Inbox. Always words.
 */
import { Fragment } from 'react';
import { Link } from 'react-router';
import { STATUS_LABELS, midflightText, type EpicMidflight, type Status } from '@docket/shared';
import { paths } from '../../lib/paths';

const statusWord = (s: string) => STATUS_LABELS[s as Status] ?? s;

/** On an epic card, which is one link: the tickets are its tooltip, never links. */
export function EpicMidflightNote({ midflight }: { midflight: EpicMidflight }) {
  return (
    <span
      className={`src epicmid${midflight.untriaged > 0 ? ' untriaged' : ''}`}
      data-epic-midflight={midflight.untriaged}
      title={midflight.added
        .map((t) => `${t.id} ${t.title}${t.untriaged ? ' (untriaged)' : ''}`)
        .join('\n')}
    >
      <span aria-hidden="true">+</span> {midflightText(midflight)}
    </span>
  );
}

/** On the epic page: each added ticket is a link, with its status or "untriaged". */
export function EpicMidflightLine({ midflight }: { midflight: EpicMidflight }) {
  return (
    <div
      className={`src epicmid-line${midflight.untriaged > 0 ? ' untriaged' : ''}`}
      data-epic-midflight={midflight.untriaged}
    >
      <span aria-hidden="true">+</span> {midflightText(midflight)}:{' '}
      {midflight.added.map((t, i) => (
        <Fragment key={t.id}>
          {i > 0 && ', '}
          <Link className="mono" to={paths.item(t.id)} title={t.title}>
            {t.id}
          </Link>{' '}
          ({t.untriaged ? <b>untriaged</b> : statusWord(t.status)})
        </Fragment>
      ))}
    </div>
  );
}
