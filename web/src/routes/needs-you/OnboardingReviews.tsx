import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { OnboardingSession } from '@docket/shared';
import { Button, Card, CardHeader } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { HelpLink } from '../../help/HelpLink';
import { InstallDialog } from '../agent-files/AgentInstall';

const agentOf = (startedBy: string) => startedBy.split(' · ')[0] ?? startedBy;

/**
 * The onboarding review cards (UI_SPEC §6.7d; FR-139; decision 31): one per
 * onboarding ready for review, "<Project> was set up by <agent> · review".
 * The counts link to filtered views (Work with only the items the session
 * created or enriched; Settings for documents and decisions; the proposal),
 * then the agent's summary and questions, *Install agent files* (B25's
 * install for that project) and *Mark reviewed*.
 */
export function OnboardingReviews({ sessions }: { sessions: readonly OnboardingSession[] }) {
  if (sessions.length === 0) return null;
  return (
    <div className="mb" data-card="onboarding-reviews">
      {sessions.map((s) => (
        <OnboardingCard key={s.id} session={s} />
      ))}
    </div>
  );
}

function OnboardingCard({ session: s }: { session: OnboardingSession }) {
  const qc = useQueryClient();
  const { scope, setScope } = useShell();
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const agent = agentOf(s.started_by);
  const c = s.changes;
  /** Work shows the shell's scope: follow the card's project unless All projects already covers it. */
  const followProject = () => {
    if (scope !== 'all' && scope !== s.project) setScope(s.project);
  };
  const work = (change: 'created' | 'enriched') =>
    paths.work({ layout: 'list', onboarding: s.id, onboarding_change: change });
  const markReviewed = async () => {
    setBusy(true);
    try {
      await runOwnerMutation(() => apiClient['onboarding.reviewed']({ params: { id: s.id } }), {
        success: `Marked the onboarding of ${s.project_name} reviewed.`,
        refetch: [queryKeys.needsYou({ scope }), queryKeys.bootstrap()],
      });
      await qc.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t mark it reviewed. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const titleId = `onb-${s.id}`;
  return (
    <Card className="onb-card" data-onboarding={s.id}>
      <CardHeader
        title={
          <span id={titleId}>
            {s.project_name} was set up by {agent} · review
          </span>
        }
        extra={<HelpLink anchor="needs-you.onboarding" />}
      />
      <div className="pad" style={{ paddingTop: 0 }}>
        <ul className="onb-counts" aria-label="What the onboarding changed">
          <li>
            <Link to={work('created')} onClick={followProject} data-onb-link="created">
              <b>{c.created}</b> created
            </Link>
          </li>
          <li>
            <Link to={work('enriched')} onClick={followProject} data-onb-link="enriched">
              <b>{c.enriched}</b> enriched
            </Link>
          </li>
          <li>
            <Link to={paths.settings()} data-onb-link="documents">
              <b>{c.documents}</b> {c.documents === 1 ? 'document' : 'documents'}
            </Link>
          </li>
          <li>
            <Link to={paths.settings()} data-onb-link="decisions">
              <b>{c.decisions}</b> {c.decisions === 1 ? 'decision' : 'decisions'}
            </Link>
          </li>
          <li>
            <b>{c.proposals}</b> {c.proposals === 1 ? 'proposal' : 'proposals'}
          </li>
        </ul>
        {s.summary && <p className="onb-summary">{s.summary}</p>}
        {s.questions.length > 0 && (
          <>
            <div className="src">{plural(s.questions.length, 'open question')}</div>
            <ul className="onb-questions">
              {s.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </>
        )}
        <div className="src">
          {s.workflow_proposal_id ? (
            <>
              Workflow notes proposed.{' '}
              <Link
                to={`${paths.agentFiles({ project: s.project })}#proposals`}
                data-onb-link="workflow"
              >
                Review the proposal
              </Link>
            </>
          ) : (
            'No Workflow notes proposed.'
          )}
        </div>
      </div>
      <div className="cardfoot">
        <span className="src">
          {plural(c.created + c.enriched, 'item')} in {s.project} · nothing was made Ready
        </span>
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" onClick={() => setInstalling(true)} aria-describedby={titleId}>
            Install agent files
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void markReviewed()}
            aria-describedby={titleId}
          >
            Mark reviewed
          </Button>
        </div>
      </div>
      {installing && (
        <InstallDialog
          project={s.project}
          projectName={s.project_name}
          onClose={() => setInstalling(false)}
        />
      )}
    </Card>
  );
}
