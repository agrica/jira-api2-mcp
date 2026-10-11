import { afterEach, describe, expect, it } from 'vitest';
import {
  createToolHarness,
  jsonResponse,
  noContent,
  type Harness,
} from '../test-support/harness.ts';
import { registerAgileTools } from './agile.ts';

describe('agile tools', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('jira_list_boards and jira_list_sprints build agile queries', async () => {
    h = await createToolHarness(registerAgileTools);
    h.fetchMock.mockImplementation(async () => jsonResponse({ values: [] }));
    await h.call('jira_list_boards', { projectKeyOrId: 'DEMO', type: 'kanban' });
    await h.call('jira_list_sprints', { boardId: 330, state: ['active', 'future'] });
    expect(h.request(0).url.pathname).toBe('/rest/agile/1.0/board');
    expect(Object.fromEntries(h.request(0).url.searchParams)).toEqual({
      projectKeyOrId: 'DEMO',
      type: 'kanban',
      startAt: '0',
      maxResults: '50',
    });
    expect(h.request(1).url.pathname).toBe('/rest/agile/1.0/board/330/sprint');
    expect(h.request(1).url.searchParams.get('state')).toBe('active,future');
  });

  it('jira_get_sprint_issues uses default fields', async () => {
    h = await createToolHarness(registerAgileTools);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [] }));
    await h.call('jira_get_sprint_issues', { sprintId: 12, jql: 'assignee = currentUser()' });
    expect(h.request().url.pathname).toBe('/rest/agile/1.0/sprint/12/issue');
    expect(h.request().url.searchParams.get('fields')).toContain('summary');
  });

  it('jira_move_issues_to_sprint exists only when writes are enabled', async () => {
    h = await createToolHarness(registerAgileTools);
    expect(await h.listToolNames()).not.toContain('jira_move_issues_to_sprint');
    await h.close();
    h = await createToolHarness(registerAgileTools, { allowWrites: true });
    h.fetchMock.mockResolvedValueOnce(noContent());
    await h.call('jira_move_issues_to_sprint', { sprintId: 12, issueKeys: ['demo-1', 'DEMO-2'] });
    expect(h.request()).toMatchObject({ method: 'POST', body: { issues: ['DEMO-1', 'DEMO-2'] } });
  });
});

describe('agile tools (paging, fields, annotations, errors)', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('bound maxResults to 50, the Agile 1.0 page cap, and say so', async () => {
    h = await createToolHarness(registerAgileTools);
    const tools = await h.listTools();
    for (const name of ['jira_list_boards', 'jira_list_sprints', 'jira_get_sprint_issues']) {
      const schema = tools.find((t) => t.name === name)?.inputSchema?.properties?.maxResults as
        | { maximum?: number; description?: string }
        | undefined;
      expect({ name, maximum: schema?.maximum }).toEqual({ name, maximum: 50 });
      expect({ name, description: schema?.description }).toMatchObject({
        name,
        description: expect.stringContaining('isLast'),
      });
    }
    h.fetchMock.mockImplementation(async () => jsonResponse({ values: [], isLast: true }));
    expect((await h.call('jira_list_sprints', { boardId: 1, maxResults: 51 })).isError).toBe(true);
    expect((await h.call('jira_list_boards', { maxResults: 100 })).isError).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect((await h.call('jira_list_boards', { maxResults: 50 })).isError).toBe(false);
    expect(h.request().url.searchParams.get('maxResults')).toBe('50');
  });

  it('jira_get_sprint_issues rejects an empty fields list and forwards an explicit one', async () => {
    h = await createToolHarness(registerAgileTools);
    const empty = await h.call('jira_get_sprint_issues', { sprintId: 12, fields: [] });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain('["*all"]');
    expect(h.fetchMock).not.toHaveBeenCalled();
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [] }));
    await h.call('jira_get_sprint_issues', { sprintId: 12, fields: ['*all'] });
    expect(h.request().url.searchParams.get('fields')).toBe('*all');
  });

  it('read tools are annotated read-only; the sprint move is an idempotent write', async () => {
    h = await createToolHarness(registerAgileTools, { allowWrites: true });
    const tools = new Map((await h.listTools()).map((t) => [t.name, t.annotations]));
    for (const name of ['jira_list_boards', 'jira_list_sprints', 'jira_get_sprint_issues']) {
      expect({ name, ...tools.get(name) }).toMatchObject({ name, readOnlyHint: true });
    }
    expect(tools.get('jira_move_issues_to_sprint')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('surfaces the Jira error for sprints of a Kanban board', async () => {
    h = await createToolHarness(registerAgileTools);
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ errorMessages: ['The board does not support sprints'], errors: {} }, 400),
    );
    const result = await h.call('jira_list_sprints', { boardId: 7 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('400');
    expect(result.text).toContain('The board does not support sprints');
  });

  it('jira_move_issues_to_sprint refuses more than 50 issues and reports 204 as OK', async () => {
    h = await createToolHarness(registerAgileTools, { allowWrites: true });
    const many = Array.from({ length: 51 }, (_, i) => `DEMO-${i + 1}`);
    expect(
      (await h.call('jira_move_issues_to_sprint', { sprintId: 3, issueKeys: many })).isError,
    ).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
    h.fetchMock.mockResolvedValueOnce(noContent());
    expect(
      await h.call('jira_move_issues_to_sprint', { sprintId: 3, issueKeys: many.slice(0, 50) }),
    ).toEqual({ isError: false, text: 'OK (no content)' });
  });
});
