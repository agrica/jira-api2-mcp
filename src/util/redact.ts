/**
 * Redaction of network details (IP addresses, certificate names) that low-level errors embed, so
 * that internal topology does not reach the model or CI logs.
 */

const IPV6 =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?::\d{1,3}(?:\.\d{1,3}){3})?)(?![\w:.])/gi;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
/** Certificate subject alternative names (DNS:…, IP Address:…). */
const CERT_NAME = /\b(?:DNS|IP Address|URI|email):[^\s,)]+/gi;

export function redactNetworkDetails(text: string): string {
  return text.replace(CERT_NAME, '<cert-name>').replace(IPV6, '<ip>').replace(IPV4, '<ip>');
}
