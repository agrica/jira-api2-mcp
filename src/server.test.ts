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

  it('describes Xray only when its family is enabled', async () => {
    const listOperations = async (families?: Operation['api'][]) => {
      const c = new Catalog([op('GET /rest/api/2/serverInfo', 'read')], undefined, families);
      h = await createHarness((deps) => createServer({ ...deps, catalog: c }));
      const tool = (await h.listTools()).find((t) => t.name === 'jira_list_operations');
      await h.close();
      return tool;
    };
    const disabled = await listOperations(['api', 'agile']);
    expect(disabled?.inputSchema?.properties?.api?.enum).toEqual(['api', 'agile']);
    expect(disabled?.description).toMatch(/REST API v2 and Agile 1.0 .*Xray is disabled/);
    const enabled = await listOperations(['api', 'agile', 'xray']);
    expect(enabled?.inputSchema?.properties?.api?.enum).toEqual(['api', 'agile', 'xray']);
    expect(enabled?.description).toMatch(/REST API v2, Agile 1.0 and Xray \(other/);
    h = await createHarness((deps) => createServer({ ...deps, catalog }));
  });

  it('serves an end-to-end read through the catalog', async () => {
    h = await createHarness((deps) => createServer({ ...deps, catalog }));
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ version: '8.20.0' }));
    const result = await h.call('jira_call_read_operation', {
      operationId: 'GET /rest/api/2/serverInfo',
    });
    expect(JSON.parse(result.text)).toEqual({ version: '8.20.0' });
  });
});
