import { afterEach, describe, expect, it } from 'vitest';
import { Catalog } from './catalog/catalog.ts';
import type { Operation } from './catalog/types.ts';
import { createServer } from './server.ts';
import { createHarness, jsonResponse, type Harness } from './test-support/harness.ts';

const op = (id: string, access: Operation['access']): Operation => {
  const [method, path] = id.split(' ') as [Operation['method'], string];
  return {
    id,
    api: 'api',
    method,
    path,
    summary: '',
    body: { accepted: false, mediaTypes: [] },
    params: [],
    access,
    accessReason: 'test',
  };
};
const withApi = (id: string, api: Operation['api']): Operation => ({ ...op(id, 'read'), api });
const catalog = new Catalog(
  [
    op('GET /rest/api/2/serverInfo', 'read'),
    op('POST /rest/api/2/issue', 'write'),
    op('DELETE /rest/api/2/version/1', 'destructive'),
  ],
  {
    jiraVersion: '8.20.0',
    jiraBuildNumber: 820000,
    fetchedAt: 'F',
    generatedAt: 'G',
    counts: { api: 3, agile: 0, xray: 0 },
  },
);
const WRITE_TOOLS = [
  'jira_create_issue',
  'jira_update_issue',
  'jira_transition_issue',
  'jira_add_comment',
  'jira_assign_issue',
  'jira_add_worklog',
  'jira_link_issues',
  'jira_add_attachment',
  'jira_delete_issue',
  'jira_move_issues_to_sprint',
  'jira_call_write_operation',
];

describe('createServer', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('is read-only by default: no write tool, only read-only annotations', async () => {
    h = await createHarness((deps) => createServer({ ...deps, catalog }));
    const tools = await h.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'jira_search_issues',
        'jira_call_read_operation',
        'jira_list_operations',
      ]),
    );
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(names.every((n) => /^jira_[a-z_]+$/.test(n))).toBe(true);
  });

  it('exposes write tools only when writes are enabled', async () => {
    h = await createHarness((deps) => createServer({ ...deps, catalog }), { allowWrites: true });
    expect(await h.listToolNames()).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });

  it('has the tool counts stated in README (31 tools, 11 of them writes)', async () => {
    h = await createHarness((deps) => createServer({ ...deps, catalog }), { allowWrites: true });
    const all = await h.listToolNames();
    await h.close();
    h = await createHarness((deps) => createServer({ ...deps, catalog }));
    const readOnly = await h.listToolNames();
    expect(all).toHaveLength(31);
    expect(all.length - readOnly.length).toBe(WRITE_TOOLS.length);
    expect(WRITE_TOOLS).toHaveLength(11);
  });

  const xrayCases: [string, Operation['api'][], Operation[], string[], RegExp][] = [
    [
      'disabled',
      ['api', 'agile'],
      [
        withApi('GET /rest/agile/1.0/board', 'agile'),
        withApi('GET /rest/raven/1.0/api/test', 'xray'),
      ],
      ['api', 'agile'],
      /for REST API v2 and Agile 1\.0 \(Xray is disabled on this server \(JIRA_ENABLE_XRAY\)\)\. Other/,
    ],
    [
      'enabled with Xray operations',
      ['api', 'agile', 'xray'],
      [
        withApi('GET /rest/agile/1.0/board', 'agile'),
        withApi('GET /rest/raven/1.0/api/test', 'xray'),
      ],
      ['api', 'agile', 'xray'],
      /for REST API v2, Agile 1\.0 and Xray\. Other/,
    ],
    [
      'enabled without Xray operations',
      ['api', 'agile', 'xray'],
      [withApi('GET /rest/agile/1.0/board', 'agile')],
      ['api', 'agile'],
      /for REST API v2 and Agile 1\.0 \(Xray is enabled but this catalog has no Xray operation/,
    ],
  ];

  it.each(xrayCases)(
    'describes the API families actually offered (Xray %s)',
    async (_label, families, extra, expectedEnum, description) => {
      const c = new Catalog(
        [op('GET /rest/api/2/serverInfo', 'read'), ...extra],
        undefined,
        families,
      );
      h = await createHarness((deps) => createServer({ ...deps, catalog: c }));
      const tool = (await h.listTools()).find((t) => t.name === 'jira_list_operations');
      expect(tool?.inputSchema?.properties?.api?.enum).toEqual(expectedEnum);
      expect(tool?.description).toMatch(description);
    },
  );

  it('serves an end-to-end read through the catalog', async () => {
    h = await createHarness((deps) => createServer({ ...deps, catalog }));
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ version: '8.20.0' }));
    const result = await h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/serverInfo',
    });
    expect(JSON.parse(result.text)).toEqual({ version: '8.20.0' });
  });
});
