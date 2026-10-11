import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { AccessDecisions, CatalogFile } from '../src/catalog/types.ts';
import { buildCatalog, compareWithLock, missingWadlFiles, verifyFiles } from './lib/build.ts';
import { decisionProblems } from './lib/classify.ts';
import { describeDiff, describeIds, diffOperations } from './lib/diff.ts';
import { runScript } from './lib/run-script.ts';
import {
  CATALOG_JSON,
  DECISIONS,
  FETCH_META,
  SOURCE_LOCK,
  WADL_DIR,
  readCatalogJson,
  type FetchMeta,
  type SourceLock,
} from './lib/sources.ts';

const fail = (problems: readonly string[]): void => {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exitCode = 1;
};

await runScript(async () => {
  const lock = await readCatalogJson<SourceLock>(
    SOURCE_LOCK,
    'run npm run catalog:build -- --update-lock (first generation)',
  );
  const decisions = await readCatalogJson<AccessDecisions>(
    DECISIONS,
    'the decisions file is versioned: restore it from git',
  );
  const meta = await readCatalogJson<FetchMeta>(FETCH_META, 'run npm run catalog:fetch');
  const committed = await readCatalogJson<CatalogFile>(CATALOG_JSON, 'run npm run catalog:build');
  const xml = new Map<string, string>();
  for (const s of meta.sources) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- few local files, read sequentially
    const text = await readFile(new URL(s.file, WADL_DIR), 'utf8').catch(() => undefined);
    if (text !== undefined) xml.set(s.file, text);
  }
  // A missing file is reported as such (not as a sha256 mismatch); nothing can be built without it.
  const missing = missingWadlFiles(meta, xml);
  if (missing.length > 0) return fail(missing);
  const invalidDecisions = decisionProblems(decisions);
  if (invalidDecisions.length > 0) return fail(invalidDecisions);

  const problems: string[] = [];
  try {
    verifyFiles(meta, xml);
  } catch (error) {
    problems.push((error as Error).message);
  }
  // Same WADL parsing and runtime schema as catalog:build: an empty, HTML or invalid source fails here.
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
    problems.push(`Stale access decisions: ${describeIds(staleDecisions)}`);
  if (pending.length > 0) {
    problems.push(
      `${pending.length} review candidate(s) without a decision — see catalog/review.md and catalog/access-decisions.json`,
    );
  }
  // Absent optional sources (e.g. Xray not installed) are recorded in the lock: their appearance
  // or disappearance is reported by compareWithLock. Empty required families make buildCatalog throw.
  problems.push(...compareWithLock(meta, catalog, lock));

  if (problems.length > 0) return fail(problems);
  console.error(
    `✔ catalog consistent — Jira ${catalog.meta.jiraVersion}, WADL fetched ${catalog.meta.fetchedAt}, ${catalog.operations.length} operations, no pending review`,
  );
});
