import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { sensitiveLiterals } from './lib/package-check.ts';
import { scanFiles } from './lib/secret-scan.ts';

let files: string[];
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\0')
    .filter(Boolean);
} catch {
  console.error(
    '✖ secrets:scan lists files with git: run it from a git checkout of the repository',
  );
  process.exit(1);
}
// The PAT and, when JIRA_BASE_URL is set, the instance host: neither belongs in versioned files.
const { scanned, findings, skipped } = await scanFiles(
  files,
  (file) => readFile(file, 'utf8'),
  sensitiveLiterals(process.env),
);
for (const { file, problem } of findings) console.error(`✖ ${file}: ${problem}`);
if (skipped.length > 0)
  console.error(`⚠ ${skipped.length} listed file(s) absent from the working tree, not scanned`);
console.error(
  findings.length === 0
    ? `✔ ${scanned} files scanned, no secret found`
    : `✖ ${findings.length} file(s) to fix`,
);
process.exit(findings.length === 0 ? 0 : 1);
