import type { Block, BlockKind, BlockMeta, InlineKind, InlineRange } from "./types";

/**
 * 把「结构化节点」摊平成一段可见纯文本，同时记录 inline 样式区间。
 *
 * 关键：start/end 记的是**摊平之后的文本**下标，不是源码坐标。
 * mdast 的 position.offset 指向 Markdown 源文件，`**bold**` 会占 8 个字符，
 * 但用户看见的只有 bold 4 个字符。锚点必须以后者为准，否则点词会错位。
 */
export class TextBuilder {
  private buf = "";
  private collected: InlineRange[] = [];

  get length(): number {
    return this.buf.length;
  }

  get value(): string {
    return this.buf;
  }

  add(s: string): void {
    if (s) this.buf += s;
  }

  /**
   * 执行 fn，把它追加出来的那段文字标成一个区间。空区间不记录。
   * display 只对 math 区间有意义：块级定界符（$$…$$ / \[…\]）来源的公式
   * 在整段提升时会用到，行内公式不传。
   */
  range(kind: InlineKind, fn: () => void, href?: string, display?: boolean): void {
    const start = this.buf.length;
    fn();
    const end = this.buf.length;
    if (end <= start) return;
    this.collected.push(
      href || display ? { start, end, kind, ...(href ? { href } : {}), ...(display ? { display } : {}) } : { start, end, kind },
    );
  }

  build(kind: BlockKind, meta: BlockMeta = {}): Block {
    return { kind, text: this.buf, ranges: this.collected, meta };
  }
}

export function makeBuilder(): TextBuilder {
  return new TextBuilder();
}
