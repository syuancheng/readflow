/**
 * 阅读页的滚动容器（P44）。
 *
 * 宽屏（≥1024px）时，正文和右侧 AI 栏是并排的两个独立滚动区：正文滚动条在两栏之间，
 * AI 栏的滚动条在窗口最右边——和 ChatGPT / Claude 的布局一样。此时「正文在滚」的不是 window，
 * 而是 `.reader-main` 这个元素。窄屏（右栏堆到文章下面）仍然是整页滚动。
 * 读进度、目录高亮、目录跳转都要通过这里取滚动位置，才能在两种布局下都对。
 */

/** 正文自己是滚动容器时返回它，否则（整页滚动）返回 null */
export function readerScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLElement>(".reader-main");
  return el && getComputedStyle(el).overflowY === "auto" ? el : null;
}

export type ScrollMetrics = {
  scrollY: number;
  innerHeight: number;
  scrollHeight: number;
  /** 把元素的视口坐标换成「滚动区内容坐标」要减去的原点（整页滚动时为 0） */
  originTop: number;
};

export function readScrollMetrics(): ScrollMetrics {
  const sc = readerScroller();
  if (sc) {
    return {
      scrollY: sc.scrollTop,
      innerHeight: sc.clientHeight,
      scrollHeight: sc.scrollHeight,
      originTop: sc.getBoundingClientRect().top,
    };
  }
  return {
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    originTop: 0,
  };
}

/** 滚动到某个元素（顶部留出 offset 像素）；两种布局都适用 */
export function scrollElementIntoReading(el: Element, offset: number): void {
  const sc = readerScroller();
  const rect = el.getBoundingClientRect();
  if (sc) {
    sc.scrollTo({ top: Math.max(0, rect.top - sc.getBoundingClientRect().top + sc.scrollTop - offset), behavior: "smooth" });
  } else {
    window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - offset - 54), behavior: "smooth" });
  }
}
