import { describe, expect, it } from 'vitest';
import { FIXTURE_CATALOG } from '../../src/test-support/catalog-fixture.ts';
import {
  containsLiteral,
  missingEntries,
  packageProblems,
  sensitiveLiterals,
  unexpectedEntries,
} from './package-check.ts';

const REQUIRED = [
  'package/package.json',
  'package/README.md',
  'package/dist/index.js',
  'package/dist/catalog/load.js',
  'package/catalog/catalog.json',
];

describe('unexpectedEntries', () => {
  it('accepts only the manifest, docs, licence, dist and the generated catalog', () => {
    expect(
      unexpectedEntries([
        ...REQUIRED,
        'package/LICENSE',
        'package/LICENSE.md',
        'package/dist/tools/generic.js.map',
        'package/dist/tools/generic.d.ts',
      ]),
    ).toEqual([]);
  });

  it('flags WADL, reports, env files, sources and look-alikes of allowed files', () => {
    const flagged = [
      'package/catalog/wadl/api.wadl',
      'package/catalog/review.md',
      'package/catalog/lock-baseline.json',
      'package/.env',
      'package/src/index.ts',
      'package/LICENSE.d/x',
      'package/LICENSE-extra.txt',
      'package/dist/index.ts',
      'package/dist/notes.md',
      'package/README.md.bak',
      'other/package.json',
    ];
    expect(unexpectedEntries(flagged)).toEqual(flagged);
  });
});

describe('missingEntries', () => {
  it('requires the manifest, README, entry point, catalog loader and catalog', () => {
    expect(missingEntries(REQUIRED)).toEqual([]);
    expect(missingEntries([])).toEqual(REQUIRED);
    expect(missingEntries(REQUIRED.filter((e) => e !== 'package/catalog/catalog.json'))).toEqual([
      'package/catalog/catalog.json',
    ]);
  });

  it('does not require the catalog for a local pack (--no-catalog)', () => {
    const local = REQUIRED.filter((e) => e !== 'package/catalog/catalog.json');
    expect(missingEntries(local, { catalog: false })).toEqual([]);
    expect(missingEntries(['package/package.json'], { catalog: false })).toEqual([
      'package/README.md',
      'package/dist/index.js',
      'package/dist/catalog/load.js',
    ]);
  });
});

const files = (overrides: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    'package/package.json': '{"name":"jira-api2-mcp"}',
    'package/README.md': '# jira-api2-mcp',
    'package/dist/index.js': '#!/usr/bin/env node\nimport "./server.js";\n',
    'package/dist/catalog/load.js': 'export {};',
    'package/catalog/catalog.json': JSON.stringify(FIXTURE_CATALOG),
  };
  return Object.entries({ ...base, ...overrides }).map(([path, text]) => ({ path, text }));
};

/** The problems of an otherwise clean package shipping this catalog text. */
const problem = (text: string) =>
  packageProblems(files({ 'package/catalog/catalog.json': text }), {
    catalog: true,
    literals: [],
  });

describe('packageProblems', () => {
  it('accepts a complete, clean package', () => {
    expect(packageProblems(files(), { catalog: true, literals: [] })).toEqual([]);
  });

  it('reports missing, unexpected and unreadable entries', () => {
    const list = files({ 'package/.env': 'X=1', 'package/README.md': undefined });
    const withoutCatalog = list.filter((f) => f.path !== 'package/catalog/catalog.json');
    expect(packageProblems(withoutCatalog, { catalog: true, literals: [] })).toEqual([
      'missing file: package/catalog/catalog.json',
      'unexpected file: package/.env',
      'package/README.md: unreadable',
    ]);
  });

  it('rejects a catalog the server would refuse at startup', () => {
    expect(problem('{oops')).toEqual(['package/catalog/catalog.json: not valid JSON']);
    expect(problem('{}')).toEqual([
      expect.stringMatching(/^package\/catalog\/catalog\.json is invalid: meta: /),
    ]);
  });

  it('requires the node shebang on the entry point', () => {
    expect(
      packageProblems(files({ 'package/dist/index.js': 'import "./server.js";\n' }), {
        catalog: true,
        literals: [],
      }),
    ).toEqual(['package/dist/index.js: missing the "#!/usr/bin/env node" shebang']);
  });

  it('names secret findings without printing the values', () => {
    const host = 'jira.example.com';
    const problems = packageProblems(
      files({ 'package/dist/catalog/load.js': `const u = "https://${host.toUpperCase()}/";` }),
      { catalog: true, literals: [host] },
    );
    expect(problems).toEqual(['package/dist/catalog/load.js: sensitive environment value']);
    expect(problems.join('\n')).not.toContain(host);
  });
});

describe('sensitiveLiterals', () => {
  it('returns the PAT and the instance host, ignoring missing values', () => {
    // Built by concatenation so that secrets:scan does not flag this test file.
    const pat = ['abcdefgh', '12345678'].join('');
    expect(
      sensitiveLiterals({ JIRA_PAT: pat, JIRA_BASE_URL: 'https://jira.example.com/' }),
    ).toEqual([pat, 'jira.example.com']);
    expect(sensitiveLiterals({})).toEqual([]);
    expect(sensitiveLiterals({ JIRA_BASE_URL: 'not a url' })).toEqual([]);
  });

  it('trims the PAT and ignores single-label hosts (they would match ordinary words)', () => {
    const pat = ['abcdefgh', '12345678'].join('');
    expect(sensitiveLiterals({ JIRA_PAT: `  ${pat}\n` })).toEqual([pat]);
    expect(sensitiveLiterals({ JIRA_BASE_URL: 'https://jira/' })).toEqual([]);
    expect(sensitiveLiterals({ JIRA_BASE_URL: 'https://jira:8443/' })).toEqual(['jira:8443']);
    expect(
      containsLiteral(
        'Jira and jira-api2-mcp',
        sensitiveLiterals({ JIRA_BASE_URL: 'https://jira' }),
      ),
    ).toBe(false);
  });

  it('returns the bare hostname too when the URL has a port, lower-cased', () => {
    expect(sensitiveLiterals({ JIRA_BASE_URL: 'https://Jira.Example.com:8443/jira' })).toEqual([
      'jira.example.com:8443',
      'jira.example.com',
    ]);
  });
});

describe('containsLiteral', () => {
  it('matches on label boundaries only', () => {
    expect(containsLiteral('host: jira.example.com.', ['jira.example.com'])).toBe(true);
    expect(containsLiteral('x.jira.example.com', ['jira.example.com'])).toBe(false);
    expect(containsLiteral('jira.example.community', ['jira.example.com'])).toBe(false);
    expect(containsLiteral('my-jira.example.com', ['jira.example.com'])).toBe(false);
  });

  it('matches case-insensitively and ignores empty literals', () => {
    expect(containsLiteral('see JIRA.EXAMPLE.COM/x', ['jira.example.com'])).toBe(true);
    expect(containsLiteral('nothing here', ['jira.example.com', ''])).toBe(false);
  });
});
