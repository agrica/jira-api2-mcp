import { describe, expect, it } from 'vitest';
import { Catalog, CatalogError, describeOperation } from './catalog.ts';
import type { Operation } from './types.ts';

const base = { summary: '', body: { accepted: false, mediaTypes: [] }, accessReason: 'test' };
const OPS: Operation[] = [
  {
    ...base,
    id: 'GET /rest/api/2/issue/{issueIdOrKey}',
    api: 'api',
    method: 'GET',
    path: '/rest/api/2/issue/{issueIdOrKey}',
    summary: 'Returns a full representation of the issue',
    access: 'read',
    accessReason: 'default rule: safe HTTP method (not individually reviewed)',
    params: [
      { name: 'issueIdOrKey', in: 'path', type: 'string', required: true, repeating: false },
      { name: 'fields', in: 'query', type: 'string', required: false, repeating: true },
      { name: 'updateHistory', in: 'query', type: 'boolean', required: false, repeating: false },
    ],
  },
  {
    ...base,
    id: 'GET /rest/agile/1.0/board/{boardId}/sprint',
    api: 'agile',
    method: 'GET',
    path: '/rest/agile/1.0/board/{boardId}/sprint',
    summary: 'Returns all sprints from a board',
    access: 'read',
    params: [
      { name: 'boardId', in: 'path', type: 'integer', required: true, repeating: false },
      { name: 'startAt', in: 'query', type: 'integer', required: true, repeating: false },
      { name: 'state', in: 'query', type: 'string', required: false, repeating: false },
    ],
  },
  {
    ...base,
    id: 'POST /rest/agile/1.0/sprint/{sprintId}/issue',
    api: 'agile',
    method: 'POST',
    path: '/rest/agile/1.0/sprint/{sprintId}/issue',
    summary: 'Moves issues to a sprint',
    access: 'write',
    body: { accepted: true, mediaTypes: ['application/json'] },
    params: [{ name: 'sprintId', in: 'path', type: 'integer', required: true, repeating: false }],
  },
  {
    ...base,
    id: 'POST /rest/api/2/issue/{issueIdOrKey}/attachments',
    api: 'api',
    method: 'POST',
    path: '/rest/api/2/issue/{issueIdOrKey}/attachments',
    access: 'write',
    body: { accepted: true, mediaTypes: ['multipart/form-data'] },
    params: [
      { name: 'issueIdOrKey', in: 'path', type: 'string', required: true, repeating: false },
    ],
  },
];
const meta = {
  jiraVersion: '8.20.0',
  jiraBuildNumber: 820000,
  fetchedAt: '2026-10-11T08:00:00.000Z',
  generatedAt: '2026-10-11T08:01:00.000Z',
  counts: { api: 2, agile: 2, xray: 0 },
};
const catalog = new Catalog(OPS, meta);
const getIssue = catalog.require('GET /rest/api/2/issue/{issueIdOrKey}');
const sprints = catalog.require('GET /rest/agile/1.0/board/{boardId}/sprint');

describe('Catalog lookup and search', () => {
  it('finds operations by id, exposes meta and size', () => {
    expect(catalog.size).toBe(4);
    expect(catalog.meta?.jiraVersion).toBe('8.20.0');
    expect(catalog.get('  GET /rest/api/2/issue/{issueIdOrKey} ')).toBe(OPS[0]);
    expect(() => catalog.require('GET /nope')).toThrow(
      /Unknown operation "GET \/nope".*jira_list_operations/,
    );
  });

  it('matches every term, ignoring case and accents, and filters by api/method/access', () => {
    expect(catalog.search({ query: 'SPRINT issue' }).operations.map((o) => o.id)).toEqual([
      'POST /rest/agile/1.0/sprint/{sprintId}/issue',
    ]);
    expect(catalog.search({ query: 'RÉPRESENTATION' }).total).toBe(1);
    expect(catalog.search({ api: 'agile', access: 'read' }).operations.map((o) => o.id)).toEqual([
      'GET /rest/agile/1.0/board/{boardId}/sprint',
    ]);
    expect(catalog.search({ method: 'POST' }).total).toBe(2);
    const limited = catalog.search({ limit: 0 });
    expect([limited.total, limited.operations.length]).toEqual([4, 1]);
  });
});

describe('Catalog.buildRequest — path parameters', () => {
  it('fills, encodes and carries the access class', () => {
    expect(
      catalog.buildRequest(getIssue, {
        pathParams: { issueIdOrKey: 'DEMO-1' },
        query: { fields: ['summary'] },
      }),
    ).toEqual({
      method: 'GET',
      path: '/rest/api/2/issue/DEMO-1',
      access: 'read',
      query: { fields: ['summary'] },
      body: undefined,
    });
    expect(catalog.buildRequest(getIssue, { pathParams: { issueIdOrKey: 'a/b?c' } }).path).toBe(
      '/rest/api/2/issue/a%2Fb%3Fc',
    );
  });

  it('rejects traversal-like, empty, mistyped, missing or unknown values', () => {
    for (const bad of ['..', '.', '']) {
      expect(() => catalog.buildRequest(getIssue, { pathParams: { issueIdOrKey: bad } })).toThrow(
        CatalogError,
      );
    }
    expect(() =>
      catalog.buildRequest(sprints, { pathParams: { boardId: '12abc' }, query: { startAt: 0 } }),
    ).toThrow(
      'Parameter "boardId" of GET /rest/agile/1.0/board/{boardId}/sprint expects integer, got "12abc"',
    );
    expect(() => catalog.buildRequest(getIssue, {})).toThrow(
      'Missing path parameter "issueIdOrKey"',
    );
    expect(() =>
      catalog.buildRequest(getIssue, { pathParams: { issueIdOrKey: 'DEMO-1', foo: 'x' } }),
    ).toThrow(
      'Unknown path parameter(s) for GET /rest/api/2/issue/{issueIdOrKey}: foo. Expected: issueIdOrKey',
    );
  });
});

describe('Catalog.buildRequest — template names with "-" and "."', () => {
  it('substitutes {issue-key} and {a.b} placeholders', () => {
    const op: Operation = {
      ...base,
      id: 'GET /rest/demo/1.0/issue/{issue-key}/{a.b}',
      api: 'api',
      method: 'GET',
      path: '/rest/demo/1.0/issue/{issue-key}/{a.b}',
      access: 'read',
      params: [
        { name: 'issue-key', in: 'path', type: 'string', required: true, repeating: false },
        { name: 'a.b', in: 'path', type: 'integer', required: true, repeating: false },
      ],
    };
    expect(
      new Catalog([op]).buildRequest(op, { pathParams: { 'issue-key': 'DEMO-1', 'a.b': 10001 } })
        .path,
    ).toBe('/rest/demo/1.0/issue/DEMO-1/10001');
  });
});

describe('Catalog.buildRequest — query parameters', () => {
  it('checks declared names, types, repeatability and declared required params', () => {
    const ok = { pathParams: { boardId: 330 } };
    expect(
      catalog.buildRequest(sprints, { ...ok, query: { startAt: '0', state: 'active,future' } })
        .query,
    ).toEqual({
      startAt: '0',
      state: 'active,future',
    });
    expect(() =>
      catalog.buildRequest(sprints, { ...ok, query: { startAt: 0, stat: 'active' } }),
    ).toThrow(
      'Unknown query parameter(s) for GET /rest/agile/1.0/board/{boardId}/sprint: stat. Allowed: startAt, state',
    );
    expect(() => catalog.buildRequest(sprints, { ...ok, query: { startAt: 1.5 } })).toThrow(
      'expects integer',
    );
    expect(() =>
      catalog.buildRequest(sprints, { ...ok, query: { startAt: 0, state: ['active', 'future'] } }),
    ).toThrow('Parameter "state" of GET /rest/agile/1.0/board/{boardId}/sprint is not repeatable');
    expect(() => catalog.buildRequest(sprints, ok)).toThrow(
      'Missing required query parameter(s) for GET /rest/agile/1.0/board/{boardId}/sprint: startAt',
    );
    expect(() =>
      catalog.buildRequest(getIssue, {
        pathParams: { issueIdOrKey: 'DEMO-1' },
        query: { updateHistory: 'yes' },
      }),
    ).toThrow('expects boolean');
  });
});

const withBody = (method: 'GET' | 'HEAD'): Operation => ({
  ...base,
  id: `${method} /rest/api/2/search`,
  api: 'api',
  method,
  path: '/rest/api/2/search',
  access: 'read',
  body: { accepted: true, mediaTypes: ['application/json'] },
  params: [],
});

describe('Catalog.buildRequest — body', () => {
  it('rejects a body where none is accepted and non-JSON media types; accepts any JSON value otherwise', () => {
    expect(() =>
      catalog.buildRequest(getIssue, { pathParams: { issueIdOrKey: 'DEMO-1' }, body: {} }),
    ).toThrow('does not accept a request body');
    const attach = catalog.require('POST /rest/api/2/issue/{issueIdOrKey}/attachments');
    expect(() =>
      catalog.buildRequest(attach, { pathParams: { issueIdOrKey: 'DEMO-1' }, body: {} }),
    ).toThrow(/multipart\/form-data.*jira_add_attachment/);
    const move = catalog.require('POST /rest/agile/1.0/sprint/{sprintId}/issue');
    expect(
      catalog.buildRequest(move, { pathParams: { sprintId: 42 }, body: { issues: ['DEMO-1'] } }),
    ).toMatchObject({
      path: '/rest/agile/1.0/sprint/42/issue',
      access: 'write',
      body: { issues: ['DEMO-1'] },
    });
    // No body schema in the WADL: an omitted body is left for Jira to judge.
    expect(catalog.buildRequest(move, { pathParams: { sprintId: 42 } }).body).toBeUndefined();
  });

  it('rejects a body for GET and HEAD even when the WADL declares a representation', () => {
    const ops = new Catalog([withBody('GET'), withBody('HEAD')], meta);
    for (const method of ['GET', 'HEAD'] as const) {
      const op = ops.require(`${method} /rest/api/2/search`);
      expect(() => ops.buildRequest(op, { body: { jql: 'project = DEMO' } })).toThrow(
        `${method} /rest/api/2/search: a ${method} request cannot carry a body. Pass the values as query parameters.`,
      );
      expect(ops.buildRequest(op).body).toBeUndefined();
    }
  });
});

describe('describeOperation', () => {
  it('states what is and is not validated, and whether the class was reviewed', () => {
    const move = describeOperation(catalog.require('POST /rest/agile/1.0/sprint/{sprintId}/issue'));
    expect(move.notes.join(' ')).toContain('Accepts a request body (application/json)');
    expect(move.notes.join(' ')).toContain('does not say whether the body is required');
    const issue = describeOperation(getIssue);
    expect(issue.notes[0]).toBe('Takes no request body.');
    expect(issue.notes[2]).toContain('not individually reviewed');
  });
});
