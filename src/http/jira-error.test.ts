import { describe, expect, it } from 'vitest';
import {
  JiraApiError,
  RequestCancelledError,
  ResponseTooLargeError,
  WritesDisabledError,
  WRITE_OUTCOME_UNKNOWN,
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

describe('extractErrorDetails — rendering (audit)', () => {
  it('serialises non-string values instead of [object Object]', () => {
    const body = JSON.stringify({
      errorMessages: [{ code: 'E1', text: 'nested' }],
      errors: { sprint: { reason: 'closed' } },
    });
    expect(extractErrorDetails(body, 'application/json')).toEqual([
      '{"code":"E1","text":"nested"}',
      'sprint: {"reason":"closed"}',
    ]);
  });

  it('decodes HTML entities in the title', () => {
    expect(
      extractErrorDetails(
        '<title>Log in - Jira &amp; Co &#39;x&#39; &lt;b&gt;&#x21;&#63;</title>',
        'text/html',
      ),
    ).toEqual(["Log in - Jira & Co 'x' <b>!?"]);
  });

  it('strips markup, scripts and styles from an HTML body without a title', () => {
    const html =
      '<html><head><style>p{color:red}</style><script>var secret = 1;</script></head><body><h1>Proxy error</h1><p>Upstream &amp; down</p></body></html>';
    expect(extractErrorDetails(html, 'text/html')).toEqual(['Proxy error Upstream & down']);
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

  it('shows Retry-After for 503 too, and an HTTP-date as is', () => {
    expect(new JiraApiError(503, 'GET', '/rest/x', ['busy'], '30').message).toBe(
      'Jira GET /rest/x failed with HTTP 503: busy — service unavailable (Retry-After: 30 s)',
    );
    expect(
      new JiraApiError(503, 'GET', '/rest/x', [], 'Wed, 21 Oct 2026 07:28:00 GMT').message,
    ).toBe(
      'Jira GET /rest/x failed with HTTP 503 — service unavailable (Retry-After: Wed, 21 Oct 2026 07:28:00 GMT)',
    );
  });

  it('adds short hints for 401, 403 and 404, and the authentication denial reason', () => {
    expect(new JiraApiError(401, 'GET', '/rest/x', []).message).toBe(
      'Jira GET /rest/x failed with HTTP 401 — the PAT is invalid, expired or revoked (check JIRA_PAT)',
    );
    expect(
      new JiraApiError(403, 'GET', '/rest/x', [], null, undefined, 'CAPTCHA_CHALLENGE; login-url=x')
        .message,
    ).toBe(
      'Jira GET /rest/x failed with HTTP 403 — the PAT account lacks the Jira permission for this operation (X-Authentication-Denied-Reason: CAPTCHA_CHALLENGE; login-url=x)',
    );
    expect(new JiraApiError(404, 'GET', '/rest/x', ['nope']).message).toBe(
      'Jira GET /rest/x failed with HTTP 404: nope — not found, or not visible to the PAT account',
    );
  });

  it('exposes the write warning used for writes of unknown outcome', () => {
    expect(WRITE_OUTCOME_UNKNOWN).toBe(
      'The operation may already have been applied by Jira: check its state before retrying.',
    );
  });
});
