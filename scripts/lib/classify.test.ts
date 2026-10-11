import { describe, expect, it } from 'vitest';
import type { AccessDecision, ParsedOperation } from '../../src/catalog/types.ts';
import { classifyOperations } from './classify.ts';

const op = (method: ParsedOperation['method'], path: string): ParsedOperation => ({
  id: `${method} ${path}`,
  api: 'api',
  method,
  path,
  summary: '',
  body: { accepted: method !== 'GET' && method !== 'DELETE', mediaTypes: [] },
  params: [],
});

const PARSED = [
  op('GET', '/rest/api/2/issue/{issueIdOrKey}'),
  op('GET', '/rest/api/2/reindex'),
  op('POST', '/rest/api/2/issue'),
  op('PUT', '/rest/api/2/issue/{issueIdOrKey}'),
  op('DELETE', '/rest/api/2/issue/{issueIdOrKey}'),
  op('POST', '/rest/api/2/search'),
  op('POST', '/rest/raven/1.0/export/test'),
  op('PUT', '/rest/api/2/project/{projectIdOrKey}/archive'),
];
const decision = (access: AccessDecision['access'], reason: string): AccessDecision => ({
  access,
  reason,
  reviewedBy: 'reviewer@example.org',
  reviewedOn: '2026-10-11',
});

describe('classifyOperations — default rules', () => {
  it('classifies by HTTP method and says when an operation was not individually reviewed', () => {
    const { operations } = classifyOperations(PARSED, {});
    const get = (id: string) => operations.find((o) => o.id === id);
    expect(get('GET /rest/api/2/issue/{issueIdOrKey}')).toMatchObject({
      access: 'read',
      accessReason: 'default rule: safe HTTP method (not individually reviewed)',
    });
    expect(get('POST /rest/api/2/issue')).toMatchObject({
      access: 'write',
      accessReason: 'default rule: unsafe HTTP method',
    });
    expect(get('DELETE /rest/api/2/issue/{issueIdOrKey}')).toMatchObject({
      access: 'destructive',
      accessReason: 'default rule: DELETE method',
    });
  });
});

describe('classifyOperations — review candidates (heuristics only)', () => {
  it('flags GET with side-effect wording, read-like POST and destructive-like writes, without reclassifying', () => {
    const { candidates, pending, operations } = classifyOperations(PARSED, {});
    expect(candidates).toEqual([
      { id: 'GET /rest/api/2/reindex', category: 'get-side-effect', matched: 'reindex' },
      { id: 'POST /rest/api/2/search', category: 'post-read-like', matched: 'search' },
      { id: 'POST /rest/raven/1.0/export/test', category: 'post-read-like', matched: 'export' },
      {
        id: 'PUT /rest/api/2/project/{projectIdOrKey}/archive',
        category: 'write-destructive-like',
        matched: 'archive',
      },
    ]);
    expect(pending).toEqual(candidates);
    expect(operations.find((o) => o.id === 'GET /rest/api/2/reindex')?.access).toBe('read');
    expect(
      operations.find((o) => o.id === 'PUT /rest/api/2/project/{projectIdOrKey}/archive')?.access,
    ).toBe('write');
  });
});

describe('classifyOperations — signed decisions', () => {
  it('apply over default rules, clear pending candidates and report stale ones', () => {
    const result = classifyOperations(PARSED, {
      'POST /rest/api/2/search': decision('read', 'JQL search sent as POST, no side effect'),
      'GET /rest/api/2/reindex': decision('destructive', 'starts a full reindex'),
      'PUT /rest/api/2/project/{projectIdOrKey}/archive': decision(
        'destructive',
        'archives a whole project',
      ),
      'GET /rest/api/2/gone': decision('read', 'obsolete'),
    });
    expect(result.operations.find((o) => o.id === 'POST /rest/api/2/search')).toMatchObject({
      access: 'read',
      accessReason:
        'reviewed: JQL search sent as POST, no side effect (reviewer@example.org, 2026-10-11)',
    });
    expect(result.operations.find((o) => o.id === 'GET /rest/api/2/reindex')?.access).toBe(
      'destructive',
    );
    expect(result.pending.map((c) => c.id)).toEqual(['POST /rest/raven/1.0/export/test']);
    expect(result.staleDecisions).toEqual(['GET /rest/api/2/gone']);
  });

  it('refuses incomplete or unsafe decisions', () => {
    const ok = decision('read', 'x');
    expect(() =>
      classifyOperations(PARSED, { 'DELETE /rest/api/2/issue/{issueIdOrKey}': ok }),
    ).toThrow(/DELETE operations cannot be classified as read/);
    expect(() =>
      classifyOperations(PARSED, { 'POST /rest/api/2/search': { ...ok, reason: ' ' } }),
    ).toThrow(/"reason"/);
    expect(() =>
      classifyOperations(PARSED, {
        'POST /rest/api/2/search': { ...ok, reviewedBy: '<identité git>' },
      }),
    ).toThrow(/"reviewedBy"/);
    expect(() =>
      classifyOperations(PARSED, {
        'POST /rest/api/2/search': { ...ok, reviewedOn: '11/10/2026' },
      }),
    ).toThrow(/"reviewedOn"/);
  });
});
