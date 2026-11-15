/** The app version, from server/package.json (the same file ships in the image). */
import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    // src/version.ts and dist/version.js both sit one level below package.json.
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();
