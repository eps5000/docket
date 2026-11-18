import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { AGENT_SETUP_LIMITS, type Workflow } from '@docket/shared';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  InlineEditor,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatDay, formatStamp, isoTitle } from '../../lib/format';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { Markdown } from '../shared/Markdown';
import { DiffView } from './DiffView';
import WORKFLOW_STARTER from '../../../../docs/templates/WORKFLOW-starter.md?raw';

/**
 * The Workflow notes starter (`docs/templates/WORKFLOW-starter.md`, bundled
 * into the web build): the project questions the old AGENTS.md block asked,
 * each with a suggested answer for the owner to edit.
 */
export { WORKFLOW_STARTER };

/**
 * A project's **Workflow notes** (UI_SPEC §6.7b; FR-123), the top section of
 * Agent files with one project selected: a versioned Markdown editor whose
 * text agents get in `get_context` for every item in the project. Empty
 * notes offer *Start from template*, which loads the starter into the editor
 * unsaved.
 */
export function WorkflowNotes({ project, projectName }: { project: string; projectName: string }) {
  const query = useQuery({
    queryKey: queryKeys.workflow(project),
    queryFn: () => apiClient['workflow.get']({ params: { key: project } }),
  });
  return (
    <Card className="afwf" data-workflow={project}>
      <QueryState
        query={query}
        skeleton={
          <div className="pad">
            <Skeleton lines={3} label="Loading the Workflow notes" />
          </div>
        }
      >
        {(wf) => <WorkflowBody wf={wf} projectName={projectName} />}
      </QueryState>
    </Card>
  );
}

function WorkflowBody({ wf, projectName }: { wf: Workflow; projectName: string }) {
  const qc = useQueryClient();
  const noteId = useId();
  const [editing, setEditing] = useState<{
    expected: number;
    initial: string;
    conflict: string | null;
  } | null>(null);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState(false);
  const [diffAt, setDiffAt] = useState<number | null>(null);
  const current = wf.versions[0];

  const save = async (content_md: string): Promise<boolean> => {
    if (!editing) return false;
    try {
      const out = await runOwnerMutation(
        () =>
          apiClient['workflow.put']({
            params: { key: wf.project },
            body: {
              content_md,
              expected_version: editing.expected,
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          }),
        {
          success: (r) =>
            r.workflow.content_md.trim() === ''
              ? `Cleared the Workflow notes of ${projectName}.`
              : `Saved the Workflow notes of ${projectName} (v${r.workflow.version_no}).`,
          refetch: [queryKeys.workflow(wf.project)],
        },
      );
      if (!out) {
        const fresh = qc.getQueryData<Workflow>(queryKeys.workflow(wf.project));
        const now = fresh?.version_no ?? 0;
        setEditing({
          expected: now,
          initial: editing.initial,
          conflict: `The Workflow notes changed since you opened them (now v${now}). Save again to replace them with your text, or cancel to see the latest.`,
        });
        return false;
      }
      setEditing(null);
      setNote('');
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t save the notes. Try again.');
      return false;
    }
  };

  return (
    <>
      <CardHeader
        title={
          <span className="withhelp">
            Workflow notes
            <HelpLink anchor="agent-files.workflow" />
          </span>
        }
        extra={
          <div className="row" style={{ gap: 6 }}>
            {current && (
              <span className="src" title={isoTitle(current.created_at)}>
                v{current.version_no} · {formatDay(current.created_at)}
              </span>
            )}
            {!editing && (
              <Button
                size="sm"
                icon="pencil"
                onClick={() => {
                  setNote('');
                  setEditing({ expected: wf.version_no, initial: wf.content_md, conflict: null });
                }}
              >
                Edit
              </Button>
            )}
          </div>
        }
      />
      <div className="pad afwfbody">
        <div className="src afwfline">
          <Chip kind="info">get_context</Chip> Rules agents get with every {projectName} item (in
          get_context). They take precedence over the skills and the AGENTS.md block.
        </div>
        {editing ? (
          <div className="afedit" data-workflow-editor="">
            <InlineEditor
              field="Workflow notes"
              multiline
              initial={editing.initial}
              maxLength={AGENT_SETUP_LIMITS.workflow_md}
              onSave={save}
              onCancel={() => setEditing(null)}
              renderPreview={(t) => <Markdown text={t} label="Workflow notes preview" />}
              conflict={
                editing.conflict ? (
                  <Callout tone="warn" role="alert">
                    {editing.conflict}
                  </Callout>
                ) : undefined
              }
            />
            <div className="afnote">
              <label htmlFor={noteId}>Note (optional)</label>
              <input
                id={noteId}
                className="input"
                value={note}
                maxLength={AGENT_SETUP_LIMITS.note}
                placeholder="What changed and why"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <div className="src">
              Saving an empty text clears the notes. Every save is a version.
            </div>
          </div>
        ) : wf.content_md.trim() === '' ? (
          <div className="afwfempty" data-workflow-empty="">
            <EmptyState
              text={
                wf.version_no === 0
                  ? 'No Workflow notes yet. Add this project’s rules for agents: who moves work to Ready, reviews, branches, the checks to run.'
                  : 'The Workflow notes are cleared. Agents get none.'
              }
            />
            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setNote('');
                  setEditing({
                    expected: wf.version_no,
                    initial: WORKFLOW_STARTER,
                    conflict: null,
                  });
                }}
              >
                Start from template
              </Button>
              <span className="src">
                Loads suggested rules into the editor, for you to change before saving.
              </span>
            </div>
          </div>
        ) : (
          <Markdown text={wf.content_md} label={`${projectName} Workflow notes`} />
        )}
        {wf.versions.length > 0 && !editing && (
          <div className="afwfhist">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={history}
              onClick={() => setHistory(!history)}
            >
              History ({wf.versions.length})
            </Button>
            {history && (
              <ol aria-label="Workflow notes history">
                {wf.versions.map((v, i) => {
                  const prev = wf.versions[i + 1];
                  return (
                    <li key={v.version_no} data-version={v.version_no}>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <b>v{v.version_no}</b>
                        {i === 0 && <Chip kind="ok">Current</Chip>}
                        {v.content_md.trim() === '' && <Chip>Cleared</Chip>}
                        <span className="src" title={isoTitle(v.created_at)}>
                          {v.author} · {formatStamp(v.created_at)}
                        </span>
                        <span className="grow" />
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={diffAt === v.version_no}
                          onClick={() => setDiffAt(diffAt === v.version_no ? null : v.version_no)}
                        >
                          {prev ? `Diff v${prev.version_no} → v${v.version_no}` : 'Show text'}
                        </Button>
                      </div>
                      {v.note && <div className="afhnote">{v.note}</div>}
                      {diffAt === v.version_no && (
                        <DiffView
                          from={prev?.content_md ?? ''}
                          to={v.content_md}
                          label={`Workflow notes ${prev ? `v${prev.version_no}` : 'empty'} to v${v.version_no}`}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
      </div>
    </>
  );
}
