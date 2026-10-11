import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  DEFAULT_ISSUE_FIELDS,
  READ,
  WRITE_IDEMPOTENT,
  agileMaxResultsSchema,
  defineTool,
  issueFieldsSchema,
  issueKeySchema,
  join,
  readGet,
  startAtSchema,
  type ToolDeps,
} from './shared.ts';

const idSchema = z.number().int().positive();

export function registerAgileTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  const get = readGet(client);

  defineTool(
    server,
    deps,
    'jira_list_boards',
    {
      title: 'List agile boards',
      description:
        'Scrum/Kanban boards, optionally filtered by project or name. Pages hold at most 50 boards.',
      inputSchema: z.object({
        projectKeyOrId: z.string().optional(),
        name: z.string().optional(),
        type: z.enum(['scrum', 'kanban']).optional(),
        startAt: startAtSchema,
        maxResults: agileMaxResultsSchema(50),
      }),
      annotations: READ,
    },
    async ({ projectKeyOrId, name, type, startAt, maxResults }) =>
      get('/rest/agile/1.0/board', { projectKeyOrId, name, type, startAt, maxResults }),
  );

  defineTool(
    server,
    deps,
    'jira_list_sprints',
    {
      title: 'List sprints of a board',
      description:
        'Sprints of a scrum board, optionally filtered by state (a Kanban board has no sprints: Jira answers 400). Pages hold at most 50 sprints.',
      inputSchema: z.object({
        boardId: idSchema,
        state: z.array(z.enum(['future', 'active', 'closed'])).optional(),
        startAt: startAtSchema,
        maxResults: agileMaxResultsSchema(50),
      }),
      annotations: READ,
    },
    async ({ boardId, state, startAt, maxResults }) =>
      get(`/rest/agile/1.0/board/${boardId}/sprint`, {
        state: state?.join(','),
        startAt,
        maxResults,
      }),
  );

  defineTool(
    server,
    deps,
    'jira_get_sprint_issues',
    {
      title: 'Issues of a sprint',
      description: 'Issues in a sprint, optionally filtered by JQL. Pages hold at most 50 issues.',
      inputSchema: z.object({
        sprintId: idSchema,
        jql: z.string().optional(),
        fields: issueFieldsSchema.default([...DEFAULT_ISSUE_FIELDS]),
        startAt: startAtSchema,
        maxResults: agileMaxResultsSchema(50),
      }),
      annotations: READ,
    },
    async ({ sprintId, jql, fields, startAt, maxResults }) =>
      get(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
        jql,
        fields: join(fields),
        startAt,
        maxResults,
      }),
  );

  if (!client.allowWrites) return;

  defineTool(
    server,
    deps,
    'jira_move_issues_to_sprint',
    {
      title: 'Move issues to a sprint',
      description:
        'Move up to 50 issues (keys or ids) into a sprint; they leave their previous sprint. Moving them again is harmless.',
      inputSchema: z.object({
        sprintId: idSchema,
        issueKeys: z.array(issueKeySchema).min(1).max(50),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ sprintId, issueKeys }) =>
      (
        await client.request({
          method: 'POST',
          path: `/rest/agile/1.0/sprint/${sprintId}/issue`,
          access: 'write',
          body: { issues: issueKeys },
        })
      ).data,
  );
}
