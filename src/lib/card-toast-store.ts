import { bgFetch } from "./bg-fetch";
import {
  addToast,
  createCardJobTracker,
  removeToast,
  type CardJob,
  type CardStateLite,
  type CardToast,
} from "./card-jobs";

/**
 * 做卡完成通知的全局状态（P43）：模块级单例，整个浏览器页面共用一份。
 * 客户端导航（读文章 → 词库）时模块不会重新加载，所以任务和通知都不会丢；
 * 整页刷新 / 关标签页才会清空（做卡本身在服务端后台继续，不受影响）。
 */
const EMPTY: readonly CardToast[] = [];
let toasts: readonly CardToast[] = EMPTY;
const listeners = new Set<() => void>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 通知停留多久后自动消失；用户看到了点「查看」或叉掉都会提前消失 */
const AUTO_DISMISS_MS = 20_000;

function emit(): void {
  for (const l of listeners) l();
}

export function dismissToast(id: string): void {
  const t = dismissTimers.get(id);
  if (t) clearTimeout(t);
  dismissTimers.delete(id);
  toasts = removeToast(toasts, id);
  emit();
}

function pushToast(toast: CardToast): void {
  toasts = addToast(toasts, toast);
  emit();
  const old = dismissTimers.get(toast.id);
  if (old) clearTimeout(old);
  dismissTimers.set(toast.id, setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS));
}

async function fetchState(contextId: string): Promise<CardStateLite | null> {
  // 后台请求：全站最多同时 2 个，不挤占点词 / AI 讲解要用的连接（P41）
  const res = await bgFetch(`/api/cards/state?contextId=${encodeURIComponent(contextId)}`);
  if (!res.ok) return null;
  return (await res.json()) as CardStateLite;
}

const tracker = createCardJobTracker({
  fetchState,
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  onToast: pushToast,
});

/** 开始做卡（或发现这个词正在做卡）时登记；做完 / 失败会自动弹通知。重复登记同一个词无副作用 */
export function trackCardJob(job: CardJob): void {
  tracker.track(job);
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): readonly CardToast[] {
  return toasts;
}

export function getServerToasts(): readonly CardToast[] {
  return EMPTY;
}
