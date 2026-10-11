import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  compareWithLock,
  emptyFamilies,
  formatReview,
  makeLock,
  missingWadlFiles,
  operationsDigest,
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
  const diff = { added: catalog.operations.map((o) => o.id), removed: [], changed: [] };
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
  const diff = { added: catalog.operations.map((o) => o.id), removed: [], changed: [] };
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
