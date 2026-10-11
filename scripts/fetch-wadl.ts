import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.ts';
import { JiraClient } from '../src/http/jira-client.ts';
import { compareSourcesWithLock } from './lib/build.ts';
import { FETCH_META, SOURCE_LOCK, WADL_DIR, fetchSources, type SourceLock } from './lib/sources.ts';
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

  const { meta, xml } = await fetchSources(client);
  await mkdir(WADL_DIR, { recursive: true });
  for (const [file, text] of xml)
    // oxlint-disable-next-line eslint/no-await-in-loop -- three small local writes, sequential
    await writeFile(new URL(file, WADL_DIR), text, 'utf8');
  // A source that disappeared must not leave a stale file behind.
  for (const file of meta.absent)
    // oxlint-disable-next-line eslint/no-await-in-loop -- at most a few local deletions
    await rm(new URL(file, WADL_DIR), { force: true });
  await writeFile(FETCH_META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.error(
    `✔ Jira ${meta.jiraVersion} (build ${meta.jiraBuildNumber}) — WADL fetched at ${meta.fetchedAt}`,
  );

  const lock = await readFile(SOURCE_LOCK, 'utf8')
    .then((t) => JSON.parse(t) as SourceLock)
    .catch(() => undefined);
  if (!lock) {
    console.error('  no catalog/source-lock.json yet: first generation');
  } else {
    const sourceDrift = compareSourcesWithLock(meta, lock);
    const sameVersion =
      meta.jiraVersion === lock.jiraVersion && meta.jiraBuildNumber === lock.jiraBuildNumber;
    console.error(
      sourceDrift.length === 0 && sameVersion
        ? '  matches catalog/source-lock.json'
        : `  differs from catalog/source-lock.json (version ${lock.jiraVersion} → ${meta.jiraVersion}; ${sourceDrift.join('; ') || 'same files'})`,
    );
  }
});
