import { afterEach, describe, expect, it, vi } from 'vitest';
import { JiraClient, type FetchLike } from '../../src/http/jira-client.ts';
import { fetchSources } from './sources.ts';

const xml = (base: string) =>
  `<?xml version="1.0"?><application xmlns="http://wadl.dev.java.net/2009/02"><resources base="https://jira.example.com${base}/"/></application>`;

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
