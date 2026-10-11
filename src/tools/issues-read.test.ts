import { afterEach, describe, expect, it } from 'vitest';
import { createToolHarness, jsonResponse, type Harness } from '../test-support/harness.ts';
import { registerIssueReadTools } from './issues-read.ts';

describe('issue read tools', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('work with writes disabled and send accented JQL with default fields', async () => {
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
    expect(req.method).toBe('GET');
    expect(req.url.pathname).toBe('/rest/api/2/search');
    expect(req.url.searchParams.get('jql')).toBe('project = DEMO AND status = "Fermée"');
    expect(req.url.search).toContain('Ferm%C3%A9e');
    expect(req.url.searchParams.get('fields')).toBe(
      'summary,status,assignee,reporter,priority,issuetype,created,updated',
    );
    expect(req.url.searchParams.get('maxResults')).toBe('25');
  });

  it('jira_search_issues marks oversized output as truncated', async () => {
    h = await createToolHarness(registerIssueReadTools, { maxOutputChars: 200 });
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ issues: Array.from({ length: 50 }, (_, i) => ({ key: `DEMO-${i}` })) }),
    );
    const result = await h.call('jira_search_issues', { jql: 'project = DEMO', fields: ['*all'] });
    expect(result.text).toContain('[output truncated for the model:');
    expect(h.request().url.searchParams.get('fields')).toBe('*all');
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
