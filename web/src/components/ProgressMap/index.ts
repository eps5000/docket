/**
 * The progress map and its cards (UI_SPEC §6.3.3, §6.3.4). Slice-owned by
 * US4 (tasks.md T108): the epic Map tab, label pages, Work → Map and the
 * Dependencies tab's 1-hop view use it.
 */
export type { CriticalOverlay } from './ProgressMap';
export { ProgressMap, outsideLabel } from './ProgressMap';
export type { ProgressMapProps } from './ProgressMap';
export { MapCard, reviewMark } from './MapCard';
export type { MapCardProps } from './MapCard';
export { layoutMap, cyclesIn, cyclePath, stepZoom, fitZoom, ZOOM_STEPS, FIT_MIN } from './layout';
export type { MapItem, MapEdge, MapLayout } from './layout';
export { planMap, routeMap, roundedPath, CARD_WIDTH, GUTTER_MIN, ROW_GAP_MIN } from './routing';
export type { MapPlan, PlanEdge, RoutedMap, RoutedArrow, CardBox } from './routing';
