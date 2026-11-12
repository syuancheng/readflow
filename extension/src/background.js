/* ReadFlow 插件 · Service Worker
 * 词表同步与所有后端请求都在这里发：扩展发请求不走网页的 CORS，
 * 也便于统一加重试、统一带 Token。
 */
"use strict";

const DEFAULTS = {
  serverUrl: "http://127.0.0.1:3000",
  token: "",
  enabled: true,
  language: "en",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored, serverUrl: String(stored.serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, "") };
}

async function setConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  next.serverUrl = String(next.serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, "");
  await chrome.storage.sync.set(next);
  return next;
}

/** 服务器的错误响应是 { ok:false, error }，取出 error 给人看；不是 JSON 就原样返回 */
function errorText(text, status) {
  try {
    const data = JSON.parse(text);
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    /* 不是 JSON */
  }
  return text || `HTTP ${status}`;
}

/** 网络失败 / 限流 / 网关错误自动重试；401/400 不重试 */
async function retryFetch(url, init = {}, attempts = 3, timeoutMs = 20_000) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      const status = res.status;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        const text = await res.text().catch(() => "");
        throw Object.assign(new Error(errorText(text, status)), { status, noRetry: true });
      }
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    } catch (err) {
      lastError = err;
      if (err.noRetry || i === attempts - 1) throw err;
      await sleep(600 * 2 ** i + Math.random() * 200);
    }
  }
  throw lastError;
}

function authHeaders(config, extra = {}) {
  return { "x-readflow-token": config.token || "", ...extra };
}

/** 拉词表，成功写缓存；失败保留上次缓存并返回错误，不让页面丢失高亮 */
async function syncWords() {
  const config = await getConfig();
  if (!config.token) {
    await chrome.storage.local.set({ syncError: "还没填插件 Token" });
    return { ok: false, error: "还没填插件 Token" };
  }
  try {
    const res = await retryFetch(`${config.serverUrl}/api/extension/words`, {
      headers: authHeaders(config),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "词表返回异常");
    await chrome.storage.local.set({
      words: data.words || [],
      syncedAt: Date.now(),
      syncError: "",
    });
    return { ok: true, count: (data.words || []).length, syncedAt: Date.now() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await chrome.storage.local.set({ syncError: error });
    return { ok: false, error };
  }
}

async function getState() {
  const [config, cache] = await Promise.all([
    getConfig(),
    chrome.storage.local.get({ words: [], syncedAt: 0, syncError: "" }),
  ]);
  return {
    config,
    words: cache.words || [],
    syncedAt: cache.syncedAt,
    syncError: cache.syncError,
    count: (cache.words || []).length,
  };
}

/** 通用后端请求（词典 / AI 释义 / 收词），统一带 Token 与重试 */
async function apiRequest({ path, method = "GET", body, raw = false }) {
  const config = await getConfig();
  const init = {
    method,
    headers: authHeaders(config, body ? { "Content-Type": "application/json" } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await retryFetch(`${config.serverUrl}${path}`, init);
  if (raw) return { text: await res.text() };
  const text = await res.text();
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { text };
  }
}

/* ---------------- 导入当前网页（P30） ----------------
 * 服务器可能访问不到国外网站，但浏览器打得开：由插件把已经渲染好的页面交给服务器，
 * 服务器不联网，走和「URL 导入」完全相同的解析。
 */

const MAX_HTML = 5 * 1024 * 1024;
const MAX_MARKDOWN = 2 * 1024 * 1024;

/**
 * 在网页里执行：复制一份页面，去掉脚本 / 样式 / 插件自己画的高亮，补全懒加载图片，
 * 返回精简后的 HTML 和站点声明的官方 Markdown 地址。
 * 注意：这个函数会被序列化后注入页面，不能引用外部变量。
 */
function snapshotPage() {
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return "";
    }
  };
  const mdHref = document.querySelector('link[rel~="alternate"][type="text/markdown"]')?.getAttribute("href");
  const root = document.documentElement.cloneNode(true);

  // 插件自己的工具条 / 卡片，以及高亮上方的中文释义小标签，都不能混进正文
  root.querySelectorAll("#rf-ext-host, .rf-gloss").forEach((n) => n.remove());
  root.querySelectorAll(".rf-hl").forEach((n) => n.replaceWith(...n.childNodes));

  root
    .querySelectorAll('script, style, noscript, template, iframe, canvas, video, audio, object, embed, link[rel="stylesheet"], link[rel="preload"], link[rel="modulepreload"]')
    .forEach((n) => n.remove());
  // 装饰性 SVG 图标很占体积；正文配图一般是 <img>
  root.querySelectorAll("svg").forEach((n) => n.remove());

  // 懒加载图片：真实地址常在 data-src / data-srcset 里，src 只是占位
  root.querySelectorAll("img").forEach((img) => {
    const cur = img.getAttribute("src") || "";
    const lazy =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      (img.getAttribute("data-srcset") || img.getAttribute("srcset") || "").split(",")[0].trim().split(/\s+/)[0];
    const src = !cur || cur.startsWith("data:") ? lazy : cur;
    if (src) img.setAttribute("src", abs(src));
    img.removeAttribute("srcset");
    img.removeAttribute("data-srcset");
  });

  return {
    url: location.href,
    title: document.title,
    html: "<!doctype html>\n" + root.outerHTML,
    markdownUrl: mdHref ? abs(mdHref) : null,
  };
}

/** 站点声明的官方 Markdown（Mintlify 等文档站都有）：保真度最高，拿不到就算了 */
async function fetchMarkdown(url) {
  try {
    const res = await fetch(url, {
      headers: { accept: "text/markdown,text/plain,*/*;q=0.8" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("markdown") && !ct.includes("text/plain")) return null;
    const body = await res.text();
    return body.trim() && body.length <= MAX_MARKDOWN ? body : null;
  } catch {
    return null;
  }
}

/** 要导入的标签页：显式给了 tabId 用它，否则用当前窗口的活动标签页 */
async function targetTab(tabId) {
  if (tabId) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function importTab({ tabId, force = false } = {}) {
  const config = await getConfig();
  if (!config.token) throw new Error("还没填插件 Token：在下面的设置里填好并保存");

  const tab = await targetTab(tabId);
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    throw new Error("这个页面不能导入：只支持普通的 http / https 网页");
  }

  let page;
  try {
    const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage });
    page = injected?.result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`读取页面失败：${msg}（浏览器自带页面、扩展商店不允许读取）`);
  }
  if (!page?.html) throw new Error("没有读到页面内容，刷新页面后再试");
  if (page.html.length > MAX_HTML) throw new Error("页面太大了（超过 5MB），可以复制正文用「粘贴」导入");

  const markdown = page.markdownUrl ? await fetchMarkdown(page.markdownUrl) : null;

  const res = await retryFetch(
    `${config.serverUrl}/api/extension/import`,
    {
      method: "POST",
      headers: authHeaders(config, { "Content-Type": "application/json" }),
      body: JSON.stringify({ url: page.url, title: page.title, html: page.html, markdown, force }),
    },
    // 导入不是幂等操作：超时后服务器可能其实已经建好了文章，自动重试会导入出好几份
    // （P30 实测）。所以只发一次、给足时间，失败让用户自己决定要不要再点。
    1,
    90_000,
  );
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "导入失败");
  return { ...data, readUrl: `${config.serverUrl}${data.readPath}`, usedMarkdown: Boolean(markdown) };
}

chrome.runtime.onInstalled.addListener(async () => {
  await setConfig({});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "rf:getState":
        return getState();
      case "rf:setConfig":
        await setConfig(msg.patch || {});
        return getState();
      case "rf:sync":
        await syncWords();
        return getState();
      case "rf:api":
        return apiRequest(msg.payload || {});
      case "rf:openReadflow": {
        const config = await getConfig();
        // 只允许打开 ReadFlow 自己的页面（网页里的 content script 也能发这个消息）
        const url = typeof msg.url === "string" && msg.url.startsWith(`${config.serverUrl}/`) ? msg.url : config.serverUrl;
        await chrome.tabs.create({ url });
        return { ok: true };
      }
      case "rf:importTab":
        return importTab({ tabId: msg.tabId, force: msg.force === true });
      default:
        return { ok: false, error: "未知消息" };
    }
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // 异步 sendResponse
});
