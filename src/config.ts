import { z } from 'zod';

export interface JiraConfig {
  baseUrl: string;
  pat: string;
  allowWrites: boolean;
  allowInsecureHttp: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  maxOutputChars: number;
  catalogPath: string | undefined;
  enableXray: boolean;
}

/** MCP client configs often template unset variables as "": treat them as unset. */
const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);

const flag = z.preprocess(
  blankAsUnset,
  z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
);

/** A positive decimal integer (no hex, exponent or sign), bounded by `max`. */
const positiveInt = (fallback: number, max: number) =>
  z.preprocess(
    blankAsUnset,
    z
      .string()
      .regex(/^\d+$/, 'must be a positive decimal integer')
      .transform(Number)
      .pipe(z.number().int().positive().max(max))
      .default(fallback),
  );

/**
 * The URL is never echoed back: it may carry credentials. Credentials, a query string or a fragment
 * would be sent with every request or swallow the REST path: they are refused.
 */
const baseUrlSchema = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .refine((raw) => {
    if (!URL.canParse(raw)) return true; // already reported by z.url()
    const url = new URL(raw);
    return !url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(raw);
  }, 'must have no credentials, query string or fragment (e.g. https://jira.example.com/jira)')
  .transform((raw) => {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  });

/** setTimeout overflows above 2^31-1 ms (it then fires after 1 ms): 10 minutes per attempt is plenty. */
const MAX_TIMEOUT_MS = 600_000;
/** The body is held in memory then decoded as one string. */
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000_000;

const envSchema = z.object({
  JIRA_BASE_URL: baseUrlSchema,
  // The PAT goes into an HTTP header: visible ASCII only. The value is never echoed back.
  JIRA_PAT: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .regex(
      /^[\x21-\x7e]+$/,
      'must contain visible ASCII characters only (no space, line break or control character)',
    ),
  JIRA_ALLOW_WRITES: flag,
  JIRA_ALLOW_INSECURE_HTTP: flag,
  JIRA_TIMEOUT_MS: positiveInt(30_000, MAX_TIMEOUT_MS),
  JIRA_MAX_RESPONSE_BYTES: positiveInt(5 * 1024 * 1024, MAX_RESPONSE_BYTES),
  JIRA_MAX_OUTPUT_CHARS: positiveInt(100_000, MAX_OUTPUT_CHARS),
  JIRA_CATALOG_PATH: z.preprocess(blankAsUnset, z.string().optional()),
  JIRA_ENABLE_XRAY: flag,
});

function isPlainHttp(url: string): boolean {
  return new URL(url).protocol === 'http:';
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): JiraConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration — ${issues}`);
  }
  const e = result.data;
  if (isPlainHttp(e.JIRA_BASE_URL) && !e.JIRA_ALLOW_INSECURE_HTTP) {
    throw new Error(
      'Invalid configuration — JIRA_BASE_URL: HTTPS is required by default because the PAT is sent with every request. ' +
        'Plain HTTP is accepted only with JIRA_ALLOW_INSECURE_HTTP=true, for exceptional local tests.',
    );
  }
  return {
    baseUrl: e.JIRA_BASE_URL,
    pat: e.JIRA_PAT,
    allowWrites: e.JIRA_ALLOW_WRITES,
    allowInsecureHttp: e.JIRA_ALLOW_INSECURE_HTTP,
    timeoutMs: e.JIRA_TIMEOUT_MS,
    maxResponseBytes: e.JIRA_MAX_RESPONSE_BYTES,
    maxOutputChars: e.JIRA_MAX_OUTPUT_CHARS,
    catalogPath: e.JIRA_CATALOG_PATH,
    enableXray: e.JIRA_ENABLE_XRAY,
  };
}

export function startupWarnings(config: JiraConfig): string[] {
  return isPlainHttp(config.baseUrl)
    ? [
        'Plain HTTP enabled by JIRA_ALLOW_INSECURE_HTTP=true: the PAT travels unencrypted. Reserved for exceptional local tests.',
      ]
    : [];
}
