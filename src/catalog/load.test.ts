/* oxlint-disable eslint/no-await-in-loop -- temp files written and loaded one case at a time */
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

  it('rejects operation paths that escape /rest/', async () => {
    for (const path of [
      '/rest/api/2/%2e%2e/%2e%2e/%2e%2e/plugins/servlet/x',
      String.raw`/rest/api/2/..\..\secure\admin`,
      '/rest/api/2/../../../secure/Logout!default.jspa',
      '/rest/api/2/x?os_authType=basic#',
    ]) {
      const bad = { ...valid, operations: [{ ...valid.operations[0], path }] };
      await expect(loadCatalogFile(await tempFile(JSON.stringify(bad)))).rejects.toThrow(
        /is invalid: operations\.0\.path: unsafe operation path/,
      );
    }
  });

  it('rejects PUT, PATCH and DELETE classified as read, and unreviewed POST reads', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const bad = { ...valid, operations: [{ ...valid.operations[0], method }] };
      await expect(loadCatalogFile(await tempFile(JSON.stringify(bad)))).rejects.toThrow(
        `operations.0.access: ${method} operations cannot be classified as read`,
      );
    }
    const post = { ...valid.operations[0], method: 'POST', path: '/rest/api/2/search' };
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
