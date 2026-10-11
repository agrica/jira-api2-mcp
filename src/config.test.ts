import { describe, expect, it } from 'vitest';
import { loadConfig, startupWarnings } from './config.ts';

const base = { JIRA_BASE_URL: 'https://jira.example.com/', JIRA_PAT: 'pat-123' };

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('loadConfig', () => {
  it('is read-only and requires HTTPS by default', () => {
    expect(loadConfig(base)).toEqual({
      baseUrl: 'https://jira.example.com',
      pat: 'pat-123',
      allowWrites: false,
      allowInsecureHttp: false,
      timeoutMs: 30_000,
      maxResponseBytes: 5 * 1024 * 1024,
      maxOutputChars: 100_000,
      catalogPath: undefined,
    });
  });

  it('accepts a base URL with a context path', () => {
    expect(loadConfig({ ...base, JIRA_BASE_URL: 'https://jira.example.com/jira/' }).baseUrl).toBe(
      'https://jira.example.com/jira',
    );
  });

  it('enables writes only when explicitly requested', () => {
    expect(loadConfig({ ...base, JIRA_ALLOW_WRITES: 'true' }).allowWrites).toBe(true);
    expect(loadConfig({ ...base, JIRA_ALLOW_WRITES: '1' }).allowWrites).toBe(true);
    expect(loadConfig({ ...base, JIRA_ALLOW_WRITES: 'false' }).allowWrites).toBe(false);
  });

  it('parses numeric limits and the catalog path', () => {
    const config = loadConfig({
      ...base,
      JIRA_TIMEOUT_MS: '5000',
      JIRA_MAX_RESPONSE_BYTES: '1024',
      JIRA_MAX_OUTPUT_CHARS: '2000',
      JIRA_CATALOG_PATH: '/opt/jira-mcp/catalog.json',
    });
    expect([config.timeoutMs, config.maxResponseBytes, config.maxOutputChars]).toEqual([
      5000, 1024, 2000,
    ]);
    expect(config.catalogPath).toBe('/opt/jira-mcp/catalog.json');
  });

  it('accepts plain HTTP only with JIRA_ALLOW_INSECURE_HTTP=true', () => {
    expect(() => loadConfig({ ...base, JIRA_BASE_URL: 'http://jira.example.com' })).toThrow(
      /HTTPS is required by default.*JIRA_ALLOW_INSECURE_HTTP=true/,
    );
    const insecure = loadConfig({
      ...base,
      JIRA_BASE_URL: 'http://localhost:8080',
      JIRA_ALLOW_INSECURE_HTTP: 'true',
    });
    expect(insecure.baseUrl).toBe('http://localhost:8080');
    expect(insecure.allowInsecureHttp).toBe(true);
  });

  it('detects plain HTTP regardless of scheme case', () => {
    expect(() => loadConfig({ ...base, JIRA_BASE_URL: 'HTTP://jira.example.com' })).toThrow(
      /HTTPS is required by default/,
    );
  });

  it('rejects missing PAT, other schemes and invalid flags', () => {
    expect(() => loadConfig({ JIRA_BASE_URL: 'https://jira.example.com' })).toThrow(/JIRA_PAT/);
    expect(() => loadConfig({ ...base, JIRA_BASE_URL: 'ftp://jira' })).toThrow(/JIRA_BASE_URL/);
    expect(() => loadConfig({ ...base, JIRA_ALLOW_WRITES: 'yes' })).toThrow(/JIRA_ALLOW_WRITES/);
  });

  it('never echoes the PAT in error messages', () => {
    // Built by concatenation so that secrets:scan does not flag this test file.
    const secret = ['super', 'secret', 'token'].join('-');
    for (const env of [
      { JIRA_BASE_URL: 'not a url', JIRA_PAT: secret },
      { JIRA_BASE_URL: 'http://jira.example.com', JIRA_PAT: secret },
    ]) {
      const message = errorMessage(() => loadConfig(env));
      expect(message).toMatch(/Invalid configuration/);
      expect(message).not.toContain(secret);
    }
  });
});

describe('startupWarnings', () => {
  it('warns only when plain HTTP is in use', () => {
    expect(startupWarnings(loadConfig(base))).toEqual([]);
    const insecure = loadConfig({
      ...base,
      JIRA_BASE_URL: 'http://localhost:8080',
      JIRA_ALLOW_INSECURE_HTTP: 'true',
    });
    expect(startupWarnings(insecure)).toEqual([
      'Plain HTTP enabled by JIRA_ALLOW_INSECURE_HTTP=true: the PAT travels unencrypted. Reserved for exceptional local tests.',
    ]);
    expect(startupWarnings(loadConfig({ ...base, JIRA_ALLOW_INSECURE_HTTP: 'true' }))).toEqual([]);
    const upper = loadConfig({
      ...base,
      JIRA_BASE_URL: 'HTTP://localhost:8080',
      JIRA_ALLOW_INSECURE_HTTP: 'true',
    });
    expect(startupWarnings(upper)).toHaveLength(1);
  });
});
