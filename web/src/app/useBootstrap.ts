import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/api';
import { apiClient } from './queryClient';

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
 * True once bootstrap has answered with no projects (deleted ones aren't
 * listed): the first-run state (UI_SPEC §6.0; B32). False while it loads or
 * fails, so a slow start never flashes the Welcome page.
 */
export function useNoProjects(): boolean {
  const boot = useBootstrap();
  return boot.isSuccess && boot.data.projects.length === 0;
}
