/* oxlint-disable eslint/no-await-in-loop -- temp files written and loaded one case at a time */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDirs } from '../test-support/catalog-fixture.ts';
import { DEFAULT_CATALOG_PATH, loadCatalogFile, parseCatalog } from './load.ts';

const valid = {
  meta: {
    jiraVersion: '8.20.0',
    jiraBuildNumber: 820000,
    fetchedAt: 'F',
    generatedAt: 'G',
    counts: { api: 1, agile: 0, xray: 0 },
  },
  operations: [
    {
      id: 'GET /rest/api/2/myself',
      api: 'api',
      method: 'GET',
      path: '/rest/api/2/myself',
      summary: '',
      body: { accepted: false, mediaTypes: [] },
      params: [],
      access: 'read',
      accessReason: 'default rule: safe HTTP method (not individually reviewed)',
    },
  ],
};

const temp = tempDirs('jira8-mcp-catalog-');
afterEach(async () => {
  await temp.cleanup();
});
const tempFile = (content: string) => temp.file('catalog.json', content);

/** The repository root: the closest parent directory holding a package.json. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
  return dir;
}

describe('DEFAULT_CATALOG_PATH', () => {
  const root = repoRoot();
  const expected = resolve(root, 'catalog', 'catalog.json');
  const srcModule = resolve(root, 'src', 'catalog', 'load.ts');

  it('is <repo>/catalog/catalog.json from the sources', () => {
    expect(DEFAULT_CATALOG_PATH).toBe(expected);
  });

  it('is <package>/catalog/catalog.json from the compiled dist/catalog/load.js too', () => {
    // Where tsc puts the module (tsconfig.build.json rootDir -> outDir), and the shipped files.
    const build = JSON.parse(readFileSync(join(root, 'tsconfig.build.json'), 'utf8')) as {
      compilerOptions: { rootDir: string; outDir: string };
    };
    const fromRootDir = relative(resolve(root, build.compilerOptions.rootDir), srcModule);
    const distModule = resolve(root, build.compilerOptions.outDir, fromRootDir).replace(
      /\.ts$/,
      '.js',
    );
    expect(relative(root, distModule).replaceAll('\\', '/')).toBe('dist/catalog/load.js');
    // The relative URL used by the source module, applied to the compiled one, must land on
    // the shipped catalog.
    const relativeUrl = relative(dirname(srcModule), DEFAULT_CATALOG_PATH);
    expect(resolve(dirname(distModule), relativeUrl)).toBe(expected);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'catalog/catalog.json']));
  });
});

describe('loadCatalogFile', () => {
  it('loads a valid catalog', async () => {
    const catalog = await loadCatalogFile(await tempFile(JSON.stringify(valid)));
    expect(catalog.meta.jiraVersion).toBe('8.20.0');
    expect(catalog.operations).toHaveLength(1);
  });

  it('explains how to produce a missing catalog', async () => {
    await expect(loadCatalogFile(join(tmpdir(), 'absent-dir-xyz', 'catalog.json'))).rejects.toThrow(
      /not found.*not stored in git.*npm run catalog:fetch.*npm run catalog:build/,
    );
  });

  it('rejects invalid JSON and invalid shapes', async () => {
    await expect(loadCatalogFile(await tempFile('{oops'))).rejects.toThrow(/not valid JSON/);
    const broken = { ...valid, operations: [{ ...valid.operations[0], access: 'maybe' }] };
    await expect(loadCatalogFile(await tempFile(JSON.stringify(broken)))).rejects.toThrow(
      /is invalid: operations\.0\.access/,
    );
  });

  it('rejects operation paths that escape /rest/', async () => {
    for (const path of [
      '/rest/api/2/%2e%2e/%2e%2e/%2e%2e/plugins/servlet/x',
      String.raw`/rest/api/2/..\..\secure\admin`,
      '/rest/api/2/../../../secure/Logout!default.jspa',
      '/rest/api/2/x?os_authType=basic#',
      '/rest/api/2/..;/..;/..;/secure/admin',
      '/rest/api/2/.;/x',
      '/rest/api/2/..;jsessionid=1/secure/admin',
    ]) {
      const bad = { ...valid, operations: [{ ...valid.operations[0], path }] };
      await expect(loadCatalogFile(await tempFile(JSON.stringify(bad)))).rejects.toThrow(
        /is invalid: operations\.0\.path: unsafe operation path/,
      );
    }
  });

  it('rejects PUT, PATCH and DELETE classified as read, and unreviewed POST reads', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const bad = {
        ...valid,
        operations: [{ ...valid.operations[0], method, id: `${method} /rest/api/2/myself` }],
      };
      await expect(loadCatalogFile(await tempFile(JSON.stringify(bad)))).rejects.toThrow(
        `operations.0.access: ${method} operations cannot be classified as read`,
      );
    }
    const post = {
      ...valid.operations[0],
      id: 'POST /rest/api/2/search',
      method: 'POST',
      path: '/rest/api/2/search',
    };
    const unreviewed = { ...valid, operations: [{ ...post, accessReason: 'default rule' }] };
    await expect(loadCatalogFile(await tempFile(JSON.stringify(unreviewed)))).rejects.toThrow(
      'operations.0.accessReason: a POST classified as read must come from a reviewed decision',
    );
    const reviewed = {
      ...valid,
      operations: [{ ...post, accessReason: 'reviewed: JQL search (jdoe, 2026-10-11)' }],
    };
    expect(
      (await loadCatalogFile(await tempFile(JSON.stringify(reviewed)))).operations,
    ).toHaveLength(1);
  });
});

describe('catalog coherence', () => {
  it('rejects an id that is not "<method> <path>", a duplicate id and counts that disagree', async () => {
    const op = valid.operations[0];
    const wrongId = { ...valid, operations: [{ ...op, id: 'GET /rest/api/2/other' }] };
    await expect(loadCatalogFile(await tempFile(JSON.stringify(wrongId)))).rejects.toThrow(
      'operations.0.id: must be "<method> <path>"',
    );
    const duplicate = {
      ...valid,
      meta: { ...valid.meta, counts: { api: 2, agile: 0, xray: 0 } },
      operations: [op, op],
    };
    await expect(loadCatalogFile(await tempFile(JSON.stringify(duplicate)))).rejects.toThrow(
      'operations.1.id: duplicate id',
    );
    const counts = { ...valid, meta: { ...valid.meta, counts: { api: 1, agile: 4, xray: 0 } } };
    await expect(loadCatalogFile(await tempFile(JSON.stringify(counts)))).rejects.toThrow(
      'meta.counts.agile: 4 does not match the 0 operation(s) of the family',
    );
  });

  it('is exported for the build scripts with a caller-chosen label', () => {
    expect(parseCatalog(valid, 'X').operations).toHaveLength(1);
    expect(() =>
      parseCatalog({ ...valid, meta: { ...valid.meta, jiraVersion: '' } }, 'The generated catalog'),
    ).toThrow('The generated catalog is invalid: meta.jiraVersion:');
  });
});
