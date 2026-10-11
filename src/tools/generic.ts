import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CatalogError,
  FAMILY_SWITCHES,
  describeOperation,
  type Catalog,
} from '../catalog/catalog.ts';
import { API_FAMILIES, type ApiFamily } from '../catalog/types.ts';
import { DESTRUCTIVE, READ, defineTool, type ToolDeps } from './shared.ts';

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const FAMILY_LABELS: Record<ApiFamily, { name: string; hint: string }> = {
  api: { name: 'REST API v2', hint: 'api = REST v2' },
  agile: { name: 'Agile 1.0', hint: 'agile = boards/sprints' },
  xray: { name: 'Xray', hint: 'xray = tests' },
};

/** "A, B and C" */
function familyNames(families: readonly ApiFamily[]): string {
  const names = families.map((family) => FAMILY_LABELS[family].name);
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : (names[0] ?? '');
}

/** Families offered to the model: those with operations, else every enabled family (never empty). */
function offeredFamilies(catalog: Catalog): readonly ApiFamily[] {
  return catalog.availableFamilies.length > 0 ? catalog.availableFamilies : catalog.families;
}

/**
 * What the catalog covers, in one wording shared by the server instructions and jira_list_operations,
 * e.g. "REST API v2 and Agile 1.0 (Xray is disabled on this server: JIRA_ENABLE_XRAY)".
 */
export function describeCoverage(catalog: Catalog): string {
  const notes: string[] = [];
  for (const family of API_FAMILIES) {
    const variable = FAMILY_SWITCHES[family];
    const { name } = FAMILY_LABELS[family];
    if (!catalog.families.includes(family)) {
      notes.push(`${name} is disabled on this server${variable ? ` (${variable})` : ''}`);
    } else if (catalog.size > 0 && !catalog.availableFamilies.includes(family)) {
      notes.push(
        `${name} is enabled but this catalog has no ${name} operation (plugin not installed, or catalog generated without it)`,
      );
    }
  }
  const covered = familyNames(offeredFamilies(catalog));
  return notes.length > 0 ? `${covered} (${notes.join('; ')})` : covered;
}

/**
 * A read operation may return a file (attachment content, avatar…). The client decodes non-JSON bodies
 * as text: binary bytes become NUL or U+FFFD characters, useless to the model. Return a note instead.
 */
function withoutBinary(data: unknown): unknown {
  if (typeof data !== 'string' || !(data.includes('\u0000') || data.includes('\uFFFD')))
    return data;
  return {
    binary: true,
    characters: data.length,
    note: 'Jira returned a binary (non-text) body; it is not passed to the model. Download it outside this MCP server.',
  };
}

const callInput = z.object({
  operationId: z.string().min(1).describe('e.g. "GET /rest/api/2/issue/{issueIdOrKey}"'),
  pathParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  query: z
    .record(z.string(), z.union([scalar, z.array(scalar)]))
    .optional()
    .describe('Only parameters declared by the operation. Arrays only for repeatable parameters.'),
  body: z
    .unknown()
    .optional()
    .describe('JSON body (Jira API v2: wiki markup text, users by "name")'),
});

export function registerGenericTools(server: McpServer, deps: ToolDeps, catalog: Catalog): void {
  const { client } = deps;
  const source = catalog.meta
    ? `WADLs of the Jira ${catalog.meta.jiraVersion} instance, fetched ${catalog.meta.fetchedAt},`
    : 'instance WADLs';
  const offered = offeredFamilies(catalog);
  const scope =
    catalog.size > 0
      ? `Search the ${catalog.size} operations described by the ${source} for ${describeCoverage(catalog)}.`
      : `The catalog is empty: no operation to search for ${describeCoverage(catalog)} (regenerate it with npm run catalog:build).`;

  defineTool(
    server,
    deps,
    'jira_list_operations',
    {
      title: 'List Jira REST operations',
      description: `${scope} Other REST families are not covered. All terms must match the operation id ("METHOD /path") or its summary. Each operation has an access class (read, write, destructive); jira_describe_operation gives its origin ("not individually reviewed" means the class comes from the HTTP method only).`,
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Keywords, e.g. "worklog", "sprint issue", "version"'),
        api: z
          // Non-empty tuple: Catalog guarantees at least one enabled family.
          .enum(offered as [ApiFamily, ...ApiFamily[]])
          .optional()
          .describe(offered.map((family) => FAMILY_LABELS[family].hint).join(', ')),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(),
        access: z.enum(['read', 'write', 'destructive']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ,
    },
    async ({ query, api, method, access, limit }) => {
      const { total, operations } = catalog.search({ query, api, method, access, limit });
      return {
        total,
        returned: operations.length,
        operations: operations.map((op) => ({
          operationId: op.id,
          access: op.access,
          summary: op.summary,
        })),
      };
    },
  );

  defineTool(
    server,
    deps,
    'jira_describe_operation',
    {
      title: 'Describe a Jira REST operation',
      description:
        'Full definition of an operation: access class and its origin, path/query parameters (type, required when declared, repeatable), accepted body media types, and what the server does and does not validate.',
      inputSchema: z.object({ operationId: z.string().min(1) }),
      annotations: READ,
    },
    async ({ operationId }) => describeOperation(catalog.require(operationId)),
  );

  defineTool(
    server,
    deps,
    'jira_call_read_operation',
    {
      title: 'Call a read operation',
      description:
        'Call a catalog operation classified "read" (includes POST operations reviewed as read, such as JQL search). Use jira_list_operations then jira_describe_operation first.',
      inputSchema: callInput,
      annotations: READ,
    },
    async ({ operationId, pathParams, query, body }) => {
      const op = catalog.require(operationId);
      if (op.access !== 'read') {
        throw new CatalogError(
          `${op.id} is classified "${op.access}" (${op.accessReason}). Use jira_call_write_operation${
            client.allowWrites
              ? ''
              : ', available only when the server runs with JIRA_ALLOW_WRITES=true'
          }.`,
        );
      }
      return withoutBinary(
        (await client.request(catalog.buildRequest(op, { pathParams, query, body }))).data,
      );
    },
  );

  if (!client.allowWrites) return;

  // H13 — conservative annotation: this single tool may call deletions, and an operation
  // classified "write" may turn out to be destructive if the review missed it. Annotations are
  // only hints for MCP clients; the server enforces the write policy itself.
  defineTool(
    server,
    deps,
    'jira_call_write_operation',
    {
      title: 'Call a write or destructive operation',
      description:
        'Call a catalog operation classified "write" or "destructive". Annotated destructive as a conservative choice, even for ordinary updates, because this tool can also call deletions. Never retried automatically. The WADL gives no body schema: check the operation with jira_describe_operation, Jira validates the content.',
      inputSchema: callInput,
      annotations: DESTRUCTIVE,
    },
    async ({ operationId, pathParams, query, body }) => {
      const op = catalog.require(operationId);
      if (op.access === 'read') {
        throw new CatalogError(`${op.id} is classified "read": use jira_call_read_operation.`);
      }
      return (await client.request(catalog.buildRequest(op, { pathParams, query, body }))).data;
    },
  );
}
