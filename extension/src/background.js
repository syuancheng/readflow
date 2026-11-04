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

/** 网络失败 / 限流 / 网关错误自动重试；401/400 不重试 */
async function retryFetch(url, init = {}, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return res;
      const status = res.status;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        const text = await res.text().catch(() => "");
        throw Object.assign(new Error(text || `HTTP ${status}`), { status, noRetry: true });
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
        await chrome.tabs.create({ url: config.serverUrl });
        return { ok: true };
      }
      default:
        return { ok: false, error: "未知消息" };
    }
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // 异步 sendResponse
});
