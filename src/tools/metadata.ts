import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { QueryValue } from '../http/jira-client.ts';
import { normalizeForSearch } from '../util/normalize.ts';
import { READ, defineTool, maxResultsSchema, projectKeySchema, type ToolDeps } from './shared.ts';

interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
}
interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string };
}

const enc = encodeURIComponent;

export function registerMetadataTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const get = async (path: string, query?: Readonly<Record<string, QueryValue>>) =>
    (await client.request({ method: 'GET', path, access: 'read', query })).data;
  const noInput = z.object({});

  defineTool(
    server,
    deps,
    'jira_get_server_info',
    {
      title: 'Server info',
      description: 'Jira version, build and base URL.',
      inputSchema: noInput,
      annotations: READ,
    },
    async () => get('/rest/api/2/serverInfo'),
  );

  defineTool(
    server,
    deps,
    'jira_get_current_user',
    {
      title: 'Current user',
      description: 'The user owning the access token.',
      inputSchema: noInput,
      annotations: READ,
    },
    async () => get('/rest/api/2/myself'),
  );

  defineTool(
    server,
    deps,
    'jira_search_users',
    {
      title: 'Search users',
      description:
        'Find users by login, name or e-mail fragment. Use the returned "name" to assign issues.',
      inputSchema: z.object({ query: z.string().min(1), maxResults: maxResultsSchema(20) }),
      annotations: READ,
    },
    async ({ query, maxResults }) =>
      get('/rest/api/2/user/search', { username: query, maxResults }),
  );

  defineTool(
    server,
    deps,
    'jira_list_projects',
    {
      title: 'List projects',
      description: 'Projects visible to the user (id, key, name, type).',
      inputSchema: noInput,
      annotations: READ,
    },
    async () =>
      ((await get('/rest/api/2/project')) as JiraProject[]).map(
        ({ id, key, name, projectTypeKey }) => ({
          id,
          key,
          name,
          projectTypeKey,
        }),
      ),
  );

  defineTool(
    server,
    deps,
    'jira_get_project',
    {
      title: 'Get a project',
      description: 'Project details including components, versions and issue types (can be large).',
      inputSchema: z.object({ projectKey: projectKeySchema }),
      annotations: READ,
    },
    async ({ projectKey }) => get(`/rest/api/2/project/${enc(projectKey)}`),
  );

  defineTool(
    server,
    deps,
    'jira_get_project_statuses',
    {
      title: 'Project workflow statuses',
      description: 'Statuses available per issue type in a project.',
      inputSchema: z.object({ projectKey: projectKeySchema }),
      annotations: READ,
    },
    async ({ projectKey }) => get(`/rest/api/2/project/${enc(projectKey)}/statuses`),
  );

  defineTool(
    server,
    deps,
    'jira_list_fields',
    {
      title: 'List fields',
      description:
        'System and custom fields with their ids (customfield_NNNNN). "query" matches name or id, ignoring case and accents (e.g. "epopee", "sprint", "10001").',
      inputSchema: z.object({
        query: z.string().optional(),
        customOnly: z.boolean().default(false),
      }),
      annotations: READ,
    },
    async ({ query, customOnly }) => {
      const needle = normalizeForSearch(query ?? '');
      return ((await get('/rest/api/2/field')) as JiraField[])
        .filter(
          (f) =>
            (!customOnly || f.custom) && normalizeForSearch(`${f.id} ${f.name}`).includes(needle),
        )
        .map((f) => ({
          id: f.id,
          name: f.name,
          custom: f.custom,
          type: f.schema?.type,
          customType: f.schema?.custom,
        }));
    },
  );

  defineTool(
    server,
    deps,
    'jira_list_issue_link_types',
    {
      title: 'Issue link types',
      description: 'Link type names usable with jira_link_issues.',
      inputSchema: noInput,
      annotations: READ,
    },
    async () => get('/rest/api/2/issueLinkType'),
  );
}
