import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Access, HttpMethod, QueryValue } from '../http/jira-client.ts';
import {
  DESTRUCTIVE,
  WRITE,
  WRITE_IDEMPOTENT,
  defineTool,
  enc,
  issueKeySchema,
  projectKeySchema,
  type ToolDeps,
} from './shared.ts';

/** Jira duration: one or more `<number><unit>` groups, decimals allowed (e.g. "1.5h", "2h 30m", "1w 2d"). */
const DURATION = /^\s*(?:\d+(?:\.\d+)?[wdhm]\s*)+$/;
/** A numeric issue reference is an issue id, anything else an issue key. */
const issueRef = (keyOrId: string) => (/^\d+$/.test(keyOrId) ? { id: keyOrId } : { key: keyOrId });
const fieldMapSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'Field id → value, e.g. {"customfield_10001":{"value":"Production"},"components":[{"name":"Backend"}]}',
  );

export function registerIssueWriteTools(server: McpServer, deps: ToolDeps): void {
  const { client } = deps;
  if (!client.allowWrites) return;

  const send = async (
    method: HttpMethod,
    path: string,
    body?: unknown,
    query?: Readonly<Record<string, QueryValue>>,
    access: Access = 'write',
  ) => (await client.request({ method, path, access, body, query })).data;

  defineTool(
    server,
    deps,
    'jira_create_issue',
    {
      title: 'Create an issue',
      description:
        'Create an issue (API v2: description in wiki markup). Use jira_get_create_meta first for required fields and allowed values. Select/radio values are written {"value":"…"}. Not retried automatically.',
      inputSchema: z.object({
        projectKey: projectKeySchema,
        issueType: z.string().min(1).describe('Issue type name, e.g. "Task", "Bug", "Story"'),
        summary: z.string().min(1),
        description: z.string().optional(),
        fields: fieldMapSchema.optional(),
      }),
      annotations: WRITE,
    },
    async ({ projectKey, issueType, summary, description, fields }) =>
      send('POST', '/rest/api/2/issue', {
        fields: {
          ...fields,
          project: { key: projectKey },
          issuetype: { name: issueType },
          summary,
          // Only override fields.description when the top-level parameter is given.
          ...(description === undefined ? {} : { description }),
        },
      }),
  );

  defineTool(
    server,
    deps,
    'jira_update_issue',
    {
      title: 'Update an issue',
      description:
        'Edit an issue with "fields" (set values) and/or "update" (operations such as {"labels":[{"add":"x"}]}). If edit metadata is empty, use jira_transition_issue instead.',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        fields: fieldMapSchema.optional(),
        update: z.record(z.string(), z.unknown()).optional(),
        notifyUsers: z.boolean().default(true),
      }),
      annotations: WRITE,
    },
    async ({ issueKey, fields, update, notifyUsers }) => {
      if (!fields && !update) throw new Error('Provide "fields" and/or "update"');
      return send('PUT', `/rest/api/2/issue/${enc(issueKey)}`, { fields, update }, { notifyUsers });
    },
  );

  defineTool(
    server,
    deps,
    'jira_transition_issue',
    {
      title: 'Transition an issue',
      description:
        'Move an issue through its workflow. Get transition ids and screen fields with jira_get_transitions (includeFields=true).',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        transitionId: z.string().regex(/^\d+$/, 'Expected a numeric transition id'),
        fields: fieldMapSchema.optional(),
        comment: z
          .string()
          .min(1)
          .optional()
          .describe('Comment added with the transition (wiki markup)'),
      }),
      annotations: WRITE,
    },
    async ({ issueKey, transitionId, fields, comment }) =>
      send('POST', `/rest/api/2/issue/${enc(issueKey)}/transitions`, {
        transition: { id: transitionId },
        fields,
        update: comment ? { comment: [{ add: { body: comment } }] } : undefined,
      }),
  );

  defineTool(
    server,
    deps,
    'jira_add_comment',
    {
      title: 'Add a comment',
      description:
        'Add a comment (wiki markup) to an issue, optionally restricted to a group or project role.',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        body: z.string().min(1),
        visibility: z
          .object({ type: z.enum(['group', 'role']), value: z.string().min(1) })
          .optional(),
      }),
      annotations: WRITE,
    },
    async ({ issueKey, body, visibility }) =>
      send('POST', `/rest/api/2/issue/${enc(issueKey)}/comment`, { body, visibility }),
  );

  defineTool(
    server,
    deps,
    'jira_assign_issue',
    {
      title: 'Assign an issue',
      description:
        'Assign an issue to a user name (e.g. "jdoe"), null to unassign, or "-1" for automatic assignment.',
      inputSchema: z.object({ issueKey: issueKeySchema, username: z.string().min(1).nullable() }),
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ issueKey, username }) =>
      send('PUT', `/rest/api/2/issue/${enc(issueKey)}/assignee`, { name: username }),
  );

  defineTool(
    server,
    deps,
    'jira_add_worklog',
    {
      title: 'Log work',
      description:
        'Log time on an issue. "started" uses the Jira format 2026-10-11T09:00:00.000+0200. Not retried automatically.',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        timeSpent: z
          .string()
          .regex(DURATION, 'Expected a Jira duration such as "1h 30m", "1.5h" or "2d"'),
        started: z.string().optional(),
        comment: z.string().optional(),
      }),
      annotations: WRITE,
    },
    async ({ issueKey, timeSpent, started, comment }) =>
      send('POST', `/rest/api/2/issue/${enc(issueKey)}/worklog`, { timeSpent, started, comment }),
  );

  defineTool(
    server,
    deps,
    'jira_link_issues',
    {
      title: 'Link two issues',
      description:
        'Create a link. linkType is the link type name, e.g. "Relates", "Blocks", "Duplicate" (see jira_list_issue_link_types).',
      inputSchema: z.object({
        linkType: z.string().min(1),
        inwardIssue: issueKeySchema,
        outwardIssue: issueKeySchema,
        comment: z.string().optional(),
      }),
      annotations: WRITE,
    },
    async ({ linkType, inwardIssue, outwardIssue, comment }) =>
      send('POST', '/rest/api/2/issueLink', {
        type: { name: linkType },
        inwardIssue: issueRef(inwardIssue),
        outwardIssue: issueRef(outwardIssue),
        comment: comment ? { body: comment } : undefined,
      }),
  );

  defineTool(
    server,
    deps,
    'jira_add_attachment',
    {
      title: 'Attach a local file',
      description:
        'Upload a file from the local disk of the machine running this MCP server as an issue attachment.',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        filePath: z.string().min(1).describe('Absolute local path'),
      }),
      annotations: WRITE,
    },
    async ({ issueKey, filePath }) => {
      const form = new FormData();
      form.append('file', await openAsBlob(filePath), basename(filePath));
      return send('POST', `/rest/api/2/issue/${enc(issueKey)}/attachments`, form);
    },
  );

  defineTool(
    server,
    deps,
    'jira_delete_issue',
    {
      title: 'Delete an issue',
      description: 'Permanently delete an issue. Irreversible.',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        deleteSubtasks: z.boolean().default(false),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ issueKey, deleteSubtasks }) =>
      send(
        'DELETE',
        `/rest/api/2/issue/${enc(issueKey)}`,
        undefined,
        { deleteSubtasks },
        'destructive',
      ),
  );
}
