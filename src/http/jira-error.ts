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
  ) {
    const suffix = details.length > 0 ? `: ${details.join(' | ')}` : '';
    const rate =
      status === 429 ? ` — rate limited${retryAfter ? ` (Retry-After: ${retryAfter} s)` : ''}` : '';
    super(
      `Jira ${method} ${path} failed with HTTP ${status}${suffix}${rate}${note ? ` — ${note}` : ''}`,
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
  constructor(method: string, path: string, access: 'read' | 'write' | 'destructive') {
    const warning =
      access === 'read'
        ? ''
        : '. The operation may already have been applied by Jira: check its state before retrying.';
    super(`Jira ${method} ${path} cancelled by the MCP client${warning}`);
    this.name = 'RequestCancelledError';
  }
}

interface JiraErrorBody {
  errorMessages?: unknown;
  errors?: unknown;
  message?: unknown;
}

function detailsFromJson(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== 'object') return [];
    const p = parsed as JiraErrorBody;
    const out: string[] = [];
    if (Array.isArray(p.errorMessages)) out.push(...p.errorMessages.map(String));
    if (p.errors !== null && typeof p.errors === 'object') {
      for (const [field, message] of Object.entries(p.errors))
        out.push(`${field}: ${String(message)}`);
    }
    if (typeof p.message === 'string') out.push(p.message);
    return out;
  } catch {
    return [];
  }
}

export function extractErrorDetails(body: string, contentType: string | null): string[] {
  if (contentType?.includes('json')) {
    const fromJson = detailsFromJson(body);
    if (fromJson.length > 0) return fromJson;
  }
  const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
  if (title) return [title];
  const text = body.trim();
  return text ? [text.slice(0, 500)] : [];
}
