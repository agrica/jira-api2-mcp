import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScript, sanitizeError } from './run-script.ts';

const BASE = 'https://jira.example.com:8443/jira';

const withCause = (message: string, cause: unknown, name = 'TypeError') => {
  const error = new Error(message, { cause });
  error.name = name;
  return error;
};

describe('sanitizeError', () => {
  it('returns one line "<name>: <message>"', () => {
    expect(sanitizeError(new RangeError('bad\nvalue'), BASE)).toBe('RangeError: bad value');
  });

  it('redacts the base URL (with and without trailing slash), host and hostname', () => {
    const message = [
      `GET ${BASE}/ failed`,
      `GET ${BASE} failed`,
      'via jira.example.com:8443',
      'cert for JIRA.example.com',
    ].join('; ');
    const out = sanitizeError(new Error(message), `${BASE}/`);
    expect(out).toBe(
      'Error: GET <instance>/ failed; GET <instance> failed; via <instance>; cert for <instance>',
    );
    expect(out).not.toContain('example.com');
  });

  it('redacts IPv4 and IPv6 literals even without a base URL', () => {
    const out = sanitizeError(
      new Error(
        'connect ECONNREFUSED 192.0.2.10:443, [2001:db8::1]:443, ::ffff:192.0.2.11 and 2001:db8:0:0:0:0:0:2',
      ),
      undefined,
    );
    expect(out).toBe('Error: connect ECONNREFUSED <ip>:443, [<ip>]:443, <ip> and <ip>');
  });

  it('appends the code of the deepest cause and never prints cause, cert or stack details', () => {
    const tls = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      host: 'jira.example.com',
      cert: {
        subject: { O: 'Example Org', CN: 'jira.example.com' },
        subjectaltname: 'DNS:jira.example.com',
        fingerprint256: 'AA:BB',
      },
    });
    const middle = Object.assign(withCause('middle layer', tls, 'Error'), { code: 'EMIDDLE' });
    const out = sanitizeError(withCause('fetch failed', middle), BASE);
    expect(out).toBe('TypeError: fetch failed [UNABLE_TO_VERIFY_LEAF_SIGNATURE]');
    for (const leak of ['Example Org', 'example.com', 'AA:BB', 'middle layer', ' at ']) {
      expect(out).not.toContain(leak);
    }
  });

  it('drops cause messages embedded in the top message (TLS altnames) and certificate names', () => {
    const tls = Object.assign(
      new Error(
        "Hostname/IP does not match certificate's altnames: Host: jira.example.com. is not in the cert's altnames: DNS:intranet.example.net, DNS:*.example.net",
      ),
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    );
    const fetchError = withCause('fetch failed', tls);
    const top = withCause(`Jira GET /x failed: fetch failed (${tls.message})`, fetchError, 'Error');
    const out = sanitizeError(top, BASE);
    expect(out).toBe('Error: Jira GET /x failed: [ERR_TLS_CERT_ALTNAME_INVALID]');
    expect(out).not.toContain('example.net');
    expect(
      sanitizeError(new Error('altnames: DNS:a.example.net, IP Address:192.0.2.1'), undefined),
    ).toBe('Error: altnames: <cert-name>, <cert-name>');
  });

  it('omits a non-string code and survives a cyclic cause chain', () => {
    const a = new Error('a');
    const b = Object.assign(new Error('b', { cause: a }), { code: 42 });
    Object.assign(a, { cause: b });
    expect(sanitizeError(a, undefined)).toBe('Error: a');
    expect(sanitizeError(withCause('x', 'plain string cause', 'Error'), undefined)).toBe(
      'Error: x',
    );
  });

  it('ignores an unparseable base URL and maps non-Error values to a generic line', () => {
    expect(sanitizeError(new Error('boom'), 'not a url')).toBe('Error: boom');
    for (const value of ['jira.example.com', { message: 'jira.example.com' }, undefined, 42]) {
      expect(sanitizeError(value, BASE)).toBe('Error: unexpected failure');
    }
  });
});

describe('runScript', () => {
  const previousExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('prints only the sanitized line and sets exitCode=1 on failure', async () => {
    vi.stubEnv('JIRA_BASE_URL', BASE);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runScript(async () => {
      throw new Error(`cannot reach ${BASE}/rest/api/2/serverInfo`);
    });
    expect(errors.mock.calls).toEqual([['✖ Error: cannot reach <instance>/rest/api/2/serverInfo']]);
    expect(process.exitCode).toBe(1);
  });

  it('leaves the exit code to main on success', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    await runScript(async () => {
      process.exitCode = 2;
    });
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
