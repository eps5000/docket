import { Link } from 'react-router';
import type { ItemDetailResponse, RunInstructions } from '@docket/shared';
import { Chip } from '../../../components/kit';
import { useBootstrap } from '../../../app/useBootstrap';
import { paths } from '../../../lib/paths';

type FileLine = RunInstructions['files'][number];

/** "Recipe App’s copy v2", "default v1", or "not sent by Docket". */
function sourceText(f: FileLine, projectName: string): string {
  if (f.source === null) return 'not sent by Docket';
  const where = f.source === 'project' ? `${projectName}’s copy` : 'default';
  return f.version_no !== null ? `${where} v${f.version_no}` : where;
}

/** The ⚠ "edited locally" chip, linking to the drift record on Agent files. */
function EditedChip({ f, project }: { f: FileLine; project: string }) {
  const chip = (
    <Chip kind="warn" icon="attention">
      edited locally
    </Chip>
  );
  if (!f.drift_id) return chip;
  return (
    <Link
      className="afchiplink"
      to={`${paths.agentFiles({ project })}#drift-${f.drift_id}`}
      aria-label={`${f.name} edited locally: review the change on Agent files`}
    >
      {chip}
    </Link>
  );
}

/**
 * "Instructions: docket-worker · Recipe App’s copy v2" (UI_SPEC §6.7b-1;
 * FR-133): the instruction versions a run reported working from on
 * `claim_lead`, with ⚠ "edited locally" when the reported file differs from
 * what Docket sent, linking to the drift record.
 *
 * `compact` (the agent bar): the first file (the worker skill) and how many
 * more, with the chip when any file was edited. Otherwise (Lead and runs):
 * every file.
 */
export function RunInstructionsLine({
  data,
  runId,
  compact = false,
}: {
  data: ItemDetailResponse;
  runId: string;
  compact?: boolean;
}) {
  const boot = useBootstrap();
  const ri = data.run_instructions?.find((r) => r.run_id === runId);
  if (!ri || ri.files.length === 0) return null;
  const project = data.item.project;
  const projectName = boot.data?.projects.find((p) => p.key === project)?.short_name ?? project;
  const all = ri.files.map((f) => `${f.name} · ${sourceText(f, projectName)}`).join(', ');

  if (compact) {
    const first = ri.files[0]!;
    const edited = ri.files.find((f) => f.edited_locally);
    const more = ri.files.length - 1;
    return (
      <div className="ab-instr src" data-ab="instructions" title={`Instructions: ${all}`}>
        <span>
          Instructions: {first.name} · {sourceText(first, projectName)}
          {more > 0 && ` (+${more} more)`}
        </span>
        {edited && <EditedChip f={edited} project={project} />}
      </div>
    );
  }
  return (
    <div className="runinstr src" data-run-instructions={runId}>
      Instructions:{' '}
      {ri.files.map((f, i) => (
        <span key={f.key} className="runinstr-file">
          {i > 0 && ', '}
          {f.name} · {sourceText(f, projectName)}
          {f.edited_locally && (
            <>
              {' '}
              <EditedChip f={f} project={project} />
            </>
          )}
        </span>
      ))}
    </div>
  );
}
