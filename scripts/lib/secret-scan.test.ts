import { describe, expect, it } from 'vitest';
import { findSecrets, scanFiles } from './secret-scan.ts';

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

const errno = (code: string) => Object.assign(new Error(code), { code });

const read = async (file: string): Promise<string> => {
  if (file === 'deleted.ts') throw errno('ENOENT');
  if (file === 'locked.ts') throw errno('EACCES');
  return file === 'leak.env' ? `JIRA_${'PAT'}=${token}` : 'clean';
};

describe('scanFiles', () => {
  it('reports findings, fails closed on unreadable files and lists deleted ones', async () => {
    expect(await scanFiles(['a.ts', 'leak.env', 'deleted.ts', 'locked.ts'], read, [])).toEqual({
      scanned: 2,
      findings: [
        { file: 'leak.env', problem: 'JIRA_PAT assignment' },
        { file: 'locked.ts', problem: 'unreadable (EACCES)' },
      ],
      skipped: ['deleted.ts'],
    });
  });

  it('passes the known literals to the search', async () => {
    const result = await scanFiles(['a.ts'], async () => 'see jira.example.com', [
      'jira.example.com',
    ]);
    expect(result.findings).toEqual([{ file: 'a.ts', problem: 'known secret value' }]);
  });
});
