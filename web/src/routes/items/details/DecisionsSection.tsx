import type { ItemDetailResponse } from '@docket/shared';
import type { ItemKind } from '../ItemPage';
import { DecisionsPanel } from '../../shared/DecisionsPanel';

/**
 * Decisions on an item's Details (UI_SPEC §6.3.5). A ticket lists its own,
 * its epic's and its labels' records, each with its scope chip, and hides
 * the section when none is active and no project record applies; an epic
 * lists its own and its labels'. Project records are one line, "N project
 * decisions also apply · View" (decision 38). The server sends everything in
 * scope, active and inactive.
 */
export function DecisionsSection({ data, kind }: { data: ItemDetailResponse; kind: ItemKind }) {
  const { item } = data;
  return kind === 'epic' ? (
    <DecisionsPanel
      place={{ kind: 'epic', project: item.project, id: item.id, title: item.title }}
      records={data.decisions}
    />
  ) : (
    <DecisionsPanel
      place={{
        kind: 'ticket',
        project: item.project,
        id: item.id,
        epic: item.epic ? { id: item.epic, title: item.epic_title ?? item.epic } : null,
      }}
      records={data.decisions}
      hideWhenEmpty
    />
  );
}
