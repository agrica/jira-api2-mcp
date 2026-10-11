/* oxlint-disable eslint/no-await-in-loop -- retries and stream reads are inherently sequential */
import { setTimeout as delay } from 'node:timers/promises';
import { redactNetworkDetails } from '../util/redact.ts';
import { currentCancellationSignal } from './cancellation.ts';
import {
  JiraApiError,
  RequestCancelledError,
  RequestTimeoutError,
  ResponseTooLargeError,
  WRITE_OUTCOME_UNKNOWN,
  WritesDisabledError,
  extractErrorDetails,
  htmlTitle,
  outcomeWarning,
  retryAfterLabel,
} from './jira-error.ts';
import { accessProblem, restPathProblem } from './request-guards.ts';

/** The single list of HTTP methods: the catalog schema and the tools derive from it. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
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
  /** Source of the backoff jitter, in [0, 1). */
  random?: () => number;
}

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const MAX_RETRY_DELAY_MS = 10_000;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const MIN_REDACTED_LENGTH = 6;

/** Network failures worth a retry (read from the `code` of the error's cause chain). */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
/** Failures that happen before the request leaves: a write cannot have been applied. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TLS_CODE = /CERT|^ERR_TLS_|^ERR_SSL_|^UNABLE_TO_/;
/** Messages (without error code) of requests that fetch refused to build or send. */
const NOT_BUILT = /bad port|invalid header|ByteString|credentials/i;

export function isRetryable(req: JiraRequest): boolean {
  return req.access === 'read' && !(req.body instanceof FormData);
}

/**
 * Retry-After in milliseconds: delta-seconds or an HTTP-date (RFC 9110), `undefined` when absent or
 * invalid. A date in the past means "now".
 */
export function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  const text = value?.trim();
  // Number('') is 0: a blank header must fall back to the backoff, not mean "retry now".
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // HTTP-date forms all start with a day name; anything else ("0x10", "-5", "1e1") is invalid.
  const date = /^[a-z]{3}/i.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff capped at MAX_RETRY_DELAY_MS, with "equal jitter" (half fixed, half random). */
function backoffMs(attempt: number, random: () => number): number {
  return Math.round(Math.min(500 * 2 ** attempt, MAX_RETRY_DELAY_MS) * (0.5 + random() / 2));
}

/**
 * Delay before the next retry: the server's Retry-After (seconds or HTTP-date) when valid, else the
 * backoff. Returns `undefined` when Retry-After asks for longer than the cap: retrying earlier than
 * the server asked would be pointless, so the caller gives up instead.
 */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  now: number = Date.now(),
  random: () => number = () => 1,
): number | undefined {
  const serverMs = parseRetryAfterMs(retryAfter, now);
  if (serverMs === undefined) return backoffMs(attempt, random);
  return serverMs > MAX_RETRY_DELAY_MS ? undefined : serverMs;
}

/** First string `code` along the cause chain (undici puts the system error code on the cause). */
function causeCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** fetch() failed: `transient` failures (connection reset, DNS hiccup…) are worth a retry for reads. */
class RequestFailedError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient: boolean, cause: unknown) {
    super(message, { cause });
    this.name = 'RequestFailedError';
    this.transient = transient;
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
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(req.method, req.path, maxBytes);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new RequestCancelledError(req.method, req.path, req.access);
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      if (onOverflow === 'throw') throw new ResponseTooLargeError(req.method, req.path, maxBytes);
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Result of a write that Jira applied (2xx) but whose response body could not be read or parsed. */
function appliedButUnreadable(req: JiraRequest, status: number, reason: string): JiraResponse {
  return {
    status,
    data: `Jira ${req.method} ${req.path} succeeded (HTTP ${status}): the write WAS applied, but its response could not be read (${reason}). Do not retry it; read the resulting state if you need its details.`,
  };
}

export class JiraClient {
  readonly allowWrites: boolean;
  readonly #origin: string;
  /** Context path of the instance, without trailing slash ('' at the root). */
  readonly #basePath: string;
  /** The instance host name, matched case-insensitively in error text. */
  readonly #hostPattern: RegExp;
  readonly #pat: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: JiraClientOptions) {
    const base = new URL(options.baseUrl);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      /[?#]/.test(options.baseUrl)
    ) {
      // The URL is not echoed: it may carry credentials.
      throw new Error(
        'JiraClient: the base URL must have no credentials, query string or fragment',
      );
    }
    this.allowWrites = options.allowWrites;
    this.#origin = base.origin;
    this.#basePath = base.pathname.replace(/\/+$/, '');
    this.#hostPattern = new RegExp(base.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    this.#pat = options.pat;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.#random = options.random ?? Math.random;
  }

  async request(req: JiraRequest): Promise<JiraResponse> {
    const pathProblem = restPathProblem(req.path);
    if (pathProblem) {
      throw new Error(
        `Refusing to call a non-REST path: ${JSON.stringify(req.path)} (${pathProblem})`,
      );
    }
    const accessIssue = accessProblem(req.method, req.access);
    if (accessIssue) throw new Error(`Inconsistent request: ${accessIssue} (${req.path})`);
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
        if (!canRetry || !this.#worthRetrying(error, req)) throw error;
        await this.#pause(backoffMs(attempt, this.#random), req, cancel);
        continue;
      }
      let note: string | undefined;
      if (canRetry && RETRYABLE_STATUS.has(res.status)) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryDelayMs(retryAfter, attempt, Date.now(), this.#random);
        if (waitMs !== undefined) {
          // A body stream that already failed rejects on cancel: that must not stop the retry.
          await res.body?.cancel().catch(() => {});
          await this.#pause(waitMs, req, cancel);
          continue;
        }
        note = `Retry-After ${retryAfterLabel(retryAfter ?? '')} exceeds the retry cap (${MAX_RETRY_DELAY_MS / 1000} s): not retried`;
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
        // Jira answered 2xx to a write: it is applied, whatever happens to the body afterwards.
        if (res.ok && req.access !== 'read') {
          if (error instanceof RequestCancelledError)
            throw new RequestCancelledError(req.method, req.path, req.access, res.status);
          return appliedButUnreadable(
            req,
            res.status,
            error instanceof ResponseTooLargeError
              ? `it exceeds ${this.#maxResponseBytes} bytes, JIRA_MAX_RESPONSE_BYTES`
              : 'connection lost / timed out while reading it',
          );
        }
        // Cancellation and size limit are final; timeouts and network errors mid-body are retried
        // for reads, like the same failure during fetch (writes never are).
        if (error instanceof RequestCancelledError || error instanceof ResponseTooLargeError)
          throw error;
        if (canRetry && this.#worthRetrying(error, req)) {
          await this.#pause(backoffMs(attempt, this.#random), req, cancel);
          continue;
        }
        throw error;
      }
      if (!res.ok) {
        throw new JiraApiError(
          res.status,
          req.method,
          req.path,
          // A proxy page may echo request headers: no PAT or instance host back to the model.
          extractErrorDetails(text, contentType).map((detail) => this.#cleanSecrets(detail)),
          res.headers.get('retry-after'),
          note,
          res.headers.get('x-authentication-denied-reason'),
        );
      }
      return this.#parse(text, contentType, req, res.status);
    }
  }

  /** The request URL: always `<base URL>/rest/…` on the base origin, whatever `path` holds. */
  buildUrl(path: string, query?: Readonly<Record<string, QueryValue>>): URL {
    const url = new URL(this.#origin);
    url.pathname = this.#basePath + path;
    if (url.origin !== this.#origin || !url.pathname.startsWith(`${this.#basePath}/rest/`)) {
      throw new Error('Refusing to call a URL outside <base URL>/rest/');
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      const values: readonly QueryScalar[] = typeof value === 'object' ? value : [value];
      for (const v of values) url.searchParams.append(key, String(v));
    }
    return url;
  }

  /**
   * Retry policy for a failed attempt (the caller checks the budget and the access class): only
   * transient network failures and timeouts. A POST read (JQL search) that timed out is not
   * replayed: it would triple the load of a heavy search on Jira.
   */
  #worthRetrying(error: unknown, req: JiraRequest): boolean {
    if (error instanceof RequestCancelledError) return false;
    if (error instanceof RequestTimeoutError) return SAFE_METHODS.has(req.method);
    if (error instanceof RequestFailedError) return error.transient;
    // Mid-body read failures (connection dropped while streaming).
    return true;
  }

  #parse(text: string, contentType: string | null, req: JiraRequest, status: number): JiraResponse {
    if (text === '') return { status, data: null };
    const expectsJson = (req.accept ?? 'application/json').includes('json');
    if (expectsJson && contentType?.includes('html')) {
      const rawTitle = htmlTitle(text);
      const title = rawTitle === undefined ? undefined : this.#cleanSecrets(rawTitle);
      throw new Error(
        `Jira ${req.method} ${req.path} returned an unexpected HTML response instead of JSON (HTTP ${status}${title ? `: ${JSON.stringify(title)}` : ''}) — authentication proxy or SSO login page? Check JIRA_BASE_URL and the proxy.${outcomeWarning(req.access)}`,
      );
    }
    if (!contentType?.includes('json')) return { status, data: text };
    try {
      return { status, data: JSON.parse(text) as unknown };
    } catch (error) {
      const mediaType = contentType.split(';')[0]?.trim();
      if (req.access !== 'read')
        return appliedButUnreadable(req, status, `unparseable ${mediaType} body`);
      throw new Error(
        `Jira ${req.method} ${req.path} returned an unparseable ${mediaType} body (HTTP ${status})`,
        { cause: error },
      );
    }
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

  /** Text from Jira or a proxy, safe for the model: no PAT, no instance host name. */
  #cleanSecrets(text: string): string {
    let out = text.replaceAll(`Bearer ${this.#pat}`, 'Bearer <redacted>');
    // A very short value would also hit ordinary words: it is redacted in its header form only.
    if (this.#pat.length >= MIN_REDACTED_LENGTH) out = out.replaceAll(this.#pat, '<redacted>');
    return out.replace(this.#hostPattern, '<instance>');
  }

  /** Error text from fetch/undici, safe for the model: no PAT (header errors echo it), host, IP or cert name. */
  #clean(text: string): string {
    return redactNetworkDetails(this.#cleanSecrets(text));
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
        throw new RequestTimeoutError(req.method, req.path, this.#timeoutMs, req.access, error);
      const message = this.#clean(error instanceof Error ? error.message : String(error));
      const warning = req.access === 'read' ? '' : `. ${WRITE_OUTCOME_UNKNOWN}`;
      throw new Error(
        `Jira ${req.method} ${req.path} failed while reading the response: ${message}${warning}`,
        { cause: error },
      );
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
        throw new RequestTimeoutError(req.method, req.path, this.#timeoutMs, req.access, error);
      }
      const message = this.#clean(error instanceof Error ? error.message : String(error));
      const code = causeCode(error);
      // An AggregateError cause (several addresses tried) has an empty message: name its code.
      const inner =
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message || code
          : undefined;
      const cause = inner ? ` (${this.#clean(inner)})` : '';
      const hint = /redirect/i.test(inner ?? '')
        ? ' — redirects are refused: check JIRA_BASE_URL (context path) or an SSO / authentication proxy'
        : '';
      // A connection that was never established, or a request refused while being built (bad
      // port, invalid header, credentials in the URL), cannot have applied a write.
      const notSent =
        code === undefined
          ? NOT_BUILT.test(
              `${error instanceof Error ? error.message : String(error)} ${inner ?? ''}`,
            )
          : NOT_SENT_CODES.has(code) || TLS_CODE.test(code);
      const warning = req.access === 'read' || notSent ? '' : `. ${WRITE_OUTCOME_UNKNOWN}`;
      throw new RequestFailedError(
        `Jira ${req.method} ${req.path} failed: ${message}${cause}${hint}${warning}`,
        code !== undefined && TRANSIENT_CODES.has(code),
        error,
      );
    }
  }
}
