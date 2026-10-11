import { afterEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from '../catalog/catalog.ts';
import type { Operation } from '../catalog/types.ts';
import {
  createToolHarness,
  jsonResponse,
  noContent,
  type Harness,
  type HarnessOptions,
} from '../test-support/harness.ts';
import { registerGenericTools } from './generic.ts';

const op = (
  o: Partial<Operation> & Pick<Operation, 'id' | 'method' | 'path' | 'access'>,
): Operation => ({
  api: 'api',
  summary: '',
  accessReason: 'test',
  body: { accepted: false, mediaTypes: [] },
  params: [],
  ...o,
});
const issueParam = {
  name: 'issueIdOrKey',
  in: 'path',
  type: 'string',
  required: true,
  repeating: false,
} as const;

const catalog = new Catalog([
  op({
    id: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
    method: 'GET',
    path: '/rest/api/2/issue/{issueIdOrKey}/comment',
    access: 'read',
    summary: 'Returns all comments for an issue',
    params: [
      issueParam,
      { name: 'maxResults', in: 'query', type: 'integer', required: false, repeating: false },
    ],
  }),
  op({
    id: 'POST /rest/api/2/search',
    method: 'POST',
    path: '/rest/api/2/search',
    access: 'read',
    accessReason: 'reviewed: JQL search (reviewer@example.org, 2026-10-11)',
    body: { accepted: true, mediaTypes: ['application/json'] },
  }),
  op({
    id: 'POST /rest/api/2/issue/{issueIdOrKey}/comment',
    method: 'POST',
    path: '/rest/api/2/issue/{issueIdOrKey}/comment',
    access: 'write',
    body: { accepted: true, mediaTypes: ['application/json'] },
    params: [issueParam],
  }),
  op({
    id: 'DELETE /rest/api/2/issue/{issueIdOrKey}',
    method: 'DELETE',
    path: '/rest/api/2/issue/{issueIdOrKey}',
    access: 'destructive',
    params: [issueParam],
  }),
]);

describe('generic catalog tools', () => {
  let h: Harness;
  const start = async (options?: HarnessOptions) => {
    h = await createToolHarness(
      (server, deps) => registerGenericTools(server, deps, catalog),
      options,
    );
  };
  afterEach(async () => {
    await h.close();
  });

  it('jira_list_operations returns ids, access classes and summaries, filterable by access', async () => {
    await start();
    const result = JSON.parse(
      (await h.call('jira_list_operations', { query: 'comment', access: 'read' })).text,
    ) as unknown;
    expect(result).toEqual({
      total: 1,
      returned: 1,
      operations: [
        {
          operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
          access: 'read',
          summary: 'Returns all comments for an issue',
        },
      ],
    });
  });

  it('jira_describe_operation returns the definition with validation notes, or a helpful error', async () => {
    await start();
    const ok = JSON.parse(
      (
        await h.call('jira_describe_operation', {
          operationId: 'POST /rest/api/2/issue/{issueIdOrKey}/comment',
        })
      ).text,
    ) as { access: string; notes: string[] };
    expect(ok.access).toBe('write');
    expect(ok.notes.join(' ')).toContain('does not say whether the body is required');
    const ko = await h.call('jira_describe_operation', { operationId: 'GET /rest/api/2/nope' });
    expect(ko).toEqual({ isError: true, text: expect.stringContaining('jira_list_operations') });
  });

  it('exposes only read tools, annotated read-only, while writes are disabled', async () => {
    await start();
    const tools = await h.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      'jira_call_read_operation',
      'jira_describe_operation',
      'jira_list_operations',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('jira_call_read_operation runs read operations, including a POST decided as read', async () => {
    await start();
    h.fetchMock
      .mockResolvedValueOnce(jsonResponse({ comments: [] }))
      .mockResolvedValueOnce(jsonResponse({ total: 0 }));
    const get = await h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: 'DEMO-1' },
      query: { maxResults: 5 },
    });
    expect(get).toEqual({ isError: false, text: '{"comments":[]}' });
    const search = await h.call('jira_call_read_operation', {
      operationId: 'POST /rest/api/2/search',
      body: { jql: 'project = DEMO', maxResults: 1 },
    });
    expect(search.isError).toBe(false);
    expect(h.request(1)).toMatchObject({
      method: 'POST',
      body: { jql: 'project = DEMO', maxResults: 1 },
    });
  });

  it('jira_call_read_operation refuses operations not classified as read, whatever the verb', async () => {
    await start();
    const result = await h.call('jira_call_read_operation', {
      operationId: 'POST /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: 'DEMO-1' },
      body: { body: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('classified "write"');
    expect(result.text).toContain('JIRA_ALLOW_WRITES=true');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces validation errors without calling Jira', async () => {
    await start();
    const result = await h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: '..' },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Invalid value for path parameter');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('jira_call_write_operation: conservative destructive annotation, runs writes, refuses reads', async () => {
    await start({ allowWrites: true });
    const writer = (await h.listTools()).find((t) => t.name === 'jira_call_write_operation');
    expect(writer?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(writer?.description).toContain('conservative');
    h.fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: '1' }, 201))
      .mockResolvedValueOnce(noContent());
    const comment = await h.call('jira_call_write_operation', {
      operationId: 'POST /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: 'DEMO-1' },
      body: { body: 'x' },
    });
    expect(comment.isError).toBe(false);
    const deleted = await h.call('jira_call_write_operation', {
      operationId: 'DELETE /rest/api/2/issue/{issueIdOrKey}',
      pathParams: { issueIdOrKey: 'DEMO-1' },
    });
    expect(deleted).toEqual({ isError: false, text: 'OK (no content)' });
    const misuse = await h.call('jira_call_write_operation', {
      operationId: 'POST /rest/api/2/search',
      body: {},
    });
    expect(misuse.isError).toBe(true);
    expect(misuse.text).toContain('jira_call_read_operation');
  });

  it('reports HTTP-level size limits and truncates model output', async () => {
    await start({ maxResponseBytes: 50 });
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ comments: 'x'.repeat(500) }));
    const tooBig = await h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: 'DEMO-1' },
    });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.text).toContain('JIRA_MAX_RESPONSE_BYTES');
    await h.close();
    await start({ maxOutputChars: 50 });
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ comments: 'x'.repeat(500) }));
    const truncated = await h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: 'DEMO-1' },
    });
    expect(truncated.text).toContain('[output truncated for the model:');
  });

  // H15 — end-to-end: cancelling the MCP call must abort the Jira request in flight.
  it('aborts the Jira request when the MCP call is cancelled', async () => {
    await start();
    let jiraSignal: AbortSignal | undefined;
    h.fetchMock.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          jiraSignal = init?.signal ?? undefined;
          jiraSignal?.addEventListener('abort', () => reject(jiraSignal?.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const pending = h.call(
      'jira_call_read_operation',
      {
        operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
        pathParams: { issueIdOrKey: 'DEMO-1' },
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    expect((await pending).isError).toBe(true);
    await vi.waitFor(() => expect(jiraSignal?.aborted).toBe(true));
    expect(h.fetchMock).toHaveBeenCalledOnce();
  });
});

describe('generic catalog tools (descriptions, binary bodies)', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  const describeList = async (cat: Catalog) => {
    h = await createToolHarness((server, deps) => registerGenericTools(server, deps, cat));
    return (await h.listTools()).find((t) => t.name === 'jira_list_operations')?.description ?? '';
  };

  it('jira_list_operations names the source WADLs and points to jira_describe_operation', async () => {
    const meta = {
      jiraVersion: '8.20.0',
      jiraBuildNumber: 820000,
      fetchedAt: '2026-01-02T03:04:05.000Z',
      generatedAt: '2026-01-02T03:05:00.000Z',
      counts: { api: 4, agile: 0, xray: 0 },
    };
    const description = await describeList(
      new Catalog(catalog.search({ limit: 1000 }).operations, meta),
    );
    expect(description).toContain('Search the 4 operations');
    expect(description).toContain('WADLs of the Jira 8.20.0 instance, fetched 2026-01-02');
    expect(description).toContain('jira_describe_operation');
  });

  it('jira_list_operations says so when the catalog is empty', async () => {
    const description = await describeList(new Catalog([]));
    expect(description).toContain('The catalog is empty');
    expect(description).not.toContain('Search the 0 operations');
  });

  it('jira_call_read_operation does not hand a binary body to the model', async () => {
    h = await createToolHarness((server, deps) => registerGenericTools(server, deps, catalog));
    h.fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    const result = await h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: 'DEMO-1' },
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('binary');
    expect(result.text).not.toContain('PNG');
  });
});

describe('binary detection', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  const readText = async (body: string) => {
    h = await createToolHarness((server, deps) => registerGenericTools(server, deps, catalog));
    h.fetchMock.mockResolvedValueOnce(
      new Response(body, { headers: { 'content-type': 'text/plain' } }),
    );
    return h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/issue/{issueIdOrKey}/comment',
      pathParams: { issueIdOrKey: 'DEMO-1' },
    });
  };

  it('lets a text with a few replacement characters through', async () => {
    const text = `Compte rendu de la r\uFFFDunion du jour. ${'Ligne de texte ordinaire. '.repeat(20)}Fin.`;
    expect(await readText(text)).toEqual({ isError: false, text });
  });

  it('treats a body dense in replacement characters as binary', async () => {
    const result = await readText('ab\uFFFDcd\uFFFD'.repeat(50));
    expect(result.text).toContain('binary');
  });
});
