import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  isCalendarDay,
  needsYouCount,
  STATUS_LABELS,
  type BriefResponse,
  type NeedsYouResponse,
} from '@docket/shared';
import { Button, Card, Skeleton } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { useBreadcrumb, useShell } from '../../app/ShellState';
import { NEEDS_YOU_REFRESH_MS } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatAge, formatClock, formatStamp, isoTitle, plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import {
  briefDayText,
  decisionChangeText,
  decisionLink,
  needsYouLines,
  type BriefLine,
} from './briefLines';
import '../screens.css';
import './brief.css';

const waitedText = (since: string) => {
  const age = formatAge(since);
  return /^\d+[smh]$/.test(age) ? `Waiting ${age}` : `Waiting since ${age}`;
};

function Line({
  to,
  id,
  title,
  meta,
  metaTitle,
}: {
  to: string;
  id: string | null;
  title: string;
  meta: ReactNode;
  metaTitle?: string;
}) {
  return (
    <li className="brief-line" data-brief-line={id ?? undefined}>
      <Link to={to} title={id ? `${id} ${title}` : title}>
        {id && <span className="mono">{id}</span>}{' '}
        <span className={id ? 'brief-t' : 'brief-t brief-t-link'}>{title}</span>
      </Link>
      <span className="src brief-meta" title={metaTitle}>
        {meta}
      </span>
    </li>
  );
}

/** "and 5 more", linking to the full list when one exists. */
function More({ count, shown, to }: { count: number; shown: number; to?: string }) {
  const more = count - shown;
  if (more <= 0) return null;
  return (
    <p className="src brief-more">
      {to ? <Link to={to}>and {more} more</Link> : `and ${more} more`}
    </p>
  );
}

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <Card data-brief-section={id}>
      <section aria-labelledby={`brief-${id}`}>
        <div className="sectionhead">
          <h2 id={`brief-${id}`}>{title}</h2>
        </div>
        <div className="brief-body">
          {note && <p className="src brief-note">{note}</p>}
          {children}
        </div>
      </section>
    </Card>
  );
}

function Finished({ data }: { data: BriefResponse }) {
  const { finished } = data;
  return (
    <Section id="finished" title={`What finished · ${finished.count}`}>
      {finished.count === 0 ? (
        <p className="brief-none">No tickets finished on {briefDayText(data.day)}.</p>
      ) : (
        <ul className="brief-list">
          {finished.rows.map((r) => (
            <Line
              key={r.id}
              to={paths.item(r.id)}
              id={r.id}
              title={r.title}
              meta={`Finished ${formatClock(r.closed_at)}`}
              metaTitle={isoTitle(r.closed_at)}
            />
          ))}
        </ul>
      )}
      <More count={finished.count} shown={finished.rows.length} to={paths.work({ show: 'done' })} />
    </Section>
  );
}

function Stuck({ data }: { data: BriefResponse }) {
  const { parked, unowned_blockers: blockers, held } = data.stuck;
  const nothing = parked.count + blockers.count + held.count === 0;
  return (
    <Section
      id="stuck"
      title="What’s stuck"
      note={
        data.day === data.today
          ? undefined
          : 'Shown as it is now. Docket doesn’t keep a day-by-day record of what was stuck.'
      }
    >
      {nothing && <p className="brief-none">Nothing is stuck right now.</p>}
      {parked.count > 0 && (
        <div data-brief-group="parked">
          <h3>Parked longest · {parked.count}</h3>
          <ul className="brief-list">
            {parked.rows.map((r) => (
              <Line
                key={r.id}
                to={paths.item(r.id)}
                id={r.id}
                title={r.title}
                meta={`${waitedText(r.since)}. ${r.next}`}
                metaTitle={isoTitle(r.since)}
              />
            ))}
          </ul>
          <More
            count={parked.count}
            shown={parked.rows.length}
            to={paths.agents({ state: 'parked' })}
          />
        </div>
      )}
      {blockers.count > 0 && (
        <div data-brief-group="unowned">
          <h3>Blockers nobody owns · {blockers.count}</h3>
          <ul className="brief-list">
            {blockers.rows.map((r) => (
              <Line
                key={r.id}
                to={paths.item(r.id)}
                id={r.id}
                title={r.title}
                meta={`${STATUS_LABELS[r.status]}. Holding up ${plural(r.blocks, 'ticket')}.`}
              />
            ))}
          </ul>
          <More count={blockers.count} shown={blockers.rows.length} />
        </div>
      )}
      {held.count > 0 && (
        <div data-brief-group="held">
          <h3>Held by your decision · {held.count}</h3>
          <p className="src brief-note">These are waiting as you decided. Nothing is wrong.</p>
          <ul className="brief-list">
            {held.rows.map((r) => (
              <Line
                key={r.id}
                to={paths.item(r.id)}
                id={r.id}
                title={r.title}
                meta={`Held by “${r.decision_title}”`}
                metaTitle={isoTitle(r.since)}
              />
            ))}
          </ul>
          <More count={held.count} shown={held.rows.length} />
        </div>
      )}
    </Section>
  );
}

const NEEDS_ROWS = 8;

function NeedsYou({ view, past }: { view: NeedsYouResponse; past: boolean }) {
  const lines: BriefLine[] = needsYouLines(view);
  const count = needsYouCount(view);
  return (
    <Section
      id="needs-you"
      title={`What needs you · ${count}`}
      note={past ? 'Shown as it is now.' : undefined}
    >
      {count === 0 ? (
        <p className="brief-none">Nothing needs you.</p>
      ) : (
        <ul className="brief-list">
          {lines.slice(0, NEEDS_ROWS).map((l) => (
            <Line key={l.key} to={l.to} id={l.id} title={l.title} meta={l.meta} />
          ))}
        </ul>
      )}
      <More
        count={count}
        shown={Math.min(count, NEEDS_ROWS)}
        to={`${paths.overview()}#needs-you`}
      />
    </Section>
  );
}

function Decisions({ data }: { data: BriefResponse }) {
  const { decisions } = data;
  return (
    <Section id="decisions" title={`What changed in decisions · ${decisions.count}`}>
      {decisions.count === 0 ? (
        <p className="brief-none">No decisions changed on {briefDayText(data.day)}.</p>
      ) : (
        <ul className="brief-list">
          {decisions.rows.map((d) => (
            <Line
              key={`${d.decision_id}:${d.change}:${d.at}`}
              to={decisionLink(d)}
              id={d.item_id}
              title={d.title}
              meta={`${decisionChangeText(d)} · ${formatStamp(d.at)}`}
              metaTitle={isoTitle(d.at)}
            />
          ))}
        </ul>
      )}
      <More count={decisions.count} shown={decisions.rows.length} />
    </Section>
  );
}

/**
 * The daily brief (`/brief`; owner decision 48; UI_SPEC §6.1b): what finished,
 * what's stuck, what needs you and what changed in decisions, for one day and
 * the current project. Read-only. "What it cost" isn't here until Docket has
 * measured data, and no estimate stands in for it.
 */
export function Brief() {
  const { scope } = useShell();
  useBreadcrumb({
    crumbs: [
      { kind: 'link', text: 'Overview', to: paths.overview() },
      { kind: 'current', text: 'Daily brief' },
    ],
  });
  const [params, setParams] = useSearchParams();
  const asked = params.get('day');
  const day = asked && isCalendarDay(asked) ? asked : undefined;
  const query = { scope, ...(day ? { day } : {}) };
  const brief = useQuery({
    queryKey: queryKeys.brief(query),
    queryFn: () => apiClient['brief.get']({ query }),
    refetchInterval: NEEDS_YOU_REFRESH_MS,
  });
  const needs = useQuery({
    queryKey: queryKeys.needsYou({ scope }),
    queryFn: () => apiClient['needsYou.get']({ query: { scope } }),
    refetchInterval: NEEDS_YOU_REFRESH_MS,
  });
  const choose = (next: string) => {
    setParams(next && next !== brief.data?.today ? { day: next } : {}, { replace: true });
  };
  const shown = brief.data?.day ?? day ?? '';
  return (
    <div className="brief" data-brief-day={brief.data?.day}>
      <p className="src">
        <Link to={paths.overview()}>← Overview</Link>
      </p>
      <div className="ov-head">
        <div className="withhelp wh-h1">
          <h1>Daily brief</h1>
          <HelpLink anchor="overview.brief" />
        </div>
        <div className="brief-day">
          <label htmlFor="brief-day">Day</label>
          <input
            id="brief-day"
            className="input"
            type="date"
            value={shown}
            max={brief.data?.today}
            onChange={(e) => {
              if (isCalendarDay(e.target.value)) choose(e.target.value);
            }}
          />
          <Button size="sm" onClick={() => choose('')}>
            Today
          </Button>
        </div>
      </div>
      {brief.data && (
        <p className="src brief-zone">
          {briefDayText(brief.data.day)}, in {brief.data.timezone}
          {brief.data.day === brief.data.today ? ', so far' : ''}.
        </p>
      )}
      <QueryState query={brief} skeleton={<Skeleton lines={8} label="Loading the brief" />}>
        {(data) => (
          <div className="brief-grid">
            <div className="brief-col">
              <Finished data={data} />
              <Stuck data={data} />
            </div>
            <div className="brief-col">
              {needs.data ? (
                <NeedsYou view={needs.data} past={data.day !== data.today} />
              ) : (
                <Section id="needs-you" title="What needs you">
                  {needs.isError ? (
                    <p className="brief-none" role="status">
                      Couldn’t load this.{' '}
                      <Button size="sm" onClick={() => void needs.refetch()}>
                        Retry
                      </Button>
                    </p>
                  ) : (
                    <Skeleton lines={3} label="Loading what needs you" />
                  )}
                </Section>
              )}
              <Decisions data={data} />
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
