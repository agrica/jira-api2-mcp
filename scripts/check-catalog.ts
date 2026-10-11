import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { AccessDecisions, CatalogFile } from '../src/catalog/types.ts';
import { buildCatalog, compareWithLock, missingWadlFiles, verifyFiles } from './lib/build.ts';
import { describeDiff, diffOperations } from './lib/diff.ts';
import {
  CATALOG_JSON,
  DECISIONS,
  FETCH_META,
  SOURCE_LOCK,
  WADL_DIR,
  type FetchMeta,
  type SourceLock,
} from './lib/sources.ts';

const readJson = async <T>(url: URL, hint: string): Promise<T> => {
  try {
    return JSON.parse(await readFile(url, 'utf8')) as T;
  } catch {
    const relative = url.pathname.split('/catalog/')[1];
    console.error(`✖ cannot read ${relative ? `catalog/${relative}` : url.pathname} — ${hint}`);
    process.exit(1);
  }
};

const lock = await readJson<SourceLock>(
  SOURCE_LOCK,
  'run npm run catalog:build -- --update-lock (first generation)',
);
const decisions = await readJson<AccessDecisions>(
  DECISIONS,
  'the decisions file is versioned: restore it from git',
);
const meta = await readJson<FetchMeta>(FETCH_META, 'run npm run catalog:fetch');
const committed = await readJson<CatalogFile>(CATALOG_JSON, 'run npm run catalog:build');
const xml = new Map<string, string>();
for (const s of meta.sources) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- few local files, read sequentially
  const text = await readFile(new URL(s.file, WADL_DIR), 'utf8').catch(() => undefined);
  if (text !== undefined) xml.set(s.file, text);
}
// A missing file is reported as such (not as a sha256 mismatch); nothing can be built without it.
const missing = missingWadlFiles(meta, xml);
if (missing.length > 0) {
  for (const p of missing) console.error(`✖ ${p}`);
  process.exit(1);
}

const problems: string[] = [];
try {
  verifyFiles(meta, xml);
} catch (error) {
  problems.push((error as Error).message);
}
const { catalog, staleDecisions, pending } = buildCatalog({
  xml,
  decisions,
  meta,
  generatedAt: committed.meta.generatedAt,
});
if (!isDeepStrictEqual(catalog, committed)) {
  problems.push(
    `catalog/catalog.json is stale — run npm run catalog:build\n${describeDiff(diffOperations(committed.operations, catalog.operations), 'Différences')}`,
  );
}
if (staleDecisions.length > 0)
  problems.push(`Stale access decisions: ${staleDecisions.join(', ')}`);
if (pending.length > 0) {
  problems.push(
    `${pending.length} review candidate(s) without a decision — see catalog/review.md and catalog/access-decisions.json`,
  );
}
problems.push(...compareWithLock(meta, catalog, lock));
for (const family of ['api', 'agile', 'xray'] as const) {
  if (catalog.meta.counts[family] === 0) problems.push(`No operation for the "${family}" family`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
console.error(
  `✔ catalog consistent — Jira ${catalog.meta.jiraVersion}, WADL fetched ${catalog.meta.fetchedAt}, ${catalog.operations.length} operations, no pending review`,
);
