/**
 * Top-level error handling for the scripts that call Jira. An uncaught error would make Node print
 * the whole error with its `cause` chain (TLS certificate subject, host names, IPs, ports), which
 * CI masking does not cover: only one sanitized line is ever printed.
 */

const IPV6 =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?::\d{1,3}(?:\.\d{1,3}){3})?)(?![\w:.])/gi;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function instanceLiterals(baseUrl: string | undefined): string[] {
  if (!baseUrl) return [];
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return [];
  }
  // Without its trailing slash, the URL also matches its spelling with one (the slash is kept).
  const values = [baseUrl, url.href].map((u) => u.replace(/\/+$/, ''));
  values.push(url.host, url.hostname);
  // Longest first, so that the full URL is replaced before its host.
  return [...new Set(values.filter(Boolean))].toSorted((a, b) => b.length - a.length);
}

function redact(text: string, literals: readonly string[]): string {
  let out = text;
  for (const literal of literals)
    out = out.replace(new RegExp(escapeRegExp(literal), 'gi'), '<instance>');
  return out
    .replace(IPV6, '<ip>')
    .replace(IPV4, '<ip>')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

/** Messages of the cause chain: callers (e.g. JiraClient) may embed them, and they can carry certificate text. */
function causeMessages(error: Error): string[] {
  const messages: string[] = [];
  const seen = new Set<object>([error]);
  let current: unknown = error.cause;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && message) messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages;
}

function deepestCause(error: Error): object {
  const seen = new Set<object>([error]);
  let current: object = error;
  for (;;) {
    const next: unknown = (current as { cause?: unknown }).cause;
    if (typeof next !== 'object' || next === null || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/** One line `<name>: <message> [<code>]`, without stack, cause, certificate or other properties. */
export function sanitizeError(error: unknown, baseUrl: string | undefined): string {
  if (!(error instanceof Error)) return 'Error: unexpected failure';
  const literals = instanceLiterals(baseUrl);
  const code = (deepestCause(error) as { code?: unknown }).code;
  const name = typeof error.name === 'string' && error.name ? error.name : 'Error';
  let message = String(error.message);
  for (const inner of causeMessages(error)) {
    message = message.split(` (${inner})`).join('').split(inner).join('');
  }
  // Defence in depth: certificate subject alternative names (DNS:…, IP Address:…).
  message = message.replace(/\b(?:DNS|IP Address|URI|email):[^\s,)]+/gi, '<cert-name>');
  const line = `${name}: ${message.trim()}${typeof code === 'string' ? ` [${code}]` : ''}`;
  return redact(line, literals);
}

/** Awaits `main`; on failure prints the sanitized error and sets `process.exitCode = 1`. */
export async function runScript(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`✖ ${sanitizeError(error, process.env.JIRA_BASE_URL)}`);
    process.exitCode = 1;
  }
}
