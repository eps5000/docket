import { ITEM_TYPES, type EpicCard as EpicCardData } from '@docket/shared';
import { EpicCard, TypeBadge } from '../../components/kit';

/**
 * EPICS · N and the type legend; one EpicCard per non-archived epic in
 * scope (UI_SPEC §6.2). Shown on every layout except Timeline.
 */
export function EpicsRow({ epics, current }: { epics: readonly EpicCardData[]; current?: string }) {
  if (epics.length === 0) return null;
  return (
    <section aria-label="Epics" data-card="epics">
      <div className="sectionhead" style={{ padding: '0 0 6px' }}>
        <h3>Epics · {epics.length}</h3>
        <span className="row" style={{ gap: 12 }} role="group" aria-label="Item types">
          {ITEM_TYPES.map((t) => (
            <TypeBadge key={t} type={t} />
          ))}
        </span>
      </div>
      <div className="epicrow">
        {epics.map((e) => (
          <EpicCard key={e.id} epic={e} forYou={e.children.for_you} current={current === e.id} />
        ))}
      </div>
    </section>
  );
}
