/* oxlint-disable eslint/no-await-in-loop -- some cases call tools sequentially on purpose (shared mock) */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs } from '../test-support/catalog-fixture.ts';
import {
  createToolHarness,
  jsonResponse,
  noContent,
  type Harness,
} from '../test-support/harness.ts';
import { normaliseWorklogStarted, registerIssueWriteTools } from './issues-write.ts';

const enabled = { allowWrites: true };
const temp = tempDirs('jira8-mcp-attach-');
afterEach(async () => {
  await temp.cleanup();
});

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

  it('jira_create_issue keeps fields.description when the top-level param is absent', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', key: 'DEMO-3' }, 201));
    await h.call('jira_create_issue', {
      projectKey: 'DEMO',
      issueType: 'Task',
      summary: 'x',
      fields: { description: 'from fields' },
    });
    const fields = (h.request().body as { fields: Record<string, unknown> }).fields;
    expect(fields.description).toBe('from fields');
  });

  it('jira_create_issue lets the top-level description win over fields.description', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', key: 'DEMO-4' }, 201));
    await h.call('jira_create_issue', {
      projectKey: 'DEMO',
      issueType: 'Task',
      summary: 'x',
      description: 'top-level',
      fields: { description: 'from fields' },
    });
    const fields = (h.request().body as { fields: Record<string, unknown> }).fields;
    expect(fields.description).toBe('top-level');
  });

  it('jira_create_issue omits description when none is given', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', key: 'DEMO-5' }, 201));
    await h.call('jira_create_issue', { projectKey: 'DEMO', issueType: 'Task', summary: 'x' });
    const fields = (h.request().body as { fields: Record<string, unknown> }).fields;
    expect('description' in fields).toBe(false);
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
    const invalid = ['deux heures', 'abc', '1.5', 'h', '', '   ', '.5h', '1.h'];
    const results: Record<string, boolean> = {};
    for (const timeSpent of invalid) {
      results[timeSpent] = (
        await h.call('jira_add_worklog', { issueKey: 'DEMO-1', timeSpent })
      ).isError;
    }
    expect(results).toEqual(Object.fromEntries(invalid.map((d) => [d, true])));
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('jira_add_worklog accepts decimal and multi-unit durations', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const durations = ['1.5h', '0.5d', '2h 30m', '1w 2d', '3m'];
    const results: Record<string, boolean> = {};
    for (const timeSpent of durations) {
      h.fetchMock.mockResolvedValueOnce(jsonResponse({ id: '20' }, 201));
      results[timeSpent] = (
        await h.call('jira_add_worklog', { issueKey: 'DEMO-1', timeSpent })
      ).isError;
    }
    expect(results).toEqual(Object.fromEntries(durations.map((d) => [d, false])));
    durations.forEach((timeSpent, i) => {
      expect(h.request(i).body).toEqual({ timeSpent });
    });
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

  it('jira_link_issues sends numeric issue ids as ids, keys as keys', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await h.call('jira_link_issues', {
      linkType: 'Blocks',
      inwardIssue: '10001',
      outwardIssue: 'DEMO-2',
    });
    expect(h.request().body).toEqual({
      type: { name: 'Blocks' },
      inwardIssue: { id: '10001' },
      outwardIssue: { key: 'DEMO-2' },
    });
    h.fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await h.call('jira_link_issues', {
      linkType: 'Blocks',
      inwardIssue: 'DEMO-3',
      outwardIssue: '10002',
    });
    expect(h.request(1).body).toMatchObject({
      inwardIssue: { key: 'DEMO-3' },
      outwardIssue: { id: '10002' },
    });
  });

  it('jira_add_attachment uploads the given file as multipart', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const dir = await temp.make();
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
    // The tool's own error (the file read), not a schema refusal.
    expect(result).toEqual({ isError: true, text: expect.stringContaining('ENOENT') });
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

describe('worklog started', () => {
  it('keeps the Jira format and converts ISO 8601 forms to it', () => {
    expect(normaliseWorklogStarted('2025-01-15T09:30:00.000+0100')).toBe(
      '2025-01-15T09:30:00.000+0100',
    );
    expect(normaliseWorklogStarted('2025-01-15T09:30:00Z')).toBe('2025-01-15T09:30:00.000+0000');
    expect(normaliseWorklogStarted('2025-01-15T09:30:00.5+02:00')).toBe(
      '2025-01-15T09:30:00.500+0200',
    );
    expect(normaliseWorklogStarted('2025-01-15T09:30:00.123456-05:30')).toBe(
      '2025-01-15T09:30:00.123-0530',
    );
    expect(normaliseWorklogStarted(' 2024-02-29T23:59:59.999z ')).toBe(
      '2024-02-29T23:59:59.999+0000',
    );
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      '2025-01-15',
      '2025-01-15 09:30:00',
      '2025-01-15T09:30',
      '2025-01-15T09:30:00',
      '2025-01-15T09:30:00.000',
      '2025-01-15T09:30:00+1',
      '2025-02-30T09:30:00Z',
      '2025-13-01T09:30:00Z',
      '2025-01-15T24:00:00Z',
      '2025-01-15T09:60:00Z',
      '2025-01-15T09:30:00+1500',
      '2025-01-15T09:30:00+0160',
      '15/01/2025 09:30',
      'now',
    ]) {
      expect({ [bad]: normaliseWorklogStarted(bad) }).toEqual({ [bad]: undefined });
    }
  });
});

describe('issue write tools (validation, descriptions, annotations)', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('expose no tool at all while writes are disabled', async () => {
    h = await createToolHarness(registerIssueWriteTools);
    expect(await h.listToolNames()).toEqual([]);
  });

  it('annotate every write tool', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const tools = new Map((await h.listTools()).map((t) => [t.name, t.annotations]));
    expect(tools.size).toBe(9);
    const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    for (const name of [
      'jira_create_issue',
      'jira_update_issue',
      'jira_transition_issue',
      'jira_add_comment',
      'jira_add_worklog',
      'jira_link_issues',
      'jira_add_attachment',
    ]) {
      expect({ name, ...tools.get(name) }).toMatchObject({ name, ...write });
    }
    expect(tools.get('jira_assign_issue')).toMatchObject({ ...write, idempotentHint: true });
    expect(tools.get('jira_delete_issue')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('jira_add_worklog normalises "started" and rejects other formats with an example', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const bad = await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      started: '2025-01-15 09:30',
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}/);
    expect(h.fetchMock).not.toHaveBeenCalled();
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ id: '20' }, 201));
    await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      started: '2025-01-15T09:30:00+01:00',
    });
    expect(h.request().body).toEqual({ timeSpent: '1h', started: '2025-01-15T09:30:00.000+0100' });
    const tool = (await h.listTools()).find((t) => t.name === 'jira_add_worklog');
    expect(tool?.description).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('jira_add_worklog forwards the remaining-estimate controls', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockImplementation(async () => jsonResponse({ id: '20' }, 201));
    await h.call('jira_add_worklog', { issueKey: 'DEMO-1', timeSpent: '1h' });
    expect(h.request(0).url.search).toBe('');
    await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      adjustEstimate: 'new',
      newEstimate: '2d',
    });
    expect(Object.fromEntries(h.request(1).url.searchParams)).toEqual({
      adjustEstimate: 'new',
      newEstimate: '2d',
    });
    await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      adjustEstimate: 'manual',
      reduceBy: '30m',
    });
    expect(Object.fromEntries(h.request(2).url.searchParams)).toEqual({
      adjustEstimate: 'manual',
      reduceBy: '30m',
    });
    await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      adjustEstimate: 'leave',
    });
    expect(h.request(3).url.searchParams.get('adjustEstimate')).toBe('leave');
    const missingNew = await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      adjustEstimate: 'new',
    });
    expect(missingNew.text).toContain('newEstimate');
    const missingReduce = await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      adjustEstimate: 'manual',
    });
    expect(missingReduce.text).toContain('reduceBy');
    const stray = await h.call('jira_add_worklog', {
      issueKey: 'DEMO-1',
      timeSpent: '1h',
      newEstimate: '2d',
    });
    expect(stray.isError).toBe(true);
    expect(h.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('jira_update_issue sends notifyUsers only when false and documents the permission', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockImplementation(async () => noContent());
    await h.call('jira_update_issue', { issueKey: 'DEMO-1', fields: { summary: 'x' } });
    await h.call('jira_update_issue', {
      issueKey: 'DEMO-1',
      fields: { summary: 'x' },
      notifyUsers: true,
    });
    expect(h.request(0).url.search).toBe('');
    expect(h.request(1).url.search).toBe('');
    const tool = (await h.listTools()).find((t) => t.name === 'jira_update_issue');
    const notify = tool?.inputSchema?.properties?.notifyUsers as { description?: string };
    expect(notify.description).toMatch(/administrator/i);
  });

  it('jira_assign_issue sends "-1" for automatic assignment', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(noContent());
    await h.call('jira_assign_issue', { issueKey: 'DEMO-1', username: '-1' });
    expect(h.request().body).toEqual({ name: '-1' });
  });

  it('describe the link direction and how to create a sub-task', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const tools = new Map((await h.listTools()).map((t) => [t.name, t.description ?? '']));
    const link = tools.get('jira_link_issues') ?? '';
    expect(link).toContain('jira_list_issue_link_types');
    expect(link).toContain('not guaranteed');
    expect(link).toContain('jira_get_issue (fields ["issuelinks"])');
    expect(link).toContain('DELETE /rest/api/2/issueLink/{linkId}');
    expect(tools.get('jira_create_issue')).toContain('parent');
    const props = (await h.listTools()).find((t) => t.name === 'jira_link_issues')?.inputSchema
      ?.properties as Record<string, { description?: string }>;
    for (const name of ['inwardIssue', 'outwardIssue']) {
      expect({ name, description: props[name]?.description }).not.toMatchObject({
        description: expect.stringMatching(/block/i),
      });
    }
  });

  it('jira_add_worklog says a time without an offset is refused', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const props = (await h.listTools()).find((t) => t.name === 'jira_add_worklog')?.inputSchema
      ?.properties as Record<string, { description?: string }>;
    expect(props.started?.description).toContain('A time without an offset is refused');
  });

  it('jira_add_attachment explains a directory, an empty file and a missing file', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    const dir = await temp.make();
    const sub = join(dir, 'folder');
    await mkdir(sub);
    const empty = join(dir, 'empty.txt');
    await writeFile(empty, '');
    const asDir = await h.call('jira_add_attachment', { issueKey: 'DEMO-1', filePath: sub });
    expect(asDir).toEqual({ isError: true, text: expect.stringContaining('not a regular file') });
    const asEmpty = await h.call('jira_add_attachment', { issueKey: 'DEMO-1', filePath: empty });
    expect(asEmpty).toEqual({ isError: true, text: expect.stringContaining('is empty') });
    const missing = await h.call('jira_add_attachment', {
      issueKey: 'DEMO-1',
      filePath: join(dir, 'absent.txt'),
    });
    expect(missing).toEqual({ isError: true, text: expect.stringContaining('ENOENT') });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('jira_delete_issue surfaces Jira refusals', async () => {
    h = await createToolHarness(registerIssueWriteTools, enabled);
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ errorMessages: ['The issue has sub-tasks'], errors: {} }, 400),
    );
    const result = await h.call('jira_delete_issue', { issueKey: 'DEMO-1' });
    expect(result).toEqual({ isError: true, text: expect.stringContaining('sub-tasks') });
    expect(h.fetchMock).toHaveBeenCalledOnce();
  });
});
