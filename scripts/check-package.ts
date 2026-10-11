import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsLiteral, sensitiveLiterals, unexpectedEntries } from './lib/package-check.ts';
import { findSecrets } from './lib/secret-scan.ts';

const tarball = process.argv[2];
if (!tarball) {
  console.error('usage: node scripts/check-package.ts <package.tgz>');
  process.exit(1);
}
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const problems = unexpectedEntries(entries).map((entry) => `unexpected file: ${entry}`);

const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-pack-'));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  const literals = sensitiveLiterals(process.env);
  for (const entry of entries) {
    let text = '';
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- package files read one at a time, locally
      text = await readFile(join(dir, entry), 'utf8');
    } catch (error) {
      // Directory entries are expected; any other read failure must fail the check (fail closed).
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') problems.push(`${entry}: unreadable`);
    }
    // Only names of findings are printed, never the matched values.
    const hits = findSecrets(text);
    if (containsLiteral(text, literals)) hits.push('sensitive environment value');
    if (hits.length > 0) problems.push(`${entry}: ${hits.join(', ')}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (problems.length > 0) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
console.error(`✔ package content checked (${entries.length} files)`);
