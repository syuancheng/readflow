import type { ReactNode } from "react";

// ====== 轻量 Markdown 渲染（AI 释义用，Reader 批注卡与词库页共用）======
// 只覆盖 AI 输出常用语法：# 标题 / **加粗** / *斜体* / `行内代码` / 列表 / 引用。
// 解析为 React 元素而非 dangerouslySetInnerHTML，天然免疫 XSS。
// 流式输出时每帧整体重解析，AI 释义篇幅短，无性能问题。

function renderMdInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const t = m[0];
    const key = `md-${i++}`;
    if (t.startsWith("**")) nodes.push(<strong key={key} className="font-bold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) nodes.push(<code key={key} className="rf-md-code">{t.slice(1, -1)}</code>);
    else nodes.push(<em key={key}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export default function MarkdownText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] | null = null;

  const flush = () => {
    if (list) {
      const items = list.items;
      const ordered = list.ordered;
      blocks.push(
        ordered ? (
          <ol key={`b-${blocks.length}`} className="rf-md-list rf-md-ol">
            {items.map((it, i) => (
              <li key={i}>{renderMdInline(it)}</li>
            ))}
          </ol>
        ) : (
          <ul key={`b-${blocks.length}`} className="rf-md-list rf-md-ul">
            {items.map((it, i) => (
              <li key={i}>{renderMdInline(it)}</li>
            ))}
          </ul>
        ),
      );
      list = null;
    }
    if (quote) {
      const qs = quote;
      blocks.push(
        <blockquote key={`b-${blocks.length}`} className="rf-md-quote">
          {qs.map((q, i) => (
            <p key={i}>{renderMdInline(q)}</p>
          ))}
        </blockquote>,
      );
      quote = null;
    }
  };

  for (const raw of text.split("\n")) {
    const t = raw.trim();
    const h = t.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      flush();
      blocks.push(
        <p key={`b-${blocks.length}`} className="rf-md-h">
          {renderMdInline(h[1])}
        </p>,
      );
    } else if (/^[-*]\s+/.test(t)) {
      if (quote) flush();
      if (!list || list.ordered) {
        flush();
        list = { ordered: false, items: [] };
      }
      list.items.push(t.replace(/^[-*]\s+/, ""));
    } else if (/^\d+[.、)]\s*/.test(t)) {
      if (quote) flush();
      if (!list || !list.ordered) {
        flush();
        list = { ordered: true, items: [] };
      }
      list.items.push(t.replace(/^\d+[.、)]\s*/, ""));
    } else if (t.startsWith(">")) {
      if (list) flush();
      if (!quote) quote = [];
      quote.push(t.replace(/^>\s?/, ""));
    } else if (!t) {
      flush();
    } else {
      flush();
      blocks.push(
        <p key={`b-${blocks.length}`} className="rf-md-p">
          {renderMdInline(t)}
        </p>,
      );
    }
  }
  flush();

  return <>{blocks}</>;
}
