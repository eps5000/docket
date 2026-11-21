import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { OVERLAP_HANDLING, type OverlapHandling } from '@docket/shared';
import { Card, Skeleton } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { errorText } from '../agent-files/install-common';
import { OVERLAP_HANDLING_TEXT } from '../shared/sharedChanges';

/**
 * Settings → Overlap handling (owner decision 39; UI_SPEC §6.7): how much of
 * parallel work's overlaps reach you, as a default and per project. Only the
 * owner changes it; no agent tool does. Single-writer leases, the merge checks
 * and overlaps you already decided are the same in every mode.
 */
export function OverlapHandlingCard() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.overlapHandling(),
    queryFn: () => apiClient['overlapHandling.get']({}),
  });
  // The choice shows at once. Controls stay enabled while it saves, because disabling the
  // focused control would drop keyboard focus (B34).
  const [pending, setPending] = useState<OverlapHandling | null>(null);
  const name = useId();
  const save = async (mode: OverlapHandling | null, project?: string) => {
    if (!project) setPending(mode);
    try {
      await runOwnerMutation(
        () =>
          apiClient['overlapHandling.set']({
            body: { mode, ...(project ? { project } : {}) },
          }),
        {
          success:
            mode === null
              ? `${project} follows the default.`
              : `Overlap handling${project ? ` for ${project}` : ''}: ${OVERLAP_HANDLING_TEXT[mode].label}.`,
          refetch: [queryKeys.overlapHandling()],
        },
      );
      await qc.invalidateQueries({ queryKey: queryKeys.overlapHandling() });
    } catch (err) {
      showToast(errorText(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <section aria-labelledby="set-overlaps" className="settings-sec" data-card="overlap-handling">
      <div className="withhelp">
        <h2 id="set-overlaps">Overlap handling</h2>
        <HelpLink anchor="settings.overlap-handling" />
      </div>
      <p className="src aflede">
        When two items touch the same thing, Docket asks: can they run together, would running them
        in order solve it, or does it need you? Single-writer leases, the merge checks and overlaps
        you already decided work the same in every mode.
      </p>
      <Card>
        <QueryState
          query={query}
          skeleton={
            <div className="pad">
              <Skeleton lines={3} label="Loading overlap handling" />
            </div>
          }
        >
          {(d) => (
            <div className="pad">
              <fieldset className="overlap-modes">
                <legend className="f">Default for all projects</legend>
                {OVERLAP_HANDLING.map((mode) => (
                  <label key={mode} className="overlap-mode">
                    <input
                      type="radio"
                      name={name}
                      value={mode}
                      checked={(pending ?? d.default) === mode}
                      onChange={() => void save(mode)}
                    />
                    <span>
                      <span className="overlap-mode-name">{OVERLAP_HANDLING_TEXT[mode].label}</span>
                      <span className="src overlap-mode-help">
                        {OVERLAP_HANDLING_TEXT[mode].help}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {d.projects.length > 0 && (
                <div className="tablewrap">
                  <table aria-label="Overlap handling per project">
                    <thead>
                      <tr>
                        <th scope="col">Project</th>
                        <th scope="col">Handling</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.projects.map((p) => (
                        <tr key={p.key} data-overlap-project={p.key}>
                          <th scope="row">{p.name}</th>
                          <td>
                            <select
                              aria-label={`Overlap handling for ${p.name}`}
                              value={p.override ?? ''}
                              onChange={(e) =>
                                void save((e.target.value || null) as OverlapHandling | null, p.key)
                              }
                            >
                              <option value="">
                                Default ({OVERLAP_HANDLING_TEXT[d.default].label})
                              </option>
                              {OVERLAP_HANDLING.map((mode) => (
                                <option key={mode} value={mode}>
                                  {OVERLAP_HANDLING_TEXT[mode].label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </QueryState>
      </Card>
    </section>
  );
}
