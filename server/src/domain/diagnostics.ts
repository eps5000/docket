/**
 * The diagnostic call log (decision T21; FR-108): the `diagnostics` service.
 *
 * Settings → *Download diagnostic log* gets the last `days` days of
 * `/data/logs/calls-*.jsonl`, oldest first. Each line is re-checked against
 * the shared line schema and rebuilt from its allowed fields only, so even
 * a hand-edited log file can't put arguments or results in the download.
 */
import { callLogLineSchema } from '@tasklite/shared';
import type { DiagnosticsService, ServiceDeps } from './contracts.js';

export function createDiagnosticsService(deps: ServiceDeps): DiagnosticsService {
  return {
    *calls(_r, input) {
      for (const raw of deps.callLog.read(input.days).split('\n')) {
        if (raw.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const line = callLogLineSchema.safeParse(parsed);
        if (!line.success) continue;
        const { time, tool, client, label, run, duration_ms, result } = line.data;
        yield JSON.stringify({ time, tool, client, label, run, duration_ms, result });
      }
    },
  };
}
