import { Link } from 'react-router';
import { STATUSES, STATUS_LABELS, type ItemDetailResponse } from '@tasklite/shared';
import { EmptyState, Section, TypeIcon } from '../../../components/kit';
import { paths } from '../../../lib/paths';

/**
 * Tickets in this epic (summary "n/N done · n ready but blocked · n for
 * you"), grouped by status; archived tickets fold into "+ N archived · Show".
 * US2 fills it.
 */
export function EpicTicketsSection({ data }: { data: ItemDetailResponse }) {
  const kids = data.children;
  const done = kids.filter((k) => k.status === 'done').length;
  const blocked = kids.filter((k) => k.status === 'ready' && k.blocked).length;
  const live = kids.filter((k) => !k.archived);
  return (
    <Section
      sectionKey="tickets"
      title="Tickets in this epic"
      summary={`${done}/${kids.length} done · ${blocked} ready but blocked`}
    >
      {kids.length === 0 ? (
        <EmptyState text="No items yet." />
      ) : (
        STATUSES.map((s) => {
          const group = live.filter((k) => k.status === s);
          if (group.length === 0) return null;
          return (
            <div key={s}>
              <div className="src" style={{ marginTop: 8 }}>
                {STATUS_LABELS[s]} · {group.length}
              </div>
              {group.map((k) => (
                <div className="lrow" key={k.id}>
                  <TypeIcon type={k.type} />
                  <Link to={paths.item(k.id)} className="mono">
                    {k.id}
                  </Link>
                  <span className="grow one">{k.title}</span>
                </div>
              ))}
            </div>
          );
        })
      )}
      {kids.length > live.length && (
        <div className="src" style={{ marginTop: 8 }}>
          + {kids.length - live.length} archived
        </div>
      )}
    </Section>
  );
}
