import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  DEFAULT_ISSUE_FIELDS,
  READ,
  defineTool,
  enc,
  issueKeySchema,
  join,
  maxResultsSchema,
  projectKeySchema,
  readGet,
  startAtSchema,
  type ToolDeps,
} from './shared.ts';

const fieldsSchema = z
  .array(z.string().min(1))
  .describe(
    'Fields to return, e.g. ["summary","status","customfield_10001"]. ["*all"] returns every field (large).',
  );

export function registerIssueReadTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const get = readGet(client);

  defineTool(
    server,
    deps,
    'jira_search_issues',
    {
      title: 'Search issues (JQL)',
      description:
        'Search Jira issues with JQL (Jira Server 8.20, API v2). Returns startAt, maxResults, total and issues. Example: project = DEMO AND statusCategory != Done ORDER BY created DESC',
      inputSchema: z.object({
        jql: z.string().min(1),
        fields: fieldsSchema.default([...DEFAULT_ISSUE_FIELDS]),
        expand: z.string().optional().describe('Comma-separated, e.g. "renderedFields,changelog"'),
        startAt: startAtSchema,
        maxResults: maxResultsSchema(25),
      }),
      annotations: READ,
    },
    async ({ jql, fields, expand, startAt, maxResults }) => {
      // POST keeps long JQL out of the URL (proxy/URL length limits); it is still a read.
      const expandList = (expand ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== '');
      const body = {
        jql,
        startAt,
        maxResults,
        fields: fields.length > 0 ? fields : undefined,
        expand: expandList.length > 0 ? expandList : undefined,
      };
      return (
        await client.request({ method: 'POST', path: '/rest/api/2/search', access: 'read', body })
      ).data;
    },
  );

  defineTool(
    server,
    deps,
    'jira_get_issue',
    {
      title: 'Get an issue',
      description: 'Get one issue by key or id. Restrict "fields" to keep the answer small.',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        fields: fieldsSchema.optional(),
        expand: z
          .array(z.string().min(1))
          .optional()
          .describe('e.g. ["renderedFields","changelog","transitions"]'),
      }),
      annotations: READ,
    },
    async ({ issueKey, fields, expand }) =>
      get(`/rest/api/2/issue/${enc(issueKey)}`, { fields: join(fields), expand: join(expand) }),
  );

  defineTool(
    server,
    deps,
    'jira_get_transitions',
    {
      title: 'Get available transitions',
      description:
        'List the workflow transitions available on an issue. includeFields=true returns the fields of each transition screen (needed when edits go through a workflow transition).',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        includeFields: z.boolean().default(false),
      }),
      annotations: READ,
    },
    async ({ issueKey, includeFields }) =>
      get(`/rest/api/2/issue/${enc(issueKey)}/transitions`, {
        expand: includeFields ? 'transitions.fields' : undefined,
      }),
  );

  defineTool(
    server,
    deps,
    'jira_get_comments',
    {
      title: 'Get issue comments',
      description: 'List comments of an issue (wiki markup bodies).',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        startAt: startAtSchema,
        maxResults: maxResultsSchema(50),
        orderBy: z.enum(['created', '-created']).optional(),
      }),
      annotations: READ,
    },
    async ({ issueKey, startAt, maxResults, orderBy }) =>
      get(`/rest/api/2/issue/${enc(issueKey)}/comment`, { startAt, maxResults, orderBy }),
  );

  defineTool(
    server,
    deps,
    'jira_get_create_meta',
    {
      title: 'Get issue creation metadata',
      description:
        'Fields (required flag, allowed values) needed to create an issue in a project, optionally for one issue type name (e.g. "Task").',
      inputSchema: z.object({
        projectKey: projectKeySchema,
        issueType: z.string().min(1).optional(),
      }),
      annotations: READ,
    },
    async ({ projectKey, issueType }) =>
      get('/rest/api/2/issue/createmeta', {
        projectKeys: projectKey,
        issuetypeNames: issueType,
        expand: 'projects.issuetypes.fields',
      }),
  );

  defineTool(
    server,
    deps,
    'jira_get_edit_meta',
    {
      title: 'Get issue edit metadata',
      description:
        'Fields editable on an issue. If it comes back empty (some screen configurations), edits go through a transition: see jira_get_transitions with includeFields=true.',
      inputSchema: z.object({ issueKey: issueKeySchema }),
      annotations: READ,
    },
    async ({ issueKey }) => get(`/rest/api/2/issue/${enc(issueKey)}/editmeta`),
  );
}
