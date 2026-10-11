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
}

const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  JIRA_BASE_URL: z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, '')),
  JIRA_PAT: z.string().min(1),
  JIRA_ALLOW_WRITES: flag.default(false),
  JIRA_ALLOW_INSECURE_HTTP: flag.default(false),
  JIRA_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  JIRA_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  JIRA_MAX_OUTPUT_CHARS: z.coerce.number().int().positive().default(100_000),
  JIRA_CATALOG_PATH: z.string().min(1).optional(),
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
  };
}

export function startupWarnings(config: JiraConfig): string[] {
  return isPlainHttp(config.baseUrl)
    ? [
        'Plain HTTP enabled by JIRA_ALLOW_INSECURE_HTTP=true: the PAT travels unencrypted. Reserved for exceptional local tests.',
      ]
    : [];
}
