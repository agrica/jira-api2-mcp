import { describe, expect, it } from 'vitest';
import { accessProblem, restPathProblem } from './request-guards.ts';

describe('restPathProblem', () => {
  it('accepts ordinary REST paths, templates included', () => {
    for (const path of [
      '/rest/api/2/myself',
      '/rest/api/2/issue/{issueIdOrKey}/worklog',
      '/rest/agile/1.0/board/{boardId}/sprint',
      '/rest/api/2/issue/DEMO-1',
      '/rest/api/2/user/search',
      '/rest/api/2/a.b/x..y/.hidden',
      '/rest/api/2/attachment/10001',
    ])
      expect(restPathProblem(path)).toBeUndefined();
  });

  it('rejects the traversal forms of the audit PoC and their variants', () => {
    for (const path of [
      '/rest/api/2/%2e%2e/%2e%2e/%2e%2e/plugins/servlet/x',
      '/rest/api/2/%2E%2E/secure',
      '/rest/api/2/..\\..\\..\\secure\\admin',
      '/rest/api/2/../../../secure/Logout!default.jspa',
      '/rest/api/2/./x',
      '/rest/api/2/..',
      '/rest/api/2/x?os_authType=basic#',
      '/rest/api/2/x#frag',
      '/rest/api/2/..;/..;/..;/secure/admin',
      '/rest/api/2/.;/x',
      '/rest/api/2/..;jsessionid=1/secure/admin',
      '/rest/api/2/a%2fb',
      '/rest/api/2/a%2Fb',
      '/rest/api/2/a%5cb',
      '/rest/api/2/a%5Cb',
      '/rest/api/2/a b',
      '/rest/api/2/a\nb',
      '/rest/api/2/a\u0000b',
      '/rest/..',
      '/rest/',
      '/secure/Dashboard.jspa',
      'rest/api/2/myself',
      '',
    ])
      expect(restPathProblem(path)).toBeTypeOf('string');
  });
});

describe('accessProblem', () => {
  it('refuses PUT, PATCH and DELETE classified as read', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'])
      expect(accessProblem(method, 'read')).toMatch(
        `${method} operations cannot be classified as read`,
      );
  });

  it('accepts POST as read (JQL search) and any method as write or destructive', () => {
    expect(accessProblem('POST', 'read')).toBeUndefined();
    expect(accessProblem('GET', 'read')).toBeUndefined();
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(accessProblem(method, 'write')).toBeUndefined();
      expect(accessProblem(method, 'destructive')).toBeUndefined();
    }
  });
});
