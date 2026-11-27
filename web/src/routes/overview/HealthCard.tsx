import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { needsYouProblemActor, type NeedsYouResponse, type WorkspaceRow } from '@docket/shared';
import { Card, CardHeader } from '../../components/kit';
import { formatAgo, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { ProposalsLine } from '../agent-files/Proposals';
import { atRiskSummary, type AtRiskTone } from '../agents/atRisk';
import { MoreProblems } from '../needs-you/ProblemsCard';
import { OverlapsHandled } from '../needs-you/SharedQuestions';

const NO_PROBLEMS: NeedsYouResponse['problems'] = [];

const MARKS: Record<AtRiskTone, string> = { ok: '✓', info: '?', warn: '!' };

function Line({ tone, children }: { tone: AtRiskTone; children: ReactNode }) {
  return (
    <li className={`ov-hl ${tone}`} data-health={tone}>
      {/* The mark and the words carry the state; colour only repeats it. */}
      <i aria-hidden="true">{MARKS[tone]}</i>
      <span>{children}</span>
    </li>
  );
}

/** The newest backup, or what's wrong with it (decision 41's Problem, when there is one). */
function BackupLine({
  data,
  lastBackupAt,
}: {
  data: NeedsYouResponse;
  lastBackupAt: string | null;
}) {
  const trouble = data.problems.some(
    (p) => p.kind === 'backup_missed' || p.kind === 'extra_backup_failed',
  );
  const text = lastBackupAt ? `Last backup ${formatAgo(lastBackupAt)}` : 'No backup yet';
  return (
    <Line tone={trouble || !lastBackupAt ? 'warn' : 'ok'}>
      <Link to={paths.settings()}>{trouble ? `Backup needs attention. ${text}` : text}</Link>
    </Line>
  );
}

/**
 * Health: problems agents are handling stay on one line until opened, then
 * what you acknowledged, backups, and the quiet signals that aren't counted as
 * owner actions (worktrees at risk and who has them, agent file proposals,
 * handled overlaps).
 */
export function HealthCard({
  data,
  lastBackupAt,
  metricsLoaded,
  workspaces,
}: {
  data: NeedsYouResponse;
  lastBackupAt: string | null | undefined;
  metricsLoaded: boolean;
  workspaces: readonly WorkspaceRow[];
}) {
  const atRisk = atRiskSummary(workspaces);
  const agentProblems = data.agent_problems ?? NO_PROBLEMS;
  const acknowledged = data.acknowledged ?? NO_PROBLEMS;
  const mine = data.problems.filter((p) => needsYouProblemActor(p) === 'owner').length;
  return (
    <Card data-card="health" className="ov-health">
      <CardHeader title="Health" />
      <ul className="ov-hlist">
        <Line tone={mine > 0 ? 'warn' : 'ok'}>
          {mine > 0 ? (
            <Link to="#problems">
              {mine === 1 ? '1 problem needs you' : `${mine} problems need you`}
            </Link>
          ) : (
            'No problems need you'
          )}
        </Line>
        {metricsLoaded && <BackupLine data={data} lastBackupAt={lastBackupAt ?? null} />}
        {atRisk && (
          <Line tone={atRisk.tone}>
            <Link to={paths.agents({ section: 'workspaces' })} data-state="workspaces-at-risk">
              {atRisk.text}
            </Link>
          </Line>
        )}
      </ul>
      <MoreProblems
        kind="agents"
        label={`Agents are handling ${plural(agentProblems.length, 'problem')}`}
        problems={agentProblems}
        workspaces={workspaces}
      />
      <MoreProblems
        kind="acknowledged"
        label={`You acknowledged ${plural(acknowledged.length, 'problem')}`}
        problems={acknowledged}
        workspaces={workspaces}
      />
      <div className="ov-quiet">
        <ProposalsLine count={data.agent_file_proposals} />
        <OverlapsHandled handled={data.overlaps_handled} />
        <Link to={paths.agents()}>All runs →</Link>
      </div>
    </Card>
  );
}
