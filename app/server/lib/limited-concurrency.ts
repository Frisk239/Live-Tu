/**
 * S3 受限并发工具（深模块）
 *
 * 同轮独立镜头允许受限并发（默认 2）：Promise.allSettled 语义——
 * 单镜失败/超时不拖垮其他镜头，每个元素独立超时与错误收集。
 * 注意：并发 ≠ 重复提交——调用方必须保证同一付费目标只会出现在 items 中一次
 * （付费防重在业务层由原子 claim 保证）。
 */

export interface ConcurrencyItemResult<T> {
  index: number;
  status: 'fulfilled' | 'rejected';
  value?: T;
  reason?: unknown;
  /** 单元素超时（ms）时置 true */
  timedOut?: boolean;
}

export interface MapWithConcurrencyOptions {
  /** 每个元素独立超时（ms），默认 0 = 不设超时 */
  timeoutMs?: number;
}

/**
 * 以受限并发执行异步任务，返回 allSettled 结果。
 * - limit 个 worker 同时运行；每个元素独立超时与错误；
 * - 结果按输入顺序返回（index 稳定）；
 * - 任何单个元素失败都不会中断其他元素。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {}
): Promise<ConcurrencyItemResult<R>[]> {
  const concurrency = Math.max(1, Math.floor(limit) || 1);
  const results: ConcurrencyItemResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const run = fn(items[index], index);
      const timedPromise =
        options.timeoutMs && options.timeoutMs > 0
          ? new Promise<never>((_, reject) => {
              const timer = setTimeout(() => {
                const err = new Error(`执行超时（${options.timeoutMs}ms）`);
                (err as any).timedOut = true;
                reject(err);
              }, options.timeoutMs);
              (run as any).__timer = timer;
            })
          : null;
      try {
        const value = timedPromise
          ? await Promise.race([run, timedPromise])
          : await run;
        if (timedPromise) clearTimeout((run as any).__timer);
        results[index] = { index, status: 'fulfilled', value };
      } catch (reason: any) {
        if (timedPromise) clearTimeout((run as any).__timer);
        results[index] = {
          index,
          status: 'rejected',
          reason,
          timedOut: Boolean(reason?.timedOut),
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
