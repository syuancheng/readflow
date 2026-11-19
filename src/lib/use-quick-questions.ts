"use client";

import { useCallback, useState } from "react";

export type QuickQuestion = { id: string; text: string };

// 整个页面共用一份：读文章时多次打开菜单不用重复请求
let cache: QuickQuestion[] | null = null;

/**
 * 用户自己的常用问题（P44）。第一次打开「＋」菜单时才读取；加、删立刻生效，失败时返回原因。
 */
export function useQuickQuestions() {
  const [items, setItems] = useState<QuickQuestion[]>(cache ?? []);
  const [loading, setLoading] = useState(false);

  const set = (next: QuickQuestion[]) => {
    cache = next;
    setItems(next);
  };

  const load = useCallback(async () => {
    if (cache) {
      setItems(cache);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/quick-questions");
      if (res.ok) {
        const data = (await res.json()) as { items?: QuickQuestion[] };
        cache = data.items ?? [];
        setItems(cache);
      }
    } catch {
      /* 读不到就先当没有，不影响提问 */
    } finally {
      setLoading(false);
    }
  }, []);

  /** 返回 null 表示成功，否则是失败原因 */
  async function add(text: string): Promise<string | null> {
    try {
      const res = await fetch("/api/quick-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json().catch(() => null)) as { item?: QuickQuestion; error?: string } | null;
      if (!res.ok || !data?.item) return data?.error ?? "没存上，稍后再试";
      set([...(cache ?? items), data.item]);
      return null;
    } catch {
      return "网络不通，稍后再试";
    }
  }

  async function remove(id: string): Promise<void> {
    const before = cache ?? items;
    set(before.filter((q) => q.id !== id)); // 先从界面拿掉
    try {
      const res = await fetch(`/api/quick-questions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) set(before); // 没删成就放回来
    } catch {
      set(before);
    }
  }

  return { items, loading, load, add, remove };
}
