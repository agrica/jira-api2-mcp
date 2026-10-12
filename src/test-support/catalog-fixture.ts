import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A minimal valid catalog file content (one read operation of the api family). */
export const FIXTURE_CATALOG = {
  meta: {
    jiraVersion: '8.20.0',
    jiraBuildNumber: 820000,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    generatedAt: '2026-01-01T00:00:00.000Z',
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

/** Temporary directories created by a test file, removed with `cleanup()` (call it in afterEach). */
export function tempDirs(prefix = 'jira-api2-mcp-test-') {
  const dirs: string[] = [];
  return {
    async make(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    async file(name: string, content: string): Promise<string> {
      const file = join(await this.make(), name);
      await writeFile(file, content);
      return file;
    },
    async cleanup(): Promise<void> {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
