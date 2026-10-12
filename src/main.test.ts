import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_CATALOG, tempDirs } from './test-support/catalog-fixture.ts';
import { main, type MainDeps } from './main.ts';

// Fictitious values only; built by concatenation so that secrets:scan does not flag this file.
const PAT = ['fakepat', 'value', '0001'].join('');
const BASE_URL = 'https://jira.example.com';
const temp = tempDirs('jira-api2-mcp-main-');

afterEach(async () => {
  await temp.cleanup();
});

async function run(env: Record<string, string>, overrides: Partial<MainDeps> = {}) {
  const lines: string[] = [];
  const serve = vi.fn<MainDeps['serve']>();
  const code = await main({ env, log: (line) => lines.push(line), serve, ...overrides });
  const output = lines.join('\n');
  // Whatever happens, neither the PAT nor the instance URL is ever logged.
  expect(output).not.toContain(PAT);
  expect(output).not.toContain('jira.example.com');
  return { code, lines, output, serve };
}

const catalogEnv = async (catalog: unknown = FIXTURE_CATALOG) => ({
  JIRA_BASE_URL: BASE_URL,
  JIRA_PAT: PAT,
  JIRA_CATALOG_PATH: await temp.file('catalog.json', JSON.stringify(catalog)),
});

describe('main', () => {
  it('serves read-only by default and logs one ready line without URL or PAT', async () => {
    const { code, lines, serve } = await run(await catalogEnv());
    expect(code).toBe(0);
    expect(serve).toHaveBeenCalledOnce();
    expect(lines).toEqual([
      '[jira-api2-mcp] ready (read-only; Xray disabled; catalog: 1 operations from Jira 8.20.0, WADL fetched 2026-01-01T00:00:00.000Z)',
    ]);
    const [factory] = serve.mock.calls[0]!;
    expect(factory()).toBeDefined();
  });

  it('says when writes are enabled', async () => {
    const { lines } = await run({ ...(await catalogEnv()), JIRA_ALLOW_WRITES: 'true' });
    expect(lines.at(-1)).toContain('writes ENABLED');
  });

  it('exits with 1 and one clean line on an invalid configuration', async () => {
    const { code, lines, serve } = await run({ JIRA_BASE_URL: BASE_URL });
    expect(code).toBe(1);
    expect(lines).toEqual([
      expect.stringMatching(/^\[jira-api2-mcp\] Invalid configuration — JIRA_PAT/),
    ]);
    expect(serve).not.toHaveBeenCalled();
  });

  it('exits with 1 and explains a missing catalog', async () => {
    const dir = await temp.make();
    const { code, lines, serve } = await run({
      JIRA_BASE_URL: BASE_URL,
      JIRA_PAT: PAT,
      JIRA_CATALOG_PATH: `${dir}/absent.json`,
    });
    expect(code).toBe(1);
    expect(lines).toEqual([
      expect.stringMatching(/^\[jira-api2-mcp\] Operation catalog not found/),
    ]);
    expect(serve).not.toHaveBeenCalled();
  });

  it('warns about plain HTTP and about Xray enabled without Xray operations', async () => {
    const { code, lines } = await run({
      ...(await catalogEnv()),
      JIRA_BASE_URL: 'http://jira.example.com',
      JIRA_ALLOW_INSECURE_HTTP: 'true',
      JIRA_ENABLE_XRAY: 'true',
    });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^\[jira-api2-mcp\] WARNING: Plain HTTP/);
    expect(lines[1]).toMatch(
      /^\[jira-api2-mcp\] WARNING: JIRA_ENABLE_XRAY=true but the catalog has no Xray/,
    );
    expect(lines[2]).toContain('Xray enabled');
  });

  it('exits with 1 when the server cannot be built, before serving', async () => {
    const { code, lines, serve } = await run(await catalogEnv(), {
      createServer: () => {
        throw new Error('factory broken');
      },
    });
    expect(code).toBe(1);
    expect(lines).toEqual(['[jira-api2-mcp] factory broken']);
    expect(serve).not.toHaveBeenCalled();
  });

  it('logs transport errors with their stack, or their message', async () => {
    const { serve, lines } = await run(await catalogEnv());
    const { onerror } = serve.mock.calls[0]![1];
    const error = new Error('pipe closed');
    onerror(error);
    error.stack = undefined;
    onerror(error);
    expect(lines.at(-2)).toMatch(/^\[jira-api2-mcp\] Error: pipe closed\n\s+at /);
    expect(lines.at(-1)).toBe('[jira-api2-mcp] pipe closed');
  });

  it('reports non-Error failures as text', async () => {
    const { code, lines } = await run(await catalogEnv(), {
      createServer: () => {
        // oxlint-disable-next-line no-throw-literal -- the non-Error case is what is tested
        throw 'plain text';
      },
    });
    expect(code).toBe(1);
    expect(lines).toEqual(['[jira-api2-mcp] plain text']);
  });
});
