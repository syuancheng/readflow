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

/**
 * 通知停留 20 秒后自动消失，但只在用户看得见这个页面时才计时：
 * 用户切去别的标签页、做卡在后台做完时，通知要等他回来再开始倒计时，不然回来什么都没有。
 */
function armDismiss(id: string): void {
  const old = dismissTimers.get(id);
  if (old) clearTimeout(old);
  const start = () => {
    dismissTimers.set(
      id,
      setTimeout(() => dismissToast(id), AUTO_DISMISS_MS),
    );
  };
  if (typeof document !== "undefined" && document.hidden) {
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisible);
      if (toasts.some((t) => t.id === id)) start();
    };
    document.addEventListener("visibilitychange", onVisible);
    return;
  }
  start();
}

function pushToast(toast: CardToast): void {
  toasts = addToast(toasts, toast);
  forget(toast.id);
  emit();
  armDismiss(toast.id);
}

/**
 * 正在跟踪的做卡任务存在 localStorage 里：用户刷新页面、点链接整页跳转、或在新标签页里打开别的页面时，
 * 跟踪器会丢，做完就没有任何提示。这里记下来，页面一加载就接着跟踪（超过 10 分钟的不再接）。
 */
const JOBS_KEY = "rf-card-jobs";
const JOB_TTL_MS = 10 * 60 * 1000;
type Saved = CardJob & { at: number };

function readSaved(): Saved[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(JOBS_KEY);
    const list = raw ? (JSON.parse(raw) as Saved[]) : [];
    return Array.isArray(list) ? list.filter((j) => j && j.contextId && Date.now() - j.at < JOB_TTL_MS) : [];
  } catch {
    return [];
  }
}
function writeSaved(list: Saved[]): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(JOBS_KEY, JSON.stringify(list));
  } catch {
    /* 存不了（隐私模式等）就只在本页内跟踪 */
  }
}
function remember(job: CardJob): void {
  const list = readSaved().filter((j) => j.contextId !== job.contextId);
  writeSaved([...list, { ...job, at: Date.now() }]);
}
function forget(contextId: string): void {
  writeSaved(readSaved().filter((j) => j.contextId !== contextId));
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
  if (!tracker.isTracking(job.contextId)) remember(job);
  tracker.track(job);
}

// 页面加载时接着跟踪上次没做完的任务（只在浏览器里；重复登记同一个词无副作用）
if (typeof window !== "undefined") {
  for (const j of readSaved()) tracker.track({ contextId: j.contextId, word: j.word, setId: j.setId });
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
