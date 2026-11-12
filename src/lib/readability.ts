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

/** 页面 <head> 里声明的官方 Markdown 版本地址（绝对地址），没有返回 null */
export function findMarkdownAlternate(doc: Document, url: string): string | null {
  const href = doc
    .querySelector('link[rel~="alternate"][type="text/markdown"]')
    ?.getAttribute("href");
  if (!href) return null;
  try {
    return new URL(href, url).toString();
  } catch {
    return null;
  }
}

/** 有些站点 404 也返回 200 的 HTML 错误页：靠内容特征判断拿到的确实是 Markdown */
export function looksLikeMarkdown(body: string): boolean {
  return Boolean(body.trim()) && !/^\s*<(!doctype|html)/i.test(body) && /^#{1,6}\s|^\s*\|.+\||^\s*```/m.test(body);
}

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
  const mdUrl = findMarkdownAlternate(doc, url);
  if (mdUrl) {
    try {
      const mdRes = await fetch(mdUrl, {
        headers: { "user-agent": UA, accept: "text/markdown,text/plain,*/*;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
      });
      if (mdRes.ok) {
        const body = await mdRes.text();
        const ct = mdRes.headers.get("content-type") ?? "";
        if ((ct.includes("markdown") || ct.includes("text/plain")) && looksLikeMarkdown(body)) {
          markdown = body;
        }
      }
    } catch {
      // 官方 Markdown 拿不到就静默降级，不阻断导入
    }
  }

  return extractFromDocument(doc, url, markdown);
}

/**
 * 已经拿到页面 HTML 时的提取（P30 插件导入）：浏览器替服务器抓好了页面，
 * 服务器不再联网，只做和 URL 导入完全相同的解析。
 * markdown 是插件在浏览器里取回的官方 Markdown（可空），这里会再校验一次。
 */
export function extractFromHtml(html: string, url: string, markdown?: string | null): Extracted {
  const dom = new JSDOM(html, { url });
  const md = markdown && looksLikeMarkdown(markdown) ? markdown : null;
  return extractFromDocument(dom.window.document, url, md);
}

/** 两条路径共用的后半段：Readability 取标题和正文 HTML，有官方 Markdown 时优先用它 */
function extractFromDocument(doc: Document, url: string, markdown: string | null): Extracted {
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
