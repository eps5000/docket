import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { JiraImport, JiraReport } from '@docket/shared';
import { Button, Callout, Dialog, DialogCancel, SegmentedControl } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { HelpLink } from '../../help/HelpLink';

type Step = 1 | 2 | 3;

/** A project the import can go into: only empty ones are offered. */
export interface ImportTargetProject {
  key: string;
  name: string;
  items: number;
}

const POLL_MS = 400;

/** "12.4 MB", "980 KB", "312 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return plural(bytes, 'byte');
}

/** Items the import creates: the type rows that aren't work steps or skips. */
export function itemCount(report: JiraReport): number {
  return report.mapping
    .filter(
      (m) =>
        m.jira.startsWith('Type: ') && m.task_lite !== 'Work step' && m.task_lite !== 'Skipped',
    )
    .reduce((n, m) => n + m.count, 0);
}

function progressLine(i: JiraImport): string {
  const p = i.progress;
  if (!p) return i.state === 'committing' ? 'Importing…' : 'Starting…';
  const of = p.total === null ? '' : ` of ${p.total}`;
  switch (p.phase) {
    case 'reading':
      return p.done === 0 && p.total === null
        ? 'Signing in to Jira…'
        : `Reading ${p.done}${of} issues…`;
    case 'mapping':
      return `Reading comments and mapping ${p.total ?? ''} issues…`.replace('  ', ' ');
    case 'importing':
      return 'Importing…';
    case 'attachments':
      return p.total === 0 ? 'Importing…' : `Downloading attachments ${p.done}${of}`;
  }
}

function errorText(err: unknown): string {
  const message = (err as { message?: string } | null)?.message;
  return message && message.trim() !== '' ? message : 'Something went wrong. Try again.';
}

/**
 * Jira import (UI_SPEC §9.2; BUILD_SPEC §9): three steps, "1 Connect · 2
 * Review · 3 Import", with *Back* on step 2.
 *
 * 1. **Connect:** site, email, API token, Jira project key and the target
 *    (a new project, or an existing empty one). *Run dry run* starts the
 *    server's read; the dialog polls it ("Reading 140 of 512 issues…") and
 *    offers *Cancel*. Errors show inline.
 * 2. **Review report:** summary tiles, the mapping table, the lossy items,
 *    cycles, the fields used, *Download report (JSON)*, and *Import n items*.
 * 3. **Import:** progress, then the result and *Open project*.
 *
 * The API token is cleared from the form as soon as the dry run is sent and
 * never shown again; the server holds it for the session only. Closing the
 * dialog before the import cancels the session (and drops the token).
 */
export function JiraImportDialog({
  onClose,
  projects = [],
}: {
  onClose: () => void;
  projects?: readonly ImportTargetProject[];
}) {
  const ids = {
    site: useId(),
    email: useId(),
    token: useId(),
    key: useId(),
    newKey: useId(),
    newName: useId(),
    existing: useId(),
    lossy: useId(),
  };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { setScope } = useShell();
  const empty = projects.filter((p) => p.items === 0);

  const [stepChoice, setStep] = useState<Step>(1);
  const [site, setSite] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [jiraKey, setJiraKey] = useState('');
  const [targetKind, setTargetKind] = useState<'new' | 'existing'>('new');
  const [newKey, setNewKey] = useState('');
  const [newName, setNewName] = useState('');
  const [existing, setExisting] = useState(empty[0]?.key ?? '');
  const [importId, setImportId] = useState<string | null>(null);
  const [actionError, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.jiraImport(importId ?? 'none'),
    queryFn: async () => (await apiClient['jira.get']({ params: { id: importId! } })).import,
    enabled: importId !== null,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === 'running' || state === 'committing' ? POLL_MS : false;
    },
  });
  const current = importId ? query.data : undefined;

  // A finished dry run shows the report; a failed one shows its error on the form.
  const step: Step = stepChoice === 1 && current?.state === 'ready' ? 2 : stepChoice;
  const error =
    actionError ??
    (current?.state === 'failed' ? (current.error ?? 'The dry run failed. Try again.') : null);
  const committedNow = current?.state === 'committed';
  useEffect(() => {
    if (committedNow) void qc.invalidateQueries({ queryKey: queryKeys.all });
  }, [committedNow, qc]);

  // Leaving before the import drops the session, and with it the token.
  const live = useRef<{ id: string | null; state: JiraImport['state'] | undefined }>({
    id: null,
    state: undefined,
  });
  useEffect(() => {
    live.current = { id: importId, state: current?.state };
  });
  useEffect(
    () => () => {
      const { id, state } = live.current;
      if (id && (state === undefined || state === 'running' || state === 'ready')) {
        void apiClient['jira.cancel']({ params: { id }, body: {} }).catch(() => {});
      }
    },
    [],
  );

  const cancelSession = async () => {
    const id = importId;
    setImportId(null);
    if (id) await apiClient['jira.cancel']({ params: { id }, body: {} }).catch(() => {});
  };

  const runDryRun = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const apiToken = token;
    // The token leaves the form now; it is never shown again.
    setToken('');
    try {
      const res = await apiClient['jira.dryRun']({
        body: {
          site_url: site.trim(),
          email: email.trim(),
          api_token: apiToken,
          jira_project: jiraKey.trim().toUpperCase(),
          target:
            targetKind === 'new'
              ? { kind: 'new', key: newKey.trim().toUpperCase(), name: newName.trim() }
              : { kind: 'existing', key: existing },
        },
      });
      qc.setQueryData(queryKeys.jiraImport(res.import.import_id), res.import);
      setImportId(res.import.import_id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!importId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient['jira.commit']({ params: { id: importId }, body: {} });
      qc.setQueryData(queryKeys.jiraImport(importId), res.import);
      setStep(3);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const back = async () => {
    await cancelSession();
    setError(null);
    setStep(1);
  };

  const close = () => {
    onClose();
  };

  const running = step === 1 && current?.state === 'running';
  const report = current?.report ?? null;
  const committed = current?.state === 'committed' ? current : null;
  const canRun =
    !busy &&
    !running &&
    site.trim() !== '' &&
    email.trim() !== '' &&
    token !== '' &&
    jiraKey.trim() !== '' &&
    (targetKind === 'new' ? newKey.trim() !== '' && newName.trim() !== '' : existing !== '');

  const openProject = () => {
    if (!committed?.result) return;
    setScope(committed.result.project);
    navigate('/work');
    onClose();
  };

  const download = () => {
    if (!report || !current) return;
    const blob = new Blob(
      [
        JSON.stringify(
          { import_id: current.import_id, jira_project: current.jira_project, report },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jira-dry-run-${current.jira_project}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Dialog
      title="Import from Jira"
      className="jira-import"
      onClose={close}
      footer={
        <>
          {step === 2 && <Button onClick={() => void back()}>Back</Button>}
          {step === 3 ? (
            <>
              <Button onClick={close} disabled={!committed}>
                Close
              </Button>
              <Button variant="primary" disabled={!committed} onClick={openProject}>
                Open project
              </Button>
            </>
          ) : running ? (
            <Button onClick={() => void cancelSession()}>Cancel</Button>
          ) : (
            <DialogCancel onClick={close} />
          )}
          {step === 1 && !running && (
            <Button variant="primary" type="submit" form="jira-connect" disabled={!canRun}>
              Run dry run
            </Button>
          )}
          {step === 2 && report && (
            <Button variant="primary" disabled={busy} onClick={() => void runImport()}>
              Import {plural(itemCount(report), 'item')}
            </Button>
          )}
        </>
      }
    >
      <div className="withhelp jira-stephead">
        <ol className="steps" aria-label="Steps">
          {(['Connect', 'Review', 'Import'] as const).map((s, i) => (
            <li key={s} aria-current={step === i + 1 ? 'step' : undefined}>
              {i + 1} {s}
            </li>
          ))}
        </ol>
        <HelpLink anchor="jira.import" />
      </div>

      {step === 1 && (
        <form
          id="jira-connect"
          onSubmit={(e) => void runDryRun(e)}
          aria-busy={running || undefined}
        >
          <fieldset disabled={running || busy} className="jira-fields">
            <label className="f" htmlFor={ids.site}>
              Jira site
            </label>
            <input
              id={ids.site}
              className="input"
              placeholder="https://yoursite.atlassian.net"
              autoComplete="off"
              value={site}
              onChange={(e) => setSite(e.target.value)}
            />
            <label className="f" htmlFor={ids.email}>
              Email
            </label>
            <input
              id={ids.email}
              className="input"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label className="f" htmlFor={ids.token}>
              API token
            </label>
            <input
              id={ids.token}
              className="input"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <div className="src">Used for this import only. Not saved.</div>
            <label className="f" htmlFor={ids.key}>
              Jira project key
            </label>
            <input
              id={ids.key}
              className="input mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="ABC"
              value={jiraKey}
              onChange={(e) => setJiraKey(e.target.value.toUpperCase())}
            />
            <span className="f">Import into</span>
            <SegmentedControl
              label="Import into"
              options={[
                { key: 'new', label: 'New project' },
                { key: 'existing', label: 'Existing empty project' },
              ]}
              value={targetKind}
              onChange={setTargetKind}
            />
            {targetKind === 'new' ? (
              <div className="jira-target">
                <div>
                  <label className="f" htmlFor={ids.newKey}>
                    Key
                  </label>
                  <input
                    id={ids.newKey}
                    className="input mono"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={5}
                    placeholder="ABC"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
                  />
                </div>
                <div className="grow">
                  <label className="f" htmlFor={ids.newName}>
                    Name
                  </label>
                  <input
                    id={ids.newName}
                    className="input"
                    autoComplete="off"
                    maxLength={80}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="jira-target">
                <div className="grow">
                  <label className="f" htmlFor={ids.existing}>
                    Project
                  </label>
                  <select
                    id={ids.existing}
                    className="input"
                    value={existing}
                    onChange={(e) => setExisting(e.target.value)}
                  >
                    {empty.length === 0 && <option value="">No empty projects</option>}
                    {empty.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </fieldset>
          {running && current && (
            <p className="jira-progress" role="status">
              {progressLine(current)}
            </p>
          )}
          {error && (
            <Callout tone="bad" role="alert" className="jira-error">
              {error}
            </Callout>
          )}
        </form>
      )}

      {step === 2 && report && (
        <ReportView report={report} lossyId={ids.lossy} onDownload={download} />
      )}
      {step === 2 && error && (
        <Callout tone="bad" role="alert" className="jira-error">
          {error}
        </Callout>
      )}

      {step === 3 && current && (
        <div>
          {committed?.result ? (
            <ImportResult result={committed.result} />
          ) : (
            <p className="jira-progress" role="status">
              {progressLine(current)}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ReportView({
  report,
  lossyId,
  onDownload,
}: {
  report: JiraReport;
  lossyId: string;
  onDownload: () => void;
}) {
  const { totals } = report;
  const tiles: [string, string][] = [
    [String(totals.issues), totals.issues === 1 ? 'issue' : 'issues'],
    [String(totals.would_import), 'would import'],
    [String(totals.skipped), 'skipped'],
    [String(totals.lossy), 'lossy'],
    [formatBytes(report.attachments.bytes), plural(report.attachments.count, 'attachment')],
  ];
  return (
    <div className="jira-report">
      <ul className="jira-tiles" aria-label="Dry-run summary">
        {tiles.map(([n, label]) => (
          <li key={label}>
            <b>{n}</b>
            <span>{label}</span>
          </li>
        ))}
      </ul>

      <h3>Mapping</h3>
      <table className="jira-mapping">
        <thead>
          <tr>
            <th scope="col">Jira</th>
            <th scope="col">Docket</th>
            <th scope="col" className="num">
              Count
            </th>
            <th scope="col" className="num">
              Lossy
            </th>
          </tr>
        </thead>
        <tbody>
          {report.mapping.map((m) => (
            <tr key={`${m.jira}→${m.task_lite}`}>
              <td>{m.jira}</td>
              <td>{m.task_lite}</td>
              <td className="num">{m.count}</td>
              <td className="num">{m.lossy > 0 ? m.lossy : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="jira-lossy">
        <summary>By field ({report.fields.length})</summary>
        <table className="jira-mapping">
          <thead>
            <tr>
              <th scope="col">Jira field</th>
              <th scope="col" className="num">
                Mapped
              </th>
              <th scope="col" className="num">
                Skipped
              </th>
              <th scope="col" className="num">
                Lossy
              </th>
            </tr>
          </thead>
          <tbody>
            {report.fields.map((f) => (
              <tr key={f.field}>
                <td>{f.field}</td>
                <td className="num">{f.mapped}</td>
                <td className="num">{f.skipped > 0 ? f.skipped : '—'}</td>
                <td className="num">{f.lossy > 0 ? f.lossy : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {report.lossy_items.length > 0 && (
        <details className="jira-lossy">
          <summary id={lossyId}>Lossy items ({report.lossy_items.length})</summary>
          <ul aria-labelledby={lossyId}>
            {report.lossy_items.map((l) => (
              <li key={l.key}>
                <span className="mono">{l.key}</span> <b>{l.title}</b>
                <div className="src">{l.reason}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.attachments.skipped.length > 0 && (
        <>
          <h3>Attachments skipped</h3>
          <ul className="jira-list">
            {report.attachments.skipped.map((a) => (
              <li key={`${a.key}/${a.name}`}>
                <span className="mono">{a.key}</span> {a.name}: {a.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      {report.cycles.length > 0 && (
        <>
          <h3>Cycles found</h3>
          <p className="src">Imported as is. They’ll show under Problems.</p>
          <ul className="jira-list">
            {report.cycles.map((c) => (
              <li key={c.join()} className="mono">
                {[...c, c[0]].join(' → ')}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Fields used</h3>
      <ul className="jira-list">
        {report.fields_used.map((f) => (
          <li key={f.field}>
            {f.field} →{' '}
            <span className={f.jira_field ? 'mono' : undefined}>{f.jira_field ?? 'not found'}</span>
          </li>
        ))}
      </ul>

      <Button size="sm" onClick={onDownload}>
        Download report (JSON)
      </Button>
    </div>
  );
}

function ImportResult({ result }: { result: NonNullable<JiraImport['result']> }) {
  const failed = result.failed_attachments;
  return (
    <div role="status">
      <p>
        Imported {plural(result.imported, 'item')} into <b>{result.project}</b>.
        {failed.length > 0 && ` ${plural(failed.length, 'attachment')} failed (listed).`} The report
        is saved in the project’s documents.
      </p>
      {failed.length > 0 && (
        <ul className="jira-list">
          {failed.map((f) => (
            <li key={f.name}>
              {f.name}: {f.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
