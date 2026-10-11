import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE,
  READ,
  WRITE,
  WRITE_IDEMPOTENT,
  errorResult,
  issueKeySchema,
  jsonResult,
  projectKeySchema,
  truncate,
} from './shared.ts';

describe('result helpers', () => {
  it('serialises data as compact JSON text, plain text as is, empty answers explicitly', () => {
    expect(jsonResult({ key: 'DEMO-1' }, 1000)).toEqual({
      content: [{ type: 'text', text: '{"key":"DEMO-1"}' }],
    });
    expect(jsonResult('<xml/>', 1000).content[0]).toEqual({ type: 'text', text: '<xml/>' });
    expect(jsonResult(null, 1000).content[0]).toEqual({ type: 'text', text: 'OK (no content)' });
  });

  it('marks output truncated for the model', () => {
    const text = truncate('a'.repeat(150), 100);
    expect(text.startsWith('a'.repeat(100))).toBe(true);
    expect(text).toContain('[output truncated for the model: 50 more characters');
    expect(truncate('short', 100)).toBe('short');
  });

  it('wraps errors as tool errors', () => {
    expect(errorResult(new Error('boom'))).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    });
    expect(errorResult('raw')).toEqual({ isError: true, content: [{ type: 'text', text: 'raw' }] });
  });

  it('never splits a surrogate pair when truncating', () => {
    const text = truncate('a😀b', 2);
    expect(text.startsWith('a\n')).toBe(true);
    expect(text.isWellFormed()).toBe(true);
    expect(text).toContain('3 more characters');
  });

  it('bounds error text like any other output', () => {
    const text = errorResult(new Error('e'.repeat(50)), 10).content[0];
    expect(text).toMatchObject({ type: 'text' });
    expect((text as { text: string }).text).toMatch(/^e{10}\n… \[output truncated/);
  });
});

describe('annotations', () => {
  it('are consistent with the write policy', () => {
    expect(READ).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(WRITE).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(WRITE_IDEMPOTENT).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(DESTRUCTIVE).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('key schemas', () => {
  it('accepts issue keys and ids, normalises case, rejects anything else', () => {
    expect(issueKeySchema.parse(' demo-123 ')).toBe('DEMO-123');
    expect(issueKeySchema.parse('142169')).toBe('142169');
    for (const bad of ['../DEMO-1', 'DEMO-1/comment', 'DEMO', '']) {
      expect(issueKeySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('accepts project keys only', () => {
    expect(projectKeySchema.parse('demo')).toBe('DEMO');
    expect(projectKeySchema.safeParse('DEMO/../x').success).toBe(false);
  });
});
