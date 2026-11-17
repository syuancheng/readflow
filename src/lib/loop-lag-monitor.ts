/**
 * 事件循环卡顿日志的启动入口（P41）。用到 node:os，所以放在单独的模块里，
 * 由 src/instrumentation.ts 在确认是 Node.js 运行时之后再动态引入（Edge 运行时不能加载 node:os）。
 * 关掉：READFLOW_PERF=off；阈值：READFLOW_LAG_LOG_MS（默认 300ms）。
 */
import os from "node:os";
import { formatLagLine, lagMs } from "./loop-lag";

const INTERVAL_MS = 200;
const g = globalThis as unknown as { __rfLagTimer?: NodeJS.Timeout };

export function startLoopLagMonitor(): void {
  if (g.__rfLagTimer) return; // 进程内只启动一个，防开发模式热重载重复启动
  const threshold = Number(process.env.READFLOW_LAG_LOG_MS) || 300;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = lagMs(last, now, INTERVAL_MS);
    last = now;
    if (lag < threshold) return;
    const mem = process.memoryUsage();
    console.warn(
      formatLagLine({
        lag,
        rssMb: mem.rss / 1048576,
        heapUsedMb: mem.heapUsed / 1048576,
        freeMb: os.freemem() / 1048576,
        totalMb: os.totalmem() / 1048576,
        load1: os.loadavg()[0],
      }),
    );
  }, INTERVAL_MS);
  timer.unref?.();
  g.__rfLagTimer = timer;
}
