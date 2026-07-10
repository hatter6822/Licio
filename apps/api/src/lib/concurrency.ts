// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A dependency-free bounded-concurrency mapper for I/O fan-out (LLM calls,
// store sweeps). At most `limit` tasks run at once; results come back
// ORDER-PRESERVING as settled outcomes, so a caller can isolate per-item
// failures (the poison-item philosophy the schedulers already follow) instead
// of letting one rejection abort a whole batch the way Promise.all does.

export type BoundedResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Map `items` through an async `task` with at most `limit` in flight. Every
 * item settles (a rejection becomes `{ok:false}` at its index); the returned
 * array preserves input order. `limit` < 1 is treated as 1.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<BoundedResult<R>[]> {
  const results: BoundedResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { ok: true, value: await task(item, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
