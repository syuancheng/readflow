/**
 * 阅读进度的纯计算（P18）。
 *
 * 进度＝滚动条位置，不是「最远读到的块」：往回翻会下降，滚到底＝1。
 * 旧版把「DOM 里全部 [data-idx] 的最大 idx」当成已读位置，打开页面就写 100%，
 * 再叠加服务端单调合并，错误值永远降不回来 —— 这个模块存在的意义就是不再那样算。
 *
 * 与「是否已读完」完全解耦：100% 只表示位置，不代表用户认定读完了。
 */
export type ScrollMetrics = {
  scrollY: number;
  innerHeight: number;
  scrollHeight: number;
};

/** 底部容差：缩放 / 滚动条 / 亚像素下，到底时 scrollY+innerHeight 常差几个 px */
const BOTTOM_EPS = 8;

/** 0–1 的实时滚动进度；内容不足一屏（没有可滚动区）视为 1 */
export function scrollProgress(m: ScrollMetrics): number {
  const { scrollY, innerHeight, scrollHeight } = m;
  if (
    !Number.isFinite(scrollY) ||
    !Number.isFinite(innerHeight) ||
    !Number.isFinite(scrollHeight) ||
    innerHeight <= 0
  ) {
    return 0;
  }

  const scrollable = scrollHeight - innerHeight;
  if (scrollable <= BOTTOM_EPS) return 1; // 一屏就能看完
  if (scrollY <= 0) return 0;
  if (scrollY + innerHeight >= scrollHeight - BOTTOM_EPS) return 1;

  return Math.max(0, Math.min(1, scrollY / scrollable));
}

/** 文档坐标下的块位置，用于算续读书签 */
export type BlockPosition = { idx: number; top: number };

/**
 * 「读到线」之上的最后一个块 idx。readLine 是视口某一深度对应的文档坐标。
 * 返回 -1 表示还没读到任何块 —— 调用方此时不要上报 readIdx（接口要求 ≥0）。
 */
export function currentBlockIdx(blocks: readonly BlockPosition[], readLine: number): number {
  let idx = -1;
  for (const b of blocks) {
    if (Number.isInteger(b.idx) && b.top <= readLine && b.idx > idx) idx = b.idx;
  }
  return idx;
}

/**
 * 打开文章时是否按 read_idx 自动续读。
 *
 * 关键是不接受「文末书签」：滚到底会把 read_idx 记成最后一块，若照它定位，
 * 每次打开都直接跳到文末 → 进度一上来就是 100% → 又写回 100%，用户被锁在
 * 100% 且再也无法从头读（P18 实测到的自锁，用户体感就是「比例永远不变」）。
 */
export function shouldAutoResume(input: {
  completedAt: number | null;
  readIdx: number | null;
  readRatio: number | null;
  maxIdx: number;
}): boolean {
  if (input.completedAt !== null) return false; // 已读完：从头回味
  if (input.readIdx === null || input.readIdx < 0) return false; // 没读过
  if (input.readIdx >= input.maxIdx) return false; // 文末书签没有续读价值
  if ((input.readRatio ?? 0) >= 0.999) return false; // 进度已到底，别把人锁在 100%
  return true;
}
