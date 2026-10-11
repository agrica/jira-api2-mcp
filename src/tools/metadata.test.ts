import { afterEach, describe, expect, it } from 'vitest';
import { createToolHarness, jsonResponse, type Harness } from '../test-support/harness.ts';
import { registerMetadataTools } from './metadata.ts';

describe('metadata tools', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('simple GET tools hit the right endpoints with writes disabled', async () => {
    h = await createToolHarness(registerMetadataTools);
    h.fetchMock.mockImplementation(async () => jsonResponse({}));
    await h.call('jira_get_server_info');
    await h.call('jira_get_current_user');
    await h.call('jira_search_users', { query: 'doe' });
    await h.call('jira_get_project', { projectKey: 'demo' });
    await h.call('jira_get_project_statuses', { projectKey: 'DEMO' });
    await h.call('jira_list_issue_link_types');
    expect(
      h.fetchMock.mock.calls.map((_, i) => h.request(i).url.pathname + h.request(i).url.search),
    ).toEqual([
      '/rest/api/2/serverInfo',
      '/rest/api/2/myself',
      '/rest/api/2/user/search?username=doe&maxResults=20',
      '/rest/api/2/project/DEMO',
      '/rest/api/2/project/DEMO/statuses',
      '/rest/api/2/issueLinkType',
    ]);
  });

  it('jira_list_projects returns a compact list', async () => {
    h = await createToolHarness(registerMetadataTools);
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: '10000',
          key: 'DEMO',
          name: 'Demo project',
          projectTypeKey: 'software',
          avatarUrls: {},
        },
      ]),
    );
    expect(JSON.parse((await h.call('jira_list_projects')).text)).toEqual([
      { id: '10000', key: 'DEMO', name: 'Demo project', projectTypeKey: 'software' },
    ]);
  });

  it('jira_list_fields filters by accent-insensitive name or id', async () => {
    h = await createToolHarness(registerMetadataTools);
    h.fetchMock.mockImplementation(async () =>
      jsonResponse([
        { id: 'summary', name: 'Résumé', custom: false, schema: { type: 'string' } },
        {
          id: 'customfield_10021',
          name: "Lien d'épopée",
          custom: true,
          schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' },
        },
        { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { type: 'array' } },
      ]),
    );
    expect(JSON.parse((await h.call('jira_list_fields', { query: 'epopee' })).text)).toEqual([
      {
        id: 'customfield_10021',
        name: "Lien d'épopée",
        custom: true,
        type: 'any',
        customType: 'com.pyxis.greenhopper.jira:gh-epic-link',
      },
    ]);
    const byId = JSON.parse((await h.call('jira_list_fields', { query: '10020' })).text) as {
      id: string;
    }[];
    expect(byId.map((f) => f.id)).toEqual(['customfield_10020']);
    expect(JSON.parse((await h.call('jira_list_fields', { customOnly: true })).text)).toHaveLength(
      2,
    );
  });
});

describe('metadata tools (filters, annotations, errors)', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('jira_list_projects filters by key or name, ignoring case and accents', async () => {
    h = await createToolHarness(registerMetadataTools);
    h.fetchMock.mockImplementation(async () =>
      jsonResponse([
        { id: '10000', key: 'DEMO', name: 'Démo', projectTypeKey: 'software' },
        { id: '10001', key: 'OPS', name: 'Exploitation', projectTypeKey: 'business' },
      ]),
    );
    const byName = JSON.parse((await h.call('jira_list_projects', { query: 'demo' })).text) as {
      key: string;
    }[];
    expect(byName.map((p) => p.key)).toEqual(['DEMO']);
    const byKey = JSON.parse((await h.call('jira_list_projects', { query: 'ops' })).text) as {
      key: string;
    }[];
    expect(byKey.map((p) => p.key)).toEqual(['OPS']);
    expect(JSON.parse((await h.call('jira_list_projects')).text)).toHaveLength(2);
  });

  it('jira_list_fields returns the JQL clause names', async () => {
    h = await createToolHarness(registerMetadataTools);
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'customfield_10020',
          name: 'Sprint',
          custom: true,
          clauseNames: ['cf[10020]', 'Sprint'],
          schema: { type: 'array' },
        },
      ]),
    );
    const [field] = JSON.parse((await h.call('jira_list_fields')).text) as {
      clauseNames: string[];
    }[];
    expect(field?.clauseNames).toEqual(['cf[10020]', 'Sprint']);
  });

  it('jira_list_issue_link_types says it returns the inward and outward texts', async () => {
    h = await createToolHarness(registerMetadataTools);
    const tool = (await h.listTools()).find((t) => t.name === 'jira_list_issue_link_types');
    expect(tool?.description).toContain('inward');
    expect(tool?.description).toContain('outward');
  });

  it('every tool is annotated read-only', async () => {
    h = await createToolHarness(registerMetadataTools);
    const tools = await h.listTools();
    expect(tools).toHaveLength(8);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('surfaces a Jira permission error', async () => {
    h = await createToolHarness(registerMetadataTools);
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { errorMessages: ['No project could be found with key DEMO.'], errors: {} },
        404,
      ),
    );
    const result = await h.call('jira_get_project', { projectKey: 'DEMO' });
    expect(result).toEqual({ isError: true, text: expect.stringContaining('No project could be') });
  });
});
