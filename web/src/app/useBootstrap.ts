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
