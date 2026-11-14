/**
 * Next.js 服务启动钩子（node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md）：
 * register() 在每个服务实例启动时调用一次。P34：在这里启动「每晚整理老师笔记」的调度器。
 * 只在 Node.js 运行时、且不在构建阶段启动。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.READFLOW_NIGHTLY === "off") return;
  const { startNightlyScheduler } = await import("./lib/nightly-note");
  startNightlyScheduler();
}
