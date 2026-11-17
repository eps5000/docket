import type { AgentFileLayer } from '@tasklite/shared';
import { Chip } from '../../components/kit';

/** The layer chip (UI_SPEC §6.7b): "Bundled", "Your edit", "Project override". */
export const LAYER_CHIP: Record<AgentFileLayer, string> = {
  bundled: 'Bundled',
  service: 'Your edit',
  project: 'Project override',
};

export function LayerChip({ layer }: { layer: AgentFileLayer }) {
  return (
    <Chip kind={layer === 'bundled' ? 'neutral' : 'info'} className="layerchip">
      {LAYER_CHIP[layer]}
    </Chip>
  );
}

/** FR-122: the bundled version changed after the owner edited the file. */
export function BundledUpdatedChip() {
  return (
    <Chip
      kind="warn"
      title="Task Lite ships a newer version of this file than the one your edit was based on. Your version is kept."
    >
      Bundled version updated
    </Chip>
  );
}
