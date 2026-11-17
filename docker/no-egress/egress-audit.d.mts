/** Types for egress-audit.mjs (used by server/tests/integration/no-egress.test.ts). */
export interface EgressAttempt {
  at: string;
  pid: number;
  kind: 'tcp' | 'udp' | 'dns';
  host: string;
  port?: number;
}
export function isLocal(host: string | null | undefined): boolean;
export function connectTarget(args: unknown[]): { host: string; port: number } | null;
export function installEgressAudit(opts: {
  allow?: string[];
  record: (attempt: EgressAttempt) => void;
}): () => void;
