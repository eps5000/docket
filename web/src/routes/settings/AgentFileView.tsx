import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import {
  AGENT_SETUP_LIMITS,
  type AgentFileDetail,
  type AgentFileLayer,
  type AgentFileVersion,
  type EditableAgentFileLayer,
} from '@tasklite/shared';
import {
  Button,
  Callout,
  Chip,
  InlineEditor,
  SegmentedControl,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { formatStamp, isoTitle } from '../../lib/format';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { Markdown } from '../shared/Markdown';
import { BundledUpdatedChip, LayerChip } from './AgentChips';
import { DiffView } from './DiffView';

interface Version extends AgentFileVersion {
  layer: AgentFileLayer;
  current: boolean;
}

/** The front matter (`---` … `---`) or a leading HTML comment, shown apart from the rendered body. */
export function splitPreamble(text: string): { preamble: string | null; body: string } {
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (fm) return { preamble: fm[0].trimEnd(), body: text.slice(fm[0].length) };
  const comment = /^<!--[\s\S]*?-->\r?\n?/.exec(text);
  if (comment) return { preamble: comment[0].trimEnd(), body: text.slice(comment[0].length) };
  return { preamble: null, body: text };
}

/** The file's text: rendered Markdown (front matter apart), or raw. */
export function AgentText({ text, raw, label }: { text: string; raw: boolean; label: string }) {
  if (raw) {
    return (
      <pre className="code afraw" aria-label={`${label}, raw`} tabIndex={0}>
        {text}
      </pre>
    );
  }
  const { preamble, body } = splitPreamble(text);
  return (
    <div className="afrendered">
      {preamble && (
        <pre className="code afpre" aria-label="Front matter" tabIndex={0}>
          {preamble}
        </pre>
      )}
      <Markdown text={body} label={label} />
    </div>
  );
}

const WHERE: Record<EditableAgentFileLayer, string> = {
  service: 'service-wide',
  project: 'project',
};

/**
 * The file view (UI_SPEC §6.7b): the rendered text and a *Raw* toggle; the
 * layer switcher (Bundled · Service-wide · this project); *Edit* (the
 * inline editor, with a required note), *Revert to …*, *History*; and
 * *Diff* against any other version or layer, computed in the browser.
 * With "Bundled version updated", the three-way view: bundled X → Y, and
 * bundled Y → the owner's edit.
 */
export function AgentFileView({
  fileKey,
  project,
  projectName,
  initialLayer,
}: {
  fileKey: string;
  project: string | null;
  projectName: string | null;
  initialLayer: AgentFileLayer | null;
}) {
  const q = project ? { project } : {};
  const query = useQuery({
    queryKey: queryKeys.agentFile(fileKey, q),
    queryFn: () => apiClient['agentFiles.get']({ params: { key: fileKey }, query: q }),
  });
  return (
    <section className="settings-sec" aria-labelledby="afv-title" data-agent-file-view={fileKey}>
      <QueryState
        query={query}
        skeleton={
          <div className="card pad">
            <Skeleton lines={6} label="Loading the file" />
          </div>
        }
      >
        {(d) => (
          <FileBody
            detail={d}
            project={project}
            projectName={projectName ?? project}
            initialLayer={initialLayer}
          />
        )}
      </QueryState>
    </section>
  );
}

interface Editing {
  layer: EditableAgentFileLayer;
  /** The layer's version when the editor opened (sent as `expected_version`). */
  expected: number;
  initial: string;
  conflict: string | null;
}

function FileBody({
  detail: d,
  project,
  projectName,
  initialLayer,
}: {
  detail: AgentFileDetail;
  project: string | null;
  projectName: string | null;
  initialLayer: AgentFileLayer | null;
}) {
  const qc = useQueryClient();
  const noteId = useId();
  const diffId = useId();
  const [chosen, setChosen] = useState<AgentFileLayer | null>(
    initialLayer === 'project' && !project ? null : initialLayer,
  );
  const [raw, setRaw] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ from: string; to: string } | null>(null);
  const [history, setHistory] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);

  const layer: AgentFileLayer = chosen ?? d.effective_layer;
  const layerName = (l: AgentFileLayer) =>
    l === 'bundled' ? 'Bundled' : l === 'service' ? 'Service-wide' : (projectName ?? 'Project');

  const versions = useMemo(() => {
    const all: Version[] = [];
    for (const l of ['project', 'service', 'bundled'] as const) {
      const ld = d.layers[l];
      for (const v of ld?.versions ?? []) {
        all.push({ ...v, layer: l, current: v.version_no === ld!.current_version_no });
      }
    }
    return all;
  }, [d]);
  const byId = (id: string) => versions.find((v) => v.id === id);
  const label = (v: Version) =>
    `${layerName(v.layer)} v${v.version_no}${v.current ? ' (current)' : ''}`;
  const currentOf = (l: AgentFileLayer) => versions.find((v) => v.layer === l && v.current);
  const effective = currentOf(d.effective_layer);

  const layerDetail = d.layers[layer];
  const shown = (viewing && byId(viewing)) || currentOf(layer) || null;
  const editable = layer !== 'bundled';
  const key = queryKeys.family('agentFiles');

  const where = (l: EditableAgentFileLayer) =>
    l === 'project' ? (projectName ?? 'project') : WHERE[l];
  /** What applies if `l` is reverted: the next layer down with a current version. */
  const below = (l: EditableAgentFileLayer): AgentFileLayer =>
    l === 'project' && currentOf('service') ? 'service' : 'bundled';

  const openEditor = (l: EditableAgentFileLayer) => {
    const base = currentOf(l) ?? currentOf(below(l)) ?? effective;
    setChosen(l);
    setViewing(null);
    setDiff(null);
    setNote('');
    setNoteError(false);
    setEditing({
      layer: l,
      expected: d.layers[l]?.current_version_no ?? 0,
      initial: base?.content ?? '',
      conflict: null,
    });
  };

  const save = async (content: string): Promise<boolean> => {
    if (!editing) return false;
    if (note.trim() === '') {
      setNoteError(true);
      document.getElementById(noteId)?.focus();
      return false;
    }
    const target = editing.layer;
    try {
      const out = await runOwnerMutation(
        () =>
          apiClient['agentFiles.put']({
            params: { key: d.key },
            body: {
              layer: target,
              ...(target === 'project' && project ? { project } : {}),
              content,
              expected_version: editing.expected,
              note: note.trim(),
            },
          }),
        {
          success: (r) =>
            `Saved ${d.name} (${where(target)}) v${r.file.layers[target]?.current_version_no ?? ''}.`,
          refetch: [key],
        },
      );
      if (!out) {
        // A conflict: the latest is refetched; keep the owner's text and say what changed.
        const fresh = qc.getQueryData<AgentFileDetail>(
          queryKeys.agentFile(d.key, project ? { project } : {}),
        );
        const now = fresh?.layers[target]?.current_version_no ?? 0;
        setEditing({
          ...editing,
          expected: now,
          conflict: `The ${where(target)} version changed since you opened it (now v${now}). Save again to replace it with your text, or cancel to see the latest.`,
        });
        return false;
      }
      setEditing(null);
      await qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t save the file. Try again.');
      return false;
    }
  };

  const revert = async (l: EditableAgentFileLayer) => {
    const to = below(l);
    try {
      await runOwnerMutation(
        () =>
          apiClient['agentFiles.revert']({
            params: { key: d.key },
            body: { layer: l, ...(l === 'project' && project ? { project } : {}) },
          }),
        {
          success: `Reverted ${d.name} (${where(l)}) to ${to === 'bundled' ? 'bundled' : 'the service-wide edit'}.`,
          refetch: [key],
        },
      );
      setViewing(null);
      setDiff(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t revert. Try again.');
    }
    await qc.invalidateQueries({ queryKey: key });
  };

  const layerOptions = [
    { key: 'bundled' as const, label: 'Bundled' },
    { key: 'service' as const, label: 'Service-wide' },
    ...(project ? [{ key: 'project' as const, label: projectName ?? project }] : []),
  ];

  const flag = d.bundled_updated;
  const flagFrom = flag?.from_version_id ? byId(flag.from_version_id) : undefined;
  const flagTo = flag ? byId(flag.to_version_id) : undefined;
  const flagEdit = flag ? currentOf(flag.edited_layer) : undefined;

  const status = (() => {
    if (!shown) return null;
    const meta = `v${shown.version_no} · ${shown.author} · ${formatStamp(shown.created_at)}`;
    return (
      <div className="src afmeta" title={isoTitle(shown.created_at)}>
        {meta}
        {shown.note && <> · “{shown.note}”</>}
      </div>
    );
  })();

  const inUse =
    layer === d.effective_layer
      ? `In use ${project ? `for ${projectName}` : 'service-wide'}.`
      : layerDetail && layerDetail.current_version_no > 0
        ? `Not in use: ${layerName(d.effective_layer)} applies${project ? ` to ${projectName}` : ''}.`
        : null;

  return (
    <div className="card afv">
      <div className="afvhead">
        <div className="row wrap" style={{ gap: 8 }}>
          <h2 id="afv-title" className="mono">
            {d.name}
          </h2>
          <span className="src">
            {d.kind === 'skill' ? 'Skill' : 'AGENTS.md / CLAUDE.md block'}
          </span>
          <LayerChip layer={d.effective_layer} />
          {effective && <Chip>v{effective.version_no}</Chip>}
          {flag && <BundledUpdatedChip />}
        </div>
        <div className="src">
          {project
            ? `As ${projectName} gets it.`
            : 'Service-wide: what projects without an override get.'}
        </div>
      </div>

      {flag && (
        <Callout tone="warn" className="afflag">
          <div>
            <b>Bundled version updated.</b> Task Lite now ships bundled v{flagTo?.version_no ?? '?'}
            ; the{' '}
            {flag.edited_layer === 'project' ? `${projectName} override` : 'service-wide edit'} was
            based on {flagFrom ? `bundled v${flagFrom.version_no}` : 'an earlier bundled version'}.
            Your version is kept: compare, then edit it to take what you need.
          </div>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            {flagFrom && flagTo && (
              <Button
                size="sm"
                onClick={() => {
                  setDiff({ from: flagFrom.id, to: flagTo.id });
                  setEditing(null);
                }}
              >
                Diff bundled v{flagFrom.version_no} → v{flagTo.version_no}
              </Button>
            )}
            {flagTo && flagEdit && (
              <Button
                size="sm"
                onClick={() => {
                  setDiff({ from: flagTo.id, to: flagEdit.id });
                  setEditing(null);
                }}
              >
                Diff bundled v{flagTo.version_no} → your edit
              </Button>
            )}
          </div>
        </Callout>
      )}

      <div className="aftools row wrap">
        <SegmentedControl
          label="Layer"
          options={layerOptions}
          value={layer}
          onChange={(l) => {
            setChosen(l);
            setViewing(null);
            setEditing(null);
            setDiff(null);
          }}
        />
        <SegmentedControl
          label="Show as"
          options={[
            { key: 'rendered' as const, label: 'Rendered' },
            { key: 'raw' as const, label: 'Raw' },
          ]}
          value={raw ? 'raw' : 'rendered'}
          onChange={(v) => setRaw(v === 'raw')}
        />
        <span className="grow" />
        {!editing && (
          <Button
            size="sm"
            icon="pencil"
            onClick={() => openEditor(layer === 'bundled' ? 'service' : layer)}
          >
            {layer === 'bundled' ? 'Edit service-wide' : 'Edit'}
          </Button>
        )}
        {editable && layerDetail && layerDetail.current_version_no > 0 && !editing && (
          <Button size="sm" variant="ghost" onClick={() => void revert(layer)}>
            Revert to {below(layer) === 'bundled' ? 'bundled' : 'service-wide'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={history}
          onClick={() => setHistory(!history)}
          disabled={!layerDetail || layerDetail.versions.length === 0}
        >
          History{layerDetail ? ` (${layerDetail.versions.length})` : ''}
        </Button>
        {shown && versions.length > 1 && (
          <span className="row" style={{ gap: 6 }}>
            <label htmlFor={diffId} className="src">
              Diff against
            </label>
            <select
              id={diffId}
              value={diff && diff.to === shown.id ? diff.from : ''}
              onChange={(e) => {
                setEditing(null);
                setDiff(e.target.value ? { from: e.target.value, to: shown.id } : null);
              }}
            >
              <option value="">Choose a version…</option>
              {versions
                .filter((v) => v.id !== shown.id)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {label(v)}
                  </option>
                ))}
            </select>
          </span>
        )}
      </div>

      <div className="afbody">
        {editing ? (
          <div className="afedit" data-agent-file-editor={editing.layer}>
            <div className="src">
              Editing the{' '}
              {editing.layer === 'project' ? `${projectName} override` : 'service-wide edit'}
              {editing.expected > 0 ? ` (replaces v${editing.expected})` : ' (a new layer)'}. Saving
              adds a version; older ones stay in History.
            </div>
            <div className="afnote">
              <label htmlFor={noteId}>Note (required)</label>
              <input
                id={noteId}
                className="input"
                value={note}
                maxLength={AGENT_SETUP_LIMITS.note}
                placeholder="What changed and why"
                aria-invalid={noteError || undefined}
                aria-describedby={noteError ? `${noteId}-err` : undefined}
                onChange={(e) => {
                  setNote(e.target.value);
                  if (e.target.value.trim()) setNoteError(false);
                }}
              />
              {noteError && (
                <div id={`${noteId}-err`} className="field-err" role="alert">
                  Add a note saying what changed.
                </div>
              )}
            </div>
            <InlineEditor
              field="file"
              multiline
              initial={editing.initial}
              maxLength={AGENT_SETUP_LIMITS.agent_file_content}
              onSave={save}
              onCancel={() => setEditing(null)}
              renderPreview={(t) => <AgentText text={t} raw={false} label="Preview" />}
              conflict={
                editing.conflict ? (
                  <Callout tone="warn" role="alert">
                    {editing.conflict}
                  </Callout>
                ) : undefined
              }
            />
          </div>
        ) : diff && byId(diff.from) && byId(diff.to) ? (
          <div>
            <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
              <b>
                {label(byId(diff.from)!)} → {label(byId(diff.to)!)}
              </b>
              <span className="grow" />
              <Button size="sm" variant="ghost" onClick={() => setDiff(null)}>
                Close diff
              </Button>
            </div>
            <DiffView
              from={byId(diff.from)!.content}
              to={byId(diff.to)!.content}
              label={`Diff from ${label(byId(diff.from)!)} to ${label(byId(diff.to)!)}`}
            />
          </div>
        ) : shown ? (
          <>
            {status}
            {inUse && !viewing && <div className="src afuse">{inUse}</div>}
            {viewing && !shown.current && (
              <Callout>
                <div className="row wrap">
                  <span className="grow">
                    Viewing {label(shown)}, an older version. It isn’t in use.
                  </span>
                  <Button size="sm" onClick={() => setViewing(null)}>
                    Back to current
                  </Button>
                </div>
              </Callout>
            )}
            <AgentText text={shown.content} raw={raw} label={`${d.name}, ${label(shown)}`} />
          </>
        ) : (
          <div className="src afuse">
            No {layer === 'project' ? `${projectName} override` : 'service-wide edit'}
            {layerDetail && layerDetail.versions.length > 0
              ? ' in use (it was reverted)'
              : ''}. {layerName(d.effective_layer)} applies{project ? ` to ${projectName}` : ''}.
            Use Edit to add one.
          </div>
        )}
      </div>

      {history && layerDetail && (
        <div className="afhist" role="region" aria-label={`${layerName(layer)} history`}>
          <h3>{layerName(layer)} history</h3>
          <ol>
            {versions
              .filter((v) => v.layer === layer)
              .map((v, i, all) => {
                const prev = all[i + 1];
                return (
                  <li key={v.id} data-version={v.version_no}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <b>v{v.version_no}</b>
                      {v.current && <Chip kind="ok">Current</Chip>}
                      <span className="src" title={isoTitle(v.created_at)}>
                        {v.author} · {formatStamp(v.created_at)}
                      </span>
                      <span className="grow" />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(null);
                          setDiff(null);
                          setViewing(v.id);
                        }}
                      >
                        View v{v.version_no}
                      </Button>
                      {prev && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(null);
                            setDiff({ from: prev.id, to: v.id });
                          }}
                        >
                          Diff v{prev.version_no} → v{v.version_no}
                        </Button>
                      )}
                    </div>
                    {v.note && <div className="afhnote">{v.note}</div>}
                  </li>
                );
              })}
          </ol>
        </div>
      )}
    </div>
  );
}
