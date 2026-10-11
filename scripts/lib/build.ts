import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseCatalog } from '../../src/catalog/load.ts';
import {
  API_FAMILIES,
  type AccessDecisions,
  type ApiFamily,
  type CatalogFile,
  type Operation,
  type ParsedOperation,
} from '../../src/catalog/types.ts';
import { classifyOperations, type ReviewCandidate, type ReviewCategory } from './classify.ts';
import { diffOperations, formatDiff, type CatalogDiff } from './diff.ts';
import type { FetchMeta, SourceLock } from './sources.ts';
import { parseWadl } from './wadl.ts';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function operationsDigest(operations: readonly Operation[]): string {
  return sha256(JSON.stringify(operations));
}

const XRAY_PREFIX = '/rest/raven/';

const missingMessage = (file: string) =>
  `missing WADL file catalog/wadl/${file}: run npm run catalog:fetch`;

/** One problem per WADL file recorded in fetch-meta.json but absent from `xml`. */
export function missingWadlFiles(meta: FetchMeta, xml: ReadonlyMap<string, string>): string[] {
  return meta.sources.filter((s) => !xml.has(s.file)).map((s) => missingMessage(s.file));
}

export function verifyFiles(meta: FetchMeta, xml: ReadonlyMap<string, string>): void {
  for (const s of meta.sources) {
    const text = xml.get(s.file);
    if (text === undefined) throw new Error(missingMessage(s.file));
    if (sha256(text) !== s.sha256) {
      throw new Error(
        `catalog/wadl/${s.file} does not match the sha256 recorded in catalog/wadl/fetch-meta.json`,
      );
    }
  }
}

export function buildCatalog(input: {
  xml: ReadonlyMap<string, string>;
  decisions: AccessDecisions;
  meta: FetchMeta;
  generatedAt: string;
  /** Reference date of the decision checks (default: now). */
  now?: Date;
  /** Receives the WADL warnings (merged duplicates, ignored parameters); default: stderr. */
  warn?: (message: string) => void;
}): {
  catalog: CatalogFile;
  staleDecisions: string[];
  /** Decisions for an optional family whose source is absent (e.g. Xray not installed): kept, not stale. */
  dormantDecisions: string[];
  candidates: ReviewCandidate[];
  pending: ReviewCandidate[];
} {
  const parsed: ParsedOperation[] = [];
  const counts: Record<ApiFamily, number> = { api: 0, agile: 0, xray: 0 };
  const sourceOf = new Map<string, string>();
  for (const s of input.meta.sources) {
    const text = input.xml.get(s.file);
    if (text === undefined) throw new Error(missingMessage(s.file));
    const ops = parseWadl(text, s.api, input.warn);
    for (const op of ops) {
      // The runtime indexes operations by id: a duplicate would silently shadow another source.
      const first = sourceOf.get(op.id);
      if (first !== undefined)
        throw new Error(`Operation ${op.id} is declared by both ${first} and ${s.file}`);
      sourceOf.set(op.id, s.file);
      // JIRA_ENABLE_XRAY hides operations by family: an Xray path must come from the xray source.
      if (s.api !== 'xray' && op.path.startsWith(XRAY_PREFIX)) {
        throw new Error(
          `${s.file} declares ${op.id}: Xray paths (${XRAY_PREFIX}) belong to the xray source`,
        );
      }
    }
    counts[s.api] += ops.length;
    parsed.push(...ops);
  }
  const classified = classifyOperations(parsed, input.decisions, input.now);
  const catalog: CatalogFile = {
    meta: {
      jiraVersion: input.meta.jiraVersion,
      jiraBuildNumber: input.meta.jiraBuildNumber,
      fetchedAt: input.meta.fetchedAt,
      generatedAt: input.generatedAt,
      counts,
    },
    operations: classified.operations,
  };
  const empty = emptyFamilies(input.meta, catalog);
  if (empty.length > 0) {
    throw new Error(
      `No operation for the ${empty.map((f) => `"${f}"`).join(', ')} family: its WADL source is missing from catalog/wadl/fetch-meta.json — run npm run catalog:fetch`,
    );
  }
  // The server validates the catalog at startup: one it would refuse must fail here, not in production.
  parseCatalog(JSON.parse(JSON.stringify(catalog)), 'The generated catalog');
  // Without the Xray plugin, its decisions are dormant: Xray is optional, they are not stale.
  const xrayAbsent = !input.meta.sources.some((s) => s.api === 'xray');
  const dormant = (id: string) => xrayAbsent && (id.split(' ')[1] ?? '').startsWith(XRAY_PREFIX);
  return {
    catalog,
    staleDecisions: classified.staleDecisions.filter((id) => !dormant(id)),
    dormantDecisions: classified.staleDecisions.filter(dormant),
    candidates: classified.candidates,
    pending: classified.pending,
  };
}

/** Local copy of the operations of the last lock (unversioned: it lists endpoints). */
export interface LockBaseline {
  operationsSha256: string;
  jiraVersion: string;
  operations: Operation[];
}

export type DiffBaseline =
  | { kind: 'previous-lock'; jiraVersion: string; operations: readonly Operation[] }
  | { kind: 'none' }
  | { kind: 'unknown'; jiraVersion: string };

/**
 * What last-diff.md and `lastChange` compare with: the operations recorded by the lock. The lock
 * stores only their digest, so the operations come from a local copy whose digest matches it
 * (catalog/lock-baseline.json, written by --update-lock, or a catalog.json still equal to the lock).
 * No lock: first generation, everything is added. No matching copy: unknown, never a wrong diff.
 */
export function selectBaseline(
  lock: SourceLock | undefined,
  copies: readonly ({ operations?: unknown } | undefined)[],
): DiffBaseline {
  if (!lock) return { kind: 'none' };
  for (const copy of copies) {
    const operations = copy?.operations;
    if (Array.isArray(operations) && operationsDigest(operations) === lock.operationsSha256)
      return { kind: 'previous-lock', jiraVersion: lock.jiraVersion, operations };
  }
  return { kind: 'unknown', jiraVersion: lock.jiraVersion };
}

/**
 * The baseline for catalog:build. Candidates, in order: the copy written by --update-lock, the
 * previous local catalog.json, then the catalog just built (on a fresh clone whose WADL still match
 * the lock, it is the locked catalog itself, so the diff is rightly empty).
 */
export function chooseBaseline(
  lock: SourceLock | undefined,
  local: { copy?: unknown; previous?: CatalogFile; built?: CatalogFile },
): DiffBaseline {
  const copy = typeof local.copy === 'object' && local.copy !== null ? local.copy : undefined;
  return selectBaseline(lock, [copy, local.previous, local.built]);
}

/** A parsed local catalog.json, or undefined when it is not a valid catalog (e.g. `{}`). */
export function asCatalog(json: unknown): CatalogFile | undefined {
  try {
    return parseCatalog(json, 'catalog/catalog.json');
  } catch {
    return undefined;
  }
}

/** The diff against the baseline, or undefined when the baseline is unknown. */
export function diffAgainstBaseline(
  baseline: DiffBaseline,
  operations: readonly Operation[],
): CatalogDiff | undefined {
  if (baseline.kind === 'unknown') return undefined;
  return diffOperations(baseline.kind === 'none' ? [] : baseline.operations, operations);
}

export function formatBaselineDiff(
  baseline: DiffBaseline,
  diff: CatalogDiff | undefined,
  catalog: CatalogFile,
): string {
  const to = `Jira ${catalog.meta.jiraVersion} (${catalog.meta.fetchedAt})`;
  if (baseline.kind === 'none')
    return formatDiff(
      diff ?? { added: [], removed: [], changed: [] },
      `Première génération → ${to}`,
    );
  const title = `Catalogue verrouillé (Jira ${baseline.jiraVersion}) → ${to}`;
  if (!diff) {
    return [
      `## ${title}`,
      '',
      'Référence inconnue : les opérations du verrou ne sont pas disponibles localement (ni `catalog/lock-baseline.json`, ni un `catalog/catalog.json` identique au verrou). Les opérations ajoutées, supprimées ou modifiées depuis le verrou ne peuvent pas être listées ; relisez le catalogue complet.',
      '',
    ].join('\n');
  }
  return formatDiff(diff, title);
}

/** Families that must have operations: api and agile always, others when their source is present. */
const ALWAYS_REQUIRED: ReadonlySet<ApiFamily> = new Set(['api', 'agile']);

/** Families without any operation although they are required (absent optional sources are fine). */
export function emptyFamilies(meta: FetchMeta, catalog: CatalogFile): ApiFamily[] {
  const present = new Set(meta.sources.map((s) => s.api));
  return API_FAMILIES.filter(
    (f) => (ALWAYS_REQUIRED.has(f) || present.has(f)) && catalog.meta.counts[f] === 0,
  );
}

/** Source drift: a WADL whose sha256 changed, appeared (e.g. plugin installed) or disappeared. */
export function compareSourcesWithLock(
  meta: Pick<FetchMeta, 'sources'>,
  lock: Pick<SourceLock, 'sources'>,
): string[] {
  const problems: string[] = [];
  for (const s of meta.sources) {
    const locked = lock.sources.find((l) => l.file === s.file);
    if (!locked)
      problems.push(`WADL ${s.file} is present but absent from catalog/source-lock.json`);
    else if (locked.sha256 !== s.sha256)
      problems.push(`WADL ${s.file} differs from catalog/source-lock.json (sha256)`);
  }
  for (const l of lock.sources) {
    if (!meta.sources.some((s) => s.file === l.file))
      problems.push(`WADL ${l.file} recorded in catalog/source-lock.json is now absent`);
  }
  return problems;
}

export function compareWithLock(meta: FetchMeta, catalog: CatalogFile, lock: SourceLock): string[] {
  const problems: string[] = [];
  if (meta.jiraVersion !== lock.jiraVersion || meta.jiraBuildNumber !== lock.jiraBuildNumber) {
    problems.push(
      `Jira version/build differs from catalog/source-lock.json: ${meta.jiraVersion} (${meta.jiraBuildNumber}) vs ${lock.jiraVersion} (${lock.jiraBuildNumber})`,
    );
  }
  problems.push(...compareSourcesWithLock(meta, lock));
  const { counts } = catalog.meta;
  if (
    counts.api !== lock.counts.api ||
    counts.agile !== lock.counts.agile ||
    counts.xray !== lock.counts.xray
  ) {
    problems.push(
      `Operation counts differ from catalog/source-lock.json: ${JSON.stringify(counts)} vs ${JSON.stringify(lock.counts)}`,
    );
  } else if (operationsDigest(catalog.operations) !== lock.operationsSha256) {
    problems.push(
      'Classified operations differ from catalog/source-lock.json (operationsSha256): run npm run catalog:build -- --update-lock after review',
    );
  }
  return problems;
}

export function makeLock(
  meta: FetchMeta,
  catalog: CatalogFile,
  previous: SourceLock | undefined,
  baseline: DiffBaseline,
  recordedAt: string,
): SourceLock {
  const diff = diffAgainstBaseline(baseline, catalog.operations);
  return {
    ...meta,
    counts: catalog.meta.counts,
    operationsSha256: operationsDigest(catalog.operations),
    lastChange: {
      fromVersion: previous?.jiraVersion ?? null,
      toVersion: meta.jiraVersion,
      baseline: baseline.kind,
      added: diff ? diff.added.length : null,
      removed: diff ? diff.removed.length : null,
      changed: diff ? diff.changed.length : null,
      recordedAt,
    },
  };
}

const lockContent = ({ fetchedAt: _f, lastChange: _l, ...rest }: SourceLock) => rest;

/**
 * Whether `next` locks the same thing as `previous`: same version, files, counts and operations.
 * Only the fetch date and the last-change record may differ; the lock is then left untouched, so
 * that a re-lock without change neither churns nor erases the record of the real last change.
 */
export function sameLockContent(previous: SourceLock | undefined, next: SourceLock): boolean {
  return previous !== undefined && isDeepStrictEqual(lockContent(previous), lockContent(next));
}

const CATEGORY_HELP: Record<ReviewCategory, string> = {
  'get-side-effect':
    'GET dont le chemin évoque un effet de bord : décider read / write / destructive',
  'post-read-like': 'POST dont le chemin évoque une lecture : décider read / write',
  'write-destructive-like':
    'POST/PUT/PATCH dont le chemin évoque une suppression ou un fort impact : décider write / destructive',
};

export function formatReview(
  catalog: CatalogFile,
  candidates: readonly ReviewCandidate[],
  pending: readonly ReviewCandidate[],
): string {
  const pendingKeys = new Set(pending.map((c) => `${c.category} ${c.id}`));
  const unreviewedGets = catalog.operations.filter(
    (o) => o.method === 'GET' && o.accessReason.includes('not individually reviewed'),
  ).length;
  const lines = [
    `# Revue des classifications — Jira ${catalog.meta.jiraVersion} (WADL ${catalog.meta.fetchedAt})`,
    '',
    'Heuristiques de chemin : elles désignent des opérations à revoir, elles ne prouvent rien.',
    '',
    `Candidats : ${candidates.length} — En attente : ${pending.length}`,
    `GET non revus individuellement : ${unreviewedGets} (risque résiduel accepté : classés lecture par la seule méthode HTTP)`,
    '',
  ];
  for (const category of Object.keys(CATEGORY_HELP) as ReviewCategory[]) {
    lines.push(`### ${category}`, '', CATEGORY_HELP[category], '');
    for (const c of candidates.filter((x) => x.category === category)) {
      const done = !pendingKeys.has(`${c.category} ${c.id}`);
      lines.push(`- [${done ? 'x' : ' '}] \`${c.id}\` (matched "${c.matched}")`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
