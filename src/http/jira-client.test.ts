/* oxlint-disable eslint/no-await-in-loop -- cases run sequentially on purpose (shared mock) */
import { describe, expect, it, vi } from 'vitest';
import { runWithCancellation } from './cancellation.ts';
import {
  JiraClient,
  isRetryable,
  retryDelayMs,
  type FetchLike,
  type JiraClientOptions,
} from './jira-client.ts';
import {
  JiraApiError,
  RequestCancelledError,
  ResponseTooLargeError,
  WritesDisabledError,
} from './jira-error.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', ...headers },
  });

function setup(overrides: Partial<JiraClientOptions> = {}) {
  const fetchMock = vi.fn<FetchLike>();
  const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {});
  const client = new JiraClient({
    baseUrl: 'https://jira.test/',
    pat: 'secret-pat',
    allowWrites: true,
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    fetch: fetchMock,
    sleep,
    ...overrides,
  });
  const call = (index = 0) => {
    const c = fetchMock.mock.calls[index];
    if (!c) throw new Error(`no fetch call #${index}`);
    const init = c[1] ?? {};
    return {
      url: new URL(String(c[0])),
      init,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
  };
  return { client, fetchMock, sleep, call };
}

describe('JiraClient.request — transport', () => {
  it('sends the PAT as a bearer token, refuses redirects and parses JSON', async () => {
    const { client, fetchMock, call } = setup();
    fetchMock.mockResolvedValueOnce(json({ version: '8.20.0' }));
    const res = await client.request({
      method: 'GET',
      path: '/rest/api/2/serverInfo',
      access: 'read',
    });
    expect(res).toEqual({ status: 200, data: { version: '8.20.0' } });
    const { url, init, headers } = call();
    expect(url.href).toBe('https://jira.test/rest/api/2/serverInfo');
    expect(init.redirect).toBe('error');
    expect(headers.Authorization).toBe('Bearer secret-pat');
    expect(headers.Accept).toBe('application/json');
  });

  it('keeps a context path from the base URL (with or without trailing slash)', async () => {
    for (const baseUrl of ['https://jira.example.com/jira', 'https://jira.example.com/jira/']) {
      const { client, fetchMock, call } = setup({ baseUrl });
      fetchMock.mockResolvedValueOnce(json({}));
      await client.request({ method: 'GET', path: '/rest/api/2/serverInfo', access: 'read' });
      expect(call().url.href).toBe('https://jira.example.com/jira/rest/api/2/serverInfo');
    }
  });

  it('encodes query values, repeats arrays and skips undefined (accents included)', async () => {
    const { client, fetchMock, call } = setup();
    fetchMock.mockResolvedValueOnce(json({}));
    await client.request({
      method: 'GET',
      path: '/rest/api/2/search',
      access: 'read',
      query: {
        jql: 'status = "Fermée"',
        fields: ['summary', 'status'],
        maxResults: 5,
        expand: undefined,
      },
    });
    const { url } = call();
    expect(url.searchParams.get('jql')).toBe('status = "Fermée"');
    expect(url.search).toContain('Ferm%C3%A9e');
    expect(url.searchParams.getAll('fields')).toEqual(['summary', 'status']);
    expect(url.searchParams.has('expand')).toBe(false);
  });

  it('serialises JSON bodies and sends FormData with the XSRF bypass header', async () => {
    const { client, fetchMock, call } = setup();
    fetchMock.mockResolvedValueOnce(json({ key: 'DEMO-1' }, 201)).mockResolvedValueOnce(json([]));
    await client.request({
      method: 'POST',
      path: '/rest/api/2/issue',
      access: 'write',
      body: { fields: { summary: 'é' } },
    });
    expect(call(0).headers['Content-Type']).toBe('application/json');
    expect(call(0).init.body).toBe('{"fields":{"summary":"é"}}');
    const form = new FormData();
    form.append('file', new Blob(['hello']), 'hello.txt');
    await client.request({
      method: 'POST',
      path: '/rest/api/2/issue/DEMO-1/attachments',
      access: 'write',
      body: form,
    });
    expect(call(1).init.body).toBe(form);
    expect(call(1).headers['X-Atlassian-Token']).toBe('no-check');
    expect(call(1).headers['Content-Type']).toBeUndefined();
  });

  it('honours a custom Accept header, returns text for non-JSON and null for 204', async () => {
    const { client, fetchMock, call } = setup();
    fetchMock
      .mockResolvedValueOnce(
        new Response('<application/>', { headers: { 'content-type': 'application/xml' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const wadl = await client.request({
      method: 'GET',
      path: '/rest/api/2/application.wadl',
      access: 'read',
      accept: 'application/xml',
    });
    expect(wadl.data).toBe('<application/>');
    expect(call(0).headers.Accept).toBe('application/xml');
    const put = await client.request({
      method: 'PUT',
      path: '/rest/api/2/issue/DEMO-1',
      access: 'write',
      body: {},
    });
    expect(put).toEqual({ status: 204, data: null });
  });

  it('refuses paths outside /rest/', async () => {
    const { client, fetchMock } = setup();
    await expect(
      client.request({ method: 'GET', path: '/secure/Dashboard.jspa', access: 'read' }),
    ).rejects.toThrow(/non-REST path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('JiraClient.request — errors', () => {
  it('throws JiraApiError with Jira error details', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      json({ errorMessages: [], errors: { summary: 'Requis' } }, 400),
    );
    const promise = client.request({
      method: 'POST',
      path: '/rest/api/2/issue',
      access: 'write',
      body: {},
    });
    await expect(promise).rejects.toBeInstanceOf(JiraApiError);
    await expect(promise).rejects.toThrow('HTTP 400: summary: Requis');
  });

  it('turns an HTML 404 page into a readable error', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      new Response(
        '<html><head><title>Oups, vous avez trouvé un lien mort. - JIRA</title></head></html>',
        {
          status: 404,
          headers: { 'content-type': 'text/html;charset=UTF-8' },
        },
      ),
    );
    await expect(
      client.request({ method: 'GET', path: '/rest/servicedeskapi/servicedesk', access: 'read' }),
    ).rejects.toThrow('HTTP 404: Oups, vous avez trouvé un lien mort. - JIRA');
  });

  it('reads at most 64 KiB of an error body', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      new Response(`${'x'.repeat(70 * 1024)}<title>late</title>`, { status: 500 }),
    );
    const error = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('late');
  });

  it('reports timeouts and network failures with their cause, without the PAT', async () => {
    const { client, fetchMock } = setup({ maxRetries: 0 });
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'TimeoutError'));
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow('Jira GET /rest/api/2/myself timed out after 1000 ms');
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: new Error('unable to verify the first certificate') }),
    );
    const error = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain(
      'fetch failed (unable to verify the first certificate)',
    );
    expect((error as Error).message).not.toContain('secret-pat');
  });
});

describe('JiraClient.request — write guard', () => {
  it('blocks write and destructive requests when writes are disabled, whatever the verb', async () => {
    const { client, fetchMock } = setup({ allowWrites: false });
    for (const req of [
      { method: 'POST', path: '/rest/api/2/issue', access: 'write' },
      { method: 'DELETE', path: '/rest/api/2/issue/DEMO-1', access: 'destructive' },
      { method: 'GET', path: '/rest/some/side-effect', access: 'write' },
    ] as const) {
      await expect(client.request(req)).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a POST classified as read through when writes are disabled', async () => {
    const { client, fetchMock } = setup({ allowWrites: false });
    fetchMock.mockResolvedValueOnce(json({ total: 0 }));
    await client.request({
      method: 'POST',
      path: '/rest/api/2/search',
      access: 'read',
      body: { jql: 'project = DEMO' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a DELETE declared as read', async () => {
    const { client } = setup();
    await expect(
      client.request({ method: 'DELETE', path: '/rest/api/2/issue/DEMO-1', access: 'read' }),
    ).rejects.toThrow(/cannot be classified as read/);
  });
});

describe('JiraClient.request — retries', () => {
  it('retries reads on 429/502/503/504 using Retry-After or backoff', async () => {
    const { client, fetchMock, sleep } = setup();
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(json({ ok: true }));
    expect(
      (await client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })).data,
    ).toEqual({ ok: true });
    expect(sleep).toHaveBeenLastCalledWith(500, undefined);
    fetchMock
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(json({ total: 0 }));
    await client.request({ method: 'POST', path: '/rest/api/2/search', access: 'read', body: {} });
    expect(sleep).toHaveBeenLastCalledWith(1000, undefined);
  });

  it('retries reads after a network error and gives up after maxRetries', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json({}));
    await client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('bad gateway', { status: 502 }));
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow('HTTP 502');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries writes, even idempotent verbs or rate limiting', async () => {
    const { client, fetchMock } = setup();
    const cases = [
      {
        req: { method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} },
        res: new Response('', { status: 429, headers: { 'retry-after': '7' } }),
      },
      {
        req: { method: 'PUT', path: '/rest/api/2/issue/DEMO-1', access: 'write', body: {} },
        res: new Response('', { status: 503 }),
      },
      {
        req: {
          method: 'POST',
          path: '/rest/api/2/issue/DEMO-1/comment',
          access: 'write',
          body: {},
        },
        res: new Response('', { status: 504 }),
      },
    ] as const;
    for (const { req, res } of cases) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(res);
      await expect(client.request(req)).rejects.toBeInstanceOf(JiraApiError);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      client.request({ method: 'DELETE', path: '/rest/api/2/issue/DEMO-1', access: 'destructive' }),
    ).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('isRetryable only accepts non-multipart reads', () => {
    expect(isRetryable({ method: 'GET', path: '/rest/x', access: 'read' })).toBe(true);
    expect(isRetryable({ method: 'POST', path: '/rest/x', access: 'read', body: {} })).toBe(true);
    expect(isRetryable({ method: 'PUT', path: '/rest/x', access: 'write' })).toBe(false);
    expect(
      isRetryable({ method: 'POST', path: '/rest/x', access: 'read', body: new FormData() }),
    ).toBe(false);
  });
});

describe('JiraClient.request — response size limit', () => {
  it('rejects a declared Content-Length above the limit without reading the body', async () => {
    const { client, fetchMock } = setup({ maxResponseBytes: 100 });
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '5000000' },
      }),
    );
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/field', access: 'read' }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('stops reading a streamed body as soon as it exceeds the limit', async () => {
    const { client, fetchMock } = setup({ maxResponseBytes: 100 });
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64));
        if (pulled > 1000) controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
    );
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/field', access: 'read' }),
    ).rejects.toThrow('exceeds 100 bytes');
    expect(pulled).toBeLessThan(10);
  });

  it('accepts a body exactly at the limit', async () => {
    const { client, fetchMock } = setup({ maxResponseBytes: 8 });
    fetchMock.mockResolvedValueOnce(
      new Response('"123456"', { headers: { 'content-type': 'application/json' } }),
    );
    expect((await client.request({ method: 'GET', path: '/rest/x', access: 'read' })).data).toBe(
      '123456',
    );
  });
});

/** A fetch that never answers and rejects as soon as its signal aborts, like the real fetch. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });

describe('JiraClient.request — cancellation', () => {
  it('does not call Jira when the signal is already aborted', async () => {
    const { client, fetchMock } = setup();
    await expect(
      client.request({
        method: 'GET',
        path: '/rest/api/2/myself',
        access: 'read',
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(RequestCancelledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts the in-flight fetch and never retries a cancelled read', async () => {
    const { client, fetchMock, call } = setup();
    fetchMock.mockImplementation(hangingFetch);
    const controller = new AbortController();
    const pending = client.request({
      method: 'GET',
      path: '/rest/api/2/myself',
      access: 'read',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow(
      'Jira GET /rest/api/2/myself cancelled by the MCP client',
    );
    expect(call().init.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stops before a retry when cancelled while waiting', async () => {
    const { client, fetchMock, sleep } = setup();
    const controller = new AbortController();
    sleep.mockImplementationOnce(async () => controller.abort());
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    await expect(
      client.request({
        method: 'GET',
        path: '/rest/api/2/myself',
        access: 'read',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RequestCancelledError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stops reading a body when cancelled mid-stream', async () => {
    const { client, fetchMock } = setup();
    const controller = new AbortController();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(8));
        // The first pull happens when the stream is created; abort once the client has started reading.
        if (++pulled === 2) controller.abort();
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
    );
    await expect(
      client.request({
        method: 'GET',
        path: '/rest/api/2/field',
        access: 'read',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RequestCancelledError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pulled).toBeLessThan(5);
  });

  it('uses the ambient signal set by runWithCancellation and warns that a write may be applied', async () => {
    const { client, fetchMock, call } = setup();
    fetchMock.mockImplementation(hangingFetch);
    const controller = new AbortController();
    const pending = runWithCancellation(controller.signal, () =>
      client.request({ method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow('may already have been applied by Jira');
    expect(call().init.signal?.aborted).toBe(true);
  });

  it('still reports a timeout as a timeout when a cancellation signal is present', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20, maxRetries: 0 });
    fetchMock.mockImplementation(hangingFetch);
    await expect(
      client.request({
        method: 'GET',
        path: '/rest/api/2/myself',
        access: 'read',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('timed out after 20 ms');
  });
});

/** Answers 200 with a first chunk, then stalls; the body errors with the signal's reason on abort, like real fetch. */
const stallingBodyFetch: FetchLike = async (_input, init) => {
  const signal = init?.signal;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/json' } });
};

describe('JiraClient.request — aborts during the body read', () => {
  it('maps a cancellation mid-body to RequestCancelledError, with the write warning', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockImplementation(stallingBodyFetch);
    const controller = new AbortController();
    const pending = client.request({
      method: 'POST',
      path: '/rest/api/2/issue',
      access: 'write',
      body: {},
      signal: controller.signal,
    });
    pending.catch(() => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow('may already have been applied by Jira');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('maps a timeout mid-body to a timeout error and retries a read once', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20, maxRetries: 1 });
    fetchMock.mockImplementation(stallingBodyFetch);
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow('Jira GET /rest/api/2/myself timed out after 20 ms');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a write that times out mid-body', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20, maxRetries: 1 });
    fetchMock.mockImplementation(stallingBodyFetch);
    await expect(
      client.request({ method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} }),
    ).rejects.toThrow('timed out after 20 ms');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('applies the same mapping to an error body', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20, maxRetries: 0 });
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(stream, { status: 500 });
    });
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow('timed out after 20 ms');
  });
});

describe('retryDelayMs', () => {
  it('uses Retry-After seconds, capped at 10 s, else exponential backoff', () => {
    expect(retryDelayMs('2', 0)).toBe(2000);
    expect(retryDelayMs('120', 0)).toBe(10_000);
    expect(retryDelayMs(null, 0)).toBe(500);
    expect(retryDelayMs('soon', 1)).toBe(1000);
  });
});
