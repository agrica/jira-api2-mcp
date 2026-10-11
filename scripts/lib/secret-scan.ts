const PATTERNS: readonly { name: string; regex: RegExp }[] = [
  {
    name: 'Authorization header',
    regex: /authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[A-Za-z0-9+/=._-]{16,}/i,
  },
  { name: 'Bearer token', regex: /\bbearer\s+[A-Za-z0-9+/=._-]{20,}/i },
  { name: 'JIRA_PAT assignment', regex: /JIRA_PAT["']?\s*[:=]\s*["']?(?!\$\{)[^\s"'$<.)]{8,}/ },
  {
    name: 'password assignment',
    regex: /\b(?:password|passwd|pwd)["']?\s*[:=]\s*["'][^"'$<]{4,}["']/i,
  },
];

/** Returns the names of the secret patterns found in `text` (empty when clean). */
export function findSecrets(text: string, literals: readonly string[] = []): string[] {
  const found = PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.name);
  if (literals.some((value) => value.trim().length >= 8 && text.includes(value.trim()))) {
    found.push('known secret value');
  }
  return found;
}
