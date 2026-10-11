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
