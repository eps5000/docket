/**
 * Card, Callout, EmptyState, Skeleton and the screen error state
 * (UI_SPEC §4, §6 "three states before content", §7).
 */
import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';
import { Button } from './Button';

export function Card({
  padded = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div className={['card', padded && 'pad', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

/** A card with an h3 header "Title · N" (Needs you cards, Agents, Settings). */
export function CardHeader({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div className="sectionhead">
      <h3>{title}</h3>
      {extra}
    </div>
  );
}

export type CalloutTone = 'info' | 'warn' | 'bad' | 'ok';

export function Callout({
  tone = 'info',
  role,
  className,
  children,
}: {
  tone?: CalloutTone;
  role?: 'alert' | 'status';
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={['callout', tone !== 'info' && tone, className].filter(Boolean).join(' ')}
      role={role}
    >
      {children}
    </div>
  );
}

/** One muted line inside the card. No illustrations (UI_SPEC §4 EmptyState). */
export function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty" data-empty="">
      {text}
    </div>
  );
}

/** How long to wait before showing a skeleton (UI_SPEC §6). */
export const SKELETON_DELAY_MS = 200;

/** True once the calling component has been mounted for `delayMs`. */
export function useDelayedFlag(delayMs = SKELETON_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);
  return shown;
}

/**
 * Skeleton blocks for the card shapes, shown only after 200 ms. Never a
 * spinner over the whole view.
 */
export function Skeleton({
  lines = 3,
  tall = 0,
  delayMs = SKELETON_DELAY_MS,
  label = 'Loading',
}: {
  lines?: number;
  tall?: number;
  delayMs?: number;
  label?: string;
}) {
  const shown = useDelayedFlag(delayMs);
  if (!shown) return null;
  return (
    <div className="skel" role="status" aria-label={label} data-skeleton="">
      {Array.from({ length: tall }, (_, k) => (
        <i key={`t${k}`} className="tall" />
      ))}
      {Array.from({ length: lines }, (_, k) => (
        <i key={k} style={{ width: `${92 - ((k * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** What the error state needs from an error (an `ApiError`, or anything thrown). */
export interface ErrorLike {
  code?: string;
  status?: number;
  message?: string;
}

/** True for a route a slice hasn't built yet: `501 {code: "unavailable"}`. */
export function isNotBuilt(err: unknown): boolean {
  const e = err as ErrorLike | null;
  return !!e && e.status === 501;
}

/**
 * The inline `--bad-soft` callout in place of the content: the error code, a
 * one-line message and *Retry* (UI_SPEC §6). A 501 from a route no slice has
 * built yet reads "Not built yet" with the same styling.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = (error ?? {}) as ErrorLike;
  const notBuilt = isNotBuilt(error);
  const code = e.code ?? (e.status ? String(e.status) : 'internal');
  const message =
    e.message && e.message.trim() !== '' ? e.message : 'Something went wrong. Try again.';
  return (
    <div
      className="callout bad errstate"
      role="alert"
      data-error-state={notBuilt ? 'not-built' : 'error'}
    >
      <div className="grow">
        <div>
          <b>{notBuilt ? 'Not built yet.' : 'Couldn’t load this.'}</b>{' '}
          <span className="code">{code}</span>
        </div>
        <div>{message}</div>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
