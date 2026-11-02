import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type Extracted = { title: string; text: string };

export async function extractFromUrl(url: string): Promise<Extracted> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`抓取失败：${(e as Error).message}`);
  }

  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);

  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  if (!article?.content) throw new Error("没能从这个页面提取出正文（可能是登录墙或纯前端渲染）");

  const text = htmlToParagraphs(article.content);
  if (!text.trim()) throw new Error("提取到的正文为空");

  return {
    title: article.title?.trim() || new URL(url).hostname,
    text,
  };
}

/**
 * Readability 返回的是 HTML，直接取 textContent 会丢掉段落边界。
 * 这里按块级元素逐个取文本，用空行拼回去，保证 splitParagraphs 能正确切分。
 */
function htmlToParagraphs(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const blocks = doc.querySelectorAll(
    "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption",
  );

  const out: string[] = [];
  for (const el of Array.from(blocks)) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (out[out.length - 1] === t) continue; // 嵌套块级元素会重复取到同一段文字
    out.push(t);
  }

  if (out.length === 0) {
    const t = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }

  return out.join("\n\n");
}
