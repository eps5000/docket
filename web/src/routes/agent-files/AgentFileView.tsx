import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  AGENT_SETUP_LIMITS,
  type AgentFileDetail,
  type EditableAgentFileLayer,
} from '@tasklite/shared';
import {
  Button,
  Callout,
  Chip,
  IconButton,
  InlineEditor,
  SegmentedControl,
  Skeleton,
} from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { formatAgo, formatStamp, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { Markdown } from '../shared/Markdown';
import { DiffView } from './DiffView';
import {
  copyOutdated,
  currentOf,
  defaultHistory,
  defaultOf,
  possessive,
  versionLabel,
  versionsOf,
  type Version,
} from './model';
import { useResetDefault, useSwitchToDefault } from './mutations';

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

/** How the view opens: reading, in the editor (*Edit*, *Customize for …*), or on the "default changed" comparison. */
export type FileViewMode = 'view' | 'edit' | 'changed';

/**
 * One file (UI_SPEC §6.7b "Opening a file"): the rendered text with a *Raw*
 * toggle, *Edit* (a required note), *History* and *Compare*. With a project
 * selected it shows what that project uses, its copy or the default, with
 * *Customize for …* or *Use default*; with All projects it edits the default,
 * with *Reset to Task Lite’s version*.
 */
export function AgentFileView({
  fileKey,
  project,
  projectName,
  mode,
  onClose,
}: {
  fileKey: string;
  project: string | null;
  projectName: string | null;
  mode: FileViewMode;
  onClose: () => void;
}) {
  const q = project ? { project } : {};
  const query = useQuery({
    queryKey: queryKeys.agentFile(fileKey, q),
    queryFn: () => apiClient['agentFiles.get']({ params: { key: fileKey }, query: q }),
  });
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <section
      ref={ref}
      className="settings-sec"
      aria-labelledby="afv-title"
      data-agent-file-view={fileKey}
    >
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
            mode={mode}
            onClose={onClose}
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
  mode,
  onClose,
}: {
  detail: AgentFileDetail;
  project: string | null;
  projectName: string | null;
  mode: FileViewMode;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const noteId = useId();
  const compareId = useId();
  const versions = useMemo(() => versionsOf(d), [d]);
  const copy = project ? currentOf(versions, 'project') : undefined;
  const dflt = defaultOf(versions);
  const edited = !!currentOf(versions, 'service');
  const using = copy ?? dflt;
  const target: EditableAgentFileLayer = project ? 'project' : 'service';
  const pName = projectName ?? project ?? '';
  const label = (v: Version) => `${versionLabel(v, pName)}${v === using ? ' (in use)' : ''}`;
  const byId = (id: string) => versions.find((v) => v.id === id);

  /** What changed: a project copy older than the default, or a default older than Task Lite's version. */
  const outdated = useMemo(() => {
    if (project) {
      const o = copyOutdated(d, versions);
      return o && copy && dflt ? { ...o, mine: copy, theirs: dflt } : null;
    }
    const flag = d.bundled_updated;
    if (!flag || flag.edited_layer !== 'service') return null;
    const to = byId(flag.to_version_id);
    const mine = currentOf(versions, 'service');
    return to && mine
      ? {
          from: flag.from_version_id ? byId(flag.from_version_id) : undefined,
          to,
          mine,
          theirs: to,
        }
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, versions, project]);

  const history = useMemo(
    () => (copy ? versions.filter((v) => v.layer === 'project') : defaultHistory(versions)),
    [versions, copy],
  );

  const firstDiff =
    mode === 'changed' && outdated?.from && outdated.to
      ? { from: outdated.from.id, to: outdated.to.id }
      : null;
  const [raw, setRaw] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ from: string; to: string } | null>(firstDiff);
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);
  const key = queryKeys.family('agentFiles');
  const switchToDefault = useSwitchToDefault();
  const resetDefault = useResetDefault();

  const openEditor = () => {
    const base = (project ? copy : currentOf(versions, 'service')) ?? dflt;
    setViewing(null);
    setDiff(null);
    setNote('');
    setNoteError(false);
    setEditing({
      layer: target,
      expected: d.layers[target]?.current_version_no ?? 0,
      initial: base?.content ?? '',
      conflict: null,
    });
  };

  // *Customize for …* and *Edit* in the list open the view straight in the editor.
  const opened = useRef(false);
  useEffect(() => {
    if (mode === 'edit' && !opened.current) {
      opened.current = true;
      openEditor();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const what = project ? `${possessive(pName)} copy of ${d.name}` : `the default ${d.name}`;

  const save = async (content: string): Promise<boolean> => {
    if (!editing) return false;
    if (note.trim() === '') {
      setNoteError(true);
      document.getElementById(noteId)?.focus();
      return false;
    }
    const layer = editing.layer;
    const creating = editing.expected === 0;
    try {
      const out = await runOwnerMutation(
        () =>
          apiClient['agentFiles.put']({
            params: { key: d.key },
            body: {
              layer,
              ...(layer === 'project' && project ? { project } : {}),
              content,
              expected_version: editing.expected,
              note: note.trim(),
            },
          }),
        {
          success: (r) =>
            layer === 'project' && creating
              ? `Customized ${d.name} for ${pName}. Only ${possessive(pName)} agents get this copy.`
              : `Saved ${what} (v${r.file.layers[layer]?.current_version_no ?? ''}).`,
          refetch: [key],
        },
      );
      if (!out) {
        // A conflict: the latest is refetched; keep the owner's text and say what changed.
        const fresh = qc.getQueryData<AgentFileDetail>(
          queryKeys.agentFile(d.key, project ? { project } : {}),
        );
        const now = fresh?.layers[layer]?.current_version_no ?? 0;
        setEditing({
          ...editing,
          expected: now,
          conflict: `${what[0]!.toUpperCase()}${what.slice(1)} changed since you opened it (now v${now}). Save again to replace it with your text, or cancel to see the latest.`,
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

  const shown = (viewing && byId(viewing)) || using || null;
  const openDiff = (from: Version | undefined, to: Version | undefined) => {
    if (!from || !to) return;
    setEditing(null);
    setDiff({ from: from.id, to: to.id });
  };

  const usingLine = project
    ? copy
      ? `${possessive(pName)} agents use ${possessive(pName)} copy.`
      : `${possessive(pName)} agents use the default${edited ? ' (edited)' : ''}.`
    : edited
      ? 'Every project uses this default, unless it has its own copy.'
      : 'Every project uses Task Lite’s version, unless it has its own copy.';

  return (
    <div className="card afv">
      <div className="afvhead row wrap">
        <h2 id="afv-title" className="mono">
          {d.name}
        </h2>
        <span className="src">{d.kind === 'skill' ? 'Skill' : 'AGENTS.md / CLAUDE.md block'}</span>
        {project ? (
          copy ? (
            <Chip kind="info">{possessive(pName)} copy</Chip>
          ) : (
            <Chip>Default{edited ? ' (edited)' : ''}</Chip>
          )
        ) : (
          <Chip kind={edited ? 'info' : 'neutral'}>
            {edited ? 'Edited' : 'Task Lite’s version'}
          </Chip>
        )}
        <span className="grow" />
        <IconButton icon="x" aria-label={`Close ${d.name}`} bare onClick={onClose} />
      </div>
      <div className="src afuse">{usingLine}</div>

      {outdated && (
        <Callout tone="warn" className="afflag">
          <div data-default-changed-callout="">
            {project ? (
              <>
                <b>The default changed since {possessive(pName)} copy was made.</b>{' '}
                {possessive(pName)} agents still get its copy. Compare, then edit the copy to take
                what you need, or use the default.
              </>
            ) : (
              <>
                <b>Task Lite’s version changed since the default was edited.</b> Projects still get
                your edited default. Compare, then edit it to take what you need, or reset it.
              </>
            )}
          </div>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            {outdated.from && outdated.to && (
              <Button size="sm" onClick={() => openDiff(outdated.from, outdated.to)}>
                {project ? 'What changed in the default' : 'What Task Lite changed'}
              </Button>
            )}
            <Button size="sm" onClick={() => openDiff(outdated.theirs, outdated.mine)}>
              {project
                ? `The default → ${possessive(pName)} copy`
                : 'Task Lite’s version → the default'}
            </Button>
          </div>
        </Callout>
      )}

      <div className="aftools row wrap">
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
        {!editing &&
          (project && !copy ? (
            <Button size="sm" variant="primary" icon="pencil" onClick={openEditor}>
              Customize for {pName}
            </Button>
          ) : (
            <Button size="sm" icon="pencil" onClick={openEditor}>
              Edit
            </Button>
          ))}
        {!editing && project && copy && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setViewing(null);
              setDiff(null);
              void switchToDefault(d, project, pName);
            }}
          >
            Use default
          </Button>
        )}
        {!editing && !project && edited && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setViewing(null);
              setDiff(null);
              void resetDefault(d);
            }}
          >
            Reset to Task Lite’s version
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          History ({history.length})
        </Button>
        {shown && versions.length > 1 && (
          <span className="row" style={{ gap: 6 }}>
            <label htmlFor={compareId} className="src">
              Compare with
            </label>
            <select
              id={compareId}
              value={diff && diff.to === shown.id ? diff.from : ''}
              onChange={(e) => {
                setEditing(null);
                setDiff(e.target.value ? { from: e.target.value, to: shown.id } : null);
              }}
            >
              <option value="">Choose a version…</option>
              {project && copy && dflt && shown.id !== dflt.id && (
                <option value={dflt.id}>The default ({versionLabel(dflt, pName)})</option>
              )}
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
              {editing.layer === 'project'
                ? editing.expected === 0
                  ? `A new copy for ${pName}, starting from the default. Only ${possessive(pName)} agents get it; other projects keep the default.`
                  : `Editing ${possessive(pName)} copy (replaces v${editing.expected}). Saving adds a version; older ones stay in History.`
                : `Editing the default, for every project without its own copy${editing.expected > 0 ? ` (replaces v${editing.expected})` : ', starting from Task Lite’s version'}. Saving adds a version; older ones stay in History.`}
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
                Close comparison
              </Button>
            </div>
            <DiffView
              from={byId(diff.from)!.content}
              to={byId(diff.to)!.content}
              label={`Compare ${label(byId(diff.from)!)} with ${label(byId(diff.to)!)}`}
            />
          </div>
        ) : shown ? (
          <>
            <div className="src afmeta" title={isoTitle(shown.created_at)}>
              {versionLabel(shown, pName)} · {shown.author} · {formatStamp(shown.created_at)}
              {shown.note && <> · “{shown.note}”</>}
            </div>
            {viewing && shown !== using && (
              <Callout>
                <div className="row wrap">
                  <span className="grow">
                    Viewing {versionLabel(shown, pName)}, an earlier version. It isn’t in use.
                  </span>
                  <Button size="sm" onClick={() => setViewing(null)}>
                    Back to the one in use
                  </Button>
                </div>
              </Callout>
            )}
            <AgentText text={shown.content} raw={raw} label={`${d.name}, ${label(shown)}`} />
            {project && !copy && (
              <div className="src afuse">
                To change it for every project, edit the default in{' '}
                <Link to={paths.agentFiles({ project: 'all', file: d.key })}>All projects</Link>.
              </div>
            )}
          </>
        ) : null}
      </div>

      {showHistory && (
        <div
          className="afhist"
          role="region"
          aria-label={copy ? `${possessive(pName)} copy history` : 'Default history'}
        >
          <h3>{copy ? `${possessive(pName)} copy history` : 'Default history'}</h3>
          {copy && <div className="src">Earlier copies and the default stay in Compare.</div>}
          <ol>
            {history.map((v, i) => {
              const prev = history[i + 1];
              return (
                <li key={v.id} data-version={`${v.layer}-${v.version_no}`}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <b>{versionLabel(v, pName)}</b>
                    {v === using && <Chip kind="ok">In use</Chip>}
                    <span className="src" title={isoTitle(v.created_at)}>
                      {v.author} · {formatAgo(v.created_at)}
                    </span>
                    <span className="grow" />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`View ${versionLabel(v, pName)}`}
                      onClick={() => {
                        setEditing(null);
                        setDiff(null);
                        setViewing(v.id);
                      }}
                    >
                      View
                    </Button>
                    {prev && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Compare ${versionLabel(v, pName)} with the one before`}
                        onClick={() => openDiff(prev, v)}
                      >
                        Compare with the one before
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
