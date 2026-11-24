import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { PAUSE_REASON_MAX, type Project } from '@docket/shared';
import { Button, Dialog, DialogCancel, ErrorState, Icon } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatDay, isoTitle } from '../../lib/format';
import { runOwnerMutation, showToast } from '../../lib/undo';

type Named = Pick<Project, 'key' | 'name'>;

/**
 * Pause project (owner decision 53; UI_SPEC §6.1). Pausing and resuming swap
 * which button is on screen, so each moves focus to the action that replaced
 * it, or to the page when there is none.
 */
function focusNext(attribute: string, key: string) {
  setTimeout(() => {
    const next =
      document.querySelector<HTMLElement>(`[${attribute}="${key}"]`) ??
      document.getElementById('main');
    next?.focus();
  }, 0);
}

function PauseDialog({ project, onClose }: { project: Named; onClose: () => void }) {
  const inputId = useId();
  const hintId = useId();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ready = reason.trim().length > 0;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runOwnerMutation(
        () =>
          apiClient['projects.pause']({
            params: { key: project.key },
            body: { reason: reason.trim() },
          }),
        { success: `Paused ${project.name}. Agents can’t start new work there.` },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.all });
      onClose();
      focusNext('data-resume-project', project.key);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Pause ${project.name}?`}
      onClose={onClose}
      footer={
        <>
          <DialogCancel onClick={onClose} />
          <Button
            variant="primary"
            disabled={!ready}
            data-confirm-pause={project.key}
            onClick={() => void submit()}
          >
            Pause project
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Agents can’t start or resume work in this project until you resume it. Work already running
        can reach a safe stopping point, and nothing is lost. Other projects aren’t affected.
      </p>
      <form onSubmit={(e) => void submit(e)}>
        <label className="f" htmlFor={inputId}>
          Why are you pausing it?
        </label>
        <input
          id={inputId}
          className="input"
          value={reason}
          maxLength={PAUSE_REASON_MAX}
          aria-describedby={hintId}
          autoComplete="off"
          onChange={(e) => setReason(e.target.value)}
        />
        <p id={hintId} className="src" style={{ marginBottom: 0 }}>
          Agents see this reason, so they know why they’re stopping.
        </p>
      </form>
      {error !== null && (
        <div style={{ marginTop: 10 }}>
          <ErrorState error={error} />
        </div>
      )}
    </Dialog>
  );
}

/** *Pause project…*: asks for the reason. */
export function PauseProjectButton({ project, size }: { project: Named; size?: 'sm' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        {...(size ? { size } : {})}
        data-pause-project={project.key}
        onClick={() => setOpen(true)}
      >
        Pause project…<span className="sr"> ({project.name})</span>
      </Button>
      {open && <PauseDialog project={project} onClose={() => setOpen(false)} />}
    </>
  );
}

/** *Resume project*, with Undo in the toast. */
export function ResumeProjectButton({
  project,
  size,
  primary = false,
}: {
  project: Named;
  size?: 'sm';
  primary?: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runOwnerMutation(
        () => apiClient['projects.resume']({ params: { key: project.key }, body: {} }),
        { success: `Resumed ${project.name}. Agents can start work there again.` },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.all });
      focusNext('data-pause-project', project.key);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t resume the project. Try again.');
    }
    setBusy(false);
  };
  return (
    <Button
      {...(size ? { size } : {})}
      {...(primary ? { variant: 'primary' as const } : {})}
      data-resume-project={project.key}
      onClick={() => void resume()}
    >
      Resume project<span className="sr"> ({project.name})</span>
    </Button>
  );
}

function Banner({ project }: { project: Project }) {
  const pause = project.paused!;
  return (
    <div className="banner" data-banner="paused" data-paused-project={project.key}>
      <Icon name="warning" />
      <div className="grow">
        <b>{project.name} is paused.</b> You paused it on{' '}
        <span title={isoTitle(pause.paused_at)}>{formatDay(pause.paused_at)}</span>: “{pause.reason}
        ”. Agents can’t start or resume work here until you resume it.
      </div>
      <ResumeProjectButton project={project} primary />
      <HelpLink anchor="settings.pause-project" />
    </div>
  );
}

/** The banner on an item's page: its own project, whatever the scope. */
export function PausedBanner({ project }: { project: string }) {
  const boot = useBootstrap();
  const found = boot.data?.projects.find((p) => p.key === project);
  return found?.paused ? <Banner project={found} /> : null;
}

/** Overview and Work: the chosen project's banner, or every paused one under All projects. */
export function PausedBanners() {
  const { scope } = useShell();
  const boot = useBootstrap();
  const paused = (boot.data?.projects ?? []).filter(
    (p) => p.paused && (scope === 'all' || p.key === scope),
  );
  return (
    <>
      {paused.map((p) => (
        <Banner key={p.key} project={p} />
      ))}
    </>
  );
}

/** Overview's action, with one project chosen. Once paused, the banner has *Resume project*. */
export function PauseProjectAction() {
  const { scope } = useShell();
  const boot = useBootstrap();
  const project = boot.data?.projects.find((p) => p.key === scope);
  if (!project || project.paused) return null;
  return <PauseProjectButton project={project} size="sm" />;
}
