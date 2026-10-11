const ALLOWED: readonly RegExp[] = [
  /^package\/package\.json$/,
  /^package\/README\.md$/,
  /^package\/LICENSE(\.\w+)?$/,
  /^package\/dist\/.+\.(js|js\.map|d\.ts)$/,
  /^package\/catalog\/catalog\.json$/,
];

/** Entries of an `npm pack` tarball that should not be shipped. */
export function unexpectedEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => !ALLOWED.some((pattern) => pattern.test(entry)));
}

/** Values that must never appear in the package: the PAT and the instance host. */
export function sensitiveLiterals(env: Readonly<Record<string, string | undefined>>): string[] {
  const values: string[] = [];
  if (env.JIRA_PAT) values.push(env.JIRA_PAT);
  if (env.JIRA_BASE_URL && URL.canParse(env.JIRA_BASE_URL))
    values.push(new URL(env.JIRA_BASE_URL).host);
  return values;
}
