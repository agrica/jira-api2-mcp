/**
 * Redaction of network details (IP addresses, certificate names) that low-level errors embed, so
 * that internal topology does not reach the model or CI logs.
 */

const IPV6 =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?::\d{1,3}(?:\.\d{1,3}){3})?)(?![\w:.])/gi;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
/** Certificate subject alternative names (DNS:…, IP Address:…). */
const CERT_NAME = /\b(?:DNS|IP Address|URI|email):[^\s,)]+/gi;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-insensitive pattern of `literal` as a whole name: not inside a longer host label or name
 * (`x.jira.example.com`, `jira.example.community`, `my-jira`). A trailing sentence dot is allowed.
 */
export function boundedPattern(literal: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9.-])${escapeRegExp(literal)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9-])`,
    'gi',
  );
}

/**
 * Pattern of an instance host name, or `undefined` for a single-label host (`https://jira`): such a
 * name is also an ordinary word ("Jira", "jira-mcp") and is not worth hiding.
 */
export function hostPattern(hostname: string): RegExp | undefined {
  return hostname.includes('.') ? boundedPattern(hostname) : undefined;
}

export function redactNetworkDetails(text: string): string {
  return text.replace(CERT_NAME, '<cert-name>').replace(IPV6, '<ip>').replace(IPV4, '<ip>');
}
