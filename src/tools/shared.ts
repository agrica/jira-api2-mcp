import type {
  CallToolResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { runWithCancellation } from '../http/cancellation.ts';
import type { JiraClient, QueryValue } from '../http/jira-client.ts';

export interface ToolDeps {
  client: JiraClient;
  maxOutputChars: number;
}

/** Encodes one path segment. */
export const enc = encodeURIComponent;

/** Joins values with commas; `undefined` for a missing or empty list (so the parameter is omitted). */
export function join(values: readonly string[] | undefined): string | undefined {
  return values && values.length > 0 ? values.join(',') : undefined;
}

/** GET helper for read tools: `access: 'read'` (allowed in read-only mode, retried). */
export function readGet(client: JiraClient) {
  return async (path: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown> =>
    (await client.request({ method: 'GET', path, access: 'read', query })).data;
}

export const DEFAULT_ISSUE_FIELDS: readonly string[] = [
  'summary',
  'status',
  'assignee',
  'reporter',
  'priority',
  'issuetype',
  'created',
  'updated',
];

export const issueKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^(?:[A-Z][A-Z0-9_]*-\d+|\d+)$/,
    'Expected an issue key such as DEMO-123 or a numeric issue id',
  )
  .describe('Issue key (e.g. DEMO-123) or numeric issue id');

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Expected a project key such as DEMO')
  .describe('Project key, e.g. DEMO');

export const startAtSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('Index of the first result (pagination)');

export function maxResultsSchema(defaultValue: number) {
  return z.number().int().min(1).max(100).default(defaultValue).describe('Page size (1-100)');
}

/**
 * MCP annotations are HINTS for clients (e.g. to ask the user for confirmation).
 * They are not a security mechanism: the server enforces the write policy itself (see JiraClient).
 */
export const READ: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
export const WRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Never cut between the two halves of a surrogate pair: a lone surrogate is invalid JSON-RPC text.
  const lastCode = text.codePointAt(maxChars - 1) ?? 0;
  const cut = lastCode > 0xffff ? maxChars - 1 : maxChars;
  return `${text.slice(0, cut)}\n… [output truncated for the model: ${text.length - cut} more characters. Narrow the request (fields, maxResults, filters).]`;
}

export function jsonResult(data: unknown, maxChars: number): CallToolResult {
  const text =
    data === null || data === undefined
      ? 'OK (no content)'
      : typeof data === 'string'
        ? data
        : JSON.stringify(data);
  return { content: [{ type: 'text', text: truncate(text, maxChars) }] };
}

export function errorResult(error: unknown, maxChars?: number): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const text = maxChars === undefined ? message : truncate(message, maxChars);
  return { isError: true, content: [{ type: 'text', text }] };
}

export function defineTool<S extends z.ZodObject>(
  server: McpServer,
  deps: ToolDeps,
  name: string,
  config: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations },
  handler: (args: z.output<S>) => Promise<unknown>,
): void {
  // SDK 2.3.1: with a generic `S` the callback type `ToolCallback<S>` stays an unresolved
  // conditional type, so no `registerTool` overload matches. Register with the concrete
  // `z.ZodObject` type; the SDK validates the arguments against this same schema, hence the cast.
  const inputSchema: z.ZodObject = config.inputSchema;
  server.registerTool(name, { ...config, inputSchema }, async (args, ctx: ServerContext) => {
    try {
      // Cancelling the MCP call aborts the Jira request(s) made by the handler (see JiraClient).
      const data = await runWithCancellation(ctx.mcpReq.signal, () => handler(args as z.output<S>));
      return jsonResult(data, deps.maxOutputChars);
    } catch (error) {
      return errorResult(error, deps.maxOutputChars);
    }
  });
}
