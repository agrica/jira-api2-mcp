import { describe, expect, it } from 'vitest';
import { normalizeForSearch } from './normalize.ts';

describe('normalizeForSearch', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeForSearch("Lien d'Épopée")).toBe("lien d'epopee");
  });
});
