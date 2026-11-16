import type { ItemSummary, LinkEdge } from '@tasklite/shared';
import { ProgressMap } from '../../components/ProgressMap';

/**
 * The label page's map (US7 owns the page): the progress map (UI_SPEC
 * §6.3.4, built by US4) over the items it is given.
 */
export function ProgressMapShell({
  items,
  links,
  outsideTitle,
}: {
  items: readonly ItemSummary[];
  links: readonly LinkEdge[];
  /** "Outside this epic", "Outside this view", "Without this label". */
  outsideTitle: string;
}) {
  return <ProgressMap items={items} links={links} outsideTitle={outsideTitle} />;
}
