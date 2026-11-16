import type { ItemDetailResponse } from '@tasklite/shared';
import type { ItemKind } from '../ItemPage';
import { DecisionsPanel } from '../../shared/DecisionsPanel';

/**
 * Decisions on an item's Details (UI_SPEC §6.3.5). A ticket lists
 * everything in scope (project, epic, labels, this item), each with its
 * scope chip, and hides the section when none is active; an epic lists its
 * own records. The server sends both active and inactive records.
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
