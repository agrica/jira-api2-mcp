import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { sensitiveLiterals } from './lib/package-check.ts';
import { findSecrets } from './lib/secret-scan.ts';

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
// The PAT and, when JIRA_BASE_URL is set, the instance host: neither belongs in versioned files.
const literals = sensitiveLiterals(process.env);
let failures = 0;
for (const file of files) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- sequential reads keep output order deterministic
  const text = await readFile(file, 'utf8').catch(() => '');
  const hits = findSecrets(text, literals);
  if (hits.length > 0) {
    failures++;
    console.error(`✖ ${file}: ${hits.join(', ')}`);
  }
}
console.error(
  failures === 0
    ? `✔ ${files.length} files scanned, no secret found`
    : `✖ ${failures} file(s) to fix`,
);
process.exit(failures === 0 ? 0 : 1);
