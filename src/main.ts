import type { McpServer } from '@modelcontextprotocol/server';
import { Catalog, enabledFamilies } from './catalog/catalog.ts';
import { loadCatalogFile } from './catalog/load.ts';
import { loadConfig, startupWarnings } from './config.ts';
import { JiraClient } from './http/jira-client.ts';
import { createServer, type ServerDeps } from './server.ts';

export interface MainDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** One line to stderr: stdout is the MCP channel. */
  log: (line: string) => void;
  /** Serves the MCP protocol on stdio (serveStdio). */
  serve: (
    factory: () => McpServer,
    options: { onerror: (error: Error) => void },
  ) => unknown | Promise<unknown>;
  createServer?: (deps: ServerDeps) => McpServer;
}

const PREFIX = '[jira-mcp]';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Starts the server. Returns 0 once it serves, or 1 after one clean line on stderr (invalid
 * configuration, missing or invalid catalog, server that cannot be built). The instance URL
 * and the PAT are never logged: stderr may end up in shared logs (e.g. CI).
 */
export async function main(deps: MainDeps): Promise<number> {
  const { log, serve, createServer: makeServerWith = createServer } = deps;
  try {
    const config = loadConfig(deps.env);
    for (const warning of startupWarnings(config)) log(`${PREFIX} WARNING: ${warning}`);

    const catalogFile = await loadCatalogFile(config.catalogPath);
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
      enabledFamilies({ xray: config.enableXray }),
    );
    // The model is told too, through the tool description and the server instructions.
    if (catalog.families.includes('xray') && !catalog.availableFamilies.includes('xray')) {
      log(
        `${PREFIX} WARNING: JIRA_ENABLE_XRAY=true but the catalog has no Xray operation (plugin not installed, or catalog generated without it).`,
      );
    }

    const makeServer = () =>
      makeServerWith({ client, catalog, maxOutputChars: config.maxOutputChars });
    // serveStdio calls the factory lazily, on the first message: build one server now so that a
    // factory failure exits with a clear message instead of answering "Internal server error" forever.
    makeServer();

    await serve(makeServer, {
      onerror: (error) => log(`${PREFIX} ${error.stack ?? error.message}`),
    });
    log(
      `${PREFIX} ready (${config.allowWrites ? 'writes ENABLED' : 'read-only'}; Xray ${config.enableXray ? 'enabled' : 'disabled'}; catalog: ${catalog.size} operations from Jira ${catalogFile.meta.jiraVersion}, WADL fetched ${catalogFile.meta.fetchedAt})`,
    );
    return 0;
  } catch (error) {
    log(`${PREFIX} ${message(error)}`);
    return 1;
  }
}
