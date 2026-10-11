import { describe, expect, it } from 'vitest';
import {
  JiraApiError,
  RequestCancelledError,
  ResponseTooLargeError,
  WritesDisabledError,
  extractErrorDetails,
} from './jira-error.ts';

describe('extractErrorDetails', () => {
  it('reads Jira errorMessages and field errors', () => {
    const body = JSON.stringify({
      errorMessages: ['Le ticket n’existe pas'],
      errors: { customfield_10001: 'Environnement est obligatoire.' },
    });
    expect(extractErrorDetails(body, 'application/json;charset=UTF-8')).toEqual([
      'Le ticket n’existe pas',
      'customfield_10001: Environnement est obligatoire.',
    ]);
  });

  it('reads the "message" form used by WebSudo/401 answers', () => {
    const body = JSON.stringify({ message: 'This resource requires WebSudo.', 'status-code': 401 });
    expect(extractErrorDetails(body, 'application/json')).toEqual([
      'This resource requires WebSudo.',
    ]);
  });

  it('uses the <title> of an HTML error page', () => {
    const html =
      '<!DOCTYPE html><html><head><title>Oups, vous avez trouvé un lien mort. - JIRA</title></head></html>';
    expect(extractErrorDetails(html, 'text/html;charset=UTF-8')).toEqual([
      'Oups, vous avez trouvé un lien mort. - JIRA',
    ]);
  });

  it('falls back to truncated text, then to nothing', () => {
    expect(extractErrorDetails('x'.repeat(600), 'text/plain')[0]).toHaveLength(500);
    expect(extractErrorDetails('{not json', 'application/json')).toEqual(['{not json']);
    expect(extractErrorDetails('   ', null)).toEqual([]);
  });
});

describe('error classes', () => {
  it('formats JiraApiError, including rate limiting', () => {
    expect(new JiraApiError(400, 'POST', '/rest/api/2/issue', ['a', 'b']).message).toBe(
      'Jira POST /rest/api/2/issue failed with HTTP 400: a | b',
    );
    const limited = new JiraApiError(429, 'POST', '/rest/api/2/issue', [], '7');
    expect(limited.message).toBe(
      'Jira POST /rest/api/2/issue failed with HTTP 429 — rate limited (Retry-After: 7 s)',
    );
    expect(limited.retryAfter).toBe('7');
  });

  it('formats WritesDisabledError and ResponseTooLargeError', () => {
    expect(new WritesDisabledError('DELETE', '/rest/api/2/issue/DEMO-1').message).toMatch(
      /Writes are disabled: DELETE \/rest\/api\/2\/issue\/DEMO-1.*JIRA_ALLOW_WRITES=true/,
    );
    const tooLarge = new ResponseTooLargeError('GET', '/rest/api/2/field', 1024);
    expect(tooLarge.message).toMatch(/exceeds 1024 bytes \(JIRA_MAX_RESPONSE_BYTES\)/);
    expect(tooLarge.maxBytes).toBe(1024);
  });

  it('formats RequestCancelledError, warning that a write may already be applied', () => {
    expect(new RequestCancelledError('GET', '/rest/api/2/myself', 'read').message).toBe(
      'Jira GET /rest/api/2/myself cancelled by the MCP client',
    );
    expect(new RequestCancelledError('POST', '/rest/api/2/issue', 'write').message).toBe(
      'Jira POST /rest/api/2/issue cancelled by the MCP client. The operation may already have been applied by Jira: check its state before retrying.',
    );
  });
});
