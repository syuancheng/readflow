/* ReadFlow 插件 · Content Script
 * 1) 已存词/短语绿色高亮 + 上方中文释义小标签（对齐 Readlang 截图）
 * 2) 右上角浮动工具条：语言 / 词数 / 同步 / 菜单
 * 3) 任意网页点词或划词 → 词典释义 + AI 释义 + 一键收进词库
 */
(function () {
  "use strict";

  const RF = self.RFMatch;
  if (!RF || !chrome?.runtime?.sendMessage) return;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "SVG", "IFRAME", "CANVAS", "VIDEO", "AUDIO", "NOSCRIPT",
  ]);

  let config = null;
  let words = [];
  let entries = [];
  let state = null;
  let host = null;
  let shadow = null;
  let bar = null;
  let card = null;
  let observer = null;
  let debounceTimer = null;
  let currentWord = null;
  let currentSentence = "";
  let dictTranslation = "";

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || "插件后台出错"));
        resolve(res.result);
      });
    });
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 浮动 UI（shadow DOM，隔绝网页样式） ---------- */

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
    .rf-bar {
      position: fixed; top: 12px; right: 16px; z-index: 2147483646;
      display: flex; align-items: center; gap: 7px;
      padding: 6px 8px; border-radius: 10px;
      background: #e8f9dc; border: 1.5px solid #58a700;
      box-shadow: 0 4px 14px rgba(0,0,0,.14);
      font-size: 12px; color: #2b5c00;
    }
    .rf-logo { width: 22px; height: 22px; border-radius: 6px; background: #58a700; color: #fff;
      display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; }
    .rf-label { font-weight: 700; opacity: .8; }
    select, .rf-bar button { font: inherit; cursor: pointer; }
    .rf-bar select { border: 1px solid #a8e86a; border-radius: 6px; background: #fff; color: #2b5c00;
      padding: 3px 5px; font-size: 12px; font-weight: 700; max-width: 110px; }
    .rf-bar button.rf-btn { border: 1px solid #a8e86a; background: #fff; color: #2b5c00;
      border-radius: 6px; padding: 3px 8px; font-size: 11.5px; font-weight: 800; }
    .rf-bar button.rf-btn:hover { background: #d7ffb8; }
    .rf-count { min-width: 22px; text-align: center; padding: 2px 6px; border-radius: 999px;
      background: #58a700; color: #fff; font-weight: 800; font-size: 11px; }
    .rf-err { color: #b52d2d; font-size: 11px; font-weight: 700; max-width: 190px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rf-menu { position: absolute; top: 38px; right: 0; min-width: 180px; background: #fff;
      border: 1.5px solid #58a700; border-radius: 10px; box-shadow: 0 8px 22px rgba(0,0,0,.16);
      padding: 5px; display: none; }
    .rf-menu.on { display: block; }
    .rf-menu button { width: 100%; text-align: left; border: 0; background: transparent; color: #3c3c3c;
      padding: 8px 10px; border-radius: 7px; font-size: 12px; font-weight: 700; cursor: pointer; }
    .rf-menu button:hover { background: #f1fbe9; }
    .rf-card { position: fixed; z-index: 2147483647; width: min(360px, calc(100vw - 24px));
      max-height: 420px; overflow-y: auto; display: none;
      background: #fff; border: 2px solid #58a700; border-radius: 13px;
      box-shadow: 0 12px 36px rgba(0,0,0,.22); padding: 14px; color: #3c3c3c; }
    .rf-card.on { display: block; }
    .rf-card-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
    .rf-card-head b { font-size: 17px; font-weight: 800; word-break: break-word; }
    .rf-card-head i { font-size: 11.5px; color: #777; font-style: normal; font-family: monospace; }
    .rf-x { margin-left: auto; border: 0; background: transparent; font-size: 18px; color: #999; cursor: pointer; line-height: 1; }
    .rf-card-body { font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
      max-height: 260px; overflow-y: auto; }
    .rf-card-body .rf-muted { color: #999; }
    .rf-example { margin-top: 8px; padding: 8px 10px; background: #f7f7f7; border-radius: 8px;
      font-size: 12px; color: #777; font-style: italic; }
    .rf-actions { display: flex; gap: 7px; margin-top: 12px; flex-wrap: wrap; }
    .rf-actions button { border: 1.5px solid #58a700; background: #fff; color: #3f7d00;
      border-radius: 8px; padding: 6px 10px; font-size: 12px; font-weight: 800; cursor: pointer; }
    .rf-actions button.rf-primary { background: #58a700; color: #fff; }
    .rf-actions button:disabled { opacity: .55; cursor: default; }
  `;

  function mountUI() {
    if (host) return;
    host = document.createElement("div");
    host.id = "rf-ext-host";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    bar = document.createElement("div");
    bar.className = "rf-bar";
    bar.innerHTML = `
      <span class="rf-logo">R</span>
      <span class="rf-label">Page language</span>
      <select class="rf-lang" title="页面语言">
        <option value="en">English</option><option value="zh">中文</option>
        <option value="ja">日本語</option><option value="fr">Français</option>
        <option value="de">Deutsch</option><option value="es">Español</option>
      </select>
      <button class="rf-btn" data-act="speak" title="朗读选中文本">🔊</button>
      <span class="rf-count" title="已同步词数">0</span>
      <button class="rf-btn" data-act="sync" title="重新同步词表">↻</button>
      <button class="rf-btn" data-act="menu">Menu ▾</button>
      <button class="rf-btn" data-act="close" title="隐藏工具条">×</button>
      <span class="rf-err"></span>
      <div class="rf-menu">
        <button data-menu="readflow">打开 ReadFlow →</button>
        <button data-menu="sync">立即同步词表</button>
        <button data-menu="popup">插件设置（点工具栏图标）</button>
        <button data-menu="disable">在本页停用高亮</button>
      </div>
    `;
    shadow.appendChild(bar);

    card = document.createElement("div");
    card.className = "rf-card";
    shadow.appendChild(card);

    document.documentElement.appendChild(host);

    bar.addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.target.closest("button");
      if (!btn) return;
      const menu = bar.querySelector(".rf-menu");
      if (btn.dataset.act === "menu") {
        menu.classList.toggle("on");
        return;
      }
      if (btn.dataset.act === "sync" || btn.dataset.menu === "sync") {
        menu.classList.remove("on");
        void resync();
      } else if (btn.dataset.act === "close") {
        bar.style.display = "none";
        card.classList.remove("on");
      } else if (btn.dataset.act === "speak") {
        const sel = window.getSelection()?.toString().trim();
        if (sel) {
          const u = new SpeechSynthesisUtterance(sel.slice(0, 600));
          u.lang = config?.language || "en";
          speechSynthesis.speak(u);
        }
      } else if (btn.dataset.menu === "readflow") {
        void send({ type: "rf:openReadflow" }).catch(() => {});
      } else if (btn.dataset.menu === "disable") {
        void disableHere();
      }
    });

    const lang = bar.querySelector(".rf-lang");
    lang.addEventListener("change", () => {
      config.language = lang.value;
      void send({ type: "rf:setConfig", patch: { language: lang.value } }).catch(() => {});
    });

    card.addEventListener("click", (e) => e.stopPropagation());
  }

  function renderBar() {
    if (!bar || !config) return;
    bar.style.display = "";
    bar.querySelector(".rf-lang").value = config.language || "en";
    bar.querySelector(".rf-count").textContent = String(words.length);
    const err = bar.querySelector(".rf-err");
    err.textContent = state?.syncError ? `同步失败：${state.syncError.slice(0, 40)}` : "";
    err.title = state?.syncError || "";
  }

  /* ---------- 高亮 ---------- */

  function blocked(node) {
    let el = node.parentElement;
    while (el && el !== document.documentElement) {
      if (SKIP_TAGS.has(el.tagName) || el.isContentEditable || el.id === "rf-ext-host") return true;
      if (el.classList?.contains("rf-hl")) return true;
      el = el.parentElement;
    }
    return false;
  }

  function clearHighlights() {
    const marks = document.querySelectorAll(".rf-hl[data-rf-text]");
    for (const el of marks) {
      const text = document.createTextNode(el.dataset.rfText || "");
      el.replaceWith(text);
      text.parentNode?.normalize();
    }
  }

  function makeMark(m) {
    const span = document.createElement("span");
    span.className = "rf-hl";
    span.dataset.rfId = m.entry.id;
    span.dataset.rfText = m.text;
    span.textContent = m.text;
    if (m.entry.gloss) {
      const label = document.createElement("span");
      label.className = "rf-gloss";
      label.textContent = m.entry.gloss;
      span.appendChild(label);
    }
    return span;
  }

  function applyHighlights() {
    if (!entries.length) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return blocked(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      if (!node.parentNode) continue;
      const text = node.nodeValue;
      const matches = RF.findMatches(text, entries);
      if (!matches.length) continue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const m of matches) {
        if (m.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.start)));
        frag.appendChild(makeMark(m));
        pos = m.end;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  function connectObserver() {
    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (!config?.enabled) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        observer?.disconnect();
        try {
          clearHighlights();
          applyHighlights();
        } finally {
          connectObserver();
        }
      }, 700);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* ---------- 查词卡片 ---------- */

  function sentenceOf(node) {
    const el = node?.parentElement?.closest?.("p, li, h1, h2, h3, h4, blockquote, div, section, article");
    return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 600);
  }

  function cardHtml(word, phonetic) {
    return `
      <div class="rf-card-head">
        <b>${esc(word)}</b>${phonetic ? `<i>/${esc(phonetic)}/</i>` : ""}
        <button class="rf-x" title="关闭">×</button>
      </div>
      <div class="rf-card-body"><span class="rf-muted">查询中…</span></div>
      <div class="rf-actions">
        <button data-act="ai">AI 释义</button>
        <button data-act="save" class="rf-primary">收进词库</button>
      </div>
    `;
  }

  function placeCard(x, y) {
    const w = 360;
    card.style.left = `${Math.max(12, Math.min(x, window.innerWidth - w - 12))}px`;
    card.style.top = `${Math.max(12, Math.min(y + 12, window.innerHeight - 200))}px`;
    card.classList.add("on");
  }

  function wordAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) range = document.createRange();
      if (p && range) range.setStart(p.offsetNode, p.offset);
    }
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const text = range.startContainer.nodeValue || "";
    let i = range.startOffset;
    const isWord = (c) => /[A-Za-z'’-]/.test(c);
    while (i > 0 && isWord(text[i - 1])) i--;
    let j = i;
    while (j < text.length && isWord(text[j])) j++;
    const raw = text.slice(i, j);
    const w = raw.replace(/^[-'’]+|[-'’]+$/g, "");
    if (!w || w.length < 2) return null;

    // 只认「真的点在这个词上」：caretRangeFromPoint 在空白处会吸附到最近的文字
    const wordRange = document.createRange();
    wordRange.setStart(range.startContainer, i);
    wordRange.setEnd(range.startContainer, j);
    if (!RF.pointInRects(x, y, wordRange.getClientRects())) return null;
    return { word: w, node: range.startContainer };
  }

  /** 点在链接、按钮、输入框这类可交互元素上：那是在用网页，不是在查词 */
  const INTERACTIVE = "a[href], button, input, textarea, select, option, label, summary, [contenteditable=''], [contenteditable='true'], [role='button'], [role='link'], [role='tab'], [role='menuitem']";

  function closeCard() {
    card?.classList.remove("on");
  }

  async function openCard(word, sentence, x, y, saved) {
    currentWord = word;
    currentSentence = sentence;
    dictTranslation = "";
    mountUI();
    const phonetic = saved?.phonetic || "";
    card.innerHTML = cardHtml(word, phonetic);
    card.querySelector(".rf-x").addEventListener("click", () => card.classList.remove("on"));
    placeCard(x, y);

    const body = card.querySelector(".rf-card-body");
    const saveBtn = card.querySelector('[data-act="save"]');
    const aiBtn = card.querySelector('[data-act="ai"]');

    if (saved) {
      body.textContent = RF.cleanTranslation(saved.translation) || saved.gloss || "（暂无释义）";
      if (saved.example) {
        const ex = document.createElement("div");
        ex.className = "rf-example";
        ex.textContent = saved.example;
        body.appendChild(ex);
      }
      saveBtn.textContent = "已在词库";
      saveBtn.disabled = true;
    } else {
      try {
        const r = await send({
          type: "rf:api",
          payload: { path: `/api/extension/dict?word=${encodeURIComponent(word)}` },
        });
        const entry = r.json?.entry;
        dictTranslation = RF.cleanTranslation(entry?.translation);
        body.textContent = dictTranslation || "词典未收录，可点「AI 释义」结合上下文解释。";
      } catch (err) {
        body.textContent = `词典查询失败：${err.message}`;
      }
    }

    aiBtn.addEventListener("click", async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = "生成中…";
      body.textContent = "";
      try {
        const r = await send({
          type: "rf:api",
          payload: {
            path: "/api/extension/explain",
            method: "POST",
            raw: true,
            body: {
              word,
              context: currentSentence,
              prefix: "",
              suffix: currentSentence,
              language: config?.language || "en",
              monolingual: false,
            },
          },
        });
        body.textContent = r.text || "（模型没有返回内容）";
        dictTranslation = body.textContent;
      } catch (err) {
        body.textContent = `AI 释义失败：${err.message}`;
      } finally {
        aiBtn.disabled = false;
        aiBtn.textContent = "AI 释义";
      }
    });

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中…";
      try {
        await send({
          type: "rf:api",
          payload: {
            path: "/api/extension/words",
            method: "POST",
            body: {
              word,
              sentence: currentSentence,
              url: location.href,
              title: document.title,
              translation: dictTranslation,
            },
          },
        });
        saveBtn.textContent = "✓ 已收进词库";
        await resync();
      } catch (err) {
        saveBtn.textContent = "保存失败，重试";
        saveBtn.disabled = false;
        saveBtn.title = err.message;
      }
    });
  }

  /* ---------- 生命周期 ---------- */

  async function resync() {
    try {
      state = await send({ type: "rf:sync" });
    } catch {
      state = await send({ type: "rf:getState" });
    }
    config = state.config;
    words = state.words || [];
    entries = RF.buildEntries(words);
    renderBar();
    clearHighlights();
    if (config.enabled && !onOwnSite()) applyHighlights();
  }

  function onOwnSite() {
    try {
      return new URL(config.serverUrl).origin === location.origin;
    } catch {
      return false;
    }
  }

  async function disableHere() {
    clearHighlights();
    state = await send({ type: "rf:setConfig", patch: { enabled: false } });
    config = state.config;
    renderBar();
    bar.querySelector(".rf-menu").classList.remove("on");
  }

  async function init() {
    try {
      state = await send({ type: "rf:getState" });
    } catch {
      return;
    }
    config = state.config;
    words = state.words || [];
    entries = RF.buildEntries(words);
    mountUI();
    renderBar();
    if (config.enabled && !onOwnSite()) applyHighlights();
    connectObserver();

    // 页面加载时静默拉一次最新词表（不阻塞首屏高亮）
    if (config.token) void resync();

    document.addEventListener(
      "click",
      (e) => {
        if (!config?.enabled || onOwnSite()) return;
        if (host && (e.target === host || shadow?.contains(e.composedPath?.()[0]))) return;
        // 已存词的高亮：点中就看卡片（高亮本身就是一个明确的词）
        const mark = e.target.closest?.(".rf-hl");
        if (mark && !mark.closest(INTERACTIVE)) {
          const hit = words.find((w) => w.id === mark.dataset.rfId);
          void openCard(mark.dataset.rfText, sentenceOf(mark), e.clientX, e.clientY, hit || null);
          return;
        }
        // 拖选了一段文字（必须含字母）：查这段
        const sel = window.getSelection();
        const selected = sel && !sel.isCollapsed ? sel.toString().trim() : "";
        if (RF.isLookupSelection(selected)) {
          void openCard(selected, sentenceOf(sel.anchorNode), e.clientX, e.clientY, null);
          return;
        }
        // 点在链接 / 按钮 / 输入框上：让网页自己处理
        if (e.target.closest?.(INTERACTIVE)) return;
        // 单击：只有真的点在一个英文单词上才查；点空白处 = 关掉卡片
        const at = wordAtPoint(e.clientX, e.clientY);
        if (at) void openCard(at.word, sentenceOf(at.node), e.clientX, e.clientY, null);
        else closeCard();
      },
      false,
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
