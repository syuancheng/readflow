/**
 * Next.js 服务启动钩子（node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md）：
 * register() 在每个服务实例启动时调用一次。只在 Node.js 运行时、且不在构建阶段启动。
 *
 * - P41：先把词典打开（必要时补建索引），再启动「事件循环卡顿」日志；
 * - P34：启动「每晚整理老师笔记」的调度器。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // 词典第一次打开时可能要补建索引（线上老库没有）：放在启动阶段做，不要拖慢第一个用户的点词
  try {
    const { warmDict } = await import("./lib/dict");
    const { nocaseIndex } = warmDict();
    console.log(`[dict] 词典就绪，大小写不敏感索引：${nocaseIndex ? "有" : "没有（改用精确匹配查词）"}`);
  } catch (err) {
    // 本机还没导入词典时不影响启动；点词会报「词典库不存在」
    console.warn("[dict] 启动时没能打开词典：", (err as Error).message);
  }

  if (process.env.READFLOW_PERF !== "off") {
    const { startLoopLagMonitor } = await import("./lib/loop-lag-monitor");
    startLoopLagMonitor();
  }

  if (process.env.READFLOW_NIGHTLY === "off") return;
  const { startNightlyScheduler } = await import("./lib/nightly-note");
  startNightlyScheduler();
}
