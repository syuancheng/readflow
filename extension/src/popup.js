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
    render(await send({ type: "rf:getState" }));
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
