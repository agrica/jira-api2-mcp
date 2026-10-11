import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import { JiraClient, type FetchLike } from '../http/jira-client.ts';
import type { ToolDeps } from '../tools/shared.ts';

export interface HarnessOptions {
  /** Defaults to false, like production. */
  allowWrites?: boolean;
  maxOutputChars?: number;
  maxResponseBytes?: number;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** Parsed JSON for string bodies, the raw value otherwise (e.g. FormData). */
  body: unknown;
}

export interface ListedTool {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
}

export interface Harness {
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
  call(
    name: string,
    args?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ isError: boolean; text: string }>;
  request(index?: number): RecordedRequest;
  listTools(): Promise<ListedTool[]>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export async function createHarness(
  build: (deps: ToolDeps) => McpServer,
  options: HarnessOptions = {},
): Promise<Harness> {
  const fetchMock = vi.fn<FetchLike>();
  const client = new JiraClient({
    baseUrl: 'https://jira.test',
    pat: 'test-pat',
    allowWrites: options.allowWrites ?? false,
    timeoutMs: 1000,
    maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024,
    fetch: fetchMock,
    sleep: async () => {},
  });
  const server = build({ client, maxOutputChars: options.maxOutputChars ?? 100_000 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'test-client', version: '0.0.0' });
  await mcp.connect(clientTransport);

  const listTools = async (): Promise<ListedTool[]> => {
    const { tools } = await mcp.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      annotations: t.annotations,
    }));
  };

  return {
    fetchMock,
    async call(name, args = {}, callOptions = {}) {
      try {
        const result = await mcp.callTool(
          { name, arguments: args },
          { signal: callOptions.signal },
        );
        const first = result.content[0];
        return { isError: result.isError === true, text: first?.type === 'text' ? first.text : '' };
      } catch (error) {
        // Unknown tools and input validation failures may surface as protocol errors.
        return { isError: true, text: error instanceof Error ? error.message : String(error) };
      }
    },
    request(index = 0) {
      const call = fetchMock.mock.calls[index];
      if (!call)
        throw new Error(`fetch call #${index} not found (${fetchMock.mock.calls.length} calls)`);
      const [input, init = {}] = call;
      const raw = init.body;
      return {
        method: init.method ?? 'GET',
        url: new URL(String(input)),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw,
      };
    },
    listTools,
    async listToolNames() {
      return (await listTools()).map((t) => t.name).toSorted();
    },
    async close() {
      await mcp.close();
      await server.close();
    },
  };
}

export function createToolHarness(
  register: (server: McpServer, deps: ToolDeps) => void,
  options: HarnessOptions = {},
): Promise<Harness> {
  return createHarness((deps) => {
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });
    register(server, deps);
    return server;
  }, options);
}
