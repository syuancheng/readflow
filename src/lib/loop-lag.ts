/**
 * 事件循环卡顿检测（P41）。纯函数，没有任何 import，单测直接跑。
 *
 * Node 只有一个主线程；better-sqlite3 是同步的，任何一次慢查询 / 大 JSON / 换页 / GC
 * 都会让整个进程在这段时间里处理不了任何请求。浏览器这边看到的只是「请求一直在转」，
 * 服务端日志里却什么都没有——所以定时器每 intervalMs 醒一次，醒来比预期晚了多少，就是这段时间被占住了多久。
 */

/** 这次定时器比预期晚醒了多少毫秒（≥ 0） */
export function lagMs(prevTickAt: number, nowAt: number, intervalMs: number): number {
  return Math.max(0, nowAt - prevTickAt - intervalMs);
}

/** 一条日志：事件循环被占住多久，附上当时的内存和负载，方便判断是不是在换页 */
export function formatLagLine(info: {
  lag: number;
  rssMb: number;
  heapUsedMb: number;
  freeMb: number;
  totalMb: number;
  load1: number;
}): string {
  return (
    `[perf] 事件循环被占住 ${Math.round(info.lag)}ms；` +
    `进程内存 ${Math.round(info.rssMb)}MB（堆 ${Math.round(info.heapUsedMb)}MB），` +
    `系统可用 ${Math.round(info.freeMb)}/${Math.round(info.totalMb)}MB，1 分钟负载 ${info.load1.toFixed(2)}`
  );
}
