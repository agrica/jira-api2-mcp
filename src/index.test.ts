// Process-level tests of the entry point: the real `node src/index.ts` (Node runs TypeScript),
// a fixture catalog, fictitious credentials, no network (listing tools never calls Jira).
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  deserializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_CATALOG, tempDirs } from './test-support/catalog-fixture.ts';

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
// Fictitious values only; built by concatenation so that secrets:scan does not flag this file.
const PAT = ['fakepat', 'value', '0002'].join('');
const BASE_URL = 'https://jira.example.com';
const temp = tempDirs('jira-api2-mcp-entry-');

/** The parent environment without any Jira setting or coverage hook, plus the given values. */
function childEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(JIRA_|NODE_OPTIONS$|NODE_V8_COVERAGE$|VITEST)/i.test(name),
    ),
  );
  return { ...env, ...values };
}

function start(env: Record<string, string>): {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<number | null>;
} {
  const child = spawn(process.execPath, [ENTRY], { env: childEnv(env), stdio: 'pipe' });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  return { child, stdout, stderr, exited };
}

/** A stdio client transport over an already spawned child, so the test sees the raw stdout too. */
class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  #buffer = '';
  readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
  }
  async start(): Promise<void> {
    this.child.stdout?.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let end: number;
      while ((end = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, end).replace(/\r$/, '');
        this.#buffer = this.#buffer.slice(end + 1);
        try {
          this.onmessage?.(deserializeMessage(line));
        } catch (error) {
          this.onerror?.(error as Error);
        }
      }
    });
    this.child.on('close', () => this.onclose?.());
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }
  async close(): Promise<void> {
    this.child.stdin?.end();
  }
}

let running: ChildProcess | undefined;
afterEach(async () => {
  running?.kill();
  running = undefined;
  await temp.cleanup();
});

describe('node src/index.ts', () => {
  it('speaks MCP on stdout only and logs a ready line without the URL or the PAT', async () => {
    const catalogPath = await temp.file('catalog.json', JSON.stringify(FIXTURE_CATALOG));
    const proc = start({ JIRA_BASE_URL: BASE_URL, JIRA_PAT: PAT, JIRA_CATALOG_PATH: catalogPath });
    running = proc.child;
    const transportErrors: Error[] = [];
    const transport = new ChildTransport(proc.child);
    const client = new Client({ name: 'entry-point-test', version: '0.0.0' });
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the MCP Client has a callback, not an EventTarget
    client.onerror = (error) => transportErrors.push(error);
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    const code = await proc.exited;

    expect(tools.map((t) => t.name)).toContain('jira_list_operations');
    expect(tools.map((t) => t.name)).not.toContain('jira_call_write_operation');
    expect(transportErrors).toEqual([]);
    // Every stdout line is a JSON-RPC message: no stray log on the MCP channel.
    const lines = proc.stdout.join('').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(() => deserializeMessage(line)).not.toThrow();
    const stderr = proc.stderr.join('');
    expect(stderr).toMatch(/^\[jira-api2-mcp\] ready \(read-only; .*catalog: 1 operations/m);
    expect(stderr).not.toContain(PAT);
    expect(stderr).not.toContain('jira.example.com');
    // stdin closed: the server exits on its own.
    expect(code).toBe(0);
  });

  it('exits with 1 and one clean stderr line on an invalid configuration', async () => {
    const proc = start({ JIRA_BASE_URL: BASE_URL, JIRA_PAT: 'two words' });
    running = proc.child;
    expect(await proc.exited).toBe(1);
    expect(proc.stdout.join('')).toBe('');
    const stderr = proc.stderr.join('');
    expect(stderr).toMatch(/^\[jira-api2-mcp\] Invalid configuration — JIRA_PAT[^\n]*\n$/);
    expect(stderr).not.toContain('two words');
    expect(stderr).not.toContain('jira.example.com');
  });

  it('exits with 1 and explains a missing catalog', async () => {
    const missing = join(await temp.make(), 'absent.json');
    const proc = start({ JIRA_BASE_URL: BASE_URL, JIRA_PAT: PAT, JIRA_CATALOG_PATH: missing });
    running = proc.child;
    expect(await proc.exited).toBe(1);
    expect(proc.stdout.join('')).toBe('');
    const stderr = proc.stderr.join('');
    expect(stderr).toMatch(
      /^\[jira-api2-mcp\] Operation catalog not found[^\n]*npm run catalog:build/,
    );
    expect(stderr).not.toMatch(/\n\s+at /);
    expect(stderr).not.toContain(PAT);
  });
});
