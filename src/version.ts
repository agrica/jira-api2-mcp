import { readFileSync } from 'node:fs';

/**
 * `src/version.ts` and `dist/version.js` both resolve to `<root>/package.json`, which `npm version`
 * updates: a hard-coded copy would drift at every release.
 */
export const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
