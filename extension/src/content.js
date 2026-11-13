/* ReadFlow 插件 · Content Script（P31）
 * 1) 已存词/短语高亮 + 悬停中文小标签（与阅读页一致）
 * 2) 右上角浮动工具条：语言 / 词数 / 同步 / 菜单
 * 3) 点词或划词 → 右侧滑出侧栏，内容与网站阅读页右栏一一对应：
 *    自动记录（可取消）、词典区、AI 对话串、问 AI 选择题、上下文
 */
(function () {
  "use strict";

  const RF = self.RFMatch;
  if (!RF || !chrome?.runtime?.sendMessage) return;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "SVG", "IFRAME", "CANVAS", "VIDEO", "AUDIO",
  ]);

  /** 选区的「块」：与阅读页的段落一一对应 */
  const BLOCK_SELECTOR =
    "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, figcaption, pre";

  /** 服务端重试前会吐这个标记：丢掉它之前已经收到的半成品 */
  const STREAM_RESET = "\u0000RF_RESET\u0000";

  let config = null;
  let words = [];
  let entries = [];
  let state = null;
  let host = null;
  let shadow = null;
  let bar = null;
  let panel = null;
  let observer = null;
  let debounceTimer = null;

  /** 侧栏当前展示的数据；null = 收起 */
  let panelState = null;
  /** AI 对话串：{ ask?, text, status: loading|streaming|done|error, req? } */
  let threadTurns = [];
  /** 当前侧栏对应的词（再点一次同一个词要收起） */
  let currentWord = "";
  let menuOpen = false;
  let streamPort = null;

  /** 同一句里的连续请教次数（只在当前页面有效，刷新即清空） */
  const repeatMap = new Map();

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || "插件后台出错"));
        resolve(res.result);
      });
    });
  }

  const esc = RF.escHtml;

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

    /* 侧栏：覆盖在网页之上，不挤压、不缩放页面 */
    .rf-panel {
      position: fixed; top: 0; right: 0; height: 100vh; width: 380px; max-width: 100vw;
      display: flex; flex-direction: column;
      background: #fff; border-left: 1px solid #e5e5e5;
      box-shadow: 0 24px 64px rgba(24,36,58,.18);
      color: #3c3c3c; z-index: 2147483647;
      transform: translateX(100%); transition: transform 200ms ease;
    }
    .rf-panel.on { transform: translateX(0); }
    .rf-p-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
      padding: 20px 20px 16px; border-bottom: 1px solid #f0f0f0; }
    .rf-p-title { min-width: 0; }
    .rf-word { font-size: 24px; font-weight: 800; line-height: 1.3; word-break: break-word;
      display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
    .rf-p-sub { margin-top: 4px; display: flex; align-items: center; gap: 8px; }
    .rf-ipa { border: 0; background: transparent; padding: 0; color: #6b6b6b; font-size: 13px;
      font-weight: 600; cursor: pointer; font-family: -apple-system, "Segoe UI", sans-serif; }
    .rf-speak { border: 0; background: #f7f7f7; border-radius: 50%; width: 24px; height: 24px;
      cursor: pointer; font-size: 12px; line-height: 1; }
    .rf-p-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .rf-cancel { border: 0; background: transparent; color: #6b6b6b; font-size: 12px; font-weight: 700;
      padding: 4px 8px; border-radius: 8px; cursor: pointer; }
    .rf-cancel:hover:not(:disabled) { background: #ffecec; color: #c62828; }
    .rf-cancel:disabled { opacity: .5; cursor: default; }
    .rf-p-x { border: 0; background: transparent; font-size: 22px; line-height: 1; color: #8a8a8a;
      padding: 0 4px; cursor: pointer; }
    .rf-p-body { flex: 1; overflow-y: auto; padding: 16px 20px 24px; }
    .rf-dict { font-size: 14px; line-height: 1.7; color: #3c3c3c; }
    .rf-trans { font-size: 16px; font-weight: 600; white-space: pre-wrap; margin-top: 8px; }
    .rf-lemma { margin-top: 8px; font-size: 12px; color: #6b6b6b; font-weight: 700; }
    .rf-badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px;
      background: #f5ecff; color: #7a3cc0; font-size: 12px; font-weight: 700; margin-right: 4px; }
    .rf-en { margin-top: 8px; font-size: 13px; color: #6b6b6b; }
    .rf-en summary { cursor: pointer; font-weight: 700; }
    .rf-collins { margin-top: 8px; color: #e08600; font-size: 12px; font-weight: 700; }
    .rf-muted { color: #8a8a8a; }
    .rf-error { margin-top: 8px; color: #c62828; font-size: 13px; font-weight: 700; }
    .rf-thread { margin-top: 16px; display: flex; flex-direction: column; gap: 12px; }
    .rf-turn { border-top: 1px solid #f0f0f0; padding-top: 12px; }
    .rf-turn-ask { font-size: 12px; font-weight: 700; color: #8a8a8a; margin-bottom: 6px; }
    .rf-turn-text { font-size: 14px; line-height: 1.75; color: #3c3c3c; }
    .rf-turn-text p { margin: 0 0 6px; }
    .rf-turn-text ul { margin: 4px 0 8px; padding-left: 20px; }
    .rf-turn-text li { margin: 2px 0; }
    .rf-turn-text code { background: #f7f7f7; border-radius: 4px; padding: 0 3px; }
    .rf-gloss-line { color: #3f7f00; }
    .rf-gap { height: 6px; }
    .rf-retry { margin-top: 6px; border: 1px solid #e5e5e5; background: #fff; border-radius: 8px;
      padding: 4px 10px; font-size: 12px; font-weight: 700; color: #3c3c3c; cursor: pointer; }
    .rf-ask { margin-top: 16px; }
    .rf-ai-primary { width: 100%; padding: 10px 16px; border: 2px solid #ce82ff; border-bottom-width: 4px;
      border-radius: 12px; background: #f5ecff; color: #7a3cc0; font-size: 14px; font-weight: 800;
      cursor: pointer; }
    .rf-ai-primary:disabled { opacity: .55; cursor: default; }
    .rf-ask-menu { display: none; flex-direction: column; gap: 6px; margin-top: 8px; padding: 8px;
      border: 1px solid #e5e5e5; border-radius: 12px; background: #f7f7f7; }
    .rf-ask-menu.on { display: flex; }
    .rf-ask-chip { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      border: 1px solid #e5e5e5; border-radius: 10px; background: #fff; padding: 10px 12px;
      font-size: 13px; font-weight: 600; color: #3c3c3c; cursor: pointer; }
    .rf-ask-chip:hover { border-color: #58a700; background: #f1fbe7; }
    .rf-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #d4d4d4; flex-shrink: 0; }
    .rf-ask-chip:hover .rf-dot { border-color: #58a700; }
    .rf-ask-custom { position: relative; }
    .rf-ask-input { width: 100%; padding: 9px 40px 9px 12px; border: 1px solid #e5e5e5; border-radius: 9px;
      font-size: 13px; font-family: inherit; color: #3c3c3c; background: #fff; outline: none; }
    .rf-ask-input:focus { border-color: #58a700; }
    .rf-ask-send { position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
      width: 26px; height: 26px; border: 0; border-radius: 50%; background: transparent;
      color: #58a700; display: flex; align-items: center; justify-content: center; cursor: pointer; }
    .rf-ask-send:disabled { color: #d4d4d4; cursor: default; }
    .rf-ctx { margin-top: 16px; font-size: 12px; color: #6b6b6b; border-top: 1px solid #f0f0f0;
      padding-top: 12px; }
    .rf-ctx summary { cursor: pointer; font-weight: 700; }
    .rf-ctx p { margin: 6px 0 0; white-space: pre-wrap; }
    .rf-ctx b { color: #3c3c3c; margin-right: 4px; }
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

    panel = document.createElement("aside");
    panel.className = "rf-panel";
    panel.setAttribute("aria-hidden", "true");
    shadow.appendChild(panel);

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
        closePanel();
      } else if (btn.dataset.act === "speak") {
        const sel = window.getSelection()?.toString().trim();
        if (sel) speak(sel.slice(0, 600));
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

    panel.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      const act = btn.dataset.act;
      if (act === "close") return closePanel();
      if (act === "cancel") return void cancelRecord();
      if (act === "speak") return speak(currentWord);
      if (act === "ask-toggle") {
        menuOpen = !menuOpen;
        panel.querySelector(".rf-ask-menu")?.classList.toggle("on", menuOpen);
        return;
      }
      if (act === "ask-custom") return askCustom();
      if (act === "retry") {
        const i = Number(btn.dataset.idx);
        const turn = threadTurns[i];
        if (!turn) return;
        threadTurns.splice(i, 1);
        triggerAI(turn.req || {});
        return;
      }
      if (btn.dataset.opt !== undefined) {
        const opt = askOptions()[Number(btn.dataset.opt)];
        if (!opt) return;
        menuOpen = false;
        triggerAI(opt.req);
      }
    });

    panel.addEventListener("input", (e) => {
      if (!e.target.classList?.contains("rf-ask-input")) return;
      const sendBtn = panel.querySelector(".rf-ask-send");
      if (sendBtn) sendBtn.disabled = !e.target.value.trim();
    });

    panel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.classList?.contains("rf-ask-input")) {
        e.preventDefault();
        askCustom();
      }
    });
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

  /* ---------- 块文本与坐标（P31 §5.4） ---------- */

  function blockOf(node) {
    const el = node?.parentElement;
    if (!el) return document.body;
    return el.closest(BLOCK_SELECTOR) || el.closest("div") || document.body;
  }

  /** 块里所有文本拼起来，跳过插件自己插的 .rf-gloss 小标签 */
  function textNodesOf(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (p && p.closest && p.closest(".rf-gloss")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function blockRawText(block) {
    return textNodesOf(block)
      .map((n) => n.nodeValue)
      .join("");
  }

  /** 选区端点在这个块里的原文下标 */
  function offsetInBlock(block, node, offset) {
    let pos = 0;
    for (const t of textNodesOf(block)) {
      if (t === node) return pos + offset;
      pos += t.nodeValue.length;
    }
    return -1;
  }

  /** ECDICT 词典 / `wordAtPoint` 用：点在链接、按钮、输入框上时不查词 */
  const INTERACTIVE =
    "a[href], button, input, textarea, select, option, label, summary, [contenteditable=''], [contenteditable='true'], [role='button'], [role='link'], [role='tab'], [role='menuitem']";

  function wordAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        range = document.createRange();
        range.setStart(p.offsetNode, p.offset);
      }
    }
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const text = range.startContainer.nodeValue || "";
    let i = range.startOffset;
    const isWord = (c) => /[A-Za-z'’-]/.test(c);
    while (i > 0 && isWord(text[i - 1])) i--;
    let j = i;
    while (j < text.length && isWord(text[j])) j++;
    const raw = text.slice(i, j);
    const lead = raw.length - raw.replace(/^[-'’]+/, "").length;
    const trail = raw.length - raw.replace(/[-'’]+$/, "").length;
    const start = i + lead;
    const end = j - trail;
    const word = text.slice(start, end);
    if (!word || word.length < 2) return null;

    // 只认「真的点在这个词上」：caretRangeFromPoint 在空白处会吸附到最近的文字
    const wordRange = document.createRange();
    wordRange.setStart(range.startContainer, start);
    wordRange.setEnd(range.startContainer, end);
    if (!RF.pointInRects(x, y, wordRange.getClientRects())) return null;
    return { word, node: range.startContainer, range: wordRange };
  }

  /* ---------- 侧栏 ---------- */

  function speak(text) {
    const t = String(text || "").trim();
    if (!t) return;
    try {
      const u = new SpeechSynthesisUtterance(t.slice(0, 600));
      u.lang = config?.language || "en";
      speechSynthesis.speak(u);
    } catch {
      /* 没有语音合成就算了 */
    }
  }

  function sentenceText() {
    const s = panelState;
    if (!s) return "";
    return (
      s.signals?.sentence ||
      `${s.aiContext?.prefix || ""}${s.quote}${s.aiContext?.suffix || ""}`
    ).trim();
  }

  function dictHtml(s) {
    if (s.error) return `<p class="rf-error">${esc(s.error)}</p>`;
    if (s.dictLoading) return `<p class="rf-muted">查词典中…</p>`;
    const e = s.dict?.entry;
    const isPhrase = /\s/.test(String(s.quote || "").trim());
    if (!e) {
      return `<p class="rf-muted">${isPhrase ? "短语不在词典中" : "词典未收录"} · ${
        s.autoExplain ? "交给 AI 老师解释" : "可用 AI 解释"
      }</p>`;
    }
    const parts = [];
    const lemma = s.dict?.lemmaForm;
    const orig = s.dict?.originalForm;
    if (lemma && orig && lemma.toLowerCase() !== orig.toLowerCase()) {
      parts.push(`<div class="rf-lemma"><span class="rf-badge">${esc(lemma)}</span> ← 原形</div>`);
    }
    const tr = RF.cleanTranslation(e.translation);
    if (tr) parts.push(`<div class="rf-trans">${esc(tr)}</div>`);
    const def = RF.cleanTranslation(e.definition);
    if (def) {
      parts.push(
        `<details class="rf-en"><summary>英文释义</summary><div>${esc(def)}</div></details>`,
      );
    }
    const stars = Math.max(0, Math.min(5, Number(e.collins) || 0));
    if (stars > 0) {
      parts.push(`<div class="rf-collins">柯林斯 ${"★".repeat(stars)}${"☆".repeat(5 - stars)}</div>`);
    }
    return parts.join("") || `<p class="rf-muted">这条没有释义内容</p>`;
  }

  function turnHtml(t, i) {
    const ask = t.ask ? `<div class="rf-turn-ask">${esc(t.ask)}</div>` : "";
    const body =
      t.status === "error"
        ? esc(t.text || "（失败）")
        : RF.renderMarkdown(t.text || (t.status === "loading" ? "生成中…" : ""));
    const retry =
      t.status === "error" ? `<button class="rf-retry" data-act="retry" data-idx="${i}">重试</button>` : "";
    return `<div class="rf-turn">${ask}<div class="rf-turn-text" data-turn="${i}">${body}</div>${retry}</div>`;
  }

  /** 选项文案与出现条件与 Reader.tsx 的 askOptions 一字不差 */
  function askOptions() {
    const s = panelState;
    if (!s) return [];
    const isPhrase = /\s/.test(String(s.quote || "").trim());
    const hasDefault = threadTurns.some((t) => !t.ask && t.status !== "error");
    const repeat = Number(s.signals?.repeatCount) || 1;
    const sentence = sentenceText();
    const isWholeSentence = Boolean(sentence) && String(s.quote || "").length >= sentence.length - 2;

    const opts = [];
    if (!hasDefault) {
      opts.push({
        label: isPhrase ? "这个短语在这句里什么意思" : "这个词在这句里什么意思",
        req: {},
      });
    } else if (repeat >= 2) {
      opts.push({ label: "只讲这个词，不讲整句", req: { ask: "只讲这个词", forceWord: true } });
    }
    if (!isWholeSentence) {
      opts.push({
        label: "整句没看懂",
        req: {
          ask: "整句没看懂",
          word: sentence,
          wholeSentence: true,
          prompt:
            "这句话里的词我基本都认识，但整句没看懂。第一行按「释义：」格式给出整句的中文翻译；" +
            "然后用一两行点明这句难在哪里（结构、指代、搭配或背景知识），帮我下次自己能拆开；必要时再给句子地图。",
        },
      });
    }
    opts.push({
      label: "讲讲句子结构",
      req: {
        ask: "讲讲句子结构",
        prompt: `讲讲这句话的结构：主干（主语、谓语、宾语或表语）是什么，「${s.quote}」在其中充当什么、修饰谁。`,
      },
    });
    opts.push({
      label: "再给个例句",
      req: {
        ask: "再给个例句",
        prompt: `用「${s.quote}」在这句里的这个意思，再给一个简单的英文例句，并附中文翻译。`,
      },
    });
    return opts;
  }

  function askHtml() {
    const s = panelState;
    const opts = askOptions();
    return `
      <button class="rf-ai-primary" data-act="ask-toggle" ${s.busy || s.dictLoading ? "disabled" : ""}>✨ 问 AI ▾</button>
      <div class="rf-ask-menu">
        ${opts
          .map(
            (o, i) => `<button class="rf-ask-chip" data-opt="${i}">
              <span class="rf-dot"></span><span>${esc(o.label)}</span>
            </button>`,
          )
          .join("")}
        <div class="rf-ask-custom">
          <input class="rf-ask-input" placeholder="自己写个问题…" />
          <button class="rf-ask-send" data-act="ask-custom" title="发送" aria-label="发送" disabled>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" />
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  function ctxHtml(s) {
    let host = "";
    try {
      host = new URL(s.sourceUrl || location.href).host;
    } catch {
      host = "";
    }
    const pre = s.aiContext?.prefix || "";
    const suf = s.aiContext?.suffix || "";
    return `<details class="rf-ctx"><summary>上下文</summary>
      ${pre ? `<p><b>前文</b>${esc(pre)}</p>` : ""}
      ${suf ? `<p><b>后文</b>${esc(suf)}</p>` : ""}
      ${host ? `<p><b>来源</b>${esc(host)}</p>` : ""}
    </details>`;
  }

  /**
   * 侧栏代次：openShell / closePanel 各加一。
   * 请求是异步的，用户完全可能在响应回来之前点空白关掉、或者点了别的词；
   * 这时旧响应必须丢掉，否则侧栏会「自己弹回来」，甚至盖掉新词的侧栏。
   */
  let panelSeq = 0;

  function renderPanel() {
    if (!panel) return;
    const s = panelState;
    if (!s) {
      panel.classList.remove("on");
      panel.setAttribute("aria-hidden", "true");
      panel.innerHTML = "";
      return;
    }
    panel.innerHTML = `
      <div class="rf-p-head">
        <div class="rf-p-title">
          <div class="rf-word" title="${esc(s.quote)}">${esc(s.quote)}</div>
          <div class="rf-p-sub">
            ${
              s.phonetic
                ? `<button class="rf-ipa" data-act="speak" title="点击朗读">/${esc(
                    RF.normalizePhonetic(s.phonetic),
                  )}/</button>`
                : ""
            }
            <button class="rf-speak" data-act="speak" title="发音" aria-label="发音">🔊</button>
          </div>
        </div>
        <div class="rf-p-actions">
          <button class="rf-cancel" data-act="cancel" ${s.contextId ? "" : "disabled"}
            title="${s.contextId ? "删除这条记录：网页上的高亮和词库里的记录一起消失" : "正在保存…"}">取消记录</button>
          <button class="rf-p-x" data-act="close" title="关闭">×</button>
        </div>
      </div>
      <div class="rf-p-body">
        <section class="rf-dict">${dictHtml(s)}</section>
        ${threadTurns.length ? `<section class="rf-thread">${threadTurns.map(turnHtml).join("")}</section>` : ""}
        <section class="rf-ask">${askHtml()}</section>
        ${ctxHtml(s)}
      </div>
    `;
    panel.querySelector(".rf-ask-menu")?.classList.toggle("on", menuOpen);
    panel.classList.add("on");
    panel.setAttribute("aria-hidden", "false");
  }

  function openShell(quote) {
    // 换词必须先停掉上一个词还在流式输出的回答：否则它的后半段会拼进新词的对话串，
    // 讲完还会被 saveGloss 存进新词的记录（P31 验收时复现过）
    abortStream();
    panelSeq++;
    currentWord = quote;
    threadTurns = [];
    menuOpen = false;
    panelState = {
      quote,
      phonetic: "",
      dict: null,
      dictLoading: true,
      autoExplain: false,
      aiContext: { prefix: "", suffix: "", withPrevSentence: false },
      signals: null,
      contextId: "",
      wordId: "",
      sourceUrl: location.href,
      imported: false,
      error: "",
      busy: false,
    };
    renderPanel();
  }

  function applyPayload(p) {
    currentWord = p.quote || currentWord;
    panelState = {
      quote: p.quote,
      phonetic: p.dict?.entry?.phonetic || "",
      dict: p.dict || { entry: null },
      dictLoading: false,
      autoExplain: p.autoExplain === true,
      aiContext: p.aiContext || { prefix: "", suffix: "", withPrevSentence: false },
      signals: p.signals || null,
      contextId: p.contextId || "",
      wordId: p.wordId || "",
      sourceUrl: location.href,
      imported: p.imported === true,
      error: "",
      busy: false,
    };
    threadTurns = (p.thread || []).map((t) => ({
      ...(t.ask ? { ask: t.ask } : {}),
      text: t.text,
      status: "done",
    }));
    renderPanel();
  }

  function closePanel() {
    panelSeq++;
    abortStream();
    panelState = null;
    threadTurns = [];
    currentWord = "";
    menuOpen = false;
    if (panel) {
      panel.classList.remove("on");
      panel.setAttribute("aria-hidden", "true");
      panel.innerHTML = "";
    }
  }

  function abortStream() {
    if (!streamPort) return;
    try {
      streamPort.disconnect();
    } catch {
      /* 已经断了 */
    }
    streamPort = null;
  }

  function paintTurn(i) {
    const t = threadTurns[i];
    const el = panel?.querySelector(`.rf-turn-text[data-turn="${i}"]`);
    if (t && el) el.innerHTML = RF.renderMarkdown(t.text);
  }

  /**
   * 问 AI：流式回答追加到对话串。
   * req 为空 = 默认讲解；forceWord 把「同句加深」清零；wholeSentence 用整句提问。
   */
  function triggerAI(req = {}) {
    // 记录还没回来（dictLoading）时不能问：回来后 applyPayload 会换掉整个对话串，
    // 这时发起的回答既显示不出来、也没有记录 ID 可存
    if (!panelState || panelState.busy || panelState.dictLoading) return;
    if (typeof chrome.runtime.connect !== "function") {
      panelState.error = "当前浏览器不支持流式请求，请升级 Chrome";
      renderPanel();
      return;
    }
    abortStream();

    const s = panelState;
    const signals =
      s.signals && !req.wholeSentence
        ? {
            ...s.signals,
            dictHit: Boolean(s.dict?.entry),
            ...(req.forceWord ? { repeatCount: 0, priorAsks: undefined } : {}),
          }
        : undefined;

    const body = req.wholeSentence
      ? {
          word: req.word || sentenceText(),
          prefix: "",
          suffix: "",
          language: config?.language || "en",
          monolingual: false,
          ...(req.prompt ? { prompt: req.prompt } : {}),
        }
      : {
          word: s.quote,
          prefix: s.aiContext?.prefix || "",
          suffix: s.aiContext?.suffix || "",
          ...(s.aiContext?.withPrevSentence ? { withPrevSentence: true } : {}),
          language: config?.language || "en",
          monolingual: false,
          ...(req.prompt ? { prompt: req.prompt } : {}),
          ...(signals ? { signals } : {}),
        };

    const index = threadTurns.length;
    const turnRef = { ask: req.ask, text: "", status: "loading", req };
    threadTurns.push(turnRef);
    s.busy = true;
    renderPanel();

    // 这段回答属于「发起时」的那个词：记下面板序号和记录 ID。
    // 之后面板换了词或关了，迟到的片段一律丢弃，也不能写进别的记录。
    const seq = panelSeq;
    const contextId = s.contextId;

    const port = chrome.runtime.connect({ name: "rf:explainStream" });
    streamPort = port;

    port.onMessage.addListener((msg) => {
      if (seq !== panelSeq) {
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        return;
      }
      const turn = threadTurns[index];
      if (!turn || turn !== turnRef) return;
      if (msg && typeof msg.chunk === "string") {
        turn.text += msg.chunk;
        if (turn.text.includes(STREAM_RESET)) turn.text = turn.text.split(STREAM_RESET).pop() || "";
        turn.status = "streaming";
        paintTurn(index);
        return;
      }
      if (msg && msg.error) {
        turn.status = "error";
        turn.text = `[Error: ${msg.error}]`;
        if (panelState) panelState.busy = false;
        renderPanel();
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        if (streamPort === port) streamPort = null;
        return;
      }
      if (msg && msg.done) {
        turn.status = "done";
        if (panelState) panelState.busy = false;
        renderPanel();
        void saveGloss(contextId);
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        if (streamPort === port) streamPort = null;
      }
    });

    port.onDisconnect.addListener(() => {
      if (streamPort === port) streamPort = null;
    });

    port.postMessage({ type: "start", body });
  }

  function askCustom() {
    const input = panel?.querySelector(".rf-ask-input");
    const q = (input?.value || "").trim();
    if (!q || !panelState || panelState.busy) return;
    menuOpen = false;
    triggerAI({ ask: q, prompt: q });
  }

  /** 每段回答结束后把「所有成功且不是错误提示的回答」整串写回这条记录 */
  async function saveGloss(contextId) {
    // 只写回发起这段回答的那条记录；面板已经换成别的记录就不写
    if (!contextId || panelState?.contextId !== contextId) return;
    const turns = threadTurns
      .filter((t) => t.status === "done" && t.text.trim())
      .map((t) => ({ ...(t.ask ? { ask: t.ask } : {}), text: t.text }));
    if (!turns.length) return;
    try {
      await send({ type: "rf:gloss", body: { contextId, turns } });
    } catch {
      // 存不进就算了：下次点这个词还能重新问，别打断阅读
    }
  }

  async function cancelRecord() {
    const s = panelState;
    if (!s?.contextId) return;
    try {
      await send({ type: "rf:unrecord", wordId: s.wordId, contextId: s.contextId });
      closePanel();
      await resync();
    } catch (err) {
      s.error = `取消记录失败：${err.message}`;
      renderPanel();
    }
  }

  /** 坐标算不准时的降级：只查词典，不记录 */
  async function openDictOnly(word) {
    openShell(word);
    try {
      const r = await send({
        type: "rf:api",
        payload: { path: `/api/extension/dict?word=${encodeURIComponent(word)}` },
      });
      if (!panelState) return;
      panelState.dict = r.json || { entry: null };
      panelState.dictLoading = false;
      renderPanel();
    } catch (err) {
      if (!panelState) return;
      panelState.dictLoading = false;
      panelState.error = `词典查询失败：${err.message}`;
      renderPanel();
    }
  }

  /** 点词 / 划词：算坐标 → 自动记录 → 渲染 → 需要时自动讲解 */
  async function lookupSelection({ word, range, node, source }) {
    const block = blockOf(node);
    const raw = blockRawText(block);
    const norm = RF.normalizeBlockText(raw);

    let quote = RF.normalizeBlockText(word);
    let start = -1;
    const startRaw = offsetInBlock(block, range.startContainer, range.startOffset);
    const endRaw = offsetInBlock(block, range.endContainer, range.endOffset);

    if (startRaw >= 0 && endRaw >= startRaw && endRaw <= raw.length) {
      const fromRaw = RF.normalizeBlockText(raw.slice(startRaw, endRaw));
      if (fromRaw) quote = fromRaw;
      const ns = RF.normalizedIndex(raw, startRaw);
      start = norm.indexOf(quote, Math.max(0, ns - 1));
      if (start < 0) start = norm.indexOf(quote);
    }
    const end = start >= 0 ? start + quote.length : -1;

    // 校验不通过就只查词典：宁可少记一条，也不能把划线画错位置
    if (!quote || start < 0 || norm.slice(start, end) !== quote) {
      void openDictOnly(word);
      return;
    }

    const sentence = RF.sentenceAround(norm, start, end);
    const repeatCount = (repeatMap.get(sentence) || 0) + 1;
    repeatMap.set(sentence, repeatCount);

    openShell(quote);
    const seq = panelSeq;
    const sel = window.getSelection?.();
    sel?.removeAllRanges?.();

    try {
      const res = await send({
        type: "rf:record",
        body: {
          word: quote,
          block: norm,
          start,
          end,
          url: location.href,
          title: document.title,
          source,
          repeatCount,
        },
      });
      // 用户可能在响应回来前就关掉侧栏、或点了别的词：旧结果直接丢掉
      if (seq !== panelSeq) return;
      // background 的 apiRequest 统一返回 { json } 或 { text }，这里取出响应体
      const payload = res?.json ?? res;
      if (!payload?.quote) throw new Error(payload?.error || "记录失败");
      applyPayload(payload);
      if (payload.autoExplain) triggerAI({});
      void resync();
    } catch (err) {
      if (!panelState || seq !== panelSeq) return;
      panelState.dictLoading = false;
      panelState.error = `记录失败：${err.message}`;
      renderPanel();
    }
  }

  /** 点已存词的高亮：只读回看，不自动讲解 */
  async function openSaved(id, text) {
    openShell(text || "");
    const seq = panelSeq;
    try {
      const res = await send({ type: "rf:word", id });
      if (seq !== panelSeq) return;
      const payload = res?.json ?? res;
      if (!payload?.quote) throw new Error(payload?.error || "打开失败");
      applyPayload(payload);
    } catch (err) {
      if (!panelState || seq !== panelSeq) return;
      panelState.dictLoading = false;
      panelState.error = `打开失败：${err.message}`;
      renderPanel();
    }
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
        // 点在插件自己的 UI 上：交给侧栏 / 工具条处理
        const path = typeof e.composedPath === "function" ? e.composedPath() : [];
        if (host && (path.includes(host) || e.target === host)) return;

        // 已存词的高亮：点中就看回看卡片（高亮本身就是一个明确的词）
        const mark = e.target.closest?.(".rf-hl");
        if (mark && !mark.closest(INTERACTIVE)) {
          e.preventDefault();
          void openSaved(mark.dataset.rfId, mark.dataset.rfText);
          return;
        }

        // 拖选了一段文字（必须含字母）：查这段
        const sel = window.getSelection();
        const selected = sel && !sel.isCollapsed ? sel.toString().trim() : "";
        if (RF.isLookupSelection(selected)) {
          const range = sel.getRangeAt(0);
          void lookupSelection({
            word: selected,
            range,
            node: range.startContainer,
            source: "select",
          });
          return;
        }

        // 点在链接 / 按钮 / 输入框上：让网页自己处理
        if (e.target.closest?.(INTERACTIVE)) return;

        // 单击：只有真的点在一个英文单词上才查；点空白处 = 关闭侧栏
        const at = wordAtPoint(e.clientX, e.clientY);
        if (at) {
          const same =
            panelState && currentWord && at.word.toLowerCase() === currentWord.toLowerCase();
          if (same) {
            closePanel();
            return;
          }
          void lookupSelection({ word: at.word, range: at.range, node: at.node, source: "word" });
        } else {
          closePanel();
        }
      },
      false,
    );

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panelState) closePanel();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
})();
