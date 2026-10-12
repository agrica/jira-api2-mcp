import { McpServer } from '@modelcontextprotocol/server';
import type { Catalog } from './catalog/catalog.ts';
import { registerAgileTools } from './tools/agile.ts';
import { describeCoverage, registerGenericTools } from './tools/generic.ts';
import { registerIssueReadTools } from './tools/issues-read.ts';
import { registerIssueWriteTools } from './tools/issues-write.ts';
import { registerMetadataTools } from './tools/metadata.ts';
import type { ToolDeps } from './tools/shared.ts';
import { VERSION } from './version.ts';

export interface ServerDeps extends ToolDeps {
  catalog: Catalog;
}

function instructions(deps: ServerDeps): string {
  return [
    'Jira Server / Data Center (REST API v2): text fields use wiki markup, users are identified by "name".',
    deps.client.allowWrites
      ? 'Writes are ENABLED; they are never retried automatically.'
      : 'This server is READ-ONLY: write tools are not available.',
    'Prefer the dedicated jira_* tools. Otherwise find an operation with jira_list_operations, check it with jira_describe_operation,',
    'then call it with jira_call_read_operation (or jira_call_write_operation when writes are enabled).',
    `The catalog covers ${describeCoverage(deps.catalog)}, as described by the instance WADL only.`,
    'Custom field ids (customfield_NNNNN) can be looked up with jira_list_fields.',
  ].join(' ');
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: 'jira8-mcp', version: VERSION },
    { instructions: instructions(deps) },
  );
  registerMetadataTools(server, deps);
  registerIssueReadTools(server, deps);
  registerIssueWriteTools(server, deps);
  registerAgileTools(server, deps);
  registerGenericTools(server, deps, deps.catalog);
  return server;
}
