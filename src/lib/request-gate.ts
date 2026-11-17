/**
 * 请求闸门：服务器变慢时，别让「后台请求」把浏览器的连接占满。
 *
 * 背景（P41）：Chrome 对同一个 http:// 站点最多同时开 6 条 HTTP/1.1 连接（没有 HTTPS 就没有 HTTP/2）。
 * 阅读页每次点词会发 4～7 个请求，滚动时还有进度上报；服务器一慢（实测每个响应慢 6 秒），
 * 请求越攒越多，真正重要的「查词典」被排在后面，等待从 6 秒放大到 12～19 秒。
 * 这里做两件事：
 *   - createLimiter：后台请求最多同时 N 个，把剩下的连接留给查词典 / 收词 / AI 讲解；
 *   - createCoalescer：同类请求（进度上报、批注刷新）同一时刻只在途一个，之后最多补一次最新的。
 *
 * 纯逻辑，没有 DOM / fetch 依赖（bg-fetch.ts 才碰 fetch），单测直接跑。
 */

/** 并发上限：同时最多跑 max 个任务，其余按先进先出排队 */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task().then(resolve, reject).finally(release);
      };
      if (active < max) start();
      else waiting.push(start);
    });
}

/**
 * 合并并发调用：没有在跑就立刻跑；正在跑时，后来的调用合并成「跑完后再跑一次」，
 * 返回的 Promise 在「覆盖了这次调用的那一轮」结束时完成（调用方 await 之后拿到的是最新数据）。
 * run 里出错不会抛给调用方（后台刷新失败不该影响正文阅读），由 run 自己处理。
 */
export function createCoalescer(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const start = (): Promise<void> => {
    const p: Promise<void> = run()
      .catch(() => {})
      .then(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  };
  return () => {
    if (!inFlight) return start();
    if (!queued) {
      queued = inFlight.then(() => {
        queued = null;
        return start();
      });
    }
    return queued;
  };
}
