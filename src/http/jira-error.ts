export type AccessClass = 'read' | 'write' | 'destructive';

/** Appended to every failure of a non-read request that may have reached Jira. */
export const WRITE_OUTCOME_UNKNOWN =
  'The operation may already have been applied by Jira: check its state before retrying.';

/** ` <warning>` for a non-read request, '' for a read. */
export function outcomeWarning(access: AccessClass): string {
  return access === 'read' ? '' : ` ${WRITE_OUTCOME_UNKNOWN}`;
}

/** Retry-After as shown to the model: delta-seconds get a unit, an HTTP-date is shown as is. */
export function retryAfterLabel(value: string): string {
  return /^\d+$/.test(value.trim()) ? `${value.trim()} s` : value.trim();
}

const STATUS_HINTS: Readonly<Record<number, string>> = {
  401: 'the PAT is invalid, expired or revoked (check JIRA_PAT)',
  403: 'the PAT account lacks the Jira permission for this operation',
  404: 'not found, or not visible to the PAT account',
  429: 'rate limited',
  503: 'service unavailable',
};

export class JiraApiError extends Error {
  readonly status: number;
  readonly details: string[];
  readonly retryAfter: string | null;

  constructor(
    status: number,
    method: string,
    path: string,
    details: string[],
    retryAfter: string | null = null,
    note?: string,
    /** Jira DC's `X-Authentication-Denied-Reason` header (e.g. CAPTCHA lockout). */
    deniedReason?: string | null,
  ) {
    const suffix = details.length > 0 ? `: ${details.join(' | ')}` : '';
    const extras: string[] = [];
    if (retryAfter && (status === 429 || status === 503))
      extras.push(`Retry-After: ${retryAfterLabel(retryAfter)}`);
    if (deniedReason) extras.push(`X-Authentication-Denied-Reason: ${deniedReason}`);
    const hintText = STATUS_HINTS[status];
    const hint =
      hintText === undefined && extras.length === 0
        ? ''
        : ` — ${[hintText, extras.length > 0 ? `(${extras.join('; ')})` : undefined]
            .filter(Boolean)
            .join(' ')}`;
    super(
      `Jira ${method} ${path} failed with HTTP ${status}${suffix}${hint}${note ? ` — ${note}` : ''}`,
    );
    this.name = 'JiraApiError';
    this.status = status;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

export class WritesDisabledError extends Error {
  constructor(method: string, path: string) {
    super(
      `Writes are disabled: ${method} ${path} is classified as a write. Start the server with JIRA_ALLOW_WRITES=true to allow it.`,
    );
    this.name = 'WritesDisabledError';
  }
}

export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(method: string, path: string, maxBytes: number) {
    super(
      `Jira ${method} ${path} response exceeds ${maxBytes} bytes (JIRA_MAX_RESPONSE_BYTES). Narrow the request (fields, maxResults, filters).`,
    );
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export class RequestCancelledError extends Error {
  constructor(method: string, path: string, access: AccessClass) {
    super(
      `Jira ${method} ${path} cancelled by the MCP client${access === 'read' ? '' : `. ${WRITE_OUTCOME_UNKNOWN}`}`,
    );
    this.name = 'RequestCancelledError';
  }
}

/** The per-attempt timeout elapsed (while waiting for the response or while reading its body). */
export class RequestTimeoutError extends Error {
  constructor(
    method: string,
    path: string,
    timeoutMs: number,
    access: AccessClass,
    cause: unknown,
  ) {
    super(`Jira ${method} ${path} timed out after ${timeoutMs} ms.${outcomeWarning(access)}`, {
      cause,
    });
    this.name = 'RequestTimeoutError';
  }
}

interface JiraErrorBody {
  errorMessages?: unknown;
  errors?: unknown;
  message?: unknown;
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));

function detailsFromJson(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== 'object') return [];
    const p = parsed as JiraErrorBody;
    const out: string[] = [];
    if (Array.isArray(p.errorMessages)) out.push(...p.errorMessages.map(asText));
    if (p.errors !== null && typeof p.errors === 'object') {
      for (const [field, message] of Object.entries(p.errors))
        out.push(`${field}: ${asText(message)}`);
    }
    if (typeof p.message === 'string') out.push(p.message);
    return out;
  } catch {
    return [];
  }
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&');
}

/** The decoded `<title>` of an HTML page, if any. */
export function htmlTitle(body: string): string | undefined {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1];
  const text = title === undefined ? '' : decodeHtmlEntities(title).replace(/\s+/g, ' ').trim();
  return text || undefined;
}

const isHtml = (body: string, contentType: string | null) =>
  Boolean(contentType?.includes('html')) || /^\s*<(?:!doctype html|html)\b/i.test(body);

/** Visible text of an HTML page: scripts, styles and tags removed. */
function htmlText(body: string): string {
  return decodeHtmlEntities(
    body
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractErrorDetails(body: string, contentType: string | null): string[] {
  if (contentType?.includes('json')) {
    const fromJson = detailsFromJson(body);
    if (fromJson.length > 0) return fromJson;
  }
  const title = htmlTitle(body);
  if (title) return [title];
  const text = isHtml(body, contentType) ? htmlText(body) : body.trim();
  return text ? [text.slice(0, 500)] : [];
}
