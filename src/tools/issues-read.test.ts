import { afterEach, describe, expect, it } from 'vitest';
import { createToolHarness, jsonResponse, type Harness } from '../test-support/harness.ts';
import { registerIssueReadTools } from './issues-read.ts';

describe('issue read tools', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('work with writes disabled and POST accented JQL with default fields', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ startAt: 0, maxResults: 25, total: 1, issues: [{ key: 'DEMO-1' }] }),
    );
    const result = await h.call('jira_search_issues', {
      jql: 'project = DEMO AND status = "Fermée"',
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ total: 1 });
    const req = h.request();
    expect(req.method).toBe('POST');
    expect(req.url.pathname).toBe('/rest/api/2/search');
    expect(req.url.search).toBe('');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.body).toEqual({
      jql: 'project = DEMO AND status = "Fermée"',
      startAt: 0,
      maxResults: 25,
      fields: [
        'summary',
        'status',
        'assignee',
        'reporter',
        'priority',
        'issuetype',
        'created',
        'updated',
      ],
    });
  });

  it('jira_search_issues splits expand into an array and is retried as a read', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ total: 0, issues: [] }));
    const result = await h.call('jira_search_issues', {
      jql: 'project = DEMO',
      fields: ['summary'],
      expand: ' renderedFields, ,changelog ,',
      startAt: 10,
      maxResults: 5,
    });
    expect(result.isError).toBe(false);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.request(1).body).toEqual({
      jql: 'project = DEMO',
      startAt: 10,
      maxResults: 5,
      fields: ['summary'],
      expand: ['renderedFields', 'changelog'],
    });
  });

  it('jira_search_issues marks oversized output as truncated', async () => {
    h = await createToolHarness(registerIssueReadTools, { maxOutputChars: 200 });
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ issues: Array.from({ length: 50 }, (_, i) => ({ key: `DEMO-${i}` })) }),
    );
    const result = await h.call('jira_search_issues', { jql: 'project = DEMO', fields: ['*all'] });
    expect(result.text).toContain('[output truncated for the model:');
    expect((h.request().body as { fields: string[] }).fields).toEqual(['*all']);
  });

  it('jira_get_issue normalises the key and forwards fields/expand', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ key: 'DEMO-123' }));
    await h.call('jira_get_issue', {
      issueKey: 'demo-123',
      fields: ['summary', 'customfield_10001'],
      expand: ['renderedFields'],
    });
    const req = h.request();
    expect(req.url.pathname).toBe('/rest/api/2/issue/DEMO-123');
    expect(req.url.searchParams.get('fields')).toBe('summary,customfield_10001');
    expect(req.url.searchParams.get('expand')).toBe('renderedFields');
  });

  it('rejects malformed issue keys before calling Jira', async () => {
    h = await createToolHarness(registerIssueReadTools);
    expect((await h.call('jira_get_issue', { issueKey: '../../myself' })).isError).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('jira_get_transitions can include transition screen fields', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockImplementation(async () => jsonResponse({ transitions: [] }));
    await h.call('jira_get_transitions', { issueKey: 'DEMO-1' });
    await h.call('jira_get_transitions', { issueKey: 'DEMO-1', includeFields: true });
    expect(h.request(0).url.search).toBe('');
    expect(h.request(1).url.searchParams.get('expand')).toBe('transitions.fields');
  });

  it('jira_get_comments paginates and orders', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ comments: [] }));
    await h.call('jira_get_comments', { issueKey: 'DEMO-1', orderBy: '-created' });
    expect(Object.fromEntries(h.request().url.searchParams)).toEqual({
      startAt: '0',
      maxResults: '50',
      orderBy: '-created',
    });
  });

  it('jira_get_create_meta and jira_get_edit_meta hit the meta endpoints', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockImplementation(async () => jsonResponse({}));
    await h.call('jira_get_create_meta', { projectKey: 'demo', issueType: 'Task' });
    await h.call('jira_get_edit_meta', { issueKey: 'DEMO-1' });
    expect(h.request(0).url.pathname).toBe('/rest/api/2/issue/createmeta');
    expect(Object.fromEntries(h.request(0).url.searchParams)).toEqual({
      projectKeys: 'DEMO',
      issuetypeNames: 'Task',
      expand: 'projects.issuetypes.fields',
    });
    expect(h.request(1).url.pathname).toBe('/rest/api/2/issue/DEMO-1/editmeta');
  });
});

describe('issue read tools (validation, hints, errors)', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('reject an empty fields list with a hint about ["*all"]', async () => {
    h = await createToolHarness(registerIssueReadTools);
    const search = await h.call('jira_search_issues', { jql: 'project = DEMO', fields: [] });
    const issue = await h.call('jira_get_issue', { issueKey: 'DEMO-1', fields: [] });
    for (const result of [search, issue]) {
      expect(result.isError).toBe(true);
      expect(result.text).toContain('["*all"]');
    }
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('jira_search_issues accepts maxResults 0 (total only), not 101', async () => {
    h = await createToolHarness(registerIssueReadTools);
    expect((await h.call('jira_search_issues', { jql: 'x = 1', maxResults: 101 })).isError).toBe(
      true,
    );
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ total: 42, issues: [] }));
    expect((await h.call('jira_search_issues', { jql: 'x = 1', maxResults: 0 })).isError).toBe(
      false,
    );
    expect(h.request().body).toMatchObject({ maxResults: 0 });
    const tools = await h.listTools();
    const search = tools.find((t) => t.name === 'jira_search_issues');
    expect(search?.description).toContain('8.x');
    expect(search?.description).not.toContain('8.20');
  });

  it('jira_search_issues also accepts expand as a list, like jira_get_issue', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ total: 0, issues: [] }));
    await h.call('jira_search_issues', { jql: 'x = 1', expand: ['changelog', ' names '] });
    expect(h.request().body).toMatchObject({ expand: ['changelog', 'names'] });
  });

  it('jira_get_create_meta explains an empty projects list', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ expand: 'projects', projects: [] }));
    const result = JSON.parse(
      (await h.call('jira_get_create_meta', { projectKey: 'DEMO', issueType: 'task' })).text,
    ) as { projects: unknown[]; hint: string };
    expect(result.projects).toEqual([]);
    expect(result.hint).toMatch(/unknown project/i);
    expect(result.hint).toContain('permission');
    expect(result.hint).toContain('jira_get_project');
  });

  it('jira_get_create_meta explains a project without the requested issue type', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ projects: [{ key: 'DEMO', issuetypes: [] }] }),
    );
    const result = JSON.parse(
      (await h.call('jira_get_create_meta', { projectKey: 'DEMO', issueType: 'task' })).text,
    ) as { projects: unknown[]; hint: string };
    expect(result.projects).toEqual([{ key: 'DEMO', issuetypes: [] }]);
    expect(result.hint).toContain('"task"');
  });

  it('jira_get_create_meta returns a non-empty answer unchanged and documents its size', async () => {
    h = await createToolHarness(registerIssueReadTools);
    const meta = { projects: [{ key: 'DEMO', issuetypes: [{ name: 'Task', fields: {} }] }] };
    h.fetchMock.mockResolvedValueOnce(jsonResponse(meta));
    expect(JSON.parse((await h.call('jira_get_create_meta', { projectKey: 'DEMO' })).text)).toEqual(
      meta,
    );
    const tool = (await h.listTools()).find((t) => t.name === 'jira_get_create_meta');
    expect(tool?.description).toMatch(/without issueType/i);
    expect(tool?.description).toContain('empty "projects"');
  });

  it('surface Jira errors (invalid JQL, missing issue) as tool errors', async () => {
    h = await createToolHarness(registerIssueReadTools);
    h.fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ errorMessages: ["Field 'foo' does not exist"], errors: {} }, 400),
      )
      .mockResolvedValueOnce(
        jsonResponse({ errorMessages: ['Issue Does Not Exist'], errors: {} }, 404),
      );
    const search = await h.call('jira_search_issues', { jql: 'foo = 1' });
    expect(search).toEqual({ isError: true, text: expect.stringContaining("Field 'foo'") });
    const issue = await h.call('jira_get_issue', { issueKey: 'DEMO-404' });
    expect(issue).toEqual({ isError: true, text: expect.stringContaining('Issue Does Not Exist') });
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('every tool is annotated read-only', async () => {
    h = await createToolHarness(registerIssueReadTools);
    const tools = await h.listTools();
    expect(tools).toHaveLength(6);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });
});

describe('fields parameter wording', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('says what omitting fields returns, per tool', async () => {
    h = await createToolHarness(registerIssueReadTools);
    const tools = await h.listTools();
    const fieldsOf = (name: string) => {
      const props = tools.find((t) => t.name === name)?.inputSchema?.properties ?? {};
      return (props.fields as { description?: string } | undefined)?.description ?? '';
    };
    expect(fieldsOf('jira_search_issues')).toContain('Omit for the default list');
    expect(fieldsOf('jira_get_issue')).toContain('Omit for all fields');
    expect(fieldsOf('jira_get_issue')).not.toContain('default list');
    const empty = await h.call('jira_get_issue', { issueKey: 'DEMO-1', fields: [] });
    expect(empty.text).not.toContain('default list');
  });
});
