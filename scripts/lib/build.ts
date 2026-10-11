import { createHash } from 'node:crypto';
import type {
  AccessDecisions,
  ApiFamily,
  CatalogFile,
  Operation,
  ParsedOperation,
} from '../../src/catalog/types.ts';
import { classifyOperations, type ReviewCandidate, type ReviewCategory } from './classify.ts';
import type { CatalogDiff } from './diff.ts';
import type { FetchMeta, SourceLock } from './sources.ts';
import { parseWadl } from './wadl.ts';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function operationsDigest(operations: readonly Operation[]): string {
  return sha256(JSON.stringify(operations));
}

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
}): {
  catalog: CatalogFile;
  staleDecisions: string[];
  candidates: ReviewCandidate[];
  pending: ReviewCandidate[];
} {
  const parsed: ParsedOperation[] = [];
  const counts: Record<ApiFamily, number> = { api: 0, agile: 0, xray: 0 };
  for (const s of input.meta.sources) {
    const text = input.xml.get(s.file);
    if (text === undefined) throw new Error(missingMessage(s.file));
    const ops = parseWadl(text, s.api);
    counts[s.api] += ops.length;
    parsed.push(...ops);
  }
  const { operations, staleDecisions, candidates, pending } = classifyOperations(
    parsed,
    input.decisions,
  );
  return {
    catalog: {
      meta: {
        jiraVersion: input.meta.jiraVersion,
        jiraBuildNumber: input.meta.jiraBuildNumber,
        fetchedAt: input.meta.fetchedAt,
        generatedAt: input.generatedAt,
        counts,
      },
      operations,
    },
    staleDecisions,
    candidates,
    pending,
  };
}

export function compareWithLock(meta: FetchMeta, catalog: CatalogFile, lock: SourceLock): string[] {
  const problems: string[] = [];
  if (meta.jiraVersion !== lock.jiraVersion || meta.jiraBuildNumber !== lock.jiraBuildNumber) {
    problems.push(
      `Jira version/build differs from catalog/source-lock.json: ${meta.jiraVersion} (${meta.jiraBuildNumber}) vs ${lock.jiraVersion} (${lock.jiraBuildNumber})`,
    );
  }
  for (const s of meta.sources) {
    if (lock.sources.find((l) => l.file === s.file)?.sha256 !== s.sha256) {
      problems.push(`WADL ${s.file} differs from catalog/source-lock.json (sha256)`);
    }
  }
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
  diff: CatalogDiff,
  recordedAt: string,
): SourceLock {
  return {
    ...meta,
    counts: catalog.meta.counts,
    operationsSha256: operationsDigest(catalog.operations),
    lastChange: {
      fromVersion: previous?.jiraVersion ?? null,
      toVersion: meta.jiraVersion,
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      recordedAt,
    },
  };
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
    `GET non revus individuellement : ${unreviewedGets} (risque résiduel H11)`,
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
