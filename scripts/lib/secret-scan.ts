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

/** Returns the names of the secret patterns found in `text` (empty when clean); literals match case-insensitively. */
export function findSecrets(text: string, literals: readonly string[] = []): string[] {
  const found = PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.name);
  const haystack = text.toLowerCase();
  const known = literals.map((value) => value.trim().toLowerCase()).filter((v) => v.length >= 8);
  if (known.some((value) => haystack.includes(value))) {
    found.push('known secret value');
  }
  return found;
}

export interface ScanResult {
  /** Files actually read. */
  scanned: number;
  /** One entry per file with a problem: secret names (never values), or why it could not be read. */
  findings: { file: string; problem: string }[];
  /** Listed files absent from the working tree (deleted, not yet committed). */
  skipped: string[];
}

/** Scans files one at a time; a file that cannot be read fails the scan (fail closed), unless it was deleted. */
export async function scanFiles(
  files: readonly string[],
  read: (file: string) => Promise<string>,
  literals: readonly string[],
): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, findings: [], skipped: [] };
  for (const file of files) {
    let text: string;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential reads keep output order deterministic
      text = await read(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'error';
      if (code === 'ENOENT') result.skipped.push(file);
      else result.findings.push({ file, problem: `unreadable (${code})` });
      continue;
    }
    result.scanned++;
    const hits = findSecrets(text, literals);
    if (hits.length > 0) result.findings.push({ file, problem: hits.join(', ') });
  }
  return result;
}
