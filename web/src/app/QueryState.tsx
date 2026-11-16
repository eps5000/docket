import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorState, Skeleton } from '../components/kit';

/**
 * The three states every screen region has before its content (UI_SPEC §6):
 * loading (skeleton after 200 ms, never a whole-view spinner), error (the
 * inline callout with code, message and *Retry*; a 501 reads "Not built
 * yet"), then the content. Empty states are the content's job: each card
 * has its own line.
 */
export function QueryState<T>({
  query,
  skeleton,
  children,
}: {
  query: Pick<UseQueryResult<T>, 'data' | 'error' | 'isPending' | 'isError' | 'refetch'>;
  /** The card-shaped skeleton for this region. */
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.isPending || query.data === undefined) {
    return <>{skeleton ?? <Skeleton />}</>;
  }
  return <>{children(query.data)}</>;
}
