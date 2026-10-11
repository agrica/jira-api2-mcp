import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_PATH, loadCatalogFile } from './load.ts';

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

const tempFile = async (content: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'jira-mcp-catalog-'));
  const file = join(dir, 'catalog.json');
  await writeFile(file, content);
  return file;
};

describe('loadCatalogFile', () => {
  it('points by default to catalog/catalog.json at the project root', () => {
    expect(DEFAULT_CATALOG_PATH.replaceAll('\\', '/')).toMatch(/\/catalog\/catalog\.json$/);
  });

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
});
