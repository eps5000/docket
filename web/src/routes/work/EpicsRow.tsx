import { useState } from 'react';
import { ITEM_TYPES, type EpicCard as EpicCardData } from '@docket/shared';
import { Button, EpicCard, TypeBadge } from '../../components/kit';

/**
 * Done epics leave the strip until *Show N done* (B43, owner feedback): an
 * epic that's done (or canceled) and has tickets. An epic with no tickets
 * stays, and so does the epic the page is filtered to.
 */
export function splitEpics(epics: readonly EpicCardData[], current?: string) {
  const hidden = (e: EpicCardData) =>
    (e.status === 'done' || e.status === 'canceled') && e.children.total > 0 && e.id !== current;
  return { shown: epics.filter((e) => !hidden(e)), done: epics.filter(hidden) };
}

/**
 * EPICS · N and the type legend; one EpicCard per non-archived epic in
 * scope (UI_SPEC §6.2). N counts the cards showing; the done ones wait behind
 * *Show N done* at the end of the strip. Shown on every layout except Timeline.
 */
export function EpicsRow({ epics, current }: { epics: readonly EpicCardData[]; current?: string }) {
  const [showDone, setShowDone] = useState(false);
  if (epics.length === 0) return null;
  const { shown, done } = splitEpics(epics, current);
  const cards = showDone ? epics : shown;
  return (
    <section aria-label="Epics" data-card="epics">
      <div className="sectionhead" style={{ padding: '0 0 6px' }}>
        <h3>Epics · {cards.length}</h3>
        <span className="row" style={{ gap: 12 }} role="group" aria-label="Item types">
          {ITEM_TYPES.map((t) => (
            <TypeBadge key={t} type={t} />
          ))}
        </span>
      </div>
      <div className="epicrow">
        {cards.map((e) => (
          <EpicCard key={e.id} epic={e} forYou={e.children.for_you} current={current === e.id} />
        ))}
        {done.length > 0 && (
          <div className="epicmore">
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showDone}
              data-epics-done=""
              onClick={() => setShowDone(!showDone)}
            >
              {showDone ? 'Hide done' : `Show ${done.length} done`}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
