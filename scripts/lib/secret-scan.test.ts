import { describe, expect, it } from 'vitest';
import { findSecrets } from './secret-scan.ts';

const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';

describe('findSecrets', () => {
  it('detects bearer tokens, authorization headers, PAT and password assignments', () => {
    expect(findSecrets(`curl -H "Author${'ization'}: Bear${'er'} ${token}"`)).toEqual(
      expect.arrayContaining(['Authorization header', 'Bearer token']),
    );
    expect(findSecrets(`JIRA_${'PAT'}=${token}`)).toEqual(['JIRA_PAT assignment']);
    expect(findSecrets(`"pass${'word'}": "hunter22"`)).toEqual(['password assignment']);
  });

  it('detects a known literal value anywhere', () => {
    expect(findSecrets(`blah ${token} blah`, [token])).toEqual(['known secret value']);
    expect(findSecrets('see https://JIRA.EXAMPLE.COM/x', ['jira.example.com'])).toEqual([
      'known secret value',
    ]);
  });

  it('ignores placeholders, env references and code templates', () => {
    for (const safe of [
      'JIRA_PAT=<votre-PAT>',
      '"JIRA_PAT": "${JIRA_PAT}"',
      'JIRA_PAT=...',
      'Authorization: `Bearer ${this.#pat}`',
      "headers.Authorization).toBe('Bearer secret-pat')",
      'JIRA_PAT: ${{ secrets.JIRA_READONLY_PAT }}',
    ]) {
      expect(findSecrets(safe)).toEqual([]);
    }
    expect(findSecrets('anything', ['  '])).toEqual([]);
  });
});
