import { describe, expect, it } from 'vitest';
import type { AccessDecision, ParsedOperation } from '../../src/catalog/types.ts';
import { classifyOperations, decisionProblems } from './classify.ts';

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
    const ok = decision('read', 'reviewed read');
    expect(() =>
      classifyOperations(PARSED, { 'DELETE /rest/api/2/issue/{issueIdOrKey}': ok }),
    ).toThrow(/DELETE operations cannot be classified as read/);
    expect(() =>
      classifyOperations(PARSED, { 'PUT /rest/api/2/issue/{issueIdOrKey}': ok }),
    ).toThrow(/PUT operations cannot be classified as read/);
    expect(() =>
      classifyOperations([op('PATCH', '/rest/api/2/x')], { 'PATCH /rest/api/2/x': ok }),
    ).toThrow(/PATCH operations cannot be classified as read/);
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

describe('decisionProblems — every decision validated, with the decision named', () => {
  const NOW = new Date('2026-10-11T12:00:00.000Z');
  const good = decision('read', 'JQL search sent as POST, no side effect');
  const check = (raw: unknown, id = 'POST /rest/api/2/search') =>
    decisionProblems({ [id]: raw }, NOW);

  it('accepts a complete decision, a git identity "Name <email>" and tomorrow (time zone margin)', () => {
    expect(check(good)).toEqual([]);
    expect(check({ ...good, reviewedBy: 'Jane Doe <jdoe@example.org>' })).toEqual([]);
    expect(check({ ...good, reviewedOn: '2026-10-12' })).toEqual([]);
    expect(check({ ...good, reviewedBy: 'Todorov' })).toEqual([]);
  });

  it('requires access to be exactly read, write or destructive', () => {
    for (const access of ['READ', 'Write', 'delete', '', undefined, 1])
      expect(check({ ...good, access })).toEqual([
        `Access decision for POST /rest/api/2/search: "access" must be exactly read, write or destructive (got ${JSON.stringify(access ?? null)})`,
      ]);
  });

  it('refuses a missing or placeholder reason', () => {
    expect(check({ ...good, reason: undefined })).toEqual([
      'Access decision for POST /rest/api/2/search: "reason" is required: explain the decision',
    ]);
    expect(check({ ...good, reason: 'TODO' })[0]).toContain('"reason" is a placeholder ("TODO")');
  });

  it('refuses placeholder reviewers with an explicit instruction', () => {
    for (const reviewedBy of [
      '<identité git du relecteur>',
      '<…>',
      'TODO',
      'todo: me',
      'TBD',
      '?',
      'xxx',
      'XXX',
      'x',
    ])
      expect(check({ ...good, reviewedBy })).toEqual([
        `Access decision for POST /rest/api/2/search: "reviewedBy" is a placeholder (${JSON.stringify(reviewedBy)}): replace the placeholder reviewer in catalog/access-decisions.json after reviewing the decision`,
      ]);
    expect(check({ ...good, reviewedBy: ' ' })).toEqual([
      'Access decision for POST /rest/api/2/search: "reviewedBy" is required: name the reviewer (git identity)',
    ]);
  });

  const date = (reviewedOn: unknown) => check({ ...good, reviewedOn });
  it('requires a real calendar date that is not in the future', () => {
    expect(date('11/10/2026')[0]).toContain('"reviewedOn" must be a YYYY-MM-DD date');
    expect(date(20261011)[0]).toContain('"reviewedOn" must be a YYYY-MM-DD date');
    expect(date('2026-13-45')[0]).toContain('"reviewedOn" is not a calendar date (2026-13-45)');
    expect(date('2026-02-30')[0]).toContain('is not a calendar date');
    expect(date('2026-10-13')[0]).toContain('"reviewedOn" is in the future (2026-10-13)');
    expect(date('2999-01-01')[0]).toContain('is in the future');
  });

  it('checks the access against the method of the id, stale decisions included, and unknown fields', () => {
    expect(check(good, 'PUT /rest/api/2/gone')).toEqual([
      'Access decision for PUT /rest/api/2/gone: PUT operations cannot be classified as read',
    ]);
    expect(check({ ...good, reviewdBy: 'jdoe' })[0]).toContain('unknown field "reviewdBy"');
    expect(check('read')).toEqual([
      'Access decision for POST /rest/api/2/search: must be an object with access, reason, reviewedBy and reviewedOn',
    ]);
    expect(decisionProblems([], NOW)).toEqual([
      'catalog/access-decisions.json must be a JSON object keyed by operation id',
    ]);
  });

  it('requires ids of the form "<METHOD> /rest/…"', () => {
    for (const id of [
      'post /rest/api/2/search',
      'GET /plugins/servlet/x',
      'TRACE /rest/api/2/x',
      'search',
    ])
      expect(check(good, id)).toEqual([
        `Access decision for ${id}: the id must be "<METHOD> /rest/…" with METHOD one of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS`,
      ]);
  });

  it('makes classifyOperations throw every problem, never a raw TypeError', () => {
    const missing = { access: 'read' } as unknown as AccessDecision;
    expect(() => classifyOperations(PARSED, { 'POST /rest/api/2/search': missing }, NOW)).toThrow(
      /"reason" is required[\s\S]*"reviewedBy" is required[\s\S]*"reviewedOn" must be/,
    );
  });
});
