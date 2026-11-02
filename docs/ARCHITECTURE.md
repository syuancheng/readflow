# Lexreader 技术实现文档

> 面向要改这个仓库的人（包括三个月后的自己）。
> 产品定位与背景见 [`../README.md`](../README.md)。

**版本**：MVP（P0–P4 完成，全链路可用）
**代码规模**：`src/` + `scripts/` 约 4.5k 行（TypeScript / TSX / CSS）
**最后核对的运行环境**：Node 24.x，Next.js 16.4.3，React 19.3.0

---

## 目录

1. [系统总览](#1-系统总览)
2. [数据模型](#2-数据模型)
3. [链路一：文本导入](#3-链路一文本导入)
4. [链路二：点词命中与锚定](#4-链路二点词命中与锚定)
5. [链路三：三层递进释义](#5-链路三三层递进释义)
6. [链路四：收词与去重](#6-链路四收词与去重)
7. [链路五：统计与游戏化](#7-链路五统计与游戏化)
8. [关键取舍与论证](#8-关键取舍与论证)
9. [踩坑记录](#9-踩坑记录)
10. [Readlang 逆向结论](#10-readlang-逆向结论)
11. [链路六：导出墨墨记忆卡](#11-链路六导出墨墨记忆卡)
12. [验证方法](#12-验证方法)
13. [代码地图与改动指引](#13-代码地图与改动指引)

---

## 1. 系统总览

单进程 Next.js 应用，同一个 Node 进程里同时提供 SSR 页面和 API，数据落在两个 SQLite 文件上。

```
                    ┌──────────────────── 浏览器 ────────────────────┐
                    │  首页 / 阅读页 / 词库 / 战绩（SSR + 少量客户端）│
                    └───────────────┬────────────────────────────────┘
                                    │ HTTP（同源，无鉴权）
┌───────────────────────────────────▼────────────────────────────────┐
│ Next.js（Node runtime）                                            │
│                                                                    │
│  Server Components            API Routes                           │
│  ├ page.tsx（列表+统计）      ├ /api/texts      导入 / 列表 / 删除  │
│  ├ texts/[id]（段落+已收词）  ├ /api/words      收词 / 列表 / 删除  │
│  ├ words/page.tsx             ├ /api/dict       词典查询            │
│  └ stats/page.tsx             └ /api/explain    AI 流式释义         │
│                                                                    │
│  lib/                                                              │
│  ├ split.ts      切段      tokenize.ts  分词 + 锚点                │
│  ├ readability.ts URL→正文  dict.ts      ECDICT 查询               │
│  ├ ai.ts         DeepSeek  stats.ts      按天聚合                  │
└──────┬──────────────────────────────┬──────────────────────┬───────┘
       │                              │                      │
┌──────▼──────────┐        ┌──────────▼─────────┐   ┌────────▼────────┐
│ data/lexreader  │        │ data/dict/ecdict.db│   │ api.deepseek.com│
│ 用户数据 + 词典 │        │ 只读，77 万词条    │   │ OpenAI 兼容接口 │
│ 索引（可写）    │        │ query_only = ON    │   │ 流式 SSE        │
└─────────────────┘        └────────────────────┘   └─────────────────┘
```

**两条不变量**（改代码时不要破坏）：

1. **段落是锚定与渲染的唯二坐标原点。** 段落不重新导入就永远不变；所有位置信息都以 `(paragraph_id, 段内偏移)` 表达。
2. **服务端与客户端渲染必须逐字符一致。** 任何依赖环境的分词/排序/格式化都会炸 hydration（见 9.1）。

---

## 2. 数据模型

定义在 `src/db/schema.ts`，建表 SQL 内联在 `src/db/index.ts`（两处必须同步，见 8.5）。

```
texts ──1:N──> paragraphs
  │
  └──(逻辑引用)
        │
user_words ──1:N──> contexts ──> (text_id, paragraph_id, 位置, quote, prefix, suffix)
  │
  └──1:N──> exports（导出幂等记录：word + deck + card_type 唯一）
```

### 2.1 表定义

| 表 | 关键字段 | 说明 |
|---|---|---|
| `texts` | `id`(uuid), `user_id`, `title`, `source_type`(paste/file/url), `source_url`, `language`, `word_count`, `created_at`(ms) | 一篇文章 |
| `paragraphs` | `id`(uuid), `text_id`, `idx`, `content` | **锚定基准**。索引 `(text_id, idx)` |
| `user_words` | `id`(uuid), `user_id`, `lemma`, `display_form`, `pos`, `phonetic`, `translation`, `note`, `created_at` | 唯一索引 `(user_id, lemma)` —— 一个词只存一行 |
| `contexts` | `id`, `user_word_id`, `text_id`, `paragraph_id`, `start`, `end`, `quote`, `prefix`, `suffix`, `ai_gloss`, `created_at` | 每次收词一条，**刻意不去重** |
| `exports` | `id`, `user_word_id`, `deck_id`, `chapter_id`, `card_id`, `card_type`, `status`, `error`, `pushed_at` | 唯一索引 `(user_word_id, deck_id, card_type)`，导出幂等的物理保证（11.5） |
| `settings` | `key`, `value`, `updated_at` | 键值配置：记住上次选的牌组/章节 |

### 2.2 为什么 `contexts` 是独立表而不是 JSON 字段

一个词会在多篇文章、多个位置出现。如果做成 `user_words.occurrences` 的 JSON 数组：

- 无法用 SQL 做「这篇文里我收了哪些词」（阅读页高亮要这个）；
- 无法按天统计收集量（战绩页要这个）；
- 并发收词时要读-改-写整个 JSON，容易丢更新。

独立成表后，这两个查询都是一次 join，收词是纯 append。

### 2.3 `exchange` 字段：词形还原的免费午餐

ECDICT 每个词条带一个 `exchange` 字段，格式：

```
went          →  "0:go/1:p"        原形 go，变形类型 p（过去式）
children      →  "0:child/1:s"     复数
better        →  "0:good/1:r"      比较级
```

`src/lib/dict.ts` 的 `lemma()` 只用一行正则 `^0:([^/]+)` 就拿到了原形——**不需要任何 NLP 库、不需要规则表**。这是整个项目性价比最高的一个发现。

`lookup()` 的三步：

```
1. 直接查词 → 命中且 translation 长度 > 10（说明是实义释义而非「go 的过去式」这种短标注）
   → 直接返回 { entry: 自己, lemmaForm: 自己 }
2. 否则用 exchange 还原到原形再查 → 命中
   → 返回原形条目，word 标注成 "go (went)"，lemmaForm = "go"
3. 直接查到但释义太短 / 原形也查不到
   → 返回直查结果；都没有则 entry = null（前端切第 2 层走 AI）
```

注意一个**已知的语义小瑕疵**：`rained` 在 ECDICT 里有自己的条目且 translation 长度足够，所以会以 `lemma = "rained"` 落库，而不是 `rain`。行为上不算错（释义是「下雨（rain 的过去式）」），但会让「同一动词的不同变形」在词库里分成两条。修法：判断 `exchange` 存在时优先走原形（P4 前建议修）。

---

## 3. 链路一：文本导入

```
ImportForm（客户端）
  ├ 粘贴：textarea
  ├ 上传：<input type=file> → File.text()
  └ 网页：只传 URL，服务端抓
        │
        ▼  POST /api/texts { title?, text?, url? }
src/app/api/texts/route.ts
  1. 有 url → extractFromUrl()
  2. splitParagraphs(content)
  3. 空 → 400；无标题 → 取首段前 40 字
  4. db.transaction：插 texts + 批量插 paragraphs
  5. 返回 { id, title, paragraphCount, wordCount }
        │
        ▼  前端 router.push(`/texts/${id}`)
```

### 3.1 URL 提取（`lib/readability.ts`）

`fetch`（带桌面 UA，20s 超时）→ `new JSDOM(html)` → `Readability.parse()` → 拿到内容 HTML。

关键一步：**不能直接 `textContent`**，否则段落边界全丢。`htmlToParagraphs()` 按块级元素（`h1-6, p, li, blockquote, pre, figcaption`）逐个取文本，用 `\n\n` 拼回去，并跳过相邻重复（嵌套块级元素会把同一段文字取两次）。

失败信息是给人看的：「没能从这个页面提取出正文（可能是登录墙或纯前端渲染）」。

### 3.2 切段（`lib/split.ts`）

```
原文 → 归一化换行(\r\n→\n) → trim
  ① 按空行切（\n\s*\n+）
  ② 按单换行切（\n+）
  若 ① 只得 1 段且 ② 得 > 3 段 → 判定为「单换行文本」（小说/字幕）→ 用 ②
```

每段再归一化：多空格压成一个、内部换行变空格、trim。

`splitParagraphs` 是**所有位置语义的起点**：切段规则一改，历史 `contexts` 的段内偏移全部失效（`paragraph_id` 还在，但同一个 id 对应的 content 可能变了）。所以**不要动切段逻辑，除非接受旧锚点失效**——真要改，用 `resolveAnchor()` 的降级路径兜住。

### 3.3 词数统计

英文按空白、CJK 按字。用于列表展示与每日目标计算（`goal = max(20, round(wordCount * 0.05))`）。

---

## 4. 链路二：点词命中与锚定

这是唯一有真正技术含量的一段，全部在 `src/components/Reader.tsx`。

### 4.1 渲染：段落 → span

`Para`（`memo` 包裹）把每段文本 `tokenize()` 成 token 数组，词 token 渲染成 `<span class="w" data-s data-e>`，非词 token（空格、标点）用裸 `<span>`。

```tsx
tokenize("She sat on the river bank.")
→ [{text:"She",s:0,e:3,word:true}, {text:" ",s:3,e:4,word:false}, ...]
```

- 一段 100 词 ≈ 200 个 DOM 节点。视口内 10 段也就 2000 个，无压力。
- `useMemo` 按 `content` 缓存分词结果，同段落不会重复切。

### 4.2 单击

```ts
onClick(e) {
  if (选区非折叠) return;                    // 拖选时不抢事件
  wordEl = e.target.closest(".w")           // 没点到词 → 关弹层
  pEl   = wordEl.closest("[data-pid]")      // 找所属段落
  s = +wordEl.dataset.s; en = +wordEl.dataset.e
  → buildAnchor(p.content, s, en)
  → setPick({ ..., x: rect.left + rect.width/2, y: rect.bottom })
}
```
再点同一个词会 toggle 关闭（比较 `paragraphId + start + end`）。

### 4.3 拖选短语

```ts
onMouseUp() {
  range = selection.getRangeAt(0)
  pEl   = paraOf(range.commonAncestorContainer)   // 向上找 [data-pid]
  起点和终点必须在同一段内（跨段直接放弃，避免语义歧义）
  start = offsetIn(pEl, range.startContainer, range.startOffset)
  end   = offsetIn(pEl, range.endContainer,   range.endOffset)
}

// 核心工具：把 DOM (node, offset) 换算成段内字符偏移
function offsetIn(container, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, offset);
  return r.toString().length;      // 借浏览器自己算，不用手写遍历
}
```

> 这里没有用 `caretRangeFromPoint(x, y)`——拖选已经给了 Range，反而更准；单击则直接读 span 上的 `data-s/data-e`，不依赖坐标命中。

### 4.4 锚点三件套（`lib/tokenize.ts`）

```ts
buildAnchor(paragraph, start, end) → {
  start, end,
  quote:  paragraph.slice(s, e),
  prefix: paragraph.slice(max(0, s-40), s),      // 前 40 字符
  suffix: paragraph.slice(e, e+40),              // 后 40 字符
}
```

对应 W3C Web Annotation 的 `TextPositionSelector`（偏移）+ `TextQuoteSelector`（引用文本 + 前后文）。

`resolveAnchor()` 的降级阶梯：

```
① paragraph.slice(start, end) === quote        → 直接信任偏移（快）
② 全文搜 prefix+quote+suffix                   → 命中即定位（能扛住前后文整体位移）
③ 只搜 quote，且必须全文唯一                   → 命中（能扛住前后文被改）
④ 都不行                                       → null
```

返回 `null` 时调用方应当「显示原句但禁用跳转」，**绝不能退化成跳到第一个匹配**——跳错位置比不跳更糟。

> 现状：`resolveAnchor` 已实现但目前没有调用方（阅读页走 SSR，用不到回跳）。它是为「词库页点词回原文」准备的，接上之前不要删。

### 4.5 弹层定位

难点：弹层高度会随 AI 流式内容增长，不能预先知道。

```ts
W = 360
left = clamp(x, W/2+16, vw - W/2 - 16)          // 水平夹在视口内
ESTIMATED_H = 420                                // 保守预估
flipUp = y + 12 + ESTIMATED_H > vh - 16          // 下方放不下就翻到上方
top = flipUp ? max(16, y - 12 - 320) : y + 12
maxHeight = min(vh - top - 16, 560)              // 硬约束：永不溢出视口
```

内部用「标题栏固定 / 内容区 `flex:1 + overflow-y:auto` / 底栏固定」的三段式：

```
┌─ 标题栏（词 + 音标 + 收词 + 关闭）   flex:0
├─ 释义区（词典 / AI / 追问输入）      flex:1, overflow-y:auto
├─ 底栏（AI 释义 / 追问按钮）          flex:0  ← 内容再长也不会被挤走
└─ <details> 锚点调试信息（前文/后文/位置）
```

这一版把弹层高度从 ~430px 压到 ~317px（−26%），长内容下也不会溢出（实测 `overflowsViewport: false`）。

---

## 5. 链路三：三层递进释义

### 5.1 时序

```
点词
 │
 ├─▶ GET /api/dict?word=bank ──▶ ECDICT（<5ms）
 │        │
 │        ├ 有结果 → 渲染第 1 层（音标 / 中文释义 / 英文释义折叠 / 柯林斯星级）
 │        │          底栏按钮文案 = 「🤖 AI 深度释义」
 │        └ 无结果 或 是短语 → 渲染「词典未收录」
 │                   底栏按钮文案 = 「🔍 用 AI 解释」（引导升级）
 │
 └─▶ 用户点按钮 / 追问
        GET /api/explain?word=&context=&language=en&monolingual=false[&prompt=]
        → ReadableStream 逐块 enqueue
        → 前端 res.body.getReader() + TextDecoder 逐块 setState
        → 光标动画 + 内容区自动滚动
```

**为什么不是打开弹层就自动调 AI？** 因为 80% 的点词词典就够，自动调 = 每次点击都烧钱、都在等首字。用户主动点按钮是成本闸门，也是 Readlang 的设计（Explain 是显式的第二个动作）。

### 5.2 context 是怎么来的

```ts
function sentenceOf(anchor) {
  const prefixSent = anchor.prefix.replace(/^.*[.!?]\s*/, "");  // 砍掉前一句
  const suffixSent = anchor.suffix.replace(/\s*[.!?].*$/, "");   // 砍掉后一句
  return `${prefixSent}${anchor.quote}${suffixSent}`.trim() || anchor.quote;
}
```

只取**当前这一句**。这是刻意的取舍，理由见 8.2。

### 5.3 Prompt 结构（`lib/ai.ts`）

| 模式 | system | user |
|---|---|---|
| 默认（中文解释） | 你是一位语言教师，帮助中文母语者学习英语…重点解释当前语境下的含义…用 Markdown 输出 | 请解释 "bank" 在下面这句话中的含义："…" 请给出：词性、当前语境下的意思、用法说明 |
| monolingual | Explain words and phrases IN ENGLISH…focus on the one that fits the context | Explain the word "bank" as used in this sentence… |
| 追问（prompt） | 同上 | `Word/phrase: "bank"\nContext sentence: "…"\nQuestion: 这个词还有别的用法吗？` |

**追问时 word 和 context 仍然带上**——这是「上下文感知追问」和「泛泛问一个词」的区别。

参数：`model: deepseek-chat`、`stream: true`、`temperature: 0.3`（释义要准不要发散）、`max_tokens: 800`。

无 `DEEPSEEK_API_KEY` 时 `getClient()` 返回 `null`，generator 直接 yield 一段提示文案并 return——**不抛错、不白屏**。前端看到的就是一段普通文本。

### 5.4 流式的实现细节

服务端（`api/explain/route.ts`）：

```ts
new ReadableStream({
  async start(c) {
    for await (const chunk of streamExplain(params)) c.enqueue(encoder.encode(chunk));
    c.close();
  }
})
→ headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" }
```

客户端：

```ts
const reader = res.body.getReader();
const decoder = new TextDecoder();
let text = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  text += decoder.decode(value, { stream: true });   // stream:true 处理多字节字符被切断
  setAiText(text);
}
```

两点注意：

- `decode(value, { stream: true })` 是必须的。中文字符 3 字节，可能被切在两个 chunk 中间，不加会出乱码。
- **Content-Type 写的是 `text/event-stream`，但 body 没有 `data:` 帧**。前端直接读 `res.body` 所以能用；若要换成标准 `EventSource`，需要在服务端加 `data: ` 前缀 + `\n\n` 分隔，并在客户端按事件解析。这是已知的不一致（README 限制章节也记了）。

---

## 6. 链路四：收词与去重

```
弹层「+」按钮
  │  onSave(aiStatus === "done" ? aiText : undefined)   ← AI 释义顺带存成 ai_gloss
  ▼
POST /api/words { word, textId, paragraphId, start, end, quote, prefix, suffix, aiGloss? }
  │
  ├ 校验 textId / paragraphId 存在（404 兜底）
  ├ lookup(word) → lemmaForm / phonetic / translation / pos
  │   translation 优先级：词典释义 > aiGloss 前 500 字 > "(待补充释义)"
  ├ db.transaction:
  │    ├ 按 lemma 查 user_words
  │    │    ├ 命中 → 更新（更好的 phonetic / translation 覆盖旧的）
  │    │    └ 未命中 → 插入
  │    └ 无条件 insert contexts（同一词不同位置 = 多条）
  └ 返回 { lemma, displayForm, translation }
  ▼
前端：setSavedSet(add lemma + displayForm) → 立即高亮 + celebrate("+1 词") + 进度条 +1
```

**幂等性**：重复收同一个词 → `user_words` 仍 1 行，`contexts` 多 1 行。这是设计意图（同一个词在不同文章里出现，每处上下文都值得保留），实测已验证。

**高亮**：`Para` 用 `savedLemmas.has(text.toLowerCase())` 判断。这里按**显示形式**匹配而非 lemma——因为前端不做词形还原（那是词典层的事）。所以收 `rained` 后，文章里的 `rain` 不会立刻高亮。接受这个精度损失，换取「前端零依赖」。

**删除**：`DELETE /api/words/{id}` 显式删 contexts 再删词（`onDelete: cascade` 在 better-sqlite3 下不一定触发，不赌）；带 `?contextId=` 时只删单条上下文。

---

## 7. 链路五：统计与游戏化

`lib/stats.ts` 一次查询拿全：

```sql
-- 文本数与总词数（texts 聚合）
-- 收词总数（user_words 计数）
-- 按天聚合（contexts join user_words，group by date(created_at/1000,'unixepoch','localtime')）
```

`created_at` 存 epoch 毫秒，转本地日期必须 `/1000` 再 `'localtime'`，否则跨时区会把今天算成昨天。

- **每日目标**：`max(20, round(wordCount * 0.05))` —— 读 400 词的文章目标 20 词，读 4000 词的目标 200 词。按文章长度自适应，避免短文本永远「完不成」。
- **streak**：从今天往回数连续有收集的天数（`stats/page.tsx` 内联计算）。
- **XP**：`todayCount * 10`，纯展示，没有经济系统。

游戏化只做**反馈**，不做**惩罚**：没有掉命、没有 streak 断签警告。这是产品判断（见 README 2.3），不是没做完。

---

## 8. 关键取舍与论证

### 8.1 为什么不用 `Intl.Segmenter`

它有中文分词、词边界更准，但**结果依赖运行环境的 ICU 版本**：Node 侧和 Chrome 侧可能切得不一样。SSR 渲染出的 DOM 结构与客户端 hydrate 时不一致 → React 19 直接丢弃整棵树重建（hydration mismatch），长文本下表现为闪烁、点击错位，甚至事件绑定失效。

现在用一条正则（`tokenize.ts` 的 `TOKEN_RE`），覆盖拉丁扩展（含带变音符号的 `\u00C0-\u024F`）、连字符/撇号复合词、以及 CJK 单字。**同一输入永远同一输出**，这是能在长文本上跑通的前提。

代价：中日韩按字切。要做中文阅读，必须换成一个纯 JS、跨环境确定性的分词器（如 `jieba-wasm` 固定词表版本）。

### 8.2 为什么 context 只用一句话，不用整段/整篇

| 级别 | token 成本 | 释义质量 | 结论 |
|---|---|---|---|
| 句子 | 1x | ⭐⭐⭐⭐ | ✅ 默认 |
| 段落 | 3–5x | ⭐⭐⭐⭐½ | ❌ 边际收益不值 |
| 全文 | 50–100x | ⭐⭐⭐⭐½ | ❌ 完全不值 |

一个句子已经是完整语义单元（搭配、语法角色、情境都在里面）。段落只在「代词指代」「跨句因果」这类场景有增量价值，而增量大约 5%、成本 +300%，还会拉高首字延迟——首字延迟直接杀死「点词即出」的手感。

Readlang 十年也选了同一档。真要补，正确做法是**追问时**把段落作为附加 context，而不是默认带。

### 8.3 为什么用 OpenAI SDK 调 DeepSeek

DeepSeek 官方文档第一句就是：API 格式兼容 OpenAI/Anthropic，改配置即可用 OpenAI SDK 访问。它自己没有独立的 Chat SDK。

我们只需要「发一次 chat completion，流式拿文本」——这就是个 HTTP 客户端的事。引入 LangChain / Vercel AI SDK / DeepSeek Harness 都属于用电梯送快递。

（顺带澄清一个易混点：**OpenAI SDK 不是 Agent Runtime**。它不跑 Agent Loop、不自动执行 tool call、不管多轮状态。我们当前的释义和未来的导墨墨都不需要 Agent Loop——都是「用户点按钮 → 确定性代码 → 拼参数调 API」。什么时候需要？当用户能用自然语言下复合指令时，比如「把我昨天读的文章里的动词都导出」。）

### 8.4 为什么 SQLite + 内联建表 SQL

- 单用户、单机、数据量在万级 → 任何服务端数据库都是过度设计。
- 备份 = `cp data/lexreader.db`；迁移 = 拷两个文件。
- 不用 migration 框架：`CREATE TABLE IF NOT EXISTS` 内联在 `db/index.ts`，启动即建表，克隆下来 `npm run dev` 就能跑。

代价：schema 变更需要在 `schema.ts` 和 `SCHEMA_SQL` 两处同步改，且没有版本记录。表结构稳定前可以接受；一旦有真实用户数据，应切到 `drizzle-kit generate/migrate`。

### 8.5 为什么建表要重试

Next dev 热重载会让多个模块实例几乎同时求值 `db/index.ts`。`CREATE TABLE IF NOT EXISTS` 幂等，但**并发写会撞锁**。于是加 5 次指数退避重试（100/200/400/800ms）。

> 这段现在的退避用的是忙等 `while (Date.now() < until) {}`，会阻塞事件循环。正确写法是同步 sleep（`Atomics.wait`）或把初始化改成 lazy + async。属于「能用但不优雅」，改的时候注意别引入新的初始化竞态。

### 8.6 词典库与用户库分成两个文件

`data/dict/ecdict.db` 以 `readonly + query_only = ON` 打开，`data/lexreader.db` 可写。

好处：词典是「可再生的大文件」（94MB，脚本 3 秒重建），用户数据是「不可再生的小文件」（64KB）。分开后可以单独备份/删除/替换，也不会因为词典写入把用户库锁住。

---

## 9. 踩坑记录

这些坑都真实踩过，写下来避免重复踩。

### 9.1 hydration 失败（长文）

**现象**：长文（1.3 万词）页面报 hydration mismatch，整棵树重建。
**原因**：`Intl.Segmenter` 在 Node 与 Chrome 上切分结果不同。
**修法**：换确定性正则分词（8.1）。

### 9.2 SQLite `disk I/O error`

**现象**：改代码后所有页面 500，报 `disk I/O error`；`-wal` / `-shm` 文件消失，磁盘空间充足。
**误判过程**：先怀疑 WAL 不被 sandbox 支持（实测可用）→ 再怀疑多进程并发写（实测并发写正常）→ 最后定位到 **Next dev 热重载累积的僵尸连接**，dev server 进程本身持有已损坏的连接。
**修法**：重启 dev server 即恢复。同时加了防御（都保留）：

- 连接挂 `globalThis.__lexreaderSqlite` 单例，热重载不新建连接；
- `busy_timeout = 10000`；
- 建表 SQL 退避重试；
- `synchronous = NORMAL`（WAL 下安全且快）。

**教训**：出现「之前好的、改完就挂、重启就好」的数据库错误，先怀疑 dev server 状态，再怀疑代码。

### 9.3 `http_proxy` 拦截 localhost

**现象**：Chrome CDP 连不上、Node `fetch('http://localhost:3000')` 502、脚本超时。
**原因**：本机设了 `http_proxy`，`localhost` 也被代理。
**修法**：`NO_PROXY=localhost,127.0.0.1`；curl 用 `--noproxy '*'`。写任何本地验证脚本时默认带上。

### 9.4 Chrome 156 的 `/json/new` 端点

**现象**：截图/自动化脚本创建 tab 失败。
**原因**：新版 Chrome 对该端点的方法/可用性有变化（PUT→GET，headless 下行为不同），程序化创建 target 更稳的方式是走 browser-level CDP 的 `Target.createTarget`。
**结论**：自动化优先用 `Target.createTarget` + 页面自己的 WebSocket（Node 22+ 内置 `WebSocket`，不用引 ws 库）。

### 9.5 弹层被视口截断

**现象**：点击页面上方的词，弹层往上翻时标题栏被切掉。
**原因**：只处理了「下方空间不够」，没处理「上方空间也不够」；且用 `bottom` 定位时高度自适应无法预先计算。
**修法**：去掉 `bottom`，统一 `top + maxHeight` 的纯 CSS 约束（4.5）。

### 9.6 按钮过大挤占内容

**现象**：两个 49px 高的大按钮吃掉 110px，弹层里 AI 长文本几乎没地方显示。
**修法**：收词降级为标题栏 30×30 图标按钮；AI 按钮进固定底栏；新增 `.duo-btn-sm`（padding 7×12、字号 13、圆角 10）。总高 430 → 317px。

---

## 10. Readlang 逆向结论

从它的 `app.js` 与官方博客整理，作为我们设计的参照系。

### 10.1 接口

| 层 | 接口 | 参数 | 返回 |
|---|---|---|---|
| 1. Translate | `POST /api/translate` | `{source, target, q, context}` | `{translations: []}` |
| 2. Context Translation | 同上（服务端切换） | 同上，`context` 为整句 | 同上 |
| 3. Explain | `GET /api/smartDictionary` | `query, context, language, explanationLanguage` | **SSE 纯文本流** |
| 3b. Ask AI | `GET /api/smartDictionary/askAI` | `language, word, context, prompt` | 纯文本 |

细节：

- `context` 不是可选参数，每次调用都带，值是**点击位置所在的那一句**。
- Explain 的 `explanationLanguage` 双模式：`showInFirstLanguage ? 用户母语 : 目标语言` —— 后者就是「用英语解释英语」。
- 状态码语义：`204` = 该词已有缓存（dismissed），`403` = 触发限额。免费版每天 10 次 Explain。
- 缓存：内存 `RA(key)` 读 / `LA(key, result)` 写；`cacheOnly: true` 只查缓存（词库页回看用）。
- 模型分层：Premium 用 GPT-4o mini，Premium Plus 用 GPT-4o。

### 10.2 卡片体系（博客《The Readlang Method for Learning Vocab》）

只有两种练习形式，但它们是**同一张卡的两个阶段**：

| 模式 | 正面 | 回忆目标 |
|---|---|---|
| Passive | 目标语言词 + 上下文句 | 母语释义 |
| Active | 上下文句**挖空** + 释义 | 原词 / 短语 |

流程：抽高频词 → Passive 答对 → 翻成 Active（cloze）→ Active 也答对才移出牌组 → 全部完成显示各词下次复习日期。

**没有选择题、没有匹配题。**

### 10.3 我们与它的差异

| 行为 | Readlang | 我们 | 理由 |
|---|---|---|---|
| 第一反应 | Translate API | ECDICT 本地词典 | 免费、<5ms、只做中→英所以词典够用 |
| 词典不够 | 用户点 Explain | 用户点「AI 解释」 | 同为显式升级 |
| AI 解释 | SSE，可目标语言/母语 | 同 | 保留 monolingual |
| 整句/短语 | Translate API | 直接 AI | 词典查不了短语 |
| Ask AI | 独立输入框 | 独立输入框 | 可追问 |
| 卡片类型 | 2 种（问答 + cloze） | 3 种（+选择题） | 墨墨原生支持选择题，是超额能力 |

关键判断：Readlang 不做本地词典是因为它要覆盖 119 种语言对，没有词典能全覆盖；我们只做中→英，77 万词条的 ECDICT 白捡，能省掉约 80% 的 AI 调用。**架构照抄，成本结构按自己的场景优化。**

---

## 11. 链路六：导出墨墨记忆卡

### 11.1 墨墨开放 API 的真实边界（推翻了原设计）

最初的设计是「我们建章节，逐张塞卡」。实测发现这条路走不通 —— **开放 API 只能写卡片和媒体**：

| 想做的事 | 能不能做 | 后果 |
|---|---|---|
| 建 / 改 / 删 **牌组** | ❌ | 牌组必须在 App 或网页端手工建 |
| 建 / 改 / 删 **章节** | ❌ | 章节也必须手工建 |
| 删 **卡片** | ❌ | 推错的卡片只能在 App 里手删 |
| 建卡片 | ✅ | 只能追加到已有章节 |

所以设计从「我们负责建结构」改成了「**用户选结构，我们只负责写**」：导出页做成「牌组下拉 → 章节下拉 → 选卡片类型 → 预览 → 写入」。

另外两个实测坑（写错会直接 4xx）：

- **创建卡片的请求体必须省略 `deck` / `chapter`**。文档标它们必填，但服务端按 24 位 ObjectId 校验，而开放 API 从不暴露 ObjectId → 传了必报 `not a valid ObjectId`。牌组和章节由 URL 路径决定。
- **不要传 `order`**。它是相对整个章节的 0 基插入索引；往非空章节从 0 递增会把新卡全插到旧卡前面。省略即按提交顺序追加到末尾。

### 11.2 三种卡片

| 卡片 | 正面 | 背面 | 语法要点 |
|---|---|---|---|
| `qa` 看词猜义（≈ Passive） | 词 + 音标 + 出处 + 原句（词标蓝） | 释义（首行红、其余灰） | `[P#H1,center#…]` 标题 + `---` 答案线 |
| `cloze` 挖空填空（≈ Active） | 原句挖空 + 释义提示 | 原词 + 释义 | 句中 `[F#1#word]` |
| `choice` 选择题（Readlang 没有） | 原句挖空 + 4 个候选词 | 答案 + 释义 | `[Choice##` + `* `/`- ` 选项 + 独占一行的 `]` |

三种都是**确定性拼装**：词、音标、释义、原句全部来自数据库，干扰项来自 ECDICT，**不经过 AI**。

### 11.3 原句从哪来（别用 40 字符的前后文）

`contexts` 只存了 `prefix/suffix` 各 40 字符 —— 长句会被截断成半句，卡片正面就废了。所以导出时回到 `paragraphs.content` 重新定位：

```
resolveAnchor(段落原文, {start, end, quote, prefix, suffix})   ← 三级降级定位
  → 命中：sentenceAround(段落原文, s, e)                       ← 按 . ! ? 向两侧扩成整句
  → 未命中：这个词直接标失败，不生成卡（宁缺，不要做出一张引用了错句子的卡）
```

`sentenceAround` 同时返回目标词在句内的偏移，供模板精确地「把词包起来 / 替换成空格」——不能靠 `replace(word, ...)` 字符串替换，一个词在一句里出现两次就会替换错位置。

### 11.4 卡片语法是最容易翻车的地方

Markji 语法写错**不会报错**，只会静默渲染成一团乱码，而且卡片删不掉。所以做了两道闸：

**第一道：`cardgen.ts` 里的 `lintCard()`（发送前）**

- 有且只有一条 `---`（答案线）
- 方括号配对（跳过 `\[` 转义）
- 没有残留 `**` / ``` ``` ``` / HTML 标签
- `[P#…]` / `[Choice#…]` / `[E##…]` 这类块级标签必须顶格

**第二道：写库前人工看预览**

`POST /api/export { dryRun: true }` 返回真正要发送的原始语法全文，页面用 `<pre>` 摊开。

开发期间还有第三道：`npm run verify:cards` 会把生成的卡片写到 `/tmp/cards`，可以逐张过 `markji.py lint`（官方语法校验器）。实测 9 张全部通过。

最容易踩的三个具体坑：

1. **ECDICT 的释义用字面量 `\n`（反斜杠 + n）分隔多行**，不是真实换行。不还原会渲染出 `n. 夜\n[法] 夜` 这种东西 → `lib/text.ts` 的 `normalizeTranslation()`。
2. **释义里有中括号**（`[医] 库`、`[法] 夜`），普通文字里的 `[` `]` 必须转义成 `\[` `\]`，否则提前闭合外层标签 → `esc()`。
3. **干扰项不能纯随机**。77 万词条里随机抽会抽到 `piasters` / `batisse` 这种，选项一眼假。用 `frq`（COCA 词频排名）过滤出常用词，再按「同词性 + 长度 ±2」筛。

### 11.5 幂等：不是防御性编程，是唯一的安全网

墨墨没有删除接口，重复推送 = 往牌组里堆垃圾且无法清理。所以幂等做在数据库层，而不是靠调用方的 if：

```
exports 唯一索引 (user_word_id, deck_id, card_type)
   ↓
推送前：查出该牌组内所有 status=done 的键 → 命中即 skipped
推送后：insert ... onConflictDoUpdate → done + card_id + pushed_at
失败：  → failed + error（下次可重试，因为不是 done）
```

`card_type` 是后加的列 —— 老库（`exports` 只有 word+deck 唯一键）由 `db/index.ts` 的 `migrate()` 补列并重建索引，可重复执行。

### 11.6 限速与配额

```
createCard() 内部串行闸门：writeChain.then(() => sleep(600ms) → fetch)
```
600ms 对应「10 秒 20 次」的硬上限（500ms 理论值留了余量）。另外按天计数封顶 600 条，超了就在结果里逐条标失败并提示明天继续。

**串行而不是并发**是有意的：并发抢频控会得到 429，重试还会打乱顺序；串行虽然慢（3 张卡 ≈ 2 秒），但结果可预测。

### 11.7 一个词的失败不应该拖垮整批

错误分两类处理：

- **5xx / 网络抖动** → 记 `failed`，继续下一个词（下次可重试）
- **4xx（401 令牌失效、400 参数错）** → 立刻停止整批并返回错误。继续跑只会刷出一堆同样的失败记录，还白占配额。

---

## 12. 验证方法

没有测试框架，靠三层验证。改完代码至少跑前两层。

### 12.1 类型检查

```bash
npx tsc --noEmit          # 必须零错误
```

### 12.2 离线验证卡片（P4 之后新增）

```bash
npm run verify:cards      # 收词 → 生成三种卡片 → 语法自检 → 输出到 /tmp/cards
npm run verify:markji     # 用自研客户端只读列牌组/章节，验证鉴权与信封解析
```

`verify:cards` 走的是真实的 DB 数据与真实模板，跑完可以再逐张过官方校验器：

```bash
python3 ~/.workbuddy/skills/markji/scripts/markji.py lint /tmp/cards/xxx-qa.txt
```

这样即使不启动 dev server、不写入墨墨，也能确认模板语法合法。

### 12.3 API 级回归（curl，注意绕代理）

```bash
curl -s --noproxy '*' "http://localhost:3000/api/dict?word=went"     # 期望 lemmaForm: "go"
curl -s --noproxy '*' "http://localhost:3000/api/dict?word=bank"     # 期望多义项
curl -s --noproxy '*' "http://localhost:3000/api/dict?word=river%20bank"  # 期望 entry: null
curl -s --noproxy '*' "http://localhost:3000/api/explain?word=bank&context=..."  # 无 key 时应返回提示文案
curl -s --noproxy '*' "http://localhost:3000/api/export"             # 导出状态：tokenReady / 各类计数
curl -s --noproxy '*' "http://localhost:3000/api/markji/decks"       # 牌组列表（token 有效时）
curl -s --noproxy '*' -X POST http://localhost:3000/api/export \
  -H 'content-type: application/json' \
  -d '{"types":["qa","cloze","choice"],"dryRun":true}'               # 只看卡片原文，不写入
for p in / /words /export /stats /texts/<id>; do curl -s -o /dev/null -w "$p %{http_code}\n" --noproxy '*' "http://localhost:3000$p"; done
```

收词幂等的验证：同一个词 POST 两次，然后查 `user_words` 应为 1 行、`contexts` 应为 2 行。
导出幂等的验证：同一批 dryRun 后再 dryRun，第二次 `summary.skipped` 应等于上次的 `pushed`。

### 12.4 交互级（CDP 驱动真实 Chrome）

启动带调试端口的 Chrome，用 `Target.createTarget` 开页，`Runtime.evaluate` 里直接点 `.w` 元素、读弹层 DOM 尺寸：

```
点击 .w → 弹层出现 → 标题为词 → 收词按钮存在
点收词 → 进度条 0/20 → 1/20 → 文案「再收集 19 个」→「+1 词」飘出
注入超长文本到 AI 区 → overflowsViewport === false
```

**经验**：小窗口下 `vh` 可能只有 469px，弹层 `maxHeight` 的实测值会跟着变——验证时要打印 `vh`、`top`、`clientHeight`，不要只看截图。

**注意**：Next 16 dev 启动时会清理 `.next/dev/logs`，如果进程被限制删除（沙箱、只读盘），dev server 会直接退出，报 `safe-delete broker denied delete`。这种情况下要换个终端/不受限的环境启动，而不是改代码。

---

### 12.4 真实写卡（不可逆，只在用户明确同意后跑）

```bash
npm run push:one -- list                                   # 列牌组/章节（只读）
npm run push:one -- push <词> qa <deckId> <chapterId> --dry # 只打印全文，不写
npm run push:one -- push <词> qa <deckId> <chapterId>       # 真写一张
```

`scripts/push-one.ts` 复用 `buildCard` / `lintCard` / `createCard`，和 `/api/export` 走同一套逻辑，
只是把取数写短。它存在的原因是：某些受限环境里 dev server 起不来（Next 启动时要删
`.next/dev/cache/**/*.del`，会被安全策略拒绝），但「墨墨到底收不收这张卡」只能用真实请求验证。

写之前的闸门和路由一致：语法自检不过不写、`exports` 里已有 `done` 记录就直接拒绝
（除非 `--force`）。**墨墨没有删除端点，写错只能去 App 里手删**，所以这两道闸门不能省。

已验证过的结果（2026-11-02）：写入后 `GET /decks/{deck}/cards/{card}` 回读的 content
与提交内容逐字一致，`grammar_version` 为 3，章节卡片数 +1。

## 13. 代码地图与改动指引

| 想改什么 | 改哪里 | 注意 |
|---|---|---|
| 换 AI 供应商 | `lib/ai.ts` 的 `getClient()`（baseURL/apiKey/model） | 保持 OpenAI 兼容即可，其余不用动 |
| 改 prompt | `lib/ai.ts` 的 `buildSystemPrompt` / `buildUserMessage` | monolingual 分支和 prompt 分支要同步 |
| 加词典字段 | `lib/dict.ts` 的 SELECT + `DictEntry` + `Reader.tsx` 的 `DictView` | 三处同步 |
| 改分词规则 | `lib/tokenize.ts` 的 `TOKEN_RE` | 必须保持确定性（不能依赖环境） |
| 改切段规则 | `lib/split.ts` | ⚠️ 会让历史锚点失效，先读 3.2 |
| 改卡片版式 | `lib/cardgen.ts` 的 `buildQaCard` / `buildClozeCard` / `buildChoiceCard` | 改完必须跑 `npm run verify:cards` + 官方 lint |
| 加卡片类型 | `CARD_TYPES` 数组 + `buildCard()` 分支 + `exports.card_type` 取值 | 幂等键含 card_type，新类型天然不冲突 |
| 换卡片样式参数 | `cardgen.ts` 顶部的 `GREY` / `RED` / `BLUE` | 颜色是不带 `#` 的 6 位小写十六进制 |
| 加页面 | `src/app/<route>/page.tsx` + `duo-card` 等现成类 | 记得挂进 `layout.tsx` 与 `BottomNav.tsx` |
| 改视觉 | `src/app/globals.css` 的 CSS 变量 + `.duo-*` 类 | 颜色改变量，别硬编码 |
| 加表/字段 | `db/schema.ts` **和** `db/index.ts` 的 `SCHEMA_SQL` + `migrate()` | 三处必须一致（8.4 / 11.5） |

### 建议优先修的四件事

1. `lookup()` 的 lemma 判断（2.3 末尾）——影响词库去重质量。
2. `explain` 的 SSE 帧格式（5.4）——现在能用但是「假 SSE」，早晚要接标准事件流。
3. `db/index.ts` 的忙等退避（8.5）——阻塞事件循环，改动小、收益明确。
4. 导出改成后台任务（11.6）——现在是同步串行，词一多请求就长；应该有 job 表 + 进度轮询。
