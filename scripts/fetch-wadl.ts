import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.ts';
import { JiraClient } from '../src/http/jira-client.ts';
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
    const changed = meta.sources.filter(
      (s) => lock.sources.find((l) => l.file === s.file)?.sha256 !== s.sha256,
    );
    const sameVersion =
      meta.jiraVersion === lock.jiraVersion && meta.jiraBuildNumber === lock.jiraBuildNumber;
    console.error(
      changed.length === 0 && sameVersion
        ? '  matches catalog/source-lock.json'
        : `  differs from catalog/source-lock.json (version ${lock.jiraVersion} → ${meta.jiraVersion}; files: ${changed.map((s) => s.file).join(', ') || 'none'})`,
    );
  }
});
