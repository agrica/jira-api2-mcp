import { readFile } from 'node:fs/promises';
import type { JiraClient } from '../../src/http/jira-client.ts';
import { JiraApiError } from '../../src/http/jira-error.ts';
import type { ApiFamily } from '../../src/catalog/types.ts';
import { sha256 } from './build.ts';
import { parseWadl } from './wadl.ts';

export const CATALOG_DIR = new URL('../../catalog/', import.meta.url);
export const WADL_DIR = new URL('wadl/', CATALOG_DIR); //                  not versioned (mode B)
export const FETCH_META = new URL('wadl/fetch-meta.json', CATALOG_DIR); // not versioned (mode B)
export const SOURCE_LOCK = new URL('source-lock.json', CATALOG_DIR); //    versioned
export const DECISIONS = new URL('access-decisions.json', CATALOG_DIR); // versioned
export const CATALOG_JSON = new URL('catalog.json', CATALOG_DIR); //       versioned (shipped)
export const LAST_DIFF = new URL('last-diff.md', CATALOG_DIR); //          not versioned (mode B)
export const REVIEW_REPORT = new URL('review.md', CATALOG_DIR); //         not versioned (mode B)
/** Operations of the last `--update-lock`: the reference of last-diff.md, kept across plain builds. */
export const LOCK_BASELINE = new URL('lock-baseline.json', CATALOG_DIR); // not versioned (mode B)

/** An `optional` source (plugin that may not be installed) answering 404 is skipped, not an error. */
export const WADL_SOURCES: readonly {
  api: ApiFamily;
  path: string;
  file: string;
  optional?: boolean;
}[] = [
  { api: 'api', path: '/rest/api/2/application.wadl', file: 'api.wadl' },
  { api: 'agile', path: '/rest/agile/1.0/application.wadl', file: 'agile.wadl' },
  { api: 'xray', path: '/rest/raven/1.0/application.wadl', file: 'xray.wadl', optional: true },
];

export interface SourceFile {
  api: ApiFamily;
  path: string;
  file: string;
  sha256: string;
  bytes: number;
}

/** Deliberately carries no instance URL: the lock built from it is versioned. */
export interface FetchMeta {
  jiraVersion: string;
  jiraBuildNumber: number;
  fetchedAt: string;
  /** Sources fetched (present on the instance). */
  sources: SourceFile[];
  /** Files of optional sources absent from the instance (404), e.g. `xray.wadl` without the plugin. */
  absent: string[];
}

export interface SourceLock extends FetchMeta {
  counts: Record<ApiFamily, number>;
  operationsSha256: string;
  lastChange: {
    fromVersion: string | null;
    toVersion: string;
    /**
     * What the counts compare with: the operations of the previous lock, nothing (first lock), or
     * `unknown` when the locked operations were not available locally (the counts are then null).
     */
    baseline: 'previous-lock' | 'none' | 'unknown';
    added: number | null;
    removed: number | null;
    changed: number | null;
    recordedAt: string;
  };
}

/**
 * Reads a JSON file of the catalog directory. A missing or unreadable file gives one line naming
 * the file and what to run (`hint`), instead of a stack trace.
 */
export async function readCatalogJson<T>(url: URL, hint: string): Promise<T> {
  const relative = url.pathname.split('/catalog/')[1];
  const name = relative ? `catalog/${relative}` : url.pathname;
  let text: string;
  try {
    text = await readFile(url, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(`${missing ? 'missing' : 'cannot read'} ${name} — ${hint}`, { cause: error });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} is not valid JSON — ${hint}`);
  }
}

/** The lock, or undefined when there is none yet; a corrupt lock is an error, not a first generation. */
export async function readLockIfAny(url: URL = SOURCE_LOCK): Promise<SourceLock | undefined> {
  try {
    return await readCatalogJson<SourceLock>(url, 'restore it from git');
  } catch (error) {
    if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function serverInfo(data: unknown): { version: string; buildNumber: number } {
  const info = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (
    typeof info.version !== 'string' ||
    !info.version.trim() ||
    typeof info.buildNumber !== 'number' ||
    !Number.isInteger(info.buildNumber)
  ) {
    throw new Error(
      '/rest/api/2/serverInfo did not return a Jira version and build number — check JIRA_BASE_URL and any authentication proxy',
    );
  }
  return { version: info.version, buildNumber: info.buildNumber };
}

export async function fetchSources(
  client: JiraClient,
): Promise<{ meta: FetchMeta; xml: Map<string, string> }> {
  const info = serverInfo(
    (await client.request({ method: 'GET', path: '/rest/api/2/serverInfo', access: 'read' })).data,
  );
  const xml = new Map<string, string>();
  const sources: SourceFile[] = [];
  const absent: string[] = [];
  for (const { optional, ...source } of WADL_SOURCES) {
    let data: unknown;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one WADL at a time: do not hammer the instance
      ({ data } = await client.request({
        method: 'GET',
        path: source.path,
        access: 'read',
        accept: 'application/xml',
      }));
    } catch (error) {
      if (optional && error instanceof JiraApiError && error.status === 404) {
        console.error(`${source.api} WADL not found: skipped (plugin not installed)`);
        absent.push(source.file);
        continue;
      }
      throw error;
    }
    if (typeof data !== 'string') throw new Error(`Unexpected WADL payload for ${source.path}`);
    // An SSO, proxy or error page answered 200 must not replace the last good WADL: validated here,
    // before the caller writes any file (warnings are left to catalog:build).
    parseWadl(data, source.api, () => {});
    xml.set(source.file, data);
    sources.push({ ...source, sha256: sha256(data), bytes: Buffer.byteLength(data) });
  }
  return {
    meta: {
      jiraVersion: info.version,
      jiraBuildNumber: info.buildNumber,
      fetchedAt: new Date().toISOString(),
      sources,
      absent,
    },
    xml,
  };
}
