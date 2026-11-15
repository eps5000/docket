/**
 * Dates, the timeline, burn-down and forecast (BUILD_SPEC §5.9): the `forecast` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US8 (T123) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ForecastService, type ServiceDeps } from './contracts.js';

export function createForecastService(_deps: ServiceDeps): ForecastService {
  return {
    timeline: notImplemented('forecast.timeline'),
    burndown: notImplemented('forecast.burndown'),
    forecast: notImplemented('forecast.forecast'),
  };
}
