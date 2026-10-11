import { AsyncLocalStorage } from 'node:async_hooks';

/** Cancellation signal of the MCP request being handled (set by defineTool, read by JiraClient). */
const storage = new AsyncLocalStorage<AbortSignal | undefined>();

export function runWithCancellation<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(signal, fn);
}

export function currentCancellationSignal(): AbortSignal | undefined {
  return storage.getStore();
}
