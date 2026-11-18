import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import {
  INSTALL_CLIENT_LABELS,
  fillsProjectKey,
  isLegacySkillKey,
  mapLegacySkillKey,
  renderAgentsBlock,
  type CreateInstallResponse,
  type Drift,
} from '@docket/shared';
import { Button, Callout, Card, Chip, type ChipKind } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatAgo, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { DiffView } from './DiffView';
import { CopyBlock } from './install-common';
import { possessive, versionsOf } from './model';

/** What a remedy refreshes: drift, the files, the install log, Needs you and the ticket. */
const REFRESH = [
  queryKeys.family('drift'),
  queryKeys.family('agentFiles'),
  queryKeys.family('installs'),
  queryKeys.family('needsYou'),
  queryKeys.family('bootstrap'),
  queryKeys.family('item'),
];

/** Open drift for one project, or every open record (All projects). */
export function useOpenDrift(project: string | null) {
  const query = project ? { project, state: 'open' as const } : { state: 'open' as const };
  return useQuery({
    queryKey: queryKeys.drift(query),
    queryFn: () => apiClient['drift.list']({ query }),
  });
}

/** Open records per file key for one target (a project, or user-wide installs), for the row chips. */
export function driftCounts(
  rows: readonly Drift[] | undefined,
  project: string | null,
): Map<string, Drift> {
  const out = new Map<string, Drift>();
  for (const d of rows ?? [])
    if (d.project === project && !out.has(d.file_key)) out.set(d.file_key, d);
  return out;
}

/** The "changed outside Docket" chip on a file row (UI_SPEC §6.7b-1). */
export function DriftChip({ drift }: { drift: Drift | undefined }) {
  if (!drift) return null;
  return (
    <a href={`#drift-${drift.id}`} className="afchiplink" data-drift-chip="">
      <Chip kind="warn" icon="attention">
        changed outside Docket
      </Chip>
    </a>
  );
}

const CHANGE: Record<Drift['change'], { label: string; kind: ChipKind }> = {
  edited: { label: 'Edited locally', kind: 'warn' },
  missing: { label: 'Missing', kind: 'bad' },
  extra: { label: 'Extra', kind: 'info' },
};

const nameOf = (key: string) => (key.startsWith('skill:') ? key.slice(6) : 'AGENTS.md block');

/**
 * The file Docket ships for a record: an old `tasklite-*` folder an install
 * kept because it was edited locally (B28) is compared with, and adopted as,
 * its `docket-*` file.
 */
const fileKeyOf = (d: Drift) => mapLegacySkillKey(d.file_key);

/**
 * "Changed outside Docket · n" (UI_SPEC §6.7b-1; FR-131, FR-132): each
 * installed file that differs from what Docket sent, with where it is,
 * how it was found, a diff when the text is known, and *Adopt as …*,
 * *Restore Docket's version* and *Keep local*.
 */
export function DriftSection({
  project,
  projects,
  shippedKeys,
}: {
  project: string | null;
  projects: readonly { key: string; short_name: string }[];
  /** The files Docket ships: only those can be adopted. */
  shippedKeys: ReadonlySet<string>;
}) {
  const list = useOpenDrift(project);
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const rows = list.data?.drift ?? [];
  useEffect(() => {
    if (rows.length === 0 || !location.hash.startsWith('#drift')) return;
    const el = document.getElementById(location.hash.slice(1)) ?? ref.current;
    el?.scrollIntoView({ block: 'start' });
  }, [rows.length, location.hash]);
  if (rows.length === 0) return null;
  const nameOfProject = (key: string | null) =>
    key ? (projects.find((p) => p.key === key)?.short_name ?? key) : null;
  return (
    <section
      ref={ref}
      id="drift"
      className="afdrift stack"
      aria-labelledby="afd-title"
      data-drift-section=""
    >
      <div className="withhelp">
        <h2 id="afd-title">
          Changed outside Docket <span className="muted">· {rows.length}</span>
        </h2>
        <HelpLink anchor="problems.agent_files_drift" />
      </div>
      <p className="src aflede">
        These installed files no longer match what Docket sent: someone edited, deleted or added
        them by hand. Every later agent there follows them. Adopt the change, restore Docket’s
        version, or keep it on purpose.
      </p>
      {rows.map((d) => (
        <DriftCard
          key={d.id}
          d={d}
          projectName={nameOfProject(d.project)}
          adoptable={shippedKeys.has(mapLegacySkillKey(d.file_key))}
        />
      ))}
    </section>
  );
}

/** What Docket sent for this record, as installed (the block rendered for the install). */
function useSentText(d: Drift): string | undefined | null {
  const q = d.project ? { project: d.project } : {};
  const file = useQuery({
    queryKey: queryKeys.agentFile(fileKeyOf(d), q),
    queryFn: () => apiClient['agentFiles.get']({ params: { key: fileKeyOf(d) }, query: q }),
    enabled: d.sent_version_id !== null,
  });
  if (d.sent_version_id === null) return null;
  if (!file.data) return undefined;
  const v = versionsOf(file.data).find((x) => x.id === d.sent_version_id);
  if (!v) return null;
  return d.file_key === 'agents_block'
    ? renderAgentsBlock(v.content, fillsProjectKey(d.install.target_kind, d.project))
    : v.content;
}

function DriftCard({
  d,
  projectName,
  adoptable,
}: {
  d: Drift;
  projectName: string | null;
  adoptable: boolean;
}) {
  const qc = useQueryClient();
  const sent = useSentText(d);
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState<CreateInstallResponse | null>(null);
  const name = nameOf(d.file_key);
  const legacy = isLegacySkillKey(d.file_key);
  const target = d.project ? `${possessive(projectName ?? d.project)} copy` : 'the default';
  const where = d.install.path ?? 'where it was installed';
  const how =
    d.found_by.source === 'push_check' ? (
      <>Found by the scheduled check of the push folder</>
    ) : (
      <>
        Reported by{' '}
        <b>
          {d.found_by.client}
          {d.found_by.label ? ` · ${d.found_by.label}` : ''}
        </b>
        {d.found_by.item_id && (
          <>
            {' '}
            on <Link to={paths.item(d.found_by.item_id, 'activity')}>{d.found_by.item_id}</Link>
          </>
        )}{' '}
        when it claimed work
      </>
    );

  const noText = d.change !== 'missing' && d.local_content === null;
  const withheld = noText && d.content_withheld === 'secret';
  const adoptWhy =
    d.change === 'missing'
      ? 'The file is missing there: nothing to adopt.'
      : !adoptable
        ? 'Only the files Docket ships can be adopted.'
        : withheld
          ? 'Content withheld: the local text looked like a secret.'
          : noText
            ? 'Run docket-check on that machine to send the text.'
            : null;
  const restoreWhy = legacy
    ? `Docket removes an old-name folder only while it is unmodified, and this one was edited: adopt it as ${nameOf(fileKeyOf(d))}, or keep it.`
    : d.change === 'extra'
      ? 'Docket never deletes files: remove the folder yourself, or keep it.'
      : null;

  async function act(kind: 'adopt' | 'restore' | 'keep') {
    setBusy(true);
    try {
      if (kind === 'adopt') {
        await runOwnerMutation(() => apiClient['drift.adopt']({ params: { id: d.id }, body: {} }), {
          success: `Adopted: the local ${name} is now ${target}.`,
          refetch: REFRESH,
        });
      } else if (kind === 'restore') {
        const r = await runOwnerMutation(
          () => apiClient['drift.restore']({ params: { id: d.id }, body: {} }),
          {
            success:
              d.install.method === 'push'
                ? `Restored: Docket reinstalled its version in ${where}.`
                : 'Run the new install command there to restore Docket’s version.',
            refetch: REFRESH,
          },
        );
        if (r?.install.command) setCommands(r.install);
      } else {
        await runOwnerMutation(
          () => apiClient['drift.keepLocal']({ params: { id: d.id }, body: {} }),
          {
            success: `Kept the local ${name}. A further change there alerts you again.`,
            refetch: REFRESH,
          },
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
      if (kind !== 'restore' || d.install.method === 'push') {
        await Promise.all(REFRESH.map((queryKey) => qc.invalidateQueries({ queryKey })));
      }
    }
  }

  return (
    <Card className="afdriftcard pad" data-drift={d.id}>
      <article id={`drift-${d.id}`} aria-labelledby={`${d.id}-h`}>
        <div className="row wrap afphead">
          <h3 id={`${d.id}-h`} className="mono">
            {name}
          </h3>
          {legacy ? (
            <Chip kind="warn">Old name, edited locally</Chip>
          ) : (
            <Chip kind={CHANGE[d.change].kind}>{CHANGE[d.change].label}</Chip>
          )}
          <Chip>{projectName ?? 'User-wide'}</Chip>
          <span className="grow" />
          <span className="src" title={isoTitle(d.detected_at)}>
            {formatAgo(d.detected_at)}
          </span>
        </div>
        <dl className="afdriftfacts">
          <dt>Where</dt>
          <dd>
            <span className="mono">{where}</span> · {INSTALL_CLIENT_LABELS[d.install.client]} ·{' '}
            {d.install.method === 'push' ? 'written by Docket' : 'installed by command'}{' '}
            <span className="mono src">({d.install_id})</span>
          </dd>
          <dt>How it was found</dt>
          <dd>
            {how} · <span title={isoTitle(d.found_by.at)}>{formatAgo(d.found_by.at)}</span>
          </dd>
        </dl>

        {d.change === 'missing' ? (
          <Callout tone="warn">
            {name} was deleted there. Agents there work without it until it’s restored.
          </Callout>
        ) : withheld ? (
          <Callout tone="warn">
            <b>Content withheld: it looked like a secret.</b> Docket kept only the file’s
            fingerprint, never the text, so it can’t show the change. Remove the secret from the
            file there; the next docket-check report sends the text.
          </Callout>
        ) : noText ? (
          <Callout>
            Docket doesn’t have the local text, so it can’t show the change. Run docket-check
            on that machine to send the text: the next agent claim there does it.
          </Callout>
        ) : sent === undefined ? (
          <div className="src">Loading the comparison…</div>
        ) : (
          <DiffView
            from={sent ?? ''}
            to={d.local_content ?? ''}
            label={
              legacy
                ? `${nameOf(fileKeyOf(d))}: Docket’s version → the local ${name} (old name)`
                : d.change === 'extra'
                  ? `${name}: the added file`
                : `${name}: Docket’s version → the local file`
            }
          />
        )}

        {commands?.command ? (
          <div className="afdrift-cmd" role="group" aria-label="Restore by command">
            <div className="src">
              Run one of these {d.install.path ? `in ${d.install.path}` : 'where it was installed'}{' '}
              to put Docket’s version back. Each works once, for 10 minutes.
            </div>
            <CopyBlock
              text={commands.command.powershell}
              label="PowerShell (Windows)"
              what="PowerShell command"
            />
            <CopyBlock
              text={commands.command.bash}
              label="bash (macOS, Linux, Git Bash)"
              what="bash command"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCommands(null);
                void Promise.all(REFRESH.map((queryKey) => qc.invalidateQueries({ queryKey })));
              }}
            >
              Done
            </Button>
          </div>
        ) : (
          <div className="afdriftacts">
            <div className="row wrap" style={{ gap: 6 }}>
              <Button
                variant="primary"
                disabled={busy || adoptWhy !== null}
                aria-describedby={adoptWhy ? `${d.id}-adopt` : undefined}
                onClick={() => void act('adopt')}
              >
                Adopt as {target}
                <span className="sr"> ({name})</span>
              </Button>
              <Button
                disabled={busy || restoreWhy !== null}
                aria-describedby={restoreWhy ? `${d.id}-restore` : undefined}
                onClick={() => void act('restore')}
              >
                Restore Docket’s version<span className="sr"> ({name})</span>
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void act('keep')}>
                Keep local<span className="sr"> ({name})</span>
              </Button>
            </div>
            {adoptWhy && (
              <div id={`${d.id}-adopt`} className="src">
                Adopt: {adoptWhy}
              </div>
            )}
            {restoreWhy && (
              <div id={`${d.id}-restore`} className="src">
                Restore: {restoreWhy}
              </div>
            )}
          </div>
        )}
      </article>
    </Card>
  );
}
