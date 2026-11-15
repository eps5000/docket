/**
 * The dependency subgraph and cycles on read (BUILD_SPEC §5.2; A11): the `subgraph` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US4 (T093) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type SubgraphService, type ServiceDeps } from './contracts.js';

export function createSubgraphService(_deps: ServiceDeps): SubgraphService {
  return {
    dependencySubgraph: notImplemented('subgraph.dependencySubgraph'),
    cycles: notImplemented('subgraph.cycles'),
  };
}
