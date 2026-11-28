import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ItemDetailResponse, ItemGithubResponse, ItemPr } from '@docket/shared';
import { Chip, Section, type ChipKind } from '../../../components/kit';
import {
  CiPhases,
  safeGithubBranchUrl,
  safeGithubPrUrl,
} from '../../../components/kit/WorkActivity';
import { apiClient } from '../../../app/queryClient';
import { HelpLink } from '../../../help/HelpLink';
import { queryKeys } from '../../../lib/api';
import { formatAgo, formatStamp, isoTitle, plural } from '../../../lib/format';

const STATE: Record<ItemPr['state'], { kind: ChipKind; label: string }> = {
  open: { kind: 'info', label: 'Open' },
  merged: { kind: 'ok', label: '✓ Merged' },
  closed: { kind: 'neutral', label: 'Closed' },
};

const CI: Record<ItemPr['ci'], { kind: ChipKind; label: string }> = {
  passed: { kind: 'ok', label: 'PR checks passed' },
  failed: { kind: 'bad', label: 'PR checks failed' },
  pending: { kind: 'warn', label: 'PR checks running' },
  none: { kind: 'neutral', label: 'No PR checks' },
};

/** Opens outside Docket, and says so to assistive tech. */
function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <span className="sr"> (opens GitHub)</span>
    </a>
  );
}

function PrLine({ pr, stale }: { pr: ItemPr; stale: boolean }) {
  const safePr = safeGithubPrUrl(pr.repo, pr.number);
  const safeBranch = safeGithubBranchUrl(pr.repo, pr.branch);
  return (
    <li className="github-pr" data-github-pr={pr.number}>
      <div>
        {safePr ? (
          <Out href={safePr}>
            #{pr.number} {pr.title}
          </Out>
        ) : (
          <span>
            #{pr.number} {pr.title}
          </span>
        )}
      </div>
      <div className="row wrap github-facts">
        <Chip kind={STATE[pr.state].kind}>{STATE[pr.state].label}</Chip>
        {pr.draft && pr.state === 'open' && <Chip>Draft</Chip>}
        {safePr ? (
          <Out href={`${safePr}/checks`}>
            <Chip kind={CI[pr.ci].kind}>{stale ? 'PR checks out of date' : CI[pr.ci].label}</Chip>
          </Out>
        ) : (
          <Chip>PR checks unavailable</Chip>
        )}
        {pr.merged_at && (
          <span className="src" title={isoTitle(pr.merged_at)}>
            Merged {formatStamp(pr.merged_at)}
          </span>
        )}
      </div>
      <div className="row wrap github-facts" aria-label="Workflow runs">
        <CiPhases repo={pr.repo} runs={pr.workflow_runs ?? []} stale={stale} />
      </div>
      <div className="src github-branch">
        {safeBranch ? (
          <Out href={safeBranch}>
            <span className="mono">{pr.branch}</span>
          </Out>
        ) : (
          <span className="mono">{pr.branch}</span>
        )}
      </div>
    </li>
  );
}

function summaryOf(d: ItemGithubResponse): string {
  if (d.primary.length > 0) return plural(d.primary.length, 'pull request');
  if (d.related.length > 0) return `${d.related.length} related`;
  return d.naming ? 'branch name' : 'nothing linked';
}

/**
 * The ticket's GitHub panel (owner decision 49; UI_SPEC §6.3): its branch, PR,
 * state, CI and merge, each linking out, with Related kept apart and how fresh
 * the data is. Hidden when GitHub is off and there's nothing to show.
 */
export function GitHubSection({ data }: { data: ItemDetailResponse }) {
  const id = data.item.id;
  const query = useQuery({
    queryKey: queryKeys.itemGithub(id),
    queryFn: () => apiClient['items.github']({ params: { id } }),
    // How fresh the data is can change with no event.
    refetchInterval: 60_000,
  });
  const d = query.data;
  if (!d) return null;
  const hasLinks = d.primary.length + d.related.length > 0;
  if (!d.enabled && !hasLinks && !d.naming) return null;
  return (
    <Section
      sectionKey="github"
      title="GitHub"
      summary={summaryOf(d)}
      extraHead={<HelpLink anchor="item.github" />}
    >
      {d.naming && (
        <p className="github-naming" data-github-naming>
          <Chip kind="warn">Branch name</Chip>{' '}
          <span className="mono">{d.naming.unnamed.join(', ')}</span>{' '}
          {d.naming.unnamed.length === 1 ? 'doesn’t' : 'don’t'} name {id}. Suggested:{' '}
          <span className="mono">{d.naming.suggested}</span>
        </p>
      )}
      {d.primary.length > 0 && (
        <ul className="github-prs" aria-label="Pull requests for this ticket">
          {d.primary.map((pr) => (
            <PrLine key={pr.url} pr={pr} stale={pr.stale ?? d.stale} />
          ))}
        </ul>
      )}
      {d.primary.length === 0 && d.enabled && (
        <p className="src">No pull request has this ticket’s key in its branch yet.</p>
      )}
      {d.related.length > 0 && (
        <>
          <h4 className="github-h4">Related</h4>
          <p className="src">These mention this ticket, but aren’t its pull request.</p>
          <ul className="github-prs" aria-label="Related pull requests" data-github-related>
            {d.related.map((pr) => (
              <PrLine key={pr.url} pr={pr} stale={pr.stale ?? d.stale} />
            ))}
          </ul>
        </>
      )}
      <p className="src github-fresh" data-github-fresh>
        {d.last_sync_at ? (
          <>
            <span title={isoTitle(d.last_sync_at)}>Synced {formatAgo(d.last_sync_at)}</span>
            {d.stale && (
              <>
                {' '}
                <Chip kind="warn">Out of date</Chip>
              </>
            )}
            {!d.enabled && ' · the GitHub connection is off, so this isn’t updating'}
          </>
        ) : (
          d.enabled && 'Not synced yet.'
        )}
      </p>
    </Section>
  );
}
