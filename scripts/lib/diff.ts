import type { Operation } from '../../src/catalog/types.ts';

export interface CatalogDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffOperations(
  before: readonly Operation[],
  after: readonly Operation[],
): CatalogDiff {
  const b = new Map(before.map((op) => [op.id, JSON.stringify(op)]));
  const a = new Map(after.map((op) => [op.id, JSON.stringify(op)]));
  return {
    added: [...a.keys()].filter((id) => !b.has(id)).toSorted(),
    removed: [...b.keys()].filter((id) => !a.has(id)).toSorted(),
    changed: [...a.keys()].filter((id) => b.has(id) && b.get(id) !== a.get(id)).toSorted(),
  };
}

export function hasDrift(diff: CatalogDiff): boolean {
  return diff.added.length + diff.removed.length + diff.changed.length > 0;
}

export function summarizeDiff(diff: CatalogDiff, title: string): string {
  return `${title}: +${diff.added.length} −${diff.removed.length} ~${diff.changed.length}`;
}

export function describeDiff(
  diff: CatalogDiff,
  title: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.CI === 'true' ? summarizeDiff(diff, title) : formatDiff(diff, title);
}

/** A list of operation ids for a log line: the count only in CI, so that logs never list endpoints. */
export function describeIds(
  ids: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.CI === 'true' ? `${ids.length} operation(s)` : ids.join(', ');
}

function section(label: string, ids: string[]): string {
  return [`### ${label} (${ids.length})`, ...ids.map((id) => `- \`${id}\``), ''].join('\n');
}

export function formatDiff(diff: CatalogDiff, title: string): string {
  return [
    `## ${title}`,
    '',
    hasDrift(diff) ? '' : 'Aucune différence d’opérations.\n',
    section('Ajoutées', diff.added),
    section('Supprimées', diff.removed),
    section('Modifiées', diff.changed),
  ].join('\n');
}
