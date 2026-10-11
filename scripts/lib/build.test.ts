import { describe, expect, it, vi } from 'vitest';
import {
  asCatalog,
  buildCatalog,
  chooseBaseline,
  compareWithLock,
  diffAgainstBaseline,
  formatBaselineDiff,
  emptyFamilies,
  formatReview,
  makeLock,
  missingWadlFiles,
  operationsDigest,
  sameLockContent,
  selectBaseline,
  sha256,
  verifyFiles,
} from './build.ts';
import type { FetchMeta } from './sources.ts';

const wadl = (base: string, path: string, method: string) => `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://jira.example${base}/"><resource path="${path}"><method name="${method}"/></resource></resources>
</application>`;

const XML = new Map([
  ['api.wadl', wadl('/rest/api/2', 'search', 'POST')],
  ['agile.wadl', wadl('/rest/agile/1.0', 'board', 'GET')],
  ['xray.wadl', wadl('/rest/raven/1.0', 'api/test', 'DELETE')],
]);

const meta = (overrides: Partial<FetchMeta> = {}): FetchMeta => ({
  jiraVersion: '8.20.0',
  jiraBuildNumber: 820000,
  fetchedAt: '2026-10-11T08:00:00.000Z',
  sources: [
    {
      api: 'api',
      path: '/rest/api/2/application.wadl',
      file: 'api.wadl',
      sha256: sha256(XML.get('api.wadl') ?? ''),
      bytes: 1,
    },
    {
      api: 'agile',
      path: '/rest/agile/1.0/application.wadl',
      file: 'agile.wadl',
      sha256: sha256(XML.get('agile.wadl') ?? ''),
      bytes: 1,
    },
    {
      api: 'xray',
      path: '/rest/raven/1.0/application.wadl',
      file: 'xray.wadl',
      sha256: sha256(XML.get('xray.wadl') ?? ''),
      bytes: 1,
    },
  ],
  absent: [],
  ...overrides,
});
/** Fetch meta of an instance without the Xray plugin (its WADL answered 404). */
const metaWithoutXray = (overrides: Partial<FetchMeta> = {}): FetchMeta =>
  meta({
    sources: meta().sources.filter((s) => s.api !== 'xray'),
    absent: ['xray.wadl'],
    ...overrides,
  });
const XML_WITHOUT_XRAY = new Map([...XML].filter(([file]) => file !== 'xray.wadl'));
const searchDecision = {
  'POST /rest/api/2/search': {
    access: 'read',
    reason: 'JQL search',
    reviewedBy: 'reviewer@example.org',
    reviewedOn: '2026-10-11',
  },
} as const;

describe('buildCatalog', () => {
  it('parses every source, applies decisions and records version, dates and counts', () => {
    const { catalog, pending } = buildCatalog({
      xml: XML,
      decisions: searchDecision,
      meta: meta(),
      generatedAt: 'G',
    });
    expect(catalog.meta).toEqual({
      jiraVersion: '8.20.0',
      jiraBuildNumber: 820000,
      fetchedAt: '2026-10-11T08:00:00.000Z',
      generatedAt: 'G',
      counts: { api: 1, agile: 1, xray: 1 },
    });
    expect(catalog.operations.map((o) => [o.id, o.access])).toEqual([
      ['POST /rest/api/2/search', 'read'],
      ['GET /rest/agile/1.0/board', 'read'],
      ['DELETE /rest/raven/1.0/api/test', 'destructive'],
    ]);
    expect(pending).toEqual([]);
  });

  it('reports pending candidates when no decision exists', () => {
    expect(
      buildCatalog({ xml: XML, decisions: {}, meta: meta(), generatedAt: 'G' }).pending.map(
        (c) => c.id,
      ),
    ).toEqual(['POST /rest/api/2/search']);
  });

  it('fails on an operation id declared by two sources', () => {
    const xml = new Map(XML).set('xray.wadl', wadl('/rest/api/2', 'search', 'POST'));
    expect(() =>
      buildCatalog({ xml, decisions: searchDecision, meta: meta(), generatedAt: 'G' }),
    ).toThrow('Operation POST /rest/api/2/search is declared by both api.wadl and xray.wadl');
  });

  it('fails when a non-Xray source declares an Xray path (/rest/raven/)', () => {
    const xml = new Map(XML).set('agile.wadl', wadl('/rest/raven/1.0', 'board', 'GET'));
    expect(() =>
      buildCatalog({ xml, decisions: searchDecision, meta: meta(), generatedAt: 'G' }),
    ).toThrow(
      'agile.wadl declares GET /rest/raven/1.0/board: Xray paths (/rest/raven/) belong to the xray source',
    );
  });

  it('fails when a source file is missing', () => {
    expect(() =>
      buildCatalog({ xml: new Map(), decisions: {}, meta: meta(), generatedAt: 'G' }),
    ).toThrow(/api.wadl/);
  });
});

describe('verifyFiles', () => {
  it('rejects a WADL that does not match its recorded sha256', () => {
    expect(() => verifyFiles(meta(), XML)).not.toThrow();
    const altered = new Map(XML).set('api.wadl', 'changed');
    expect(() => verifyFiles(meta(), altered)).toThrow(/api.wadl.*sha256/);
  });

  it('reports a missing WADL file as missing, not as a sha256 mismatch', () => {
    const partial = new Map(XML);
    partial.delete('agile.wadl');
    const message = 'missing WADL file catalog/wadl/agile.wadl: run npm run catalog:fetch';
    expect(missingWadlFiles(meta(), XML)).toEqual([]);
    expect(missingWadlFiles(meta(), partial)).toEqual([message]);
    expect(() => verifyFiles(meta(), partial)).toThrow(message);
    expect(() =>
      buildCatalog({ xml: partial, decisions: searchDecision, meta: meta(), generatedAt: 'G' }),
    ).toThrow(message);
  });
});

describe('source lock', () => {
  const { catalog } = buildCatalog({
    xml: XML,
    decisions: searchDecision,
    meta: meta(),
    generatedAt: 'G',
  });
  const diff = { kind: 'none' } as const;
  const lock = makeLock(meta(), catalog, undefined, diff, '2026-10-11T09:00:00.000Z');

  it('records version, hashes, counts, digest and a numeric summary of the last change (no endpoint list, no URL)', () => {
    expect(lock).toMatchObject({
      jiraVersion: '8.20.0',
      jiraBuildNumber: 820000,
      counts: { api: 1, agile: 1, xray: 1 },
      operationsSha256: operationsDigest(catalog.operations),
      lastChange: {
        fromVersion: null,
        toVersion: '8.20.0',
        baseline: 'none',
        added: 3,
        removed: 0,
        changed: 0,
        recordedAt: '2026-10-11T09:00:00.000Z',
      },
    });
    expect(JSON.stringify(lock)).not.toContain('/rest/api/2/search');
    expect(JSON.stringify(lock)).not.toMatch(/https?:\/\//);
    expect(compareWithLock(meta(), catalog, lock)).toEqual([]);
  });

  it('detects version, file, count and classification drift', () => {
    const other = buildCatalog({ xml: XML, decisions: {}, meta: meta(), generatedAt: 'G' }).catalog;
    expect(compareWithLock(meta({ jiraVersion: '8.20.1' }), catalog, lock)).toEqual([
      'Jira version/build differs from catalog/source-lock.json: 8.20.1 (820000) vs 8.20.0 (820000)',
    ]);
    expect(compareWithLock(meta(), other, lock)).toEqual([
      'Classified operations differ from catalog/source-lock.json (operationsSha256): run npm run catalog:build -- --update-lock after review',
    ]);
    const changedFile = meta({
      // oxlint-disable-next-line oxc/no-map-spread -- fixture: immutable copy of a source entry
      sources: meta().sources.map((s) => (s.file === 'xray.wadl' ? { ...s, sha256: 'x' } : s)),
    });
    expect(compareWithLock(changedFile, catalog, lock)).toEqual([
      'WADL xray.wadl differs from catalog/source-lock.json (sha256)',
    ]);
  });
});

describe('optional Xray source', () => {
  const { catalog } = buildCatalog({
    xml: XML_WITHOUT_XRAY,
    decisions: searchDecision,
    meta: metaWithoutXray(),
    generatedAt: 'G',
  });
  const diff = { kind: 'none' } as const;
  const lock = makeLock(metaWithoutXray(), catalog, undefined, diff, 'R');

  it('builds, locks and verifies without the xray source (counts.xray = 0)', () => {
    expect(catalog.meta.counts).toEqual({ api: 1, agile: 1, xray: 0 });
    expect(() => verifyFiles(metaWithoutXray(), XML_WITHOUT_XRAY)).not.toThrow();
    expect(missingWadlFiles(metaWithoutXray(), XML_WITHOUT_XRAY)).toEqual([]);
    expect(lock.sources.map((s) => s.file)).toEqual(['api.wadl', 'agile.wadl']);
    expect(lock.absent).toEqual(['xray.wadl']);
    expect(compareWithLock(metaWithoutXray(), catalog, lock)).toEqual([]);
  });

  it('requires operations only for families whose source is present (api and agile always)', () => {
    expect(emptyFamilies(metaWithoutXray(), catalog)).toEqual([]);
    const full = buildCatalog({
      xml: XML,
      decisions: searchDecision,
      meta: meta(),
      generatedAt: 'G',
    });
    expect(emptyFamilies(meta(), full.catalog)).toEqual([]);
    const noXrayOps = {
      ...full.catalog,
      meta: { ...full.catalog.meta, counts: { api: 1, agile: 1, xray: 0 } },
    };
    expect(emptyFamilies(meta(), noXrayOps)).toEqual(['xray']);
    const nothing = {
      ...catalog,
      meta: { ...catalog.meta, counts: { api: 0, agile: 0, xray: 0 } },
    };
    expect(emptyFamilies(metaWithoutXray({ sources: [] }), nothing)).toEqual(['api', 'agile']);
  });

  it('detects xray appearing or disappearing as drift', () => {
    const full = buildCatalog({
      xml: XML,
      decisions: searchDecision,
      meta: meta(),
      generatedAt: 'G',
    });
    const fullLock = makeLock(meta(), full.catalog, undefined, diff, 'R');
    expect(compareWithLock(meta(), full.catalog, lock)).toEqual(
      expect.arrayContaining([
        'WADL xray.wadl is present but absent from catalog/source-lock.json',
      ]),
    );
    expect(compareWithLock(metaWithoutXray(), catalog, fullLock)).toEqual(
      expect.arrayContaining(['WADL xray.wadl recorded in catalog/source-lock.json is now absent']),
    );
  });
});

describe('formatReview', () => {
  it('lists decided and pending candidates and counts GETs not individually reviewed', () => {
    const { catalog, candidates, pending } = buildCatalog({
      xml: XML,
      decisions: {},
      meta: meta(),
      generatedAt: 'G',
    });
    const report = formatReview(catalog, candidates, pending);
    expect(report).toContain('### post-read-like');
    expect(report).toContain('- [ ] `POST /rest/api/2/search` (matched "search")');
    expect(report).toContain('En attente : 1');
    expect(report).toContain('GET non revus individuellement : 1');
  });
});

/** Fetch meta whose `file` entry records the sha256 of `text`. */
const metaWith = (file: string, text: string, overrides: Partial<FetchMeta> = {}): FetchMeta =>
  meta({
    // oxlint-disable-next-line oxc/no-map-spread -- fixture: immutable copy of a source entry
    sources: meta().sources.map((s) => (s.file === file ? { ...s, sha256: sha256(text) } : s)),
    ...overrides,
  });
const withFile = (file: string, text: string) => ({
  xml: new Map(XML).set(file, text),
  meta: metaWith(file, text),
});

describe('buildCatalog — unusable sources and runtime schema', () => {
  it('fails on an HTML, empty or operation-less WADL for a present source (Xray included)', () => {
    for (const [file, text] of [
      ['api.wadl', '<html><head><title>Log in</title></head></html>'],
      ['agile.wadl', ''],
      [
        'xray.wadl',
        '<application><resources base="https://jira.example/rest/raven/1.0/"/></application>',
      ],
    ] as const) {
      const input = withFile(file, text);
      expect(() => buildCatalog({ ...input, decisions: searchDecision, generatedAt: 'G' })).toThrow(
        /WADL is not a usable WADL/,
      );
    }
  });

  it('fails when a required family has no source at all', () => {
    const noAgile = meta({ sources: meta().sources.filter((s) => s.api !== 'agile') });
    expect(() =>
      buildCatalog({ xml: XML, decisions: searchDecision, meta: noAgile, generatedAt: 'G' }),
    ).toThrow(
      'No operation for the "agile" family: its WADL source is missing from catalog/wadl/fetch-meta.json',
    );
  });

  it('validates the generated catalog with the schema the server applies at startup', () => {
    expect(() =>
      buildCatalog({
        xml: XML,
        decisions: searchDecision,
        meta: meta({ jiraVersion: undefined as unknown as string }),
        generatedAt: 'G',
      }),
    ).toThrow(/^The generated catalog is invalid: meta\.jiraVersion/);
  });

  it('refuses invalid decisions before building, naming each one', () => {
    expect(() =>
      buildCatalog({
        xml: XML,
        decisions: {
          'POST /rest/api/2/search': {
            ...searchDecision['POST /rest/api/2/search'],
            reviewedBy: '<identité git du relecteur>',
          },
        },
        meta: meta(),
        generatedAt: 'G',
        now: new Date('2026-10-11T00:00:00.000Z'),
      }),
    ).toThrow(
      'Access decision for POST /rest/api/2/search: "reviewedBy" is a placeholder ("<identité git du relecteur>"): replace the placeholder reviewer in catalog/access-decisions.json after reviewing the decision',
    );
  });

  it('passes WADL warnings to the caller', () => {
    const dup = `<application><resources base="https://jira.example/rest/agile/1.0/">
<resource path="board"><method name="GET"/></resource><resource path="board/"><method name="GET"/></resource>
</resources></application>`;
    const input = withFile('agile.wadl', dup);
    const warn = vi.fn<(message: string) => void>();
    buildCatalog({ ...input, decisions: searchDecision, generatedAt: 'G', warn });
    expect(warn).toHaveBeenCalledWith(
      '⚠ agile WADL: 1 duplicate method + path declaration(s) merged',
    );
  });

  it('keeps Xray decisions as dormant, not stale, when the Xray source is absent', () => {
    const base = searchDecision['POST /rest/api/2/search'];
    const decisions = {
      ...searchDecision,
      'POST /rest/raven/1.0/export/test': { ...base, access: 'write' },
      'GET /rest/api/2/gone': base,
    } as const;
    const without = buildCatalog({
      xml: XML_WITHOUT_XRAY,
      decisions,
      meta: metaWithoutXray(),
      generatedAt: 'G',
    });
    expect(without.staleDecisions).toEqual(['GET /rest/api/2/gone']);
    expect(without.dormantDecisions).toEqual(['POST /rest/raven/1.0/export/test']);
    const withXray = buildCatalog({ xml: XML, decisions, meta: meta(), generatedAt: 'G' });
    expect(withXray.staleDecisions).toEqual([
      'GET /rest/api/2/gone',
      'POST /rest/raven/1.0/export/test',
    ]);
    expect(withXray.dormantDecisions).toEqual([]);
  });
});

describe('lock-based diff (build, then build -- --update-lock)', () => {
  const v1 = buildCatalog({ xml: XML, decisions: searchDecision, meta: meta(), generatedAt: 'G' });
  const lock = makeLock(meta(), v1.catalog, undefined, { kind: 'none' }, 'R1');
  const copy = {
    operationsSha256: lock.operationsSha256,
    jiraVersion: '8.20.0',
    operations: v1.catalog.operations,
  };
  // Jira upgrade: one agile operation added.
  const agile2 = `<?xml version="1.0"?>
<application xmlns="http://wadl.dev.java.net/2009/02">
  <resources base="https://jira.example/rest/agile/1.0/"><resource path="board"><method name="GET"/></resource><resource path="sprint"><method name="GET"/></resource></resources>
</application>`;
  const xml2 = new Map(XML).set('agile.wadl', agile2);
  const meta2 = metaWith('agile.wadl', agile2, { jiraVersion: '8.22.0' });
  const v2 = buildCatalog({ xml: xml2, decisions: searchDecision, meta: meta2, generatedAt: 'G2' });

  it('reports the operations added since the lock even after a plain build overwrote catalog.json', () => {
    // After `catalog:build`, catalog.json already holds v2: only the baseline copy matches the lock.
    const baseline = selectBaseline(lock, [copy, v2.catalog]);
    expect(baseline).toMatchObject({ kind: 'previous-lock', jiraVersion: '8.20.0' });
    const diff = diffAgainstBaseline(baseline, v2.catalog.operations);
    expect(diff).toEqual({ added: ['GET /rest/agile/1.0/sprint'], removed: [], changed: [] });
    expect(makeLock(meta2, v2.catalog, lock, baseline, 'R2').lastChange).toEqual({
      fromVersion: '8.20.0',
      toVersion: '8.22.0',
      baseline: 'previous-lock',
      added: 1,
      removed: 0,
      changed: 0,
      recordedAt: 'R2',
    });
    expect(formatBaselineDiff(baseline, diff, v2.catalog)).toContain(
      '## Catalogue verrouillé (Jira 8.20.0) → Jira 8.22.0',
    );
  });

  it('uses a catalog.json that still equals the lock when no baseline copy exists', () => {
    expect(selectBaseline(lock, [undefined, v1.catalog]).kind).toBe('previous-lock');
  });

  it('says the baseline is unknown instead of reporting a wrong diff', () => {
    const baseline = selectBaseline(lock, [undefined, v2.catalog, { operations: 'garbage' }]);
    expect(baseline).toEqual({ kind: 'unknown', jiraVersion: '8.20.0' });
    expect(diffAgainstBaseline(baseline, v2.catalog.operations)).toBeUndefined();
    expect(makeLock(meta2, v2.catalog, lock, baseline, 'R2').lastChange).toMatchObject({
      baseline: 'unknown',
      added: null,
      removed: null,
      changed: null,
    });
    expect(formatBaselineDiff(baseline, undefined, v2.catalog)).toContain('Référence inconnue');
  });

  it('treats a missing lock as a first generation (everything added)', () => {
    const baseline = selectBaseline(undefined, [copy]);
    expect(baseline).toEqual({ kind: 'none' });
    const diff = diffAgainstBaseline(baseline, v1.catalog.operations);
    expect(diff?.added).toHaveLength(3);
    expect(formatBaselineDiff(baseline, diff, v1.catalog)).toContain(
      '## Première génération → Jira 8.20.0',
    );
  });

  it('leaves the lock untouched when only the fetch date and the last-change record would change', () => {
    const same = {
      kind: 'previous-lock',
      jiraVersion: '8.20.0',
      operations: v1.catalog.operations,
    };
    const again = makeLock(meta({ fetchedAt: 'later' }), v1.catalog, lock, same as never, 'R3');
    expect(sameLockContent(lock, again)).toBe(true);
    expect(sameLockContent(undefined, again)).toBe(false);
    const upgraded = makeLock(meta2, v2.catalog, lock, { kind: 'none' }, 'R3');
    expect(sameLockContent(lock, upgraded)).toBe(false);
  });
});

describe('wave 2 review follow-ups (build)', () => {
  const v1 = buildCatalog({ xml: XML, decisions: searchDecision, meta: meta(), generatedAt: 'G' });
  const lock = makeLock(meta(), v1.catalog, undefined, { kind: 'none' }, 'R1');

  it('treats a local catalog.json of the wrong shape as absent instead of crashing', () => {
    expect(asCatalog({})).toBeUndefined();
    expect(asCatalog({ meta: {} })).toBeUndefined();
    expect(asCatalog(null)).toBeUndefined();
    expect(asCatalog(JSON.parse(JSON.stringify(v1.catalog)))).toEqual(v1.catalog);
  });

  it('on a fresh clone, uses the freshly built catalog when it equals the lock (empty diff)', () => {
    const baseline = chooseBaseline(lock, { built: v1.catalog });
    expect(baseline.kind).toBe('previous-lock');
    expect(diffAgainstBaseline(baseline, v1.catalog.operations)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    // The local copies come first; nothing matching gives unknown.
    expect(chooseBaseline(lock, {}).kind).toBe('unknown');
    expect(chooseBaseline(undefined, { built: v1.catalog }).kind).toBe('none');
  });
});
