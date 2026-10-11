import { describe, expect, it } from 'vitest';
import { currentCancellationSignal, runWithCancellation } from './cancellation.ts';

describe('runWithCancellation', () => {
  it('exposes the signal inside the callback only, across awaits', async () => {
    const controller = new AbortController();
    expect(currentCancellationSignal()).toBeUndefined();
    await runWithCancellation(controller.signal, async () => {
      await Promise.resolve();
      expect(currentCancellationSignal()).toBe(controller.signal);
    });
    expect(currentCancellationSignal()).toBeUndefined();
  });
});
