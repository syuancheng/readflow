import type { BlockMeta } from "./types";

export type Groupable = {
  idx: number;
  blockType?: string | null;
  blockMeta?: BlockMeta;
};

/**
 * 前端渲染前的分组：表格的每个 cell、列表的每个 item 在库里都是**独立一行**
 * （为了守住 paragraphId 锚点契约），渲染时才重新组装回 <table> / <ul>。
 *
 * 注意：这里是纯函数，服务端和客户端执行结果必须一致，否则 hydration 会炸。
 * 不能用 Intl.Segmenter，也不能依赖对象键的遍历顺序做随机化。
 */
export type Group<T> =
  | { type: "single"; items: [T]; endIdx: number }
  | { type: "list"; items: T[]; ordered: boolean; listId: string; endIdx: number }
  | { type: "table"; rows: T[][]; tableId: string; items: T[]; endIdx: number };

export function groupBlocks<T extends Groupable>(blocks: T[]): Group<T>[] {
  const out: Group<T>[] = [];
  let i = 0;

  while (i < blocks.length) {
    const cur = blocks[i];
    const kind = cur.blockType ?? "paragraph";

    if (kind === "table_cell") {
      const tableId = cur.blockMeta?.tableId ?? `t-${i}`;
      const cells: T[] = [];
      let j = i;
      while (
        j < blocks.length &&
        (blocks[j].blockType ?? "paragraph") === "table_cell" &&
        (blocks[j].blockMeta?.tableId ?? `t-${j}`) === tableId
      ) {
        cells.push(blocks[j]);
        j++;
      }

      const byRow = new Map<number, T[]>();
      let hasRow = false;
      for (const c of cells) {
        const r = c.blockMeta?.row;
        if (typeof r === "number") hasRow = true;
        const key = typeof r === "number" ? r : 0;
        const arr = byRow.get(key) ?? [];
        arr.push(c);
        byRow.set(key, arr);
      }

      let rows: T[][];
      if (hasRow) {
        rows = [...byRow.keys()]
          .sort((a, b) => a - b)
          .map((k) => (byRow.get(k) ?? []).sort((a, b) => (a.blockMeta?.col ?? 0) - (b.blockMeta?.col ?? 0)));
      } else {
        const size = Math.max(1, cur.blockMeta?.colCount ?? cells.length);
        rows = [];
        for (let k = 0; k < cells.length; k += size) rows.push(cells.slice(k, k + size));
      }

      out.push({
        type: "table",
        rows,
        tableId,
        items: cells,
        endIdx: cells[cells.length - 1].idx,
      });
      i = j;
      continue;
    }

    if (kind === "list_item") {
      const listId = cur.blockMeta?.listId ?? `l-${i}`;
      const items: T[] = [];
      let j = i;
      while (
        j < blocks.length &&
        (blocks[j].blockType ?? "paragraph") === "list_item" &&
        (blocks[j].blockMeta?.listId ?? `l-${j}`) === listId
      ) {
        items.push(blocks[j]);
        j++;
      }
      out.push({
        type: "list",
        items,
        ordered: cur.blockMeta?.ordered === true,
        listId,
        endIdx: items[items.length - 1].idx,
      });
      i = j;
      continue;
    }

    out.push({ type: "single", items: [cur], endIdx: cur.idx });
    i++;
  }

  return out;
}

/** 跳过前端渲染的块（agent-only 隐藏元数据）。 */
export function isSkipped(b: Groupable): boolean {
  return b.blockMeta?.skip === true;
}
