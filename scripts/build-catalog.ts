import { readFile, writeFile } from 'node:fs/promises';
import type { AccessDecisions } from '../src/catalog/types.ts';
import {
  asCatalog,
  buildCatalog,
  chooseBaseline,
  diffAgainstBaseline,
  formatBaselineDiff,
  formatReview,
  makeLock,
  operationsDigest,
  sameLockContent,
  verifyFiles,
  type LockBaseline,
} from './lib/build.ts';
import { decisionProblems } from './lib/classify.ts';
import { describeIds, diffOperations, hasDrift } from './lib/diff.ts';
import { runScript } from './lib/run-script.ts';
import {
  CATALOG_JSON,
  DECISIONS,
  FETCH_META,
  LAST_DIFF,
  LOCK_BASELINE,
  REVIEW_REPORT,
  SOURCE_LOCK,
  WADL_DIR,
  readCatalogJson,
  readLockIfAny,
  type FetchMeta,
} from './lib/sources.ts';

const FETCH_HINT = 'run npm run catalog:fetch';
const optional = <T>(url: URL): Promise<T | undefined> =>
  readCatalogJson<T>(url, '').catch(() => undefined);

await runScript(async () => {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--update-lock');
  if (unknown.length > 0)
    throw new Error(`Unknown argument(s): ${unknown.join(' ')} (only --update-lock is accepted)`);
  const updateLock = args.includes('--update-lock');

  const meta = await readCatalogJson<FetchMeta>(FETCH_META, FETCH_HINT);
  const decisions = await readCatalogJson<AccessDecisions>(
    DECISIONS,
    'the decisions file is versioned: restore it from git',
  );
  // Every decision problem on its own line, before anything is built or written.
  const problems = decisionProblems(decisions);
  if (problems.length > 0) {
    for (const p of problems) console.error(`✖ ${p}`);
    process.exitCode = 1;
    return;
  }
  const xml = new Map<string, string>();
  for (const s of meta.sources) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- few local files, read sequentially
    const text = await readFile(new URL(s.file, WADL_DIR), 'utf8').catch(() => undefined);
    if (text === undefined) throw new Error(`missing catalog/wadl/${s.file} — ${FETCH_HINT}`);
    xml.set(s.file, text);
  }
  verifyFiles(meta, xml);

  // A local catalog.json of the wrong shape (e.g. `{}`) is treated as absent.
  const previous = asCatalog(await optional<unknown>(CATALOG_JSON));
  const { catalog, staleDecisions, dormantDecisions, candidates, pending } = buildCatalog({
    xml,
    decisions,
    meta,
    generatedAt: new Date().toISOString(),
  });
  if (staleDecisions.length > 0) {
    throw new Error(
      `Stale entries in catalog/access-decisions.json (operation no longer in the WADL): ${describeIds(staleDecisions)}`,
    );
  }
  if (dormantDecisions.length > 0)
    console.error(
      `  ${dormantDecisions.length} Xray decision(s) kept although Xray is absent from this instance`,
    );
  if (previous && previous.meta.fetchedAt === catalog.meta.fetchedAt) {
    // Unchanged content keeps its generation date.
    if (!hasDrift(diffOperations(previous.operations, catalog.operations)))
      catalog.meta.generatedAt = previous.meta.generatedAt;
  }

  // The reference is the locked catalog, not the previous local build: `build` then
  // `build -- --update-lock` must both report what changed since the lock.
  const previousLock = await readLockIfAny();
  const baseline = chooseBaseline(previousLock, {
    copy: await optional<unknown>(LOCK_BASELINE),
    previous,
    built: catalog,
  });
  const diff = diffAgainstBaseline(baseline, catalog.operations);

  await writeFile(CATALOG_JSON, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await writeFile(LAST_DIFF, formatBaselineDiff(baseline, diff, catalog), 'utf8');
  await writeFile(REVIEW_REPORT, formatReview(catalog, candidates, pending), 'utf8');

  const { counts } = catalog.meta;
  console.error(
    `✔ ${catalog.operations.length} operations (api ${counts.api}, agile ${counts.agile}, xray ${counts.xray})`,
  );
  console.error(
    diff
      ? `  +${diff.added.length} −${diff.removed.length} ~${diff.changed.length} since the ${baseline.kind === 'none' ? 'first generation' : 'locked catalog'} (catalog/last-diff.md)`
      : '  changes since the locked catalog: unknown, its operations are not available locally (catalog/last-diff.md)',
  );
  console.error(
    `  review: ${candidates.length} candidate(s), ${pending.length} pending (catalog/review.md)`,
  );

  if (!updateLock) return;
  if (pending.length > 0) {
    throw new Error(
      `Cannot update catalog/source-lock.json: ${pending.length} review candidate(s) pending`,
    );
  }
  const lock = makeLock(meta, catalog, previousLock, baseline, new Date().toISOString());
  const copy: LockBaseline = {
    operationsSha256: operationsDigest(catalog.operations),
    jiraVersion: catalog.meta.jiraVersion,
    operations: catalog.operations,
  };
  await writeFile(LOCK_BASELINE, `${JSON.stringify(copy)}\n`, 'utf8');
  if (sameLockContent(previousLock, lock)) {
    console.error('✔ catalog/source-lock.json unchanged (same version, files and operations)');
    return;
  }
  await writeFile(SOURCE_LOCK, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.error(
    '✔ catalog/source-lock.json updated — commit it together with catalog/access-decisions.json',
  );
});
