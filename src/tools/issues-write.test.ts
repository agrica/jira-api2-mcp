import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createToolHarness,
  jsonResponse,
  noContent,
  type Harness,
} from '../test-support/harness.ts';
import { registerIssueWriteTools } from './issues-write.ts';

const enabled = { allowWrites: true };

describe('issue write tools', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('are not available while writes are disabled (the default)', async () => {
    h = await createToolHarness(registerIssueWriteTools);
    const result = await h.call('jira_create_issue', {
      projectKey: 'DEMO',
      issueType: 'Task',
      summary: 'x',
    });
    expect(result.isError).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('carry precise annotations when enabled', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const tools = new Map((await h.listTools()).map((t) => [t.name, t.annotations]));
    expect(tools.get('jira_create_issue')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(tools.get('jira_assign_issue')).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools.get('jira_add_attachment')).toMatchObject({ destructiveHint: false });
    expect(tools.get('jira_delete_issue')).toMatchObject({ destructiveHint: true });
  });

  it('jira_create_issue merges custom fields under the standard ones', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', key: 'DEMO-2' }, 201));
    const result = await h.call('jira_create_issue', {
      projectKey: 'demo',
      issueType: 'Task',
      summary: '[PRODUCTION] - BO - Déploiement',
      description: 'h2. Contexte',
      fields: { customfield_10001: { value: 'Production' }, summary: 'ignored' },
    });
    expect(JSON.parse(result.text)).toEqual({ id: '1', key: 'DEMO-2' });
    expect(h.request()).toMatchObject({
      method: 'POST',
      body: {
        fields: {
          customfield_10001: { value: 'Production' },
          project: { key: 'DEMO' },
          issuetype: { name: 'Task' },
          summary: '[PRODUCTION] - BO - Déploiement',
          description: 'h2. Contexte',
        },
      },
    });
  });

  it('jira_create_issue is never retried and surfaces Jira field errors', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const busy = await h.call('jira_create_issue', {
      projectKey: 'DEMO',
      issueType: 'Task',
      summary: 'x',
    });
    expect(busy.isError).toBe(true);
    expect(h.fetchMock).toHaveBeenCalledOnce();
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { errorMessages: [], errors: { customfield_10001: 'Environnement est obligatoire.' } },
        400,
      ),
    );
    const invalid = await h.call('jira_create_issue', {
      projectKey: 'DEMO',
      issueType: 'Task',
      summary: 'x',
    });
    expect(invalid.text).toContain('customfield_10001: Environnement est obligatoire.');
  });

  it('jira_update_issue sends fields/update, reports 204 as OK and requires something to change', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(noContent());
    const result = await h.call('jira_update_issue', {
      issueKey: 'DEMO-1',
      fields: { summary: 'Nouveau résumé' },
      update: { labels: [{ add: 'mep' }] },
      notifyUsers: false,
    });
    expect(result).toEqual({ isError: false, text: 'OK (no content)' });
    expect(h.request().url.searchParams.get('notifyUsers')).toBe('false');
    expect(h.request().body).toEqual({
      fields: { summary: 'Nouveau résumé' },
      update: { labels: [{ add: 'mep' }] },
    });
    const empty = await h.call('jira_update_issue', { issueKey: 'DEMO-1' });
    expect(empty.text).toContain('"fields" and/or "update"');
    expect(h.fetchMock).toHaveBeenCalledOnce();
  });

  it('jira_transition_issue posts transition, fields and comment', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(noContent());
    await h.call('jira_transition_issue', {
      issueKey: 'DEMO-1',
      transitionId: '11',
      fields: { customfield_10002: { value: 'Non' } },
      comment: 'Release rescheduled',
    });
    expect(h.request().url.pathname).toBe('/rest/api/2/issue/DEMO-1/transitions');
    expect(h.request().body).toEqual({
      transition: { id: '11' },
      fields: { customfield_10002: { value: 'Non' } },
      update: { comment: [{ add: { body: 'Release rescheduled' } }] },
    });
  });

  it('jira_add_comment, jira_assign_issue and jira_add_worklog build the expected bodies', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: '10' }, 201))
      .mockResolvedValueOnce(noContent())
      .mockResolvedValueOnce(noContent())
      .mockResolvedValueOnce(jsonResponse({ id: '20' }, 201));
    await h.call('jira_add_comment', {
      issueKey: 'DEMO-1',
      body: 'Bonjour *équipe*',
      visibility: { type: 'group', value: 'developers' },
    });
    await h.call('jira_assign_issue', { issueKey: 'DEMO-1', username: 'jdoe' });
    await h.call('jira_assign_issue', { issueKey: 'DEMO-1', username: null });
    await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h 30m',
      comment: 'Deployment',
    });
    expect(h.request(0).body).toEqual({
      body: 'Bonjour *équipe*',
      visibility: { type: 'group', value: 'developers' },
    });
    expect(h.request(1)).toMatchObject({ method: 'PUT', body: { name: 'jdoe' } });
    expect(h.request(2).body).toEqual({ name: null });
    expect(h.request(3).body).toEqual({ timeSpent: '1h 30m', comment: 'Deployment' });
  });

  it('jira_add_worklog rejects malformed durations', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    expect(
      (await h.call('jira_add_worklog', { issueKey: 'DEMO-1', timeSpent: 'deux heures' })).isError,
    ).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('jira_link_issues posts an issueLink', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await h.call('jira_link_issues', {
      linkType: 'Relates',
      inwardIssue: 'DEMO-1',
      outwardIssue: 'other-7',
      comment: 'lié',
    });
    expect(h.request().body).toEqual({
      type: { name: 'Relates' },
      inwardIssue: { key: 'DEMO-1' },
      outwardIssue: { key: 'OTHER-7' },
      comment: { body: 'lié' },
    });
  });

  it('jira_add_attachment uploads the given file as multipart', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-'));
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'contenu');
    h.fetchMock.mockResolvedValueOnce(jsonResponse([{ filename: 'notes.txt' }]));
    expect(
      (await h.call('jira_add_attachment', { issueKey: 'DEMO-1', filePath: file })).isError,
    ).toBe(false);
    const req = h.request();
    expect(req.url.pathname).toBe('/rest/api/2/issue/DEMO-1/attachments');
    expect(req.headers['X-Atlassian-Token']).toBe('no-check');
    const uploaded = (req.body as FormData).get('file') as File;
    expect(uploaded.name).toBe('notes.txt');
    expect(await uploaded.text()).toBe('contenu');
  });

  it('jira_add_attachment reports a missing file', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const result = await h.call('jira_add_attachment', {
      issueKey: 'DEMO-1',
      filePath: join(tmpdir(), 'absent-xyz.txt'),
    });
    expect(result.isError).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('jira_delete_issue sends DELETE with deleteSubtasks', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(noContent());
    await h.call('jira_delete_issue', { issueKey: 'DEMO-1', deleteSubtasks: true });
    expect(h.request()).toMatchObject({ method: 'DELETE' });
    expect(h.request().url.searchParams.get('deleteSubtasks')).toBe('true');
  });
});
