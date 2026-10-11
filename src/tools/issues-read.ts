import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  DEFAULT_ISSUE_FIELDS,
  READ,
  defineTool,
  enc,
  issueKeySchema,
  issueFieldsSchema,
  join,
  maxResultsSchema,
  projectKeySchema,
  readGet,
  startAtSchema,
  type ToolDeps,
} from './shared.ts';

const expandSchema = z.array(z.string().min(1));

/** Trimmed, non-empty entries of a comma-separated string or a list. */
function expandList(expand: string | readonly string[] | undefined): string[] {
  const parts = typeof expand === 'string' ? expand.split(',') : (expand ?? []);
  return parts.map((e) => e.trim()).filter((e) => e !== '');
}

interface CreateMeta {
  projects?: { issuetypes?: unknown[] }[];
}

/** Adds a hint when Jira answers createmeta with nothing usable (it does so with HTTP 200). */
function explainCreateMeta(
  data: unknown,
  projectKey: string,
  issueType: string | undefined,
): unknown {
  const projects = (data as CreateMeta | null)?.projects;
  if (!Array.isArray(projects)) return data;
  if (projects.length === 0) {
    return {
      ...(data as object),
      hint: `No project returned: unknown project key "${projectKey}"${issueType === undefined ? '' : ` or issue type "${issueType}"`}, or no "Create Issues" permission in this project. Issue type names must match exactly (case, accents, language of the instance): list them with jira_get_project.`,
    };
  }
  if (issueType !== undefined && projects.every((p) => (p.issuetypes ?? []).length === 0)) {
    return {
      ...(data as object),
      hint: `The project has no issue type named "${issueType}" (exact name, including case and accents): list its issue types with jira_get_project.`,
    };
  }
  return data;
}

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
        'Search Jira issues with JQL (Jira Server/Data Center 8.x, API v2). Returns startAt, maxResults, total and issues; maxResults 0 returns only the total. Example: project = DEMO AND statusCategory != Done ORDER BY created DESC',
      inputSchema: z.object({
        jql: z.string().min(1),
        fields: issueFieldsSchema('the default list').default([...DEFAULT_ISSUE_FIELDS]),
        expand: z
          .union([z.string(), expandSchema])
          .optional()
          .describe('Comma-separated string or list, e.g. "renderedFields,changelog"'),
        startAt: startAtSchema,
        maxResults: maxResultsSchema(25, { min: 0, note: '; 0 returns only the total' }),
      }),
      annotations: READ,
    },
    async ({ jql, fields, expand, startAt, maxResults }) => {
      // POST keeps long JQL out of the URL (proxy/URL length limits); it is still a read.
      const expands = expandList(expand);
      const body = {
        jql,
        startAt,
        maxResults,
        fields,
        expand: expands.length > 0 ? expands : undefined,
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
        fields: issueFieldsSchema('all fields (large)').optional(),
        expand: expandSchema
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
        'Fields (required flag, allowed values) needed to create an issue in a project, for one issue type name (e.g. "Task"). Without issueType the answer covers every issue type of the project and can be very large (truncated): give issueType, and list the exact names with jira_get_project. An empty "projects" list means an unknown project or issue type name, or no permission to create issues there; the answer then carries a "hint".',
      inputSchema: z.object({
        projectKey: projectKeySchema,
        issueType: z
          .string()
          .min(1)
          .optional()
          .describe('Exact issue type name as shown by jira_get_project (case and accents matter)'),
      }),
      annotations: READ,
    },
    async ({ projectKey, issueType }) =>
      explainCreateMeta(
        await get('/rest/api/2/issue/createmeta', {
          projectKeys: projectKey,
          issuetypeNames: issueType,
          expand: 'projects.issuetypes.fields',
        }),
        projectKey,
        issueType,
      ),
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
