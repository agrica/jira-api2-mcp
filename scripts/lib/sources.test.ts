import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JiraClient, type FetchLike } from '../../src/http/jira-client.ts';
import { fetchSources, readCatalogJson, readLockIfAny } from './sources.ts';

const xml = (base: string) =>
  `<?xml version="1.0"?><application xmlns="http://wadl.dev.java.net/2009/02"><resources base="https://jira.example.com${base}/"><resource path="x"><method name="GET"/></resource></resources></application>`;

function setup(statusFor: (path: string) => number) {
  const fetchMock = vi.fn<FetchLike>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/rest/api/2/serverInfo')
      return new Response(JSON.stringify({ version: '8.20.0', buildNumber: 820000 }), {
        headers: { 'content-type': 'application/json' },
      });
    const status = statusFor(path);
    if (status !== 200) return new Response('<html>nope</html>', { status });
    return new Response(xml(path.replace('/application.wadl', '')), {
      headers: { 'content-type': 'application/xml' },
    });
  });
  const client = new JiraClient({
    baseUrl: 'https://jira.example.com',
    pat: 'test-pat',
    allowWrites: false,
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    fetch: fetchMock,
    sleep: async () => {},
  });
  return { client, fetchMock };
}

describe('fetchSources', () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => {
    stderr.mockClear();
  });

  it('fetches every source and records none as absent', async () => {
    const { client } = setup(() => 200);
    const { meta, xml: files } = await fetchSources(client);
    expect(meta.sources.map((s) => s.file)).toEqual(['api.wadl', 'agile.wadl', 'xray.wadl']);
    expect(meta.absent).toEqual([]);
    expect([...files.keys()]).toEqual(['api.wadl', 'agile.wadl', 'xray.wadl']);
    expect(meta).toMatchObject({ jiraVersion: '8.20.0', jiraBuildNumber: 820000 });
  });

  it('skips an optional source answering 404 and records it as absent', async () => {
    const { client } = setup((path) => (path.startsWith('/rest/raven/') ? 404 : 200));
    const { meta, xml: files } = await fetchSources(client);
    expect(meta.sources.map((s) => s.file)).toEqual(['api.wadl', 'agile.wadl']);
    expect(meta.absent).toEqual(['xray.wadl']);
    expect(files.has('xray.wadl')).toBe(false);
    expect(stderr).toHaveBeenCalledWith('xray WADL not found: skipped (plugin not installed)');
  });

  it('fails when a required source answers 404', async () => {
    const { client } = setup((path) => (path.startsWith('/rest/agile/') ? 404 : 200));
    await expect(fetchSources(client)).rejects.toThrow('HTTP 404');
  });

  it('fails when an optional source answers anything else than 404', async () => {
    const { client, fetchMock } = setup((path) => (path.startsWith('/rest/raven/') ? 500 : 200));
    await expect(fetchSources(client)).rejects.toThrow('HTTP 500');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects a non-text WADL payload', async () => {
    const { client, fetchMock } = setup(() => 200);
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ version: '8.20.0', buildNumber: 1 }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
    await expect(fetchSources(client)).rejects.toThrow('Unexpected WADL payload');
  });
});

describe('fetchSources — validation before any file is written', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});

  it('refuses an SSO or proxy page answered 200 instead of a WADL, optional source included', async () => {
    for (const prefix of ['/rest/api/', '/rest/raven/']) {
      const { client, fetchMock } = setup(() => 200);
      const real = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (input, init) =>
        new URL(String(input)).pathname.startsWith(`${prefix}`) &&
        !String(input).includes('serverInfo')
          ? new Response('<html><body>Log in</body></html>', {
              headers: { 'content-type': 'application/xml' },
            })
          : (real?.(input, init) ?? new Response('')),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- one fresh client per case
      await expect(fetchSources(client)).rejects.toThrow(/WADL is not a usable WADL/);
    }
  });

  it('refuses a serverInfo without version or build number', async () => {
    for (const body of ['{}', '{"version":"","buildNumber":1}', '{"version":"8.20.0"}']) {
      const { client, fetchMock } = setup(() => 200);
      fetchMock.mockImplementationOnce(
        async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- one fresh client per case
      await expect(fetchSources(client)).rejects.toThrow(
        '/rest/api/2/serverInfo did not return a Jira version and build number',
      );
    }
  });
});

describe('readCatalogJson / readLockIfAny', () => {
  const dir = new URL('../../catalog/', import.meta.url);

  it('names a missing or invalid file and the hint, without a stack trace', async () => {
    await expect(
      readCatalogJson(new URL('absent-file-xyz.json', dir), 'run npm run catalog:fetch'),
    ).rejects.toThrow('missing catalog/absent-file-xyz.json — run npm run catalog:fetch');
    await expect(readCatalogJson(new URL('../README.md', dir), 'restore it')).rejects.toThrow(
      /README\.md is not valid JSON — restore it/,
    );
  });

  it('reads valid JSON', async () => {
    expect(
      await readCatalogJson<Record<string, unknown>>(new URL('access-decisions.json', dir), ''),
    ).toBeTypeOf('object');
  });
});

describe('readLockIfAny — injected location', () => {
  it('returns undefined for a missing lock and refuses a corrupt one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jira-api2-mcp-lock-'));
    const url = pathToFileURL(join(dir, 'source-lock.json'));
    await expect(readLockIfAny(url)).resolves.toBeUndefined();
    await writeFile(url, '{oops');
    await expect(readLockIfAny(url)).rejects.toThrow(/is not valid JSON — restore it from git/);
    await writeFile(url, '{"jiraVersion":"8.20.0"}');
    await expect(readLockIfAny(url)).resolves.toEqual({ jiraVersion: '8.20.0' });
  });
});
