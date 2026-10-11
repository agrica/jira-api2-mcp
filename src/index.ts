#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Catalog, enabledFamilies } from './catalog/catalog.ts';
import { loadCatalogFile } from './catalog/load.ts';
import type { CatalogFile } from './catalog/types.ts';
import { loadConfig, startupWarnings, type JiraConfig } from './config.ts';
import { JiraClient } from './http/jira-client.ts';
import { createServer } from './server.ts';

function fail(error: unknown): never {
  console.error(`[jira-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let config: JiraConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  fail(error);
}
for (const warning of startupWarnings(config)) console.error(`[jira-mcp] WARNING: ${warning}`);

let catalogFile: CatalogFile;
try {
  catalogFile = await loadCatalogFile(config.catalogPath);
} catch (error) {
  fail(error);
}

const client = new JiraClient({
  baseUrl: config.baseUrl,
  pat: config.pat,
  allowWrites: config.allowWrites,
  timeoutMs: config.timeoutMs,
  maxResponseBytes: config.maxResponseBytes,
});
const catalog = new Catalog(
  catalogFile.operations,
  catalogFile.meta,
  enabledFamilies(config.enableXray),
);
if (config.enableXray && catalogFile.meta.counts.xray === 0) {
  console.error(
    '[jira-mcp] WARNING: JIRA_ENABLE_XRAY=true but the catalog has no Xray operation (plugin not installed, or catalog built without it).',
  );
}

serveStdio(() => createServer({ client, catalog, maxOutputChars: config.maxOutputChars }), {
  onerror: (error) => console.error('[jira-mcp]', error.message),
});
console.error(
  // The instance URL is not logged: stderr may end up in shared logs (e.g. CI).
  `[jira-mcp] ready (${config.allowWrites ? 'writes ENABLED' : 'read-only'}; Xray ${config.enableXray ? 'enabled' : 'disabled'}; catalog: ${catalog.size} operations from Jira ${catalogFile.meta.jiraVersion}, WADL fetched ${catalogFile.meta.fetchedAt})`,
);
