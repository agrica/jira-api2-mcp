import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
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
const durationSchema = z
  .string()
  .regex(DURATION, 'Expected a Jira duration such as "1h 30m", "1.5h" or "2d"');

/** `yyyy-MM-ddTHH:mm:ss[.fraction](Z|±HH:MM|±HHMM)` */
const STARTED =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/i;
const STARTED_MESSAGE =
  'Expected the Jira date-time format yyyy-MM-ddTHH:mm:ss.SSS±HHMM, e.g. 2025-01-15T09:30:00.000+0100 (ISO 8601 with "Z" or "±HH:MM", with or without milliseconds, is converted)';

/**
 * Jira 8 parses worklog `started` with `yyyy-MM-dd'T'HH:mm:ss.SSSZ` only (milliseconds required, offset
 * without colon). Returns that form for it and for the usual ISO 8601 variants, `undefined` otherwise.
 */
export function normaliseWorklogStarted(value: string): string | undefined {
  const match = STARTED.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = '', zone = ''] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth)
    return undefined;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  let offset = '+0000';
  if (zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    if (Number(digits.slice(0, 2)) > 14 || Number(digits.slice(2)) > 59) return undefined;
    offset = `${zone[0]}${digits}`;
  }
  const millis = fraction.padEnd(3, '0').slice(0, 3);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}${offset}`;
}

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
        'Create an issue (API v2: description in wiki markup). Use jira_get_create_meta first for required fields and allowed values. Select/radio values are written {"value":"…"}. A sub-task needs a sub-task issue type and fields.parent = {"key":"DEMO-1"}; epic link and epic name are custom fields (find their ids with jira_list_fields, query "epic"). Not retried automatically.',
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
        notifyUsers: z
          .boolean()
          .optional()
          .describe(
            'false suppresses the e-mail notification. Jira accepts it only from a Jira or project administrator: anyone else gets HTTP 403 and the edit is not applied. Default: notify.',
          ),
      }),
      annotations: WRITE,
    },
    async ({ issueKey, fields, update, notifyUsers }) => {
      if (!fields && !update) throw new Error('Provide "fields" and/or "update"');
      return send(
        'PUT',
        `/rest/api/2/issue/${enc(issueKey)}`,
        { fields, update },
        notifyUsers === false ? { notifyUsers } : undefined,
      );
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
        'Log time on an issue. "started" (default: now) uses the Jira format yyyy-MM-ddTHH:mm:ss.SSS±HHMM; ISO 8601 values ending in "Z" or "±HH:MM" are converted. By default Jira reduces the remaining estimate by timeSpent (adjustEstimate "auto"). Not retried automatically.',
      inputSchema: z.object({
        issueKey: issueKeySchema,
        timeSpent: durationSchema,
        started: z
          .string()
          .refine((value) => normaliseWorklogStarted(value) !== undefined, STARTED_MESSAGE)
          .optional()
          .describe(
            'When the work started, yyyy-MM-ddTHH:mm:ss.SSS±HHMM (with the time zone offset)',
          ),
        comment: z.string().optional(),
        adjustEstimate: z
          .enum(['auto', 'new', 'manual', 'leave'])
          .optional()
          .describe(
            'Remaining estimate: auto (Jira default, reduced by timeSpent), new (set to newEstimate), manual (reduced by reduceBy), leave (unchanged)',
          ),
        newEstimate: durationSchema.optional().describe('With adjustEstimate "new" only'),
        reduceBy: durationSchema.optional().describe('With adjustEstimate "manual" only'),
      }),
      annotations: WRITE,
    },
    async ({ issueKey, timeSpent, started, comment, adjustEstimate, newEstimate, reduceBy }) => {
      if ((adjustEstimate === 'new') !== (newEstimate !== undefined))
        throw new Error('"newEstimate" is required with adjustEstimate "new", and only then');
      if ((adjustEstimate === 'manual') !== (reduceBy !== undefined))
        throw new Error('"reduceBy" is required with adjustEstimate "manual", and only then');
      return send(
        'POST',
        `/rest/api/2/issue/${enc(issueKey)}/worklog`,
        {
          timeSpent,
          started: started === undefined ? undefined : normaliseWorklogStarted(started),
          comment,
        },
        { adjustEstimate, newEstimate, reduceBy },
      );
    },
  );

  defineTool(
    server,
    deps,
    'jira_link_issues',
    {
      title: 'Link two issues',
      description:
        'Create a link between two issues. linkType is the link type name, e.g. "Relates", "Blocks", "Duplicate"; jira_list_issue_link_types gives each type with its outward and inward texts. Direction: outwardIssue is the issue the outward text applies to, inwardIssue the one on the inward side. Example with "Blocks" (outward "blocks", inward "is blocked by"): to record "DEMO-1 blocks DEMO-2", send outwardIssue=DEMO-1, inwardIssue=DEMO-2. Keys or numeric ids.',
      inputSchema: z.object({
        linkType: z.string().min(1),
        inwardIssue: issueKeySchema.describe(
          'Issue on the inward side (for "Blocks": the one that is blocked)',
        ),
        outwardIssue: issueKeySchema.describe(
          'Issue the outward text applies to (for "Blocks": the one that blocks)',
        ),
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
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error(`${filePath} is not a regular file`);
      if (info.size === 0) throw new Error(`${filePath} is empty: Jira refuses empty attachments`);
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
