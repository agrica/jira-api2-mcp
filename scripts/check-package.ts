import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageProblems, sensitiveLiterals, type PackedFile } from './lib/package-check.ts';

// Usage: node scripts/check-package.ts [--no-catalog] <package.tgz>...
// --no-catalog: local pack made without a generated catalog (CI always checks with the catalog).
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('-'));
const tarballs = args.filter((arg) => !arg.startsWith('-'));
const unknown = flags.filter((flag) => flag !== '--no-catalog');
if (tarballs.length === 0 || unknown.length > 0) {
  if (unknown.length > 0) console.error(`✖ Unknown argument(s): ${unknown.join(' ')}`);
  console.error('usage: node scripts/check-package.ts [--no-catalog] <package.tgz>...');
  process.exit(1);
}
const catalog = !flags.includes('--no-catalog');
const literals = sensitiveLiterals(process.env);

let failed = false;
// Every tarball is checked: a glob may match a leftover package next to the new one.
for (const tarball of tarballs) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- tarballs checked one at a time
  const problems = await checkTarball(tarball);
  if (problems.length > 0) {
    failed = true;
    for (const p of problems) console.error(`✖ ${tarball}: ${p}`);
  }
}
if (failed) process.exit(1);

async function checkTarball(tarball: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter((entry) => entry !== '' && !entry.endsWith('/'));
  } catch {
    return ['cannot be listed (missing file or not a gzip tarball)'];
  }
  const dir = await mkdtemp(join(tmpdir(), 'jira-api2-mcp-pack-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', dir]);
    const files: PackedFile[] = [];
    for (const path of entries) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- package files read one at a time, locally
      const text = await readFile(join(dir, path), 'utf8').catch(() => undefined);
      files.push({ path, text });
    }
    const problems = packageProblems(files, { catalog, literals });
    if (problems.length === 0)
      console.error(
        `✔ ${tarball}: package content checked (${entries.length} files${catalog ? '' : ', without catalog'})`,
      );
    return problems;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
