import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  BRANCH_RULES,
  type BranchRule,
  type GithubSettingsResponse,
  type GithubState,
} from '@docket/shared';
import { Button, Card, Chip, Skeleton, type ChipKind } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatAgo, isoTitle } from '../../lib/format';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { errorText } from '../agent-files/install-common';

/** What each connection state says. Always words, never colour alone. */
export const GITHUB_STATUS: Record<GithubState, { kind: ChipKind; label: string; help: string }> = {
  off: {
    kind: 'neutral',
    label: 'Off',
    help: 'Docket isn’t reading GitHub. Everything else works the same.',
  },
  no_repos: {
    kind: 'warn',
    label: 'Needs a repository',
    help: 'Add a repository to a project below.',
  },
  helper_not_running: {
    kind: 'warn',
    label: 'Helper not running',
    help: 'The helper on this computer hasn’t reported in. The steps below set it up or start it.',
  },
  gh_missing: {
    kind: 'bad',
    label: 'GitHub CLI not found',
    help: 'The helper can’t find gh on this computer. Install the GitHub CLI.',
  },
  gh_signed_out: {
    kind: 'warn',
    label: 'gh not signed in',
    help: 'Run gh auth login on this computer. The helper picks it up on its next try.',
  },
  rate_limited: {
    kind: 'warn',
    label: 'Waiting for GitHub’s limit',
    help: 'The helper paused to stay under GitHub’s hourly limit. It resumes on its own.',
  },
  network: {
    kind: 'warn',
    label: 'Can’t reach GitHub',
    help: 'The helper will try again on its own.',
  },
  error: {
    kind: 'bad',
    label: 'Sync failed',
    help: 'Run the helper’s status command on this computer to see why.',
  },
  connected: { kind: 'ok', label: '✓ Connected', help: 'Reading pull requests from GitHub.' },
};

/** The helper's error codes, in words. An unknown code is still shown, so it can be looked up. */
const ERROR_TEXT: Record<string, string> = {
  gh_missing: 'The GitHub CLI isn’t installed',
  gh_signed_out: 'gh isn’t signed in',
  rate_limited: 'GitHub’s hourly limit is close',
  network: 'GitHub couldn’t be reached',
  gh_error: 'gh reported an error',
  collect_failed: 'The helper hit an unexpected error',
  repo_not_found: 'not found, or your gh login can’t see it',
  repo_forbidden: 'your gh login doesn’t have access',
};
export const errorWords = (code: string) => ERROR_TEXT[code] ?? `Error: ${code}`;

const RULE_TEXT: Record<BranchRule, string> = { off: 'Off', warn: 'Warn' };

const STEPS = [
  {
    text: 'Install the GitHub CLI, then sign in. Docket never sees or stores this login.',
    code: 'gh auth login',
  },
  {
    text: 'From a Docket checkout on this computer, install the helper. It doesn’t start yet.',
    code: 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\tools\\docket-sync\\manage.ps1 -Action Install',
  },
  { text: 'Start it.', code: "Start-ScheduledTask -TaskName 'Docket Sync'" },
  {
    text: 'Check it.',
    code: 'node "$env:LOCALAPPDATA\\docket-sync\\app\\docket-sync.mjs" status',
  },
] as const;

/** Installing, starting and checking the helper, for a source that needs no `gh` login. */
export const HELPER_STEPS = STEPS.slice(1);

/**
 * Settings → Connections → GitHub (owner decision 49; UI_SPEC §6.7): off by
 * default. Docket stores no GitHub token and never writes to GitHub. A small
 * helper on this computer reads through the `gh` login already there.
 */
export function GitHubCard({ protectedMode }: { protectedMode: boolean | undefined }) {
  const query = useQuery({
    queryKey: queryKeys.github(),
    queryFn: () => apiClient['github.get']({}),
    // The helper's status is bookkeeping, with no event to refresh on.
    refetchInterval: 60_000,
  });
  return (
    <Card padded data-card="github">
      <div className="withhelp wh-h3">
        <h3 id="settings-github">GitHub</h3>
        <HelpLink anchor="settings.github" />
      </div>
      <p className="src" style={{ marginTop: 4 }}>
        Optional. Shows branches, pull requests and CI on tickets. Docket stores no GitHub token and
        never writes to GitHub.
      </p>
      <QueryState query={query} skeleton={<Skeleton lines={4} label="Loading GitHub settings" />}>
        {(d) => <GitHubBody data={d} protectedMode={protectedMode} />}
      </QueryState>
    </Card>
  );
}

function GitHubBody({
  data,
  protectedMode,
}: {
  data: GithubSettingsResponse;
  protectedMode: boolean | undefined;
}) {
  const qc = useQueryClient();
  // The choice shows at once, and the control stays enabled so keyboard focus stays on it (B34).
  const [pending, setPending] = useState<boolean | null>(null);
  const toggle = async (enabled: boolean) => {
    setPending(enabled);
    try {
      await runOwnerMutation(() => apiClient['github.set']({ body: { enabled } }), {
        success: enabled ? 'GitHub connection is on.' : 'GitHub connection is off.',
        refetch: [queryKeys.github()],
      });
      await qc.invalidateQueries({ queryKey: queryKeys.github() });
    } catch (err) {
      showToast(errorText(err));
    } finally {
      setPending(null);
    }
  };
  const status = GITHUB_STATUS[data.state];
  const showSteps = data.enabled && data.state !== 'connected' && data.state !== 'no_repos';
  return (
    <>
      <label className="overlap-mode" data-github-toggle>
        <input
          type="checkbox"
          checked={pending ?? data.enabled}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="overlap-mode-name">Connect to GitHub</span>
      </label>
      <dl className="kv" data-github-status={data.state}>
        <dt>Status</dt>
        <dd>
          <Chip kind={status.kind}>{status.label}</Chip>
          <div className="src">{status.help}</div>
        </dd>
        {data.enabled && (
          <>
            <dt>Last sync</dt>
            <dd>
              {data.last_sync_at ? (
                <span title={isoTitle(data.last_sync_at)}>{formatAgo(data.last_sync_at)}</span>
              ) : (
                'Never'
              )}
              {data.stale && (
                <>
                  {' '}
                  <Chip kind="warn">Out of date</Chip>
                </>
              )}
            </dd>
            {data.last_error && (
              <>
                <dt>Last error</dt>
                <dd>{errorWords(data.last_error)}</dd>
              </>
            )}
            <dt>Repositories</dt>
            <dd data-github-repos>
              {data.repos.length === 0 ? (
                'None yet'
              ) : (
                <ul className="github-repos">
                  {data.repos.map((r) => (
                    <li key={r.repo}>
                      <span className="mono">{r.repo}</span>
                      <span className="src">
                        {' '}
                        · {r.projects.join(', ')}
                        {r.error ? ` · ${errorWords(r.error)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </>
        )}
      </dl>
      {showSteps && (
        <div data-github-steps>
          <h4 className="github-h4">Connect it</h4>
          {protectedMode && (
            <p className="src">
              Protected mode is on, and the helper has no owner session, so it can’t report to
              Docket. It works with local trust.
            </p>
          )}
          <ol className="github-steps">
            {STEPS.map((step) => (
              <li key={step.code}>
                {step.text}
                <pre className="code" tabIndex={0} aria-label={step.text}>
                  {step.code}
                </pre>
              </li>
            ))}
          </ol>
        </div>
      )}
      <h4 className="github-h4">Projects</h4>
      <p className="src">
        Branches look like <span className="mono">owner/GF-243-short-description</span>. Warn tells
        the agent and shows it on the ticket. It never blocks anything.
      </p>
      <div className="tablewrap">
        <table aria-label="GitHub repository and branch naming per project">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Repository</th>
              <th scope="col">Branch naming</th>
              <th scope="col">Exempt branches</th>
              <th scope="col">
                <span className="sr">Save</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.projects.map((p) => (
              <ProjectRow
                // A saved value from elsewhere resets the row.
                key={`${p.key}|${p.github_repo ?? ''}|${p.branch_rule}|${p.branch_exempt.join(',')}`}
                project={p}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProjectRow({ project: p }: { project: GithubSettingsResponse['projects'][number] }) {
  const qc = useQueryClient();
  const errorId = useId();
  const [repo, setRepo] = useState(p.github_repo ?? '');
  const [rule, setRule] = useState<BranchRule>(p.branch_rule);
  const [exempt, setExempt] = useState(p.branch_exempt.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patterns = exempt
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const dirty =
    repo.trim() !== (p.github_repo ?? '') ||
    rule !== p.branch_rule ||
    patterns.join(',') !== p.branch_exempt.join(',');
  const save = async () => {
    const name = repo.trim();
    if (name && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) {
      setError('Use owner/name, like acme/web-app.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await runOwnerMutation(
        () =>
          apiClient['github.setProject']({
            params: { key: p.key },
            body: { github_repo: name || null, branch_rule: rule, branch_exempt: patterns },
          }),
        { success: `Saved ${p.name}.`, refetch: [queryKeys.github()] },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.github() });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <tr data-github-project={p.key}>
      <th scope="row">{p.name}</th>
      <td>
        <input
          className="input"
          aria-label={`GitHub repository for ${p.name}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder="owner/name"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
        {error && (
          <div id={errorId} className="src github-error" role="alert">
            {error}
          </div>
        )}
      </td>
      <td>
        <select
          aria-label={`Branch naming for ${p.name}`}
          value={rule}
          onChange={(e) => setRule(e.target.value as BranchRule)}
        >
          {BRANCH_RULES.map((value) => (
            <option key={value} value={value}>
              {RULE_TEXT[value]}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          className="input"
          aria-label={`Exempt branch patterns for ${p.name}, separated by commas`}
          value={exempt}
          onChange={(e) => setExempt(e.target.value)}
        />
      </td>
      <td>
        <Button
          size="sm"
          aria-label={`Save ${p.name}`}
          onClick={() => {
            if (saving) return;
            if (dirty) void save();
            else showToast('No changes to save.');
          }}
        >
          Save
        </Button>
      </td>
    </tr>
  );
}
