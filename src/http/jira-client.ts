/* oxlint-disable eslint/no-await-in-loop -- retries and stream reads are inherently sequential */
import { setTimeout as delay } from 'node:timers/promises';
import { currentCancellationSignal } from './cancellation.ts';
import {
  JiraApiError,
  RequestCancelledError,
  ResponseTooLargeError,
  WritesDisabledError,
  extractErrorDetails,
} from './jira-error.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type Access = 'read' | 'write' | 'destructive';
export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[] | undefined;
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface JiraRequest {
  method: HttpMethod;
  /** Absolute REST path, e.g. `/rest/api/2/issue/DEMO-1`. */
  path: string;
  /** Access class of the operation: drives the write guard and the retry policy. */
  access: Access;
  query?: Readonly<Record<string, QueryValue>>;
  /** Serialised as JSON, unless it is a `FormData` (multipart upload). */
  body?: unknown;
  accept?: string;
  /** Cancels the request. Defaults to the cancellation signal of the current MCP call, if any. */
  signal?: AbortSignal;
}

export interface JiraResponse {
  status: number;
  data: unknown;
}

export interface JiraClientOptions {
  baseUrl: string;
  pat: string;
  allowWrites: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  fetch?: FetchLike;
  maxRetries?: number;
  /** Waits before a retry; should reject or return early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const MAX_RETRY_DELAY_MS = 10_000;

export function isRetryable(req: JiraRequest): boolean {
  return req.access === 'read' && !(req.body instanceof FormData);
}

export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const waitMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 500 * 2 ** attempt;
  return Math.min(waitMs, MAX_RETRY_DELAY_MS);
}

function parseBody(text: string, contentType: string | null): unknown {
  if (text === '') return null;
  if (contentType?.includes('json')) return JSON.parse(text) as unknown;
  return text;
}

/** The per-attempt timeout elapsed (while waiting for the response or while reading its body). */
class RequestTimeoutError extends Error {
  constructor(method: string, path: string, timeoutMs: number, cause: unknown) {
    super(`Jira ${method} ${path} timed out after ${timeoutMs} ms`, { cause });
    this.name = 'RequestTimeoutError';
  }
}

async function readBody(
  res: Response,
  maxBytes: number,
  onOverflow: 'throw' | 'truncate',
  req: JiraRequest,
  signal: AbortSignal | undefined,
): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (onOverflow === 'throw' && Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new ResponseTooLargeError(req.method, req.path, maxBytes);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new RequestCancelledError(req.method, req.path, req.access);
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      if (onOverflow === 'throw') throw new ResponseTooLargeError(req.method, req.path, maxBytes);
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class JiraClient {
  readonly allowWrites: boolean;
  readonly #baseUrl: string;
  readonly #pat: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: JiraClientOptions) {
    this.allowWrites = options.allowWrites;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#pat = options.pat;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  async request(req: JiraRequest): Promise<JiraResponse> {
    if (!req.path.startsWith('/rest/')) {
      throw new Error(`Refusing to call a non-REST path: ${req.path}`);
    }
    if (req.access === 'read' && req.method === 'DELETE') {
      throw new Error(`Inconsistent request: DELETE ${req.path} cannot be classified as read`);
    }
    if (!this.allowWrites && req.access !== 'read') {
      throw new WritesDisabledError(req.method, req.path);
    }
    const cancel = req.signal ?? currentCancellationSignal();
    if (cancel?.aborted) throw new RequestCancelledError(req.method, req.path, req.access);
    const url = this.buildUrl(req.path, req.query);
    const { headers, body } = this.#prepare(req);
    const retryable = isRetryable(req);

    for (let attempt = 0; ; attempt++) {
      const canRetry = retryable && attempt < this.#maxRetries;
      let res: Response;
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      try {
        res = await this.#send(
          url,
          { method: req.method, headers, body, redirect: 'error' },
          req,
          cancel,
          timeout,
        );
      } catch (error) {
        if (!canRetry || error instanceof RequestCancelledError) throw error;
        await this.#pause(retryDelayMs(null, attempt), req, cancel);
        continue;
      }
      if (canRetry && RETRYABLE_STATUS.has(res.status)) {
        await res.body?.cancel();
        await this.#pause(retryDelayMs(res.headers.get('retry-after'), attempt), req, cancel);
        continue;
      }
      const contentType = res.headers.get('content-type');
      let text: string;
      try {
        text = await this.#readBody(
          res,
          res.ok ? this.#maxResponseBytes : ERROR_BODY_MAX_BYTES,
          res.ok ? 'throw' : 'truncate',
          req,
          cancel,
          timeout,
        );
      } catch (error) {
        if (canRetry && error instanceof RequestTimeoutError) {
          await this.#pause(retryDelayMs(null, attempt), req, cancel);
          continue;
        }
        throw error;
      }
      if (!res.ok) {
        throw new JiraApiError(
          res.status,
          req.method,
          req.path,
          extractErrorDetails(text, contentType),
          res.headers.get('retry-after'),
        );
      }
      return { status: res.status, data: parseBody(text, contentType) };
    }
  }

  buildUrl(path: string, query?: Readonly<Record<string, QueryValue>>): URL {
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      const values: readonly QueryScalar[] = typeof value === 'object' ? value : [value];
      for (const v of values) url.searchParams.append(key, String(v));
    }
    return url;
  }

  #prepare(req: JiraRequest): { headers: Record<string, string>; body: RequestInit['body'] } {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#pat}`,
      Accept: req.accept ?? 'application/json',
    };
    if (req.body === undefined) return { headers, body: undefined };
    if (req.body instanceof FormData) {
      headers['X-Atlassian-Token'] = 'no-check';
      return { headers, body: req.body };
    }
    headers['Content-Type'] = 'application/json';
    return { headers, body: JSON.stringify(req.body) };
  }

  async #pause(ms: number, req: JiraRequest, cancel: AbortSignal | undefined): Promise<void> {
    try {
      await this.#sleep(ms, cancel);
    } catch (error) {
      if (!cancel?.aborted) throw error;
    }
    if (cancel?.aborted) throw new RequestCancelledError(req.method, req.path, req.access);
  }

  /** Reads a body; aborts of the fetch signal surface as cancellation or timeout errors, like in `#send`. */
  async #readBody(
    res: Response,
    maxBytes: number,
    onOverflow: 'throw' | 'truncate',
    req: JiraRequest,
    cancel: AbortSignal | undefined,
    timeout: AbortSignal,
  ): Promise<string> {
    try {
      return await readBody(res, maxBytes, onOverflow, req, cancel);
    } catch (error) {
      if (error instanceof RequestCancelledError || error instanceof ResponseTooLargeError)
        throw error;
      if (cancel?.aborted) throw new RequestCancelledError(req.method, req.path, req.access);
      if (timeout.aborted)
        throw new RequestTimeoutError(req.method, req.path, this.#timeoutMs, error);
      throw error;
    }
  }

  async #send(
    url: URL,
    init: RequestInit,
    req: JiraRequest,
    cancel: AbortSignal | undefined,
    timeout: AbortSignal,
  ): Promise<Response> {
    const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;
    try {
      return await this.#fetch(url, { ...init, signal });
    } catch (error) {
      if (cancel?.aborted) throw new RequestCancelledError(req.method, req.path, req.access);
      if (timeout.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) {
        throw new RequestTimeoutError(req.method, req.path, this.#timeoutMs, error);
      }
      const message = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
      throw new Error(`Jira ${req.method} ${req.path} failed: ${message}${cause}`, {
        cause: error,
      });
    }
  }
}
