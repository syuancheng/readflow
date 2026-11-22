/**
 * 做卡完成提醒的核心逻辑（P43）。纯函数 + 可注入依赖，没有任何 import，单测直接跑。
 *
 * 为什么要有：做卡在后台跑（可能要几十秒），用户不会一直守在右栏等。
 * 以前「已做成 N 张卡 · 查看」只出现在右栏那个按钮上——一切到别的词，按钮卸载、轮询停止，
 * 就再也没有任何提示。现在由页面级的跟踪器负责：开始做卡就登记一个任务，
 * 做完（或失败）弹一条通知，不管用户当时在看哪个词、哪一页。
 */

/** 登记一个做卡任务时需要知道的 */
export type CardJob = {
  contextId: string;
  /** 通知里显示的词 */
  word: string;
  /** 这次生成的那一组；有它就只认这一组的结果，不会被上一组遗留的「已完成」误触发 */
  setId?: string | null;
};

/** /api/cards/state 的返回里这里用到的字段 */
export type CardStateLite = {
  state: "none" | "generating" | "ready" | "failed" | "pushed";
  setId: string | null;
  count: number;
  error: string | null;
  wordId: string | null;
};

export type CardToast = {
  /** 同一个任务只会有一条通知 */
  id: string;
  kind: "ready" | "failed";
  word: string;
  count: number;
  /** ready 才有：在新标签页打开卡片的地址 */
  href: string | null;
  /** failed 才有：失败原因 */
  detail: string | null;
};

/** 「查看」打开的地址：待推送列表里定位到这个词（和右栏按钮里的「查看」是同一个） */
export function cardViewHref(wordId: string | null): string {
  return `/words?status=pending&word=${encodeURIComponent(wordId ?? "")}`;
}

/** 这个状态要不要弹通知：做完 / 失败才弹，还在跑或还没开始返回 null */
export function toastOf(job: CardJob, st: CardStateLite): CardToast | null {
  // 只认自己这一组：状态里的 setId 对不上，说明看到的是别的（更早或更晚的）一组
  if (job.setId && st.setId && st.setId !== job.setId) return null;
  if (st.state === "ready" || st.state === "pushed") {
    return { id: job.contextId, kind: "ready", word: job.word, count: st.count, href: cardViewHref(st.wordId), detail: null };
  }
  if (st.state === "failed") {
    return { id: job.contextId, kind: "failed", word: job.word, count: 0, href: null, detail: st.error };
  }
  return null;
}

export type JobTrackerDeps = {
  fetchState: (contextId: string) => Promise<CardStateLite | null>;
  /** 定时器：返回取消函数（测试里换成假的） */
  schedule: (fn: () => void, ms: number) => () => void;
  onToast: (toast: CardToast) => void;
  /** 每次查到最新状态（不论是否弹通知）都广播一下，右栏按钮订阅它，不用自己再开一路轮询 */
  onState?: (contextId: string, state: CardStateLite) => void;
  /** 多久查一次，默认 3 秒（比右栏按钮的 2 秒慢一点：它只是兜底，别多占连接） */
  pollMs?: number;
  /** 最多查几次，默认 110 次（约 5.5 分钟；服务端 5 分钟没结束会自己标失败） */
  maxPolls?: number;
};

export function createCardJobTracker(deps: JobTrackerDeps) {
  const pollMs = deps.pollMs ?? 3000;
  const maxPolls = deps.maxPolls ?? 110;
  const active = new Map<string, () => void>(); // contextId → 取消下一次轮询

  function track(job: CardJob): void {
    if (!job.contextId || active.has(job.contextId)) return; // 同一个词已经在跟踪了
    let polls = 0;
    const finish = () => {
      active.delete(job.contextId);
    };
    const step = async () => {
      polls++;
      let st: CardStateLite | null = null;
      try {
        st = await deps.fetchState(job.contextId);
      } catch {
        st = null; // 网络抖一下不算失败，下一轮再查
      }
      if (!active.has(job.contextId)) return; // 查的过程中被取消了
      if (st) {
        try {
          deps.onState?.(job.contextId, st);
        } catch {
          /* 订阅者出错不能打断跟踪 */
        }
      }
      const toast = st ? toastOf(job, st) : null;
      if (toast) {
        finish();
        deps.onToast(toast);
        return;
      }
      if (polls >= maxPolls) {
        finish();
        return;
      }
      active.set(job.contextId, deps.schedule(() => void step(), pollMs));
    };
    active.set(job.contextId, deps.schedule(() => void step(), pollMs));
  }

  return {
    track,
    isTracking: (contextId: string) => active.has(contextId),
    /** 全部停掉（卸载 / 测试收尾） */
    stopAll() {
      for (const cancel of active.values()) cancel();
      active.clear();
    },
  };
}

/** 同时最多显示几条通知，新的在最上面，超出的丢掉最旧的 */
export const MAX_TOASTS = 3;

export function addToast(list: readonly CardToast[], toast: CardToast): CardToast[] {
  return [toast, ...list.filter((t) => t.id !== toast.id)].slice(0, MAX_TOASTS);
}

export function removeToast(list: readonly CardToast[], id: string): CardToast[] {
  return list.filter((t) => t.id !== id);
}
