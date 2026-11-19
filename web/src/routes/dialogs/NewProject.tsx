import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  PROJECT_KEY_RE,
  SATISFIED_WHEN,
  SATISFIED_WHEN_LABELS,
  type Project,
  type SatisfiedWhen,
} from '@docket/shared';
import { Button, Callout, Dialog, DialogCancel } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { HelpLink } from '../../help/HelpLink';
import { CopyBlock } from '../agent-files/install-common';

/** The server's colours for a new project, picked from the key (projects.ts). */
const PROJECT_COLORS = ['#3b5bdb', '#d9480f', '#2b8a3e', '#862e9c', '#c2255c', '#0b7285'];
export const defaultColor = (key: string): string =>
  PROJECT_COLORS[[...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % PROJECT_COLORS.length]!;

/** The line to give an agent (UI_SPEC §6.7d). */
export const onboardLine = (key: string) =>
  `Onboard this repo into Docket as project ${key}, using onboard_project.`;

/**
 * *New project* (Settings; UI_SPEC §6.7d; FR-135; decision 31): key (2–5
 * letters, uppercased as you type, checked against the existing keys),
 * name, colour and *Blockers clear when*. After creating, the dialog lands
 * on the project's "What next" choices (B32): *Import from Jira…* (first, so
 * an agent enriches the imported tickets instead of duplicating them),
 * "Onboard it with an agent" (the line to give an agent, and the prompt for
 * clients that support prompts) and *Install agent files*. Creating the
 * first project also switches the scope to it.
 */
export function NewProjectDialog({
  existingKeys,
  onClose,
  onImport,
}: {
  existingKeys: readonly string[];
  onClose: () => void;
  /** Opens the Jira import with the new project as its target. */
  onImport: (key: string) => void;
}) {
  const ids = { key: useId(), name: useId(), color: useId(), rule: useId(), keyHint: useId() };
  const qc = useQueryClient();
  const { setScope } = useShell();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [rule, setRule] = useState<SatisfiedWhen>('done');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Project | null>(null);
  // The first project ever (B32): switch to it once it's created.
  const [first] = useState(existingKeys.length === 0);

  const taken = existingKeys.includes(key);
  const keyProblem =
    key === ''
      ? null
      : !PROJECT_KEY_RE.test(key)
        ? 'Use 2–5 letters.'
        : taken
          ? `${key} is taken. Pick another key.`
          : null;
  const shownColor = color ?? defaultColor(key || 'A');
  const ready = PROJECT_KEY_RE.test(key) && !taken && name.trim() !== '' && !busy;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiClient['projects.create']({
        body: { key, name: name.trim(), color: shownColor, default_satisfied_when: rule },
      });
      setCreated(res.project);
      if (first) setScope(res.project.key);
      await qc.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t create the project. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Dialog
        title={`${created.name} created`}
        onClose={onClose}
        className="newproj"
        footer={
          <>
            {!first && (
              <Button
                onClick={() => {
                  setScope(created.key);
                  onClose();
                }}
              >
                Switch to {created.key}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <div className="row withhelp" style={{ gap: 6 }}>
          <h3 style={{ margin: 0 }}>What next</h3>
          <HelpLink anchor="settings.new-project" />
        </div>
        <ol className="whatnext">
          <li>
            <h4>Import from Jira</h4>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span className="src">
                Tickets in Jira? Import them first, so an agent enriches them instead of duplicating
                them.
              </span>
              <Button size="sm" onClick={() => onImport(created.key)}>
                Import from Jira…
              </Button>
            </div>
          </li>
          <li>
            <h4>Onboard it with an agent</h4>
            <p className="src" style={{ marginTop: 0 }}>
              An agent reads the repo’s specs, plans, tasks and docs, and sets up {created.key} in
              Planning. Nothing is made Ready, and you review it all from one card on Needs you.
            </p>
            <CopyBlock
              text={onboardLine(created.key)}
              label="Give any connected agent this line, in the repo’s folder"
              what="line"
            />
            <CopyBlock
              text={`/mcp__docket__onboard ${created.key}`}
              label="Or run the onboard prompt (Claude Code shown; other clients name it onboard)"
              what="prompt"
            />
          </li>
          <li>
            <h4>Install agent files</h4>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span className="src">
                Put Docket’s AGENTS.md block, skills and connection file into the repo, so agents
                there find Docket.
              </span>
              <Link
                className="btn sm"
                to={paths.agentFiles({ project: created.key })}
                onClick={onClose}
              >
                Install agent files
              </Link>
            </div>
          </li>
        </ol>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      className="newproj"
      footer={
        <>
          <DialogCancel onClick={onClose} />
          <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="newproj-form">
        <div className="jira-target">
          <div>
            <label className="f" htmlFor={ids.key}>
              Key
            </label>
            <input
              id={ids.key}
              className="input mono"
              autoComplete="off"
              spellCheck={false}
              maxLength={5}
              placeholder="GF"
              aria-describedby={ids.keyHint}
              aria-invalid={keyProblem ? true : undefined}
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
            />
          </div>
          <div className="grow">
            <label className="f" htmlFor={ids.name}>
              Name
            </label>
            <input
              id={ids.name}
              className="input"
              autoComplete="off"
              maxLength={100}
              placeholder="Gameflow"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <div id={ids.keyHint} className={keyProblem ? 'src err-text' : 'src'} role="status">
          {keyProblem ?? '2–5 letters. Item IDs start with it, like GF-12.'}
        </div>
        <div className="row" style={{ gap: 16, marginTop: 10, alignItems: 'flex-end' }}>
          <div>
            <label className="f" htmlFor={ids.color}>
              Colour
            </label>
            <input
              id={ids.color}
              type="color"
              className="colorpick"
              value={shownColor}
              onChange={(e) => setColor(e.target.value)}
            />
          </div>
          <div>
            <label className="f" htmlFor={ids.rule}>
              Blockers clear when
            </label>
            <select
              id={ids.rule}
              value={rule}
              onChange={(e) => setRule(e.target.value as SatisfiedWhen)}
            >
              {SATISFIED_WHEN.map((r) => (
                <option key={r} value={r}>
                  {SATISFIED_WHEN_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* Enter submits. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
      {error && (
        <Callout tone="bad" className="mt">
          {error}
        </Callout>
      )}
    </Dialog>
  );
}
