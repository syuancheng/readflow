/**
 * 前台讲解优先闸门（进程内）。纯逻辑，没有任何 import，单测直接跑。
 *
 * 为什么要有：做卡在后台会连续调好几次模型（出题 / 重出 / 选择题复核…），
 * 用户这时点下一个词，前台的讲解流和后台这些调用共用同一个 Key，上游会排队 / 限流，
 * 表现就是「建卡之后查词变慢」。
 *
 * 做法：前台讲解开始时 enterForeground()，结束 / 取消时调用返回的 release；
 * 后台每次调模型之前 await waitForForegroundIdle()——前台没有讲解就立刻放行，
 * 有就等到全部结束（最多等 maxWaitMs，到点照常往下跑，不会把建卡永远挂住）。
 * 不会打断已经发出去的调用，只是不在它旁边再叠新的。
 *
 * 只在单进程内有效（本项目是单进程 + SQLite）；多实例部署时要换成共享计数。
 */

/** 后台最多让路多久：前台一直在讲 / 计数泄漏时，后台也不能无限等 */
export const FOREGROUND_MAX_WAIT_MS = 15_000;
/** 一次前台讲解最长占多久：release 万一没被调到（异常路径），到点自动归还 */
export const FOREGROUND_TTL_MS = 120_000;

let active = 0;
let waiters: (() => void)[] = [];

function flush(): void {
  const list = waiters;
  waiters = [];
  for (const w of list) w();
}

/** 前台开始一次讲解。返回 release（幂等）；忘了调也会在 ttlMs 后自动归还 */
export function enterForeground(ttlMs: number = FOREGROUND_TTL_MS): () => void {
  active++;
  let released = false;
  const timer = setTimeout(() => release(), Math.max(1, ttlMs));
  timer.unref?.();
  function release(): void {
    if (released) return;
    released = true;
    clearTimeout(timer);
    active = Math.max(0, active - 1);
    if (active === 0) flush();
  }
  return release;
}

/** 当前有几个前台讲解在进行（测试 / 日志用） */
export function foregroundActive(): number {
  return active;
}

/** 后台调模型前等一下：前台空闲立刻返回；否则等到空闲或 maxWaitMs 到点，两种情况都 resolve */
export function waitForForegroundIdle(maxWaitMs: number = FOREGROUND_MAX_WAIT_MS): Promise<void> {
  if (active === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, maxWaitMs));
    timer.unref?.();
    waiters.push(done);
  });
}
