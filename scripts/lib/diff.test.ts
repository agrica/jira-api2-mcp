import { describe, expect, it } from 'vitest';
import type { Operation } from '../../src/catalog/types.ts';
import {
  describeDiff,
  describeIds,
  diffOperations,
  formatDiff,
  hasDrift,
  summarizeDiff,
} from './diff.ts';

const op = (id: string, summary = ''): Operation => {
  const [method, path] = id.split(' ') as [Operation['method'], string];
  return {
    id,
    api: 'api',
    method,
    path,
    summary,
    body: { accepted: false, mediaTypes: [] },
    params: [],
    access: 'read',
    accessReason: 'x',
  };
};

describe('diffOperations', () => {
  it('reports added, removed and changed operations', () => {
    const before = [op('GET /a'), op('GET /b', 'old'), op('GET /c')];
    const after = [op('GET /b', 'new'), op('GET /c'), op('GET /d')];
    const diff = diffOperations(before, after);
    expect(diff).toEqual({ added: ['GET /d'], removed: ['GET /a'], changed: ['GET /b'] });
    expect(hasDrift(diff)).toBe(true);
    expect(hasDrift(diffOperations(after, after))).toBe(false);
  });

  it('formats a readable markdown report', () => {
    const text = formatDiff(
      { added: ['GET /d'], removed: [], changed: ['GET /b'] },
      'Jira 8.20.0 → 8.20.1',
    );
    expect(text).toContain('## Jira 8.20.0 → 8.20.1');
    expect(text).toContain('Ajoutées (1)');
    expect(text).toContain('- `GET /d`');
    expect(text).toContain('Supprimées (0)');
    expect(formatDiff({ added: [], removed: [], changed: [] }, 'x')).toContain('Aucune différence');
  });

  it('prints counts only in CI, so that logs never list endpoints', () => {
    const diff = { added: ['GET /d'], removed: [], changed: ['GET /b'] };
    expect(summarizeDiff(diff, 'Δ')).toBe('Δ: +1 −0 ~1');
    expect(describeDiff(diff, 'Δ', { CI: 'true' })).toBe('Δ: +1 −0 ~1');
    expect(describeDiff(diff, 'Δ', {})).toContain('- `GET /d`');
  });

  it('lists ids outside CI and counts them in CI', () => {
    expect(describeIds(['GET /a', 'GET /b'], {})).toBe('GET /a, GET /b');
    expect(describeIds(['GET /a', 'GET /b'], { CI: 'true' })).toBe('2 operation(s)');
  });
});
