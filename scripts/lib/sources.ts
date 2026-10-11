import type { JiraClient } from '../../src/http/jira-client.ts';
import { JiraApiError } from '../../src/http/jira-error.ts';
import type { ApiFamily } from '../../src/catalog/types.ts';
import { sha256 } from './build.ts';

export const CATALOG_DIR = new URL('../../catalog/', import.meta.url);
export const WADL_DIR = new URL('wadl/', CATALOG_DIR); //                  not versioned (mode B)
export const FETCH_META = new URL('wadl/fetch-meta.json', CATALOG_DIR); // not versioned (mode B)
export const SOURCE_LOCK = new URL('source-lock.json', CATALOG_DIR); //    versioned
export const DECISIONS = new URL('access-decisions.json', CATALOG_DIR); // versioned
export const CATALOG_JSON = new URL('catalog.json', CATALOG_DIR); //       not versioned (mode B)
export const LAST_DIFF = new URL('last-diff.md', CATALOG_DIR); //          not versioned (mode B)
export const REVIEW_REPORT = new URL('review.md', CATALOG_DIR); //         not versioned (mode B)

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
    added: number;
    removed: number;
    changed: number;
    recordedAt: string;
  };
}

interface ServerInfo {
  version: string;
  buildNumber: number;
}

export async function fetchSources(
  client: JiraClient,
): Promise<{ meta: FetchMeta; xml: Map<string, string> }> {
  const info = (
    await client.request({ method: 'GET', path: '/rest/api/2/serverInfo', access: 'read' })
  ).data as ServerInfo;
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
