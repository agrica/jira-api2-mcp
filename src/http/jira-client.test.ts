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

/** undici-like network failure: TypeError "fetch failed" whose cause carries a system error code. */
const networkError = (code: string, message = `connect ${code}`) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

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
    random: () => 1,
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
    fetchMock.mockRejectedValueOnce(networkError('ECONNRESET')).mockResolvedValueOnce(json({}));
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
  it('maps a cancellation mid-body of a 2xx write to RequestCancelledError saying it WAS applied', async () => {
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
    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    await expect(pending).rejects.toThrow(
      'Jira POST /rest/api/2/issue cancelled by the MCP client after Jira answered HTTP 200: the write WAS applied. Do not retry it.',
    );
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

  it('does not retry a 2xx write that times out mid-body, and reports it as applied', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20, maxRetries: 1 });
    fetchMock.mockImplementation(stallingBodyFetch);
    const res = await client.request({
      method: 'POST',
      path: '/rest/api/2/issue',
      access: 'write',
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.data).toBe(
      'Jira POST /rest/api/2/issue succeeded (HTTP 200): the write WAS applied, but its response could not be read (connection lost / timed out while reading it). Do not retry it; read the resulting state if you need its details.',
    );
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
  it('uses Retry-After seconds up to the 10 s cap, else exponential backoff (capped)', () => {
    expect(retryDelayMs('2', 0)).toBe(2000);
    expect(retryDelayMs('10', 0)).toBe(10_000);
    expect(retryDelayMs(null, 0)).toBe(500);
    expect(retryDelayMs('', 1)).toBe(retryDelayMs(null, 1));
    expect(retryDelayMs('  ', 1)).toBe(retryDelayMs(null, 1));
    expect(retryDelayMs('soon', 1)).toBe(1000);
    expect(retryDelayMs(null, 10)).toBe(10_000);
  });

  it('returns undefined when Retry-After asks for more than the cap (do not retry early)', () => {
    expect(retryDelayMs('11', 0)).toBeUndefined();
    expect(retryDelayMs('120', 0)).toBeUndefined();
  });
});

describe('JiraClient.request — Retry-After above the cap', () => {
  it('surfaces the 429 without retrying when Retry-After exceeds the cap', async () => {
    const { client, fetchMock, sleep } = setup();
    fetchMock.mockResolvedValueOnce(
      new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const error = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraApiError);
    expect((error as JiraApiError).status).toBe(429);
    expect((error as Error).message).toContain('Retry-After 120 s exceeds the retry cap');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('still retries when Retry-After is at the cap', async () => {
    const { client, fetchMock, sleep } = setup();
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '10' } }))
      .mockResolvedValueOnce(json({ ok: true }));
    await client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' });
    expect(sleep).toHaveBeenCalledWith(10_000, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** 200 response whose body sends one chunk then fails like a dropped connection (undici: TypeError "terminated"). */
const brokenBody = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"par'));
      },
      pull(controller) {
        controller.error(new TypeError('terminated', { cause: new Error('ECONNRESET') }));
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

describe('JiraClient.request — network errors during the body read', () => {
  it('retries a read whose body fails mid-stream, within the retry budget', async () => {
    const { client, fetchMock, sleep } = setup();
    fetchMock.mockResolvedValueOnce(brokenBody()).mockResolvedValueOnce(json({ ok: true }));
    const res = await client.request({ method: 'GET', path: '/rest/api/2/field', access: 'read' });
    expect(res.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('gives up after maxRetries with a readable error', async () => {
    const { client, fetchMock } = setup({ maxRetries: 2 });
    fetchMock.mockImplementation(async () => brokenBody());
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/field', access: 'read' }),
    ).rejects.toThrow('Jira GET /rest/api/2/field failed while reading the response: terminated');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries a 2xx write whose body fails mid-stream, and reports it as applied', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(brokenBody()).mockResolvedValueOnce(json({ id: '1' }));
    const res = await client.request({
      method: 'POST',
      path: '/rest/api/2/issue',
      access: 'write',
      body: {},
    });
    expect(res.data).toBe(
      'Jira POST /rest/api/2/issue succeeded (HTTP 200): the write WAS applied, but its response could not be read (connection lost / timed out while reading it). Do not retry it; read the resulting state if you need its details.',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('JiraClient.request — path hardening (audit)', () => {
  it('refuses traversal, encoded separators, backslashes, query and fragment without calling Jira', async () => {
    const { client, fetchMock } = setup({ baseUrl: 'https://jira.example.com/jira' });
    for (const path of [
      '/rest/api/2/%2e%2e/%2e%2e/%2e%2e/plugins/servlet/x',
      '/rest/../../secure/Dashboard.jspa',
      String.raw`/rest/api/2/..\..\..\secure\admin`,
      '/rest/api/2/x?os_authType=basic#',
      '/rest/api/2/issue/a%2Fb',
      '/rest/api/2/..;/..;/..;/secure/admin',
      '/rest/api/2/.;/x',
      '/rest/api/2/..;jsessionid=1/secure/admin',
    ]) {
      await expect(client.request({ method: 'GET', path, access: 'read' })).rejects.toThrow(
        /Refusing to call a non-REST path/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds URLs that stay under <base path>/rest/ and refuses any other', () => {
    const { client } = setup({ baseUrl: 'https://jira.example.com/jira/' });
    expect(client.buildUrl('/rest/api/2/myself').href).toBe(
      'https://jira.example.com/jira/rest/api/2/myself',
    );
    expect(() => client.buildUrl('/rest/../../secure/Dashboard.jspa')).toThrow(
      'Refusing to call a URL outside <base URL>/rest/',
    );
  });

  it('refuses PUT and PATCH classified as read', async () => {
    const { client, fetchMock } = setup();
    for (const method of ['PUT', 'PATCH'] as const) {
      await expect(
        client.request({ method, path: '/rest/api/2/issue/DEMO-1', access: 'read' }),
      ).rejects.toThrow(`Inconsistent request: ${method} operations cannot be classified as read`);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a base URL with credentials, query or fragment, without echoing them', () => {
    const password = ['hunter', '2'].join('');
    for (const baseUrl of [
      `https://svc:${password}@jira.example.com`,
      'https://jira.example.com/jira?x=1',
      'https://jira.example.com/jira#f',
    ]) {
      let message = '';
      try {
        setup({ baseUrl });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        'JiraClient: the base URL must have no credentials, query string or fragment',
      );
    }
  });
});

describe('JiraClient.request — PAT never echoed (audit)', () => {
  it('redacts the PAT from undici header errors and their causes', async () => {
    const { client, fetchMock } = setup({ maxRetries: 0 });
    fetchMock.mockRejectedValueOnce(
      new TypeError('Headers.append: "Bearer secret-pat" is an invalid header value.', {
        cause: new Error('value secret-pat'),
      }),
    );
    const message = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(message).toContain('Headers.append: "Bearer <redacted>" is an invalid header value.');
    expect(message).not.toContain('secret-pat');
  });

  it('redacts a very short PAT in its header form only, without mangling other words', async () => {
    const { client, fetchMock } = setup({ pat: 'p', maxRetries: 0 });
    fetchMock.mockRejectedValueOnce(
      new TypeError('Headers.append: "Bearer p" is invalid (bad port)'),
    );
    const message = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(message).toContain('"Bearer <redacted>" is invalid (bad port)');
  });

  it('redacts IP addresses and certificate names from network error causes', async () => {
    const { client, fetchMock } = setup({ maxRetries: 0 });
    fetchMock.mockRejectedValueOnce(
      networkError('ECONNREFUSED', 'connect ECONNREFUSED 192.0.2.10:443'),
    );
    fetchMock.mockRejectedValueOnce(
      networkError(
        'ERR_TLS_CERT_ALTNAME_INVALID',
        "Hostname/IP does not match certificate's altnames: DNS:internal.example.org, IP Address:192.0.2.11",
      ),
    );
    const first = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(first).toBe(
      'Jira GET /rest/api/2/myself failed: fetch failed (connect ECONNREFUSED <ip>:443)',
    );
    const second = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(second).not.toContain('internal.example.org');
    expect(second).not.toContain('192.0.2.11');
  });
});

describe('JiraClient.request — error text hygiene (fix round 1)', () => {
  const write = { method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} } as const;

  it('does not warn when the request was refused before being sent', async () => {
    const { client, fetchMock } = setup();
    for (const error of [
      new TypeError('fetch failed', { cause: new TypeError('bad port') }),
      new TypeError('Headers.append: "x" is an invalid header value.'),
      new TypeError('Cannot convert argument to a ByteString'),
      new TypeError('Request cannot be constructed from a URL that includes credentials'),
    ]) {
      fetchMock.mockRejectedValueOnce(error);
      const message = await client.request(write).catch((e: unknown) => (e as Error).message);
      expect(message).not.toContain('may already have been applied');
    }
  });

  it('names the cause code when the cause message is empty (AggregateError)', async () => {
    const { client, fetchMock } = setup({ maxRetries: 0 });
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', {
        cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }),
      }),
    );
    const message = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(message).toBe('Jira GET /rest/api/2/myself failed: fetch failed (ECONNREFUSED)');
  });

  it('redacts the instance hostname from network errors', async () => {
    const { client, fetchMock } = setup({
      baseUrl: 'https://Jira.Example.com/jira',
      maxRetries: 0,
    });
    fetchMock.mockRejectedValueOnce(
      networkError('ENOTFOUND', 'getaddrinfo ENOTFOUND jira.example.com'),
    );
    const message = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(message).toBe(
      'Jira GET /rest/api/2/myself failed: fetch failed (getaddrinfo ENOTFOUND <instance>)',
    );
  });

  it('redacts the PAT echoed by a proxy in an error body or an HTML title', async () => {
    const { client, fetchMock } = setup();
    fetchMock
      .mockResolvedValueOnce(
        new Response('<html><body>Header: Bearer secret-pat</body></html>', {
          status: 500,
          headers: { 'content-type': 'text/html' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<title>Hello secret-pat</title>', {
          headers: { 'content-type': 'text/html' },
        }),
      );
    const first = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    const second = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(first).toContain('Header: Bearer <redacted>');
    expect(second).toContain('"Hello <redacted>"');
    expect(`${first}${second}`).not.toContain('secret-pat');
  });
});

describe('JiraClient.request — writes of unknown outcome (audit)', () => {
  const write = { method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} } as const;
  const warning = 'may already have been applied by Jira: check its state before retrying';

  it('warns on a write timeout while waiting for the response, not on a read timeout', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20, maxRetries: 0 });
    fetchMock.mockImplementation(hangingFetch);
    await expect(client.request(write)).rejects.toThrow(
      `Jira POST /rest/api/2/issue timed out after 20 ms. The operation ${warning}`,
    );
    const read = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(read).toBe('Jira GET /rest/api/2/myself timed out after 20 ms.');
  });

  it('reports a 2xx write that times out while reading the body as applied (multipart included)', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20 });
    fetchMock.mockImplementation(stallingBodyFetch);
    expect((await client.request(write)).data).toMatch(
      /succeeded \(HTTP 200\): the write WAS applied/,
    );
    const upload = await client.request({
      method: 'POST',
      path: '/rest/api/2/issue/DEMO-1/attachments',
      access: 'write',
      body: new FormData(),
    });
    expect(upload.data).toContain('connection lost / timed out while reading it');
  });

  it('keeps the may-have-been-applied warning for a write whose non-2xx body times out', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20 });
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(stream, { status: 500 });
    });
    await expect(client.request(write)).rejects.toThrow(
      `Jira POST /rest/api/2/issue timed out after 20 ms. The operation ${warning}`,
    );
  });

  it('warns on a connection reset after sending, not on a refused connection', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockRejectedValueOnce(networkError('UND_ERR_SOCKET', 'other side closed'));
    await expect(client.request(write)).rejects.toThrow(
      `Jira POST /rest/api/2/issue failed: fetch failed (other side closed). The operation ${warning}`,
    );
    fetchMock.mockRejectedValueOnce(networkError('ECONNREFUSED'));
    const refused = await client.request(write).catch((e: unknown) => (e as Error).message);
    expect(refused).toBe('Jira POST /rest/api/2/issue failed: fetch failed (connect ECONNREFUSED)');
    fetchMock.mockRejectedValueOnce(networkError('UND_ERR_SOCKET', 'other side closed'));
    await expect(
      client.request({ method: 'DELETE', path: '/rest/api/2/issue/DEMO-1', access: 'destructive' }),
    ).rejects.toThrow(warning);
  });

  it('warns on a write whose error body fails mid-stream', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 500 },
      ),
    );
    await expect(client.request(write)).rejects.toThrow(
      `failed while reading the response: terminated. The operation ${warning}`,
    );
  });

  it('reports a 2xx write with a too-large body as applied, not as a failure', async () => {
    const { client, fetchMock } = setup({ maxResponseBytes: 10 });
    fetchMock.mockResolvedValueOnce(json({ key: 'DEMO-1', padding: 'x'.repeat(100) }, 201));
    const res = await client.request(write);
    expect(res.status).toBe(201);
    expect(res.data).toBe(
      'Jira POST /rest/api/2/issue succeeded (HTTP 201): the write WAS applied, but its response could not be read (it exceeds 10 bytes, JIRA_MAX_RESPONSE_BYTES). Do not retry it; read the resulting state if you need its details.',
    );
    fetchMock.mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '5000' },
      }),
    );
    expect((await client.request({ ...write, method: 'PUT' })).data).toMatch(
      /succeeded \(HTTP 200\): the write WAS applied/,
    );
  });

  it('reports a 2xx write with invalid JSON as applied, and a read with invalid JSON as an error', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(badJson());
    expect((await client.request(write)).data).toBe(
      'Jira POST /rest/api/2/issue succeeded (HTTP 201): the write WAS applied, but its response could not be read (unparseable application/json body). Do not retry it; read the resulting state if you need its details.',
    );
    fetchMock.mockResolvedValueOnce(badJson());
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow(
      'Jira GET /rest/api/2/myself returned an unparseable application/json body (HTTP 201)',
    );
  });
});

/** 201 whose JSON body is truncated (e.g. rewritten by a proxy). */
const badJson = () =>
  new Response('{"key": "DEMO-1"', {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

/** Login page of an authentication proxy, answered with a 2xx status. */
const loginPage = (status = 200) =>
  new Response('<html><head><title>Log in - SSO &amp; Co</title></head><body>form</body></html>', {
    status,
    headers: { 'content-type': 'text/html;charset=UTF-8' },
  });

describe('JiraClient.request — 2xx HTML instead of JSON (audit)', () => {
  it('turns a 2xx HTML page into an error for a JSON read', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(loginPage());
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow(
      'Jira GET /rest/api/2/myself returned an unexpected HTML response instead of JSON (HTTP 200: "Log in - SSO & Co") — authentication proxy or SSO login page? Check JIRA_BASE_URL and the proxy.',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('adds the unknown-outcome warning for a write', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(loginPage(201));
    await expect(
      client.request({ method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} }),
    ).rejects.toThrow(
      /unexpected HTML response instead of JSON \(HTTP 201: "Log in - SSO & Co"\).*Check JIRA_BASE_URL and the proxy\. The operation may already have been applied by Jira/,
    );
  });

  it('keeps HTML when it was asked for, and text or empty bodies as before', async () => {
    const { client, fetchMock } = setup();
    fetchMock
      .mockResolvedValueOnce(loginPage())
      .mockResolvedValueOnce(new Response('plain', { headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response('', { headers: { 'content-type': 'text/html' } }));
    const html = await client.request({
      method: 'GET',
      path: '/rest/x',
      access: 'read',
      accept: 'text/html',
    });
    expect(html.data).toContain('<title>');
    const plain = await client.request({ method: 'GET', path: '/rest/x', access: 'read' });
    expect(plain.data).toBe('plain');
    const empty = await client.request({ method: 'GET', path: '/rest/x', access: 'read' });
    expect(empty.data).toBeNull();
  });
});

describe('JiraClient.request — retry policy (audit)', () => {
  it('honours Retry-After given as an HTTP-date', async () => {
    const { client, fetchMock, sleep } = setup();
    const soon = new Date(Date.now() + 3000).toUTCString();
    fetchMock
      .mockResolvedValueOnce(
        new Response('busy', { status: 503, headers: { 'retry-after': soon } }),
      )
      .mockResolvedValueOnce(json({ ok: true }));
    await client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' });
    const waited = sleep.mock.calls[0]?.[0] ?? -1;
    expect(waited).toBeGreaterThan(1500);
    expect(waited).toBeLessThanOrEqual(3000);
  });

  it('surfaces a 503 whose Retry-After date is beyond the cap, with the date', async () => {
    const { client, fetchMock, sleep } = setup();
    const later = new Date(Date.now() + 3_600_000).toUTCString();
    fetchMock.mockResolvedValueOnce(
      new Response('busy', { status: 503, headers: { 'retry-after': later } }),
    );
    const message = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(message).toBe(
      `Jira GET /rest/api/2/myself failed with HTTP 503: busy — service unavailable (Retry-After: ${later}) — Retry-After ${later} exceeds the retry cap (10 s): not retried`,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry deterministic fetch failures, and explains a redirect', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
    );
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow(
      'Jira GET /rest/api/2/myself failed: fetch failed (unexpected redirect) — redirects are refused: check JIRA_BASE_URL (context path) or an SSO / authentication proxy',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(networkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
    await expect(
      client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' }),
    ).rejects.toThrow('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry the timeout of a POST read (heavy JQL search)', async () => {
    const { client, fetchMock } = setup({ timeoutMs: 20 });
    fetchMock.mockImplementation(hangingFetch);
    await expect(
      client.request({ method: 'POST', path: '/rest/api/2/search', access: 'read', body: {} }),
    ).rejects.toThrow('timed out after 20 ms');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries a retryable status whose body stream has already failed', async () => {
    const { client, fetchMock } = setup();
    const errored = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    fetchMock
      .mockResolvedValueOnce(new Response(errored, { status: 503 }))
      .mockResolvedValueOnce(json({ ok: true }));
    const res = await client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' });
    expect(res.data).toEqual({ ok: true });
  });

  it('adds jitter to the backoff (not to Retry-After)', async () => {
    const { client, fetchMock, sleep } = setup({ random: () => 0 });
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(json({}));
    await client.request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 2000]);
  });
});

describe('retryDelayMs — HTTP-date', () => {
  it('parses an HTTP-date relative to now, and refuses one beyond the cap', () => {
    const now = Date.parse('2026-10-11T10:00:00Z');
    expect(retryDelayMs('Sun, 11 Oct 2026 10:00:05 GMT', 0, now)).toBe(5000);
    expect(retryDelayMs('Sun, 11 Oct 2026 09:00:00 GMT', 0, now)).toBe(0);
    expect(retryDelayMs('Sun, 11 Oct 2026 11:00:00 GMT', 0, now)).toBeUndefined();
    // Not delta-seconds: 0x10 and 1e1 are not Retry-After values (backoff instead).
    expect(retryDelayMs('0x10', 0, now)).toBe(500);
    expect(retryDelayMs('1e1', 0, now)).toBe(500);
    expect(retryDelayMs('-5', 0, now)).toBe(500);
  });
});

describe('JiraClient.request — write outcome on 5xx (final review)', () => {
  it('warns that a write answered 500, 502 or 504 may have been applied; reads unchanged', async () => {
    const { client, fetchMock } = setup();
    for (const status of [500, 502, 504]) {
      fetchMock.mockResolvedValueOnce(new Response('gateway', { status }));
      const message = await client
        .request({ method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} })
        .catch((e: unknown) => (e as Error).message);
      expect(message).toBe(
        `Jira POST /rest/api/2/issue failed with HTTP ${status}: gateway — The operation may already have been applied by Jira: check its state before retrying.`,
      );
    }
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    const rejected = await client
      .request({ method: 'POST', path: '/rest/api/2/issue', access: 'write', body: {} })
      .catch((e: unknown) => (e as Error).message);
    expect(rejected).not.toContain('may already have been applied');
    const { client: reader, fetchMock: readFetch } = setup({ maxRetries: 0 });
    readFetch.mockResolvedValueOnce(new Response('gateway', { status: 502 }));
    const read = await reader
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(read).toBe('Jira GET /rest/api/2/myself failed with HTTP 502: gateway');
  });
});

describe('JiraClient.request — host redaction on label boundaries (final review)', () => {
  it('redacts the host only as a whole name, and never a single-label host', async () => {
    const { client, fetchMock } = setup({ baseUrl: 'https://jira.example.com', maxRetries: 0 });
    fetchMock.mockRejectedValueOnce(
      networkError(
        'ENOTFOUND',
        'getaddrinfo ENOTFOUND jira.example.com. x.jira.example.com jira.example.community',
      ),
    );
    const message = await client
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(message).toContain(
      'getaddrinfo ENOTFOUND <instance>. x.jira.example.com jira.example.community',
    );
    const { client: single, fetchMock: singleFetch } = setup({
      baseUrl: 'https://jira',
      maxRetries: 0,
    });
    singleFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errorMessages: ['Jira says jira-mcp failed'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const text = await single
      .request({ method: 'GET', path: '/rest/api/2/myself', access: 'read' })
      .catch((e: unknown) => (e as Error).message);
    expect(text).toContain('Jira says jira-mcp failed');
  });
});
