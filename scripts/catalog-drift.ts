import { loadConfig } from '../src/config.ts';
import { JiraClient } from '../src/http/jira-client.ts';
import type { AccessDecisions, CatalogFile } from '../src/catalog/types.ts';
import { buildCatalog, compareWithLock } from './lib/build.ts';
import { describeDiff, diffOperations } from './lib/diff.ts';
import {
  CATALOG_JSON,
  DECISIONS,
  SOURCE_LOCK,
  fetchSources,
  readCatalogJson,
  type SourceLock,
} from './lib/sources.ts';
import { runScript } from './lib/run-script.ts';

await runScript(async () => {
  const config = loadConfig(process.env);
  const client = new JiraClient({
    baseUrl: config.baseUrl,
    pat: config.pat,
    allowWrites: false,
    timeoutMs: 120_000,
    maxResponseBytes: 20 * 1024 * 1024,
  });

  const lock = await readCatalogJson<SourceLock>(
    SOURCE_LOCK,
    'restore it from git, or create it by following README "Catalogue et revue" (first generation)',
  );
  const decisions = await readCatalogJson<AccessDecisions>(
    DECISIONS,
    'the decisions file is versioned: restore it from git',
  );
  const { meta, xml } = await fetchSources(client);
  const { catalog, pending } = buildCatalog({ xml, decisions, meta, generatedAt: meta.fetchedAt });
  const problems = compareWithLock(meta, catalog, lock);

  console.error(
    `Jira: locked ${lock.jiraVersion} (build ${lock.jiraBuildNumber}, WADL ${lock.fetchedAt}) — live ${meta.jiraVersion} (build ${meta.jiraBuildNumber})`,
  );
  const local = await readCatalogJson<CatalogFile>(CATALOG_JSON, '').catch(() => undefined);
  if (local)
    console.error(
      describeDiff(
        diffOperations(local.operations, catalog.operations),
        'Opérations : catalogue local → instance',
      ),
    );
  if (pending.length > 0)
    console.error(`${pending.length} new review candidate(s) would be pending`);

  if (problems.length > 0) {
    for (const p of problems) console.error(`✖ ${p}`);
    console.error(
      'Drift detected: catalog:fetch, catalog:build, review, catalog:build -- --update-lock, then commit the lock.',
    );
    process.exitCode = 2;
    return;
  }
  console.error('✔ No drift.');
});
