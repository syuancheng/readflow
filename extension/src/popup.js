"use strict";

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "后台出错"));
      resolve(res.result);
    });
  });
}

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("err", isError);
}

/* ---------------- 导入当前网页（P30） ---------------- */

/** 要导入的标签页：自动化测试会用 ?tabId= 指定，平时就是弹窗所在窗口的当前标签页 */
const forcedTabId = Number(new URLSearchParams(location.search).get("tabId")) || null;
let targetTabId = null;

function importMsg(text, kind = "") {
  const el = $("import-msg");
  el.hidden = !text;
  el.textContent = text;
  el.className = `msg${kind ? ` ${kind}` : ""}`;
}

async function loadTab(config) {
  let tab;
  try {
    tab = forcedTabId
      ? await chrome.tabs.get(forcedTabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  } catch {
    tab = null;
  }
  const btn = $("import");
  if (!tab || !/^https?:/i.test(tab.url || "")) {
    $("page-title").textContent = tab?.title || "当前页面";
    $("page-host").textContent = "浏览器自带页面不能导入，打开一篇文章再试";
    btn.disabled = true;
    return;
  }
  targetTabId = tab.id;
  $("page-title").textContent = tab.title || tab.url;
  $("page-host").textContent = new URL(tab.url).host;
  btn.disabled = !config.token;
  if (!config.token) {
    importMsg("先在下面的「插件设置」里填好服务地址和插件 Token", "err");
    $("settings").open = true;
  }
}

async function runImport(force = false) {
  const btn = $("import");
  btn.disabled = true;
  btn.textContent = "导入中…";
  $("after").hidden = true;
  importMsg("正在读取页面并发给 ReadFlow…");
  try {
    const r = await send({ type: "rf:importTab", tabId: targetTabId, force });
    $("open").href = r.readUrl;
    $("after").hidden = false;
    $("force").hidden = !r.duplicate;
    if (r.duplicate) {
      importMsg(`这篇已经导入过了：《${r.title}》`, "ok");
    } else {
      const how = r.usedMarkdown ? "（用了站点提供的 Markdown 原文）" : "";
      importMsg(`✓ 已导入《${r.title}》，共 ${r.wordCount.toLocaleString()} 词${how}`, "ok");
    }
  } catch (err) {
    const timedOut = /timed out|timeout|aborted/i.test(err.message);
    importMsg(
      timedOut
        ? "等了 90 秒还没回应：服务器可能还在处理，先去 ReadFlow 首页看看有没有这篇，别急着重复点"
        : `导入失败：${err.message}`,
      "err",
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "📥 导入到 ReadFlow";
  }
}

$("import").addEventListener("click", () => void runImport(false));
$("force").addEventListener("click", () => void runImport(true));

function render(state) {
  const c = state.config;
  $("server").value = c.serverUrl || "";
  $("token").value = c.token || "";
  $("lang").value = c.language || "en";
  $("enabled").classList.toggle("on", Boolean(c.enabled));
  if (state.syncError) {
    setStatus(`同步失败：${state.syncError}`, true);
  } else {
    const when = state.syncedAt
      ? new Date(state.syncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : "尚未同步";
    // 未同步时别写「已同步 0 个词」，容易让人以为词表是空的
    setStatus(state.syncedAt ? `已同步 ${state.count} 个词 · ${when}` : `已缓存 ${state.count} 个词 · ${when}`);
  }
}

async function load() {
  try {
    const state = await send({ type: "rf:getState" });
    render(state);
    await loadTab(state.config);
  } catch (err) {
    setStatus(`读取配置失败：${err.message}`, true);
  }
}

async function save() {
  const btn = $("save");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    // 先落配置再同步；同步完成前不要 render 旧状态，否则会闪一下「0 个词」
    await send({
      type: "rf:setConfig",
      patch: {
        serverUrl: $("server").value.trim(),
        token: $("token").value.trim(),
        language: $("lang").value,
        enabled: $("enabled").classList.contains("on"),
      },
    });
    setStatus("同步中…");
    const synced = await send({ type: "rf:sync" });
    render(synced);
    await loadTab(synced.config);
    if (synced.config.token) importMsg("");
    if (synced.syncError) setStatus(`同步失败：${synced.syncError}`, true);
    else setStatus(`✓ 已同步 ${synced.count} 个词`);
  } catch (err) {
    setStatus(`失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存并同步";
  }
}

$("save").addEventListener("click", () => void save());
$("sync").addEventListener("click", async () => {
  setStatus("同步中…");
  try {
    const state = await send({ type: "rf:sync" });
    render(state);
    if (state.syncError) setStatus(`同步失败：${state.syncError}`, true);
    else setStatus(`✓ 已同步 ${state.count} 个词`);
  } catch (err) {
    setStatus(`同步失败：${err.message}`, true);
  }
});
$("enabled").addEventListener("click", (e) => e.currentTarget.classList.toggle("on"));

void load();
