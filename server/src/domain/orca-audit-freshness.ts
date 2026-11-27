/** Parked claims need a prompt custody signal; ended-resource inventory rotates more slowly. */
export const PARKED_AUDIT_FRESH_MS = 5 * 60_000;
export const ENDED_RESOURCE_AUDIT_FRESH_MS = 15 * 60_000;

/**
 * The helper audits at most 80 targets, 16 per pass, once a minute, with a
 * 90-second collection deadline. Five passes can take 12.5 minutes if each
 * reaches that deadline; the remaining 2.5 minutes are scheduling margin.
 * Beyond this window, custody is unknown again. This is display freshness,
 * never permission to release an Orca resource.
 */
export function resourceRotationBoundMs(targets: number): number | null {
  if (!Number.isInteger(targets) || targets < 0 || targets > 80) return null;
  return Math.ceil(targets / 16) * (90_000 + 60_000);
}

export function auditFreshAt(observedAt: string, now: string, windowMs: number): boolean {
  const observed = Date.parse(observedAt);
  const current = Date.parse(now);
  return (
    Number.isFinite(observed) &&
    Number.isFinite(current) &&
    current - observed <= windowMs &&
    observed <= current + 5_000
  );
}
