import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const ROOT = process.cwd();
const MATCHER = fs.readFileSync(path.join(ROOT, "extension/src/matcher.js"), "utf8");
const CONTENT = fs.readFileSync(path.join(ROOT, "extension/src/content.js"), "utf8");

const WORDS = [
  { id: "w1", lemma: "prompt", displayForm: "Prompt", gloss: "提示", translation: "n. 提示", phonetic: "", example: "" },
  { id: "w2", lemma: "engineering", displayForm: "Engineering", gloss: "工程学", translation: "n. 工程学", phonetic: "", example: "" },
  { id: "w3", lemma: "has been shown", displayForm: "has been shown", gloss: "已被证明", translation: "已被证明", phonetic: "", example: "" },
];

const ARTICLE = `<!doctype html><html><body>
  <h1>Reading</h1>
  <p>This post only focuses on Prompt Engineering for modern AI.</p>
  <p>In AI has been shown to accelerate research; prompt is common.</p>
  <pre>code should not be highlighted: Prompt Engineering</pre>
</body></html>`;

let dom: JSDOM;
let doc: Document;
let shadowRoot: ShadowRoot;

before(async () => {
  dom = new JSDOM(ARTICLE, { url: "https://example.com/article" });
  const w = dom.window as unknown as Window & typeof globalThis;
  const g = globalThis as unknown as Record<string, unknown>;

  // token 留空：init 不会额外触发 resync，测试只验证首屏高亮链路
  const state = {
    config: { serverUrl: "http://127.0.0.1:3000", token: "", enabled: true, language: "en" },
    words: WORDS,
    syncedAt: Date.now(),
    syncError: "",
    count: WORDS.length,
  };
  const chromeMock = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string }, cb: (r: unknown) => void) {
        if (msg.type === "rf:getState" || msg.type === "rf:sync" || msg.type === "rf:setConfig") {
          cb({ ok: true, result: state });
        } else {
          cb({ ok: true, result: {} });
        }
      },
    },
  };

  Object.assign(g, {
    window: w,
    document: w.document,
    Node: w.Node,
    NodeFilter: w.NodeFilter,
    MutationObserver: w.MutationObserver,
    location: w.location,
    chrome: chromeMock,
    self: g,
    speechSynthesis: { speak() {} },
    SpeechSynthesisUtterance: class {},
  });

  vm.runInThisContext(MATCHER, { filename: "matcher.js" });
  vm.runInThisContext(CONTENT, { filename: "content.js" });
  await new Promise((r) => setTimeout(r, 150));
  doc = w.document;
  shadowRoot = (doc.getElementById("rf-ext-host") as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot;
});

after(() => {
  dom?.window.close();
});

test("content script：已存词/短语高亮 + 中文小标签", () => {
  const marks = Array.from(doc.querySelectorAll(".rf-hl")) as HTMLElement[];
  assert.ok(marks.length >= 4, `高亮数量 ${marks.length}`);
  const texts = marks.map((m) => m.dataset.rfText);
  assert.ok(texts.includes("Prompt"));
  assert.ok(texts.includes("Engineering"));
  assert.ok(texts.includes("has been shown"));
  assert.ok(texts.includes("prompt"));
  const glosses = Array.from(doc.querySelectorAll(".rf-gloss")).map((e) => e.textContent);
  assert.ok(glosses.includes("提示"));
  assert.ok(glosses.includes("已被证明"));
});

test("content script：跳过 code/pre，不破坏网页结构", () => {
  const pre = doc.querySelector("pre")!;
  assert.equal(pre.querySelectorAll(".rf-hl").length, 0);
  assert.ok(pre.textContent?.includes("Prompt Engineering"));
});

test("content script：浮动工具条挂在 shadow DOM，显示同步词数", () => {
  assert.ok(shadowRoot, "shadow root 应存在");
  assert.ok(shadowRoot.querySelector(".rf-bar"), "工具条应存在");
  assert.equal(shadowRoot.querySelector(".rf-count")?.textContent, "3");
  assert.ok(shadowRoot.querySelector(".rf-lang"), "语言下拉应存在");
});

test("content script：小标签是原文之外的独立节点，不污染正文文本", () => {
  const mark = doc.querySelector('.rf-hl[data-rf-text="Prompt"]') as HTMLElement;
  assert.ok(mark);
  assert.equal(mark.dataset.rfText, "Prompt");
  assert.equal(mark.querySelector(".rf-gloss")?.textContent, "提示");
  assert.ok(doc.body.textContent?.includes("Prompt Engineering"));
});
