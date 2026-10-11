import { findSecrets } from './secret-scan.ts';

const ALLOWED: readonly RegExp[] = [
  /^package\/package\.json$/,
  /^package\/README\.md$/,
  /^package\/LICENSE(\.\w+)?$/,
  /^package\/dist\/.+\.(js|js\.map|d\.ts)$/,
  /^package\/catalog\/catalog\.json$/,
];

const ENTRY_POINT = 'package/dist/index.js';
const CATALOG = 'package/catalog/catalog.json';
/**
 * Files the package cannot work without. `dist/catalog/load.js` resolves the default catalog as
 * `../../catalog/catalog.json`: with `catalog/catalog.json`, it pins the installed layout.
 */
const REQUIRED: readonly string[] = [
  'package/package.json',
  'package/README.md',
  ENTRY_POINT,
  'package/dist/catalog/load.js',
  CATALOG,
];
const SHEBANG = '#!/usr/bin/env node';

export interface RequiredOptions {
  /** false for a local pack made without a generated catalog (`--no-catalog`). */
  catalog?: boolean;
}

/** Entries of an `npm pack` tarball that should not be shipped. */
export function unexpectedEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !ALLOWED.some((pattern) => pattern.test(entry)));
}

/** Required entries absent from an `npm pack` tarball. */
export function missingEntries(
  entries: readonly string[],
  { catalog = true }: RequiredOptions = {},
): string[] {
  const present = new Set(entries);
  return REQUIRED.filter((entry) => (catalog || entry !== CATALOG) && !present.has(entry));
}

export interface PackedFile {
  path: string;
  /** undefined when the file could not be read as text. */
  text: string | undefined;
}

/**
 * Everything wrong with a package, one line per problem. Only names of findings are given,
 * never the matched values.
 */
export function packageProblems(
  files: readonly PackedFile[],
  options: RequiredOptions & { literals: readonly string[] },
): string[] {
  const paths = files.map((file) => file.path);
  const problems = [
    ...missingEntries(paths, options).map((entry) => `missing file: ${entry}`),
    ...unexpectedEntries(paths).map((entry) => `unexpected file: ${entry}`),
  ];
  for (const { path, text } of files) {
    if (text === undefined) {
      problems.push(`${path}: unreadable`);
      continue;
    }
    if (path === ENTRY_POINT && !text.startsWith(`${SHEBANG}\n`))
      problems.push(`${path}: missing the "${SHEBANG}" shebang`);
    const hits = findSecrets(text);
    if (containsLiteral(text, options.literals)) hits.push('sensitive environment value');
    if (hits.length > 0) problems.push(`${path}: ${hits.join(', ')}`);
  }
  return problems;
}

/**
 * Values that must never appear in the package: the PAT and the instance host, with and without its
 * port (a URL with a port would otherwise hide the bare hostname). Compare with `containsLiteral`.
 */
export function sensitiveLiterals(env: Readonly<Record<string, string | undefined>>): string[] {
  const values: string[] = [];
  if (env.JIRA_PAT) values.push(env.JIRA_PAT);
  if (env.JIRA_BASE_URL && URL.canParse(env.JIRA_BASE_URL)) {
    const url = new URL(env.JIRA_BASE_URL);
    values.push(url.host, url.hostname);
  }
  return [...new Set(values)];
}

/** Case-insensitive search (host names are case-insensitive); empty literals never match. */
export function containsLiteral(text: string, literals: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return literals.some((value) => value !== '' && haystack.includes(value.toLowerCase()));
}
