import type { ItemDetailResponse } from '@tasklite/shared';
import { Section } from '../../../components/kit';
import { formatDay } from '../../../lib/format';
import { HelpLink } from '../../../help/HelpLink';

/** Dates and effort (summary "Nov 4 → Nov 11" or "not set"). Agent-edited in V1; US8 fills it. */
export function DatesSection({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const planned =
    item.planned_start && item.planned_end
      ? `${formatDay(item.planned_start)} → ${formatDay(item.planned_end)}`
      : null;
  return (
    <Section
      sectionKey="dates"
      title="Dates and effort"
      summary={planned ?? 'not set'}
      extraHead={<HelpLink anchor="item.dates" />}
    >
      <dl className="kv">
        <dt>Planned</dt>
        <dd className={planned ? undefined : 'muted'}>
          {planned ?? 'Not set'}
          {planned && item.dates_set_by && <div className="src">set by {item.dates_set_by}</div>}
        </dd>
        <dt>Effort</dt>
        <dd className={item.effort === null ? 'muted' : undefined}>
          {item.effort === null ? 'Not estimated' : `${item.effort} pts`}
        </dd>
      </dl>
    </Section>
  );
}
