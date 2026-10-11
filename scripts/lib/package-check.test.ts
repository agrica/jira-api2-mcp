import { describe, expect, it } from 'vitest';
import { containsLiteral, sensitiveLiterals, unexpectedEntries } from './package-check.ts';

describe('unexpectedEntries', () => {
  it('accepts only the manifest, docs, dist and the generated catalog', () => {
    expect(
      unexpectedEntries([
        'package/package.json',
        'package/README.md',
        'package/dist/index.js',
        'package/dist/tools/generic.js.map',
        'package/catalog/catalog.json',
      ]),
    ).toEqual([]);
  });

  it('flags WADL, reports, env files and sources', () => {
    expect(
      unexpectedEntries([
        'package/catalog/wadl/api.wadl',
        'package/catalog/review.md',
        'package/.env',
        'package/src/index.ts',
      ]),
    ).toEqual([
      'package/catalog/wadl/api.wadl',
      'package/catalog/review.md',
      'package/.env',
      'package/src/index.ts',
    ]);
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

  it('returns the bare hostname too when the URL has a port, lower-cased', () => {
    expect(sensitiveLiterals({ JIRA_BASE_URL: 'https://Jira.Example.com:8443/jira' })).toEqual([
      'jira.example.com:8443',
      'jira.example.com',
    ]);
  });
});

describe('containsLiteral', () => {
  it('matches case-insensitively and ignores empty literals', () => {
    expect(containsLiteral('see JIRA.EXAMPLE.COM/x', ['jira.example.com'])).toBe(true);
    expect(containsLiteral('nothing here', ['jira.example.com', ''])).toBe(false);
  });
});
