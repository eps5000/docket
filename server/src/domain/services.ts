/**
 * Wires every domain service (contracts.ts) from its own file. The runtime
 * builds one `Services` and hands it to both adapters, MCP and the UI API.
 */
import { createAgentFilesService } from './agent-files.js';
import { createArchiveService } from './archive.js';
import { createBackupService } from './backup.js';
import { createChecklistService } from './checklist.js';
import { createContextService } from './context.js';
import type { ServiceDeps, Services } from './contracts.js';
import { createDecisionsService } from './decisions.js';
import { createDiagnosticsService } from './diagnostics.js';
import { createDocumentsService } from './documents.js';
import { createEvidenceService } from './evidence.js';
import { createForecastService } from './forecast.js';
import { createHumanReviewService } from './human-review.js';
import { createItemsService } from './items.js';
import { createInstallsService } from './installs.js';
import { createJiraImportService } from './jira-import.js';
import { createLinksService } from './links.js';
import { createMessagesService } from './messages.js';
import { createPacketsService } from './packets.js';
import { createProjectsService } from './projects.js';
import { createRecoveryService } from './recovery.js';
import { createReviewDecisionsService } from './review-decisions.js';
import { createRunsService } from './runs.js';
import { createSearchService } from './search.js';
import { createSubgraphService } from './subgraph.js';
import { createUndoService } from './undo.js';
import { createViewsService } from './views.js';

/** Replace some methods of some services (tests only). */
export type ServiceOverrides = { [K in keyof Services]?: Partial<Services[K]> };

export function createServices(
  deps: Omit<ServiceDeps, 'services'>,
  overrides: ServiceOverrides = {},
): Services {
  // Late-bound, so a service can call another (e.g. evidence → packets.markStale).
  const full: ServiceDeps = { ...deps, services: () => services };
  const services: Services = {
    items: createItemsService(full),
    runs: createRunsService(full),
    checklist: createChecklistService(full),
    humanReview: createHumanReviewService(full),
    packets: createPacketsService(full),
    reviewDecisions: createReviewDecisionsService(full),
    evidence: createEvidenceService(full),
    search: createSearchService(full),
    views: createViewsService(full),
    links: createLinksService(full),
    subgraph: createSubgraphService(full),
    decisions: createDecisionsService(full),
    context: createContextService(full),
    messages: createMessagesService(full),
    documents: createDocumentsService(full),
    archive: createArchiveService(full),
    projects: createProjectsService(full),
    backup: createBackupService(full),
    forecast: createForecastService(full),
    jiraImport: createJiraImportService(full),
    diagnostics: createDiagnosticsService(full),
    recovery: createRecoveryService(full),
    agentFiles: createAgentFilesService(full),
    installs: createInstallsService(full),
    undo: createUndoService(full),
  };
  for (const [name, methods] of Object.entries(overrides)) {
    Object.assign(services[name as keyof Services], methods);
  }
  return services;
}
