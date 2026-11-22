import { useQuery } from '@tanstack/react-query';
import { needsYouCount } from '@docket/shared';
import { queryKeys } from '../lib/api';
import { apiClient } from './queryClient';
import { useShell } from './ShellState';

/**
 * `GET /api/bootstrap`: projects, labels, sidebar counts, health and timing.
 * The shell renders without it (it answers 501 until US2 builds it): no
 * counts, only "All projects", and a neutral health line.
 */
export function useBootstrap() {
  return useQuery({
    queryKey: queryKeys.bootstrap(),
    queryFn: () => apiClient['bootstrap.get']({}),
  });
}

/**
 * What the owner can act on in the current project (owner decision 41): the
 * sidebar badge and the tab title. It reads the same query as the Needs you
 * page, so they always agree. Undefined until it has loaded.
 */
export function useNeedsYouCount(): number | undefined {
  const { scope } = useShell();
  // Not before bootstrap answers: a locked browser gets the unlock screen, not a failed count.
  const boot = useBootstrap();
  const query = useQuery({
    queryKey: queryKeys.needsYou({ scope }),
    queryFn: () => apiClient['needsYou.get']({ query: { scope } }),
    enabled: boot.isSuccess,
  });
  return query.data ? needsYouCount(query.data) : undefined;
}

/**
 * True once bootstrap has answered with no projects (deleted ones aren't
 * listed): the first-run state (UI_SPEC §6.0; B32). False while it loads or
 * fails, so a slow start never flashes the Welcome page.
 */
export function useNoProjects(): boolean {
  const boot = useBootstrap();
  return boot.isSuccess && boot.data.projects.length === 0;
}
