/**
 * The UI kit (tasks.md T057; UI_SPEC §4–§5). Built from the tokens in
 * styles/tokens.css; light and dark.
 *
 * Shared contract file (tasks.md, Slice rules): slices use the kit and don't
 * edit it. A slice that needs a new variant opens a "contract:" PR first.
 */
import './kit.css';

export { Button, IconButton, SegmentedControl, FilterChip } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize, IconButtonProps } from './Button';
export {
  Chip,
  StatusChip,
  BlockedChip,
  HumanReviewChip,
  WorkspaceStateChip,
  HUMAN_REVIEW_CHIP,
} from './Chip';
export type { ChipKind, BlockerWait } from './Chip';
export {
  TypeBadge,
  TypeIcon,
  RunState,
  Provenance,
  PROVENANCE,
  DecisionAuthorityBadge,
  Priority,
} from './Badges';
export type { ProvenanceKind } from './Badges';
export { Label, EpicLink } from './Label';
export {
  Card,
  CardHeader,
  Callout,
  EmptyState,
  Skeleton,
  ErrorState,
  isNotBuilt,
  useDelayedFlag,
  SKELETON_DELAY_MS,
} from './Card';
export type { CalloutTone, ErrorLike } from './Card';
export { Section } from './Section';
export type { SectionProps } from './Section';
export { ViewTabs } from './ViewTabs';
export type { ViewTab } from './ViewTabs';
export { TicketCard, EpicCard, ReviewChip, leadName } from './Cards';
export { DecisionRow } from './DecisionRow';
export { Toast, ToastRegion, TOAST_MS, TOAST_UNDO_MS } from './Toast';
export type { ToastData } from './Toast';
export { Dialog, DialogCancel } from './Dialog';
export type { DialogProps } from './Dialog';
export { CommandPalette } from './CommandPalette';
export type { PaletteGroup, PaletteOption } from './CommandPalette';
export { InlineEditor, EditableText, showCounter } from './InlineEditor';
export type { InlineEditorProps } from './InlineEditor';
export { Icon, TypeGlyph } from './icons';
export type { IconName } from './icons';
export { useFocusTrap, focusableIn } from './focus';
