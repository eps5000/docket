import type { ItemDetailResponse } from '@docket/shared';
import type { ItemKind } from './ItemPage';
import { AgentReviewSection } from './checklist/AgentReviewSection';
import { HumanReviewSection } from './checklist/HumanReviewSection';
import { WorkSection } from './checklist/WorkSection';

/** Checklist (UI_SPEC §6.3, §6.3.1): Work, Agent review, Human review; the same three on epics. */
export function ChecklistTab({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  return (
    <div className="stack1">
      <WorkSection kind={kind} data={data} />
      <AgentReviewSection kind={kind} data={data} />
      <HumanReviewSection kind={kind} data={data} />
    </div>
  );
}
