import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { loadCatalogFile } from '../src/catalog/load.ts';
import { runScript } from './lib/run-script.ts';

// Forwarded to the server when set, so the smoke test works behind a proxy or a private CA.
const FORWARDED_ENV = [
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
];

// Parse failures never print the raw text or the parser message.
const parse = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

await runScript(async () => {
  const baseUrl = process.env.JIRA_BASE_URL;
  const pat = process.env.JIRA_PAT;
  const project = process.env.SMOKE_PROJECT;
  if (!baseUrl || !pat || !project) {
    console.error('JIRA_BASE_URL, JIRA_PAT and SMOKE_PROJECT are required');
    process.exitCode = 1;
    return;
  }
  const catalogPath = process.env.JIRA_CATALOG_PATH;
  const { meta } = await loadCatalogFile(catalogPath);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--use-system-ca', 'dist/index.js'],
    // JIRA_ALLOW_WRITES is forced to false: the smoke test must never write.
    env: {
      ...getDefaultEnvironment(),
      ...Object.fromEntries(
        FORWARDED_ENV.flatMap((name) => {
          const value = process.env[name];
          return value ? [[name, value]] : [];
        }),
      ),
      JIRA_BASE_URL: baseUrl,
      JIRA_PAT: pat,
      JIRA_ALLOW_WRITES: 'false',
      ...(catalogPath ? { JIRA_CATALOG_PATH: catalogPath } : {}),
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'jira-mcp-smoke', version: '0.0.0' });
  await client.connect(transport);
  try {
    const WRITE_TOOLS = [
      'jira_create_issue',
      'jira_update_issue',
      'jira_transition_issue',
      'jira_add_comment',
      'jira_assign_issue',
      'jira_add_worklog',
      'jira_link_issues',
      'jira_add_attachment',
      'jira_delete_issue',
      'jira_move_issues_to_sprint',
      'jira_call_write_operation',
    ];
    let failures = 0;
    // Output carries labels, versions and counts only: never the instance URL, the PAT or issue content.
    const check = (label: string, ok: boolean, detail = '') => {
      console.error(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
      if (!ok) failures++;
    };
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const first = result.content[0];
      return { isError: result.isError === true, text: first?.type === 'text' ? first.text : '' };
    };

    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    check(
      'no write tool exposed',
      WRITE_TOOLS.every((n) => !names.has(n)),
    );
    check(
      'every tool annotated readOnlyHint',
      tools.every((t) => t.annotations?.readOnlyHint === true),
    );

    const info = await call('jira_get_server_info');
    const infoBody = info.isError ? undefined : parse<{ version?: string }>(info.text);
    const version = infoBody?.version;
    check(
      'jira_get_server_info',
      version !== undefined,
      info.isError || infoBody === undefined ? 'unparseable response' : `Jira ${version}`,
    );
    check(
      'Jira version matches the catalog',
      version === meta.jiraVersion,
      `catalog ${meta.jiraVersion} (WADL ${meta.fetchedAt})`,
    );

    check('jira_get_current_user (valid PAT)', !(await call('jira_get_current_user')).isError);

    const search = await call('jira_search_issues', {
      jql: `project = ${project} ORDER BY created DESC`,
      maxResults: 1,
      fields: ['summary'],
    });
    const total = search.isError ? undefined : parse<{ total?: unknown }>(search.text)?.total;
    check(
      'jira_search_issues on SMOKE_PROJECT',
      typeof total === 'number',
      search.isError
        ? 'error (details withheld from logs)'
        : typeof total === 'number'
          ? `total=${total}`
          : 'unparseable response',
    );

    check(
      'jira_call_read_operation (GET)',
      !(await call('jira_call_read_operation', { operationId: 'GET /rest/api/2/serverInfo' }))
        .isError,
    );

    const blocked = await call('jira_call_read_operation', {
      operationId: 'POST /rest/api/2/issue',
      body: { fields: {} },
    });
    check(
      'write refused by the read caller',
      blocked.isError && blocked.text.includes('classified "write"'),
    );

    console.error(failures === 0 ? '✔ smoke test passed' : `✖ ${failures} check(s) failed`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await client.close();
  }
});
// The exit code is set above; exit explicitly so that no leftover handle keeps the process alive.
process.exit();
