import { STARTED_FLAG, compose } from './container';

/** Stop the container only if the global setup started it. The data volume is kept. */
export default async function globalTeardown(): Promise<void> {
  if (process.env[STARTED_FLAG] === '1') compose('down');
}
