import { readFile, writeFile } from 'node:fs/promises';
import type { AccessDecisions, CatalogFile } from '../src/catalog/types.ts';
import { buildCatalog, formatReview, makeLock, verifyFiles } from './lib/build.ts';
import { diffOperations, formatDiff, hasDrift } from './lib/diff.ts';
import {
  CATALOG_JSON,
  DECISIONS,
  FETCH_META,
  LAST_DIFF,
  REVIEW_REPORT,
  SOURCE_LOCK,
  WADL_DIR,
  type FetchMeta,
  type SourceLock,
} from './lib/sources.ts';

const updateLock = process.argv.includes('--update-lock');
const readJson = async <T>(url: URL): Promise<T> => JSON.parse(await readFile(url, 'utf8')) as T;

const meta = await readJson<FetchMeta>(FETCH_META);
const decisions = await readJson<AccessDecisions>(DECISIONS);
const xml = new Map<string, string>();
// oxlint-disable-next-line eslint/no-await-in-loop -- few local files, read sequentially
for (const s of meta.sources) xml.set(s.file, await readFile(new URL(s.file, WADL_DIR), 'utf8'));
verifyFiles(meta, xml);

const previous = await readJson<CatalogFile>(CATALOG_JSON).catch(() => undefined);
const { catalog, staleDecisions, candidates, pending } = buildCatalog({
  xml,
  decisions,
  meta,
  generatedAt: new Date().toISOString(),
});
if (staleDecisions.length > 0) {
  throw new Error(`Stale entries in catalog/access-decisions.json: ${staleDecisions.join(', ')}`);
}
const diff = diffOperations(previous?.operations ?? [], catalog.operations);
if (previous && !hasDrift(diff) && previous.meta.fetchedAt === catalog.meta.fetchedAt) {
  catalog.meta.generatedAt = previous.meta.generatedAt; // unchanged content keeps its generation date
}

await writeFile(CATALOG_JSON, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
await writeFile(
  LAST_DIFF,
  formatDiff(
    diff,
    `Jira ${previous?.meta.jiraVersion ?? '—'} → Jira ${catalog.meta.jiraVersion} (${catalog.meta.fetchedAt})`,
  ),
  'utf8',
);
await writeFile(REVIEW_REPORT, formatReview(catalog, candidates, pending), 'utf8');

const { counts } = catalog.meta;
console.error(
  `✔ ${catalog.operations.length} operations (api ${counts.api}, agile ${counts.agile}, xray ${counts.xray})`,
);
console.error(
  `  +${diff.added.length} −${diff.removed.length} ~${diff.changed.length} (catalog/last-diff.md)`,
);
console.error(
  `  review: ${candidates.length} candidate(s), ${pending.length} pending (catalog/review.md)`,
);

if (updateLock) {
  if (pending.length > 0) {
    throw new Error(
      `Cannot update catalog/source-lock.json: ${pending.length} review candidate(s) pending`,
    );
  }
  const previousLock = await readJson<SourceLock>(SOURCE_LOCK).catch(() => undefined);
  const lock = makeLock(meta, catalog, previousLock, diff, new Date().toISOString());
  await writeFile(SOURCE_LOCK, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.error(
    '✔ catalog/source-lock.json updated — commit it together with catalog/access-decisions.json',
  );
}
