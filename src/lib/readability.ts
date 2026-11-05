import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type Extracted = {
  title: string;
  /** 站点官方提供的 Markdown 源（Mintlify / GitHub Docs 等），保真度最高 */
  markdown: string | null;
  /** Readability 提取的正文 HTML，作为没有官方 Markdown 时的 fallback */
  html: string | null;
  sourceUrl: string;
};

/**
 * URL 导入的取源策略：**优先找源头的结构化版本**。
 *
 * 很多文档站在 <head> 里声明了 <link rel="alternate" type="text/markdown">，
 * 页面上的 "Copy page" 按钮复制的也是同一份内容。直接抓它，
 * 比「Readability 提取 HTML → 再猜哪些标签是表格/代码块」保真得多。
 * 没有声明才降级到 Readability 的 HTML，交给 html.ts 解析。
 *
 * 两条路径最终都产出同一个 Block[]（见 src/lib/import/），下游不区分来源。
 */
export async function extractFromUrl(url: string): Promise<Extracted> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`抓取失败：${(e as Error).message}`);
  }

  if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);
  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // 1) 官方 Markdown（若站点提供）
  let markdown: string | null = null;
  const link = doc.querySelector('link[rel~="alternate"][type="text/markdown"]');
  const href = link?.getAttribute("href");
  if (href) {
    try {
      const mdUrl = new URL(href, url).toString();
      const mdRes = await fetch(mdUrl, {
        headers: { "user-agent": UA, accept: "text/markdown,text/plain,*/*;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
      });
      if (mdRes.ok) {
        const body = await mdRes.text();
        const ct = mdRes.headers.get("content-type") ?? "";
        // 有些站点 404 也返回 200 的 HTML 错误页，靠内容类型 + 内容特征双保险
        const looksLikeMarkdown = /^#{1,6}\s|^\s*\|.+\||^\s*```/m.test(body);
        if (body.trim() && (ct.includes("markdown") || ct.includes("text/plain")) && looksLikeMarkdown) {
          markdown = body;
        }
      }
    } catch {
      // 官方 Markdown 拿不到就静默降级，不阻断导入
    }
  }

  // 2) Readability：既提供 title，也提供 fallback 正文 HTML
  let title = (doc.querySelector("meta[property='og:title']")?.getAttribute("content") || doc.title || "").trim();
  let articleHtml: string | null = null;
  try {
    const article = new Readability(doc).parse();
    if (article?.title?.trim()) title = article.title.trim();
    if (article?.content?.trim()) articleHtml = article.content;
  } catch {
    // Readability 对某些畸形页面会抛错；有 markdown 就不影响
  }

  if (!markdown && !articleHtml) {
    throw new Error("没能从这个页面提取出正文（可能是登录墙或纯前端渲染）");
  }

  return {
    title: title || new URL(url).hostname,
    markdown,
    html: markdown ? null : articleHtml,
    sourceUrl: url,
  };
}
