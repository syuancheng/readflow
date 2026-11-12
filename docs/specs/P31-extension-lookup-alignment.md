# P31 实现说明：浏览器插件查词与网站阅读页对齐 + 词库「插件来源」标记

> 这份文档写给负责实现的开发者（或 AI 编程助手）。读完应能独立完成，不需要再问背景。
> 仓库：ReadFlow（Next.js 16 + React 19 + Tailwind 4 + SQLite/better-sqlite3 + drizzle），浏览器插件在 `extension/`（Chrome MV3，原生 JS）。

---

## 0. 开工前必读

1. **先读 `AGENTS.md`**：这是 Next.js 16，和你训练数据里的版本不同。
   - `middleware` 改名为 `src/proxy.ts`。
   - 页面的 `searchParams` 和 `params` 是 Promise，必须 `await`。
   - 路由文件（`route.ts`）**只能导出** `GET/POST/PUT/PATCH/DELETE/OPTIONS` 和 `runtime/dynamic` 这类配置，不能导出别的函数。共用逻辑放进 `src/lib/`。
   - 拿不准时，查 `node_modules/next/dist/docs/`。
2. **代码基线**：本需求基于 P30（每人一个插件 Token、插件「导入当前网页」、查词点击命中修复）。动手前确认工作区里有这些文件：
   - `src/lib/extension-tokens.ts`
   - `src/lib/extension-http.ts`
   - `src/app/api/extension/{dict,explain,import,words}/route.ts`
   - `src/lib/explain-handler.ts`
   - `src/lib/create-text.ts`
3. **设计规范**：
   - 读 `docs/design-system.md`，token 定义在 `src/styles/tokens.css`。
   - `npm test` 的第一步是 `scripts/check-tokens.mjs`：`src/` 下的 CSS 和 TSX 出现以下任何一种就会失败——裸 hex 颜色、阶梯外的字号、不是 4 的倍数的间距、自定义阴影。
   - 插件（`extension/`）不在检查范围内，但颜色和尺寸要**抄同一组数值**。`extension/src/popup.html` 顶部的 `:root` 变量就是现成的例子。
4. **不要破坏的已有行为**（都有测试）：
   - 插件单击查词只在「真的点在单词框里」时触发：`RFMatch.pointInRects`。
   - 点链接、按钮、输入框不查词：`INTERACTIVE`。
   - 点空白处关闭卡片：`closeCard`。
   - 网页上已存词的中文小标签平时隐藏、悬停才显示。
   - 导入网页时剔除 `#rf-ext-host`、`.rf-gloss`，并拆掉 `.rf-hl`：`background.js` 的 `snapshotPage`。
   - 插件所有对服务器的请求都**经 background service worker 发出**，content script 不直接 `fetch` 服务器。原因有两个：网站目前是 HTTP，在 HTTPS 网页里直接请求会被浏览器的混合内容规则拦截；另外由 background 统一带 Token。

---

## 1. 目标

### 1.1 插件查词 = 网站阅读页查词
插件里查词的内容、交互和规则与网站阅读页右栏完全一致。网站的实现在 `src/components/Reader.tsx` 的 `PickCard`、`DictView` 以及 `triggerAI` / `askOptions` 等函数里，**它是唯一标准**，遇到本文没写到的细节，一律以它为准。

当前插件和网站的差异：

| | 网站阅读页（标准） | 插件现状 |
|---|---|---|
| 点词后 | 自动记录（落库），右上角「取消记录」可撤销 | 要手动点「收进词库」 |
| 位置 | 右侧栏 | 鼠标旁的浮动小卡片 |
| 词条 | 单词、音标（可点读）、🔊、「原形」徽章、多行释义、可展开的英文释义、柯林斯星级 | 只有一行中文 |
| 词典查不到 | 自动请 AI 讲解（`shouldAutoExplain`） | 要手动点「AI 释义」 |
| 问 AI | 「✨ 问 AI ▾」展开选择题选项和自定义输入框，回答以对话串追加、流式显示 | 一个按钮，一次性返回 |
| 记录后 | AI 对话串存进这条记录（`contexts.ai_gloss`），悬停显示的中文取 AI 的「释义：」行 | 悬停显示词典释义 |

### 1.2 词库里能看出「这个词是从插件记的」，并能找回出处
- 词库来源一栏对插件记录的词显示 **「🧩 插件」** 标记。
- 点来源时：
  - 这个网页**整篇导入过** → 跳进阅读页，定位到那一段（和普通词一样）。
  - **没导入过** → 新标签页打开原网页，并用 Chrome 的文本片段链接（`#:~:text=`）滚动到那句话、高亮它。

---

## 2. 已定决策（要改就改这里，其余章节按此执行）

| # | 决策 | 取值 |
|---|---|---|
| D1 | 插件查词的显示位置 | **右侧滑出侧栏**，覆盖在网页上方，不挤压网页布局。宽 380px，高度占满视口 |
| D2 | 点词是否自动记录 | **自动记录**（同网站），「取消记录」撤销 |
| D3 | 记录挂在哪篇文章上 | 同一账号**已整篇导入过这个网址** → 挂到那篇文章对应的段落；否则挂到该网址的「网页摘录」（`texts.source_type='web'`） |
| D4 | 「网页摘录」是否出现在首页「我的文本」和战绩「读过的文本」 | **不出现**（它不是完整文章）；词库照常能看到 |
| D5 | 来源标记粒度 | 记在**每一条记录（context）**上：同一个词可以既在阅读页记过、又在插件记过 |

---

## 3. 数据模型

### 3.1 新增列 `contexts.via`
- `TEXT NOT NULL DEFAULT 'reader'`，取值 `'reader' | 'extension'`。
- 需要改三处：
  1. `src/db/schema.ts`：`contexts` 加 `via: text("via").notNull().default("reader")`。
  2. `src/db/index.ts` 的 `SCHEMA_SQL`：`CREATE TABLE contexts` 加这一列（这里保存的是完整的建表快照）。
  3. `src/db/index.ts` 的 `migrate()`：老库没有这一列时执行 `ALTER TABLE contexts ADD COLUMN via TEXT NOT NULL DEFAULT 'reader'`。然后**回填一次**：
     ```sql
     UPDATE contexts SET via = 'extension'
      WHERE via = 'reader' AND text_id IN (SELECT id FROM texts WHERE source_type = 'web');
     ```
     这段语句可以重复执行，只会修改原本是 `'reader'` 的行。
- 所有由插件写入的 context 都写 `via='extension'`，包括现有的 `POST /api/extension/words`。

### 3.2 `src/lib/word-store.ts`
- `saveWordAndContext` / `ensureContextByAnchor` 的入参加可选字段 `via?: "reader" | "extension"`，默认 `'reader'`，插入 context 时写入。
- `ensureContextByAnchor` 命中已有 context 时**不修改** `via`：最早是从哪里记的，就保留哪里。
- 新增 `deleteWordContexts(wordId, userId, { contextId?: string; textId?: string }): { prunedWord: boolean }`。把 `src/app/api/words/[id]/route.ts` 里 DELETE 分支的逻辑原样搬过来，包括：校验词条归属、删掉指定的 context、没有剩余 context 时连词条一起删并返回 `prunedWord`。原路由改为调用它，行为不变。

---

## 4. 服务端接口（插件专用）

### 4.1 通用规则
- 全部放在 `src/app/api/extension/` 下。`src/proxy.ts` 已经放行这个目录，不需要登录 cookie。
- 一律通过 `requireExtensionUser(req)` 按插件 Token 识别用户，响应用 `withCors()` 包一层，`OPTIONS` 返回 `preflight()`。这三个函数都在 `src/lib/extension-http.ts`。
- 出错时返回 `{ ok:false, error:"中文原因" }`，状态码按语义给：400 / 401 / 404 / 413 / 422 / 429。

### 4.2 新增 `src/lib/web-anchor.ts`（纯函数，必须写单元测试）

```ts
export function normalizeBlockText(s: string): string;
// 把各种空白（含  ）压成一个空格，并去掉首尾空白

export function stripHash(url: string): string;
// 去掉 #fragment，保留 query

export function locateInParagraphs(
  paragraphs: { id: string; content: string }[],
  block: string, start: number, end: number,
): { paragraphId: string; start: number; end: number } | null;
// 在已导入文章的段落里找到这个块，并把选区换算成段落内的坐标。
// 步骤：
//   1. 用 normalizeBlockText 处理过的块文本，与每个段落的 content（同样归一化）比较：
//      先找完全相等的，再找「段落包含这个块」或「块包含这个段落」的。
//   2. 坐标换算：quote = block.slice(start, end)。在命中段落的 content 中找 quote 出现的位置；
//      有多处时，取前文（quote 前 30 个字符）匹配最好的那一处。
//   3. 返回的坐标必须满足 content.slice(start, end) === quote。找不到返回 null。
// 注意：paragraphs.content 是阅读页坐标的唯一基准（见 src/db/schema.ts 注释），绝不能改它。

export function textFragmentUrl(sourceUrl: string, quote: string, prefix: string, suffix: string): string;
// 生成 Chrome 文本片段链接：`${stripHash(sourceUrl)}#:~:text=${p}-,${q},-${s}`
// 其中 p 是 prefix 末尾最多 3 个词，s 是 suffix 开头最多 3 个词；为空时省略对应部分及其分隔符。
// 每一部分都用 encodeURIComponent 编码，并且要额外把 "-" 编码成 %2D、"," 编码成 %2C，
// 因为这两个字符在文本片段语法里有特殊含义。
```

### 4.3 `POST /api/extension/record`：点词自动记录（对应网站的 `/api/contexts/ensure`）

请求体：
```jsonc
{
  "word": "bloating",          // 选中的原文（单词或短语），1–120 字符
  "block": "…整段文本…",        // 选区所在块元素的文本，已用 normalizeBlockText 处理，最多 4000 字符
  "start": 123, "end": 131,    // 选区在 block 里的坐标，满足 block.slice(start, end) === word
  "url": "https://…",          // location.href
  "title": "页面标题",
  "source": "word",            // "word" = 单击，"select" = 拖选
  "repeatCount": 1             // 同一句里第几次请教（插件本地统计，见 §5.6）
}
```

处理流程：
1. 校验参数。只接受 http(s) 网址；`url = stripHash(url)`。
2. **决定锚点挂在哪篇文章上（决策 D3）**：
   - 查当前用户 `source_type='url'` 且 `stripHash(source_url) === url` 的文章，取最新一篇；读出它的段落，用 `locateInParagraphs` 定位。命中就用这个 `textId / paragraphId / start / end`。
   - 没有这篇文章或没定位到：用这个网址的「网页摘录」。查找条件是 `user_id`、`source_url = url`、`source_type = 'web'`，没有就新建一条（标题用 `title`）。在摘录里找 `content === block` 的段落，没有就追加一段（`idx` 取当前最大值 +1，`blockType` 为 `'paragraph'`）。坐标直接用请求里的 `start/end`。
   - 现有 `POST /api/extension/words` 里建摘录、追加段落的代码可以抽出来复用。它已经限定了 `source_type='web'`，不会往整篇导入的文章末尾追加段落。
3. 生成锚点：`buildAnchor(paragraph.content, start, end)`（`src/lib/tokenize.ts`，与阅读页同一个函数，前文和后文按句子边界截取），得到 `quote / prefix / suffix`。然后调用 `ensureContextByAnchor({ word, textId, paragraphId, ...anchor, via:"extension" }, user.id)`。这一步**按锚点幂等**：同一处重复点不会多建记录。
   发给 AI 的前文和后文是另一套规则：用 `aiContextOf(paragraph.content, start, end, { prevParagraph })`（`src/lib/sentence.ts`）计算，`prevParagraph` 取同一篇文章里的上一段。阅读页的做法见 `Reader.tsx` 里调用 `aiContextOf` 的地方。
4. 查词典：调用 `lookup(word)`（`src/lib/dict.ts`）。
5. 判断要不要自动讲解：调用 `shouldAutoExplain({ dictHit: !!dict.entry, hasInitialGloss: !!已有记录的aiGloss, fromAnnotation:false, repeatCount })`（`src/lib/explain-policy.ts`）。**这个判断只在服务端做**，插件不要自己再实现一份。
6. 组装讲解信号：调用 `selectionSignals(paragraph.content, start, end, source)`（`src/lib/sentence.ts`），再补上 `repeatCount`。

响应：
```jsonc
{
  "ok": true,
  "wordId": "…", "contextId": "…",
  "textId": "…", "paragraphId": "…", "start": 0, "end": 0,
  "quote": "bloating", "prefix": "…", "suffix": "…",
  "dict": { "entry": {…} | null, "originalForm": "bloating", "lemmaForm": "bloat" },
  "thread": [ { "ask": "…", "text": "…" } ],  // 已有记录里存过的 AI 对话串（parseThread 解析），没有就是 []
  "autoExplain": true,
  "aiContext": { "prefix": "…", "suffix": "…", "withPrevSentence": false }, // 问 AI 时作为 prefix/suffix/withPrevSentence 发送
  "signals": { … },          // 原样转发给 /api/extension/explain
  "imported": true           // 是否挂到了整篇导入的文章上（true = 词库点来源会进阅读页）
}
```

### 4.4 `DELETE /api/extension/record?wordId=…&contextId=…`：取消记录
- 调用 `deleteWordContexts(wordId, user.id, { contextId })`，返回 `{ ok:true, prunedWord }`。
- 词条不属于当前用户时返回 404，不要返回 403，避免暴露别人的数据存在。

### 4.5 `POST /api/extension/gloss`：保存 AI 对话串（对应网站的 `/api/contexts/gloss`）
- 请求体：`{ contextId, turns: [{ ask?: string, text: string }] }`。
- 服务端先过滤掉 `isNotAGloss(text)` 为真的段落，再用 `serializeThread(turns)`（`src/lib/ai-thread.ts`）拼成字符串，调用 `applyGlossToContext(contextId, 串)`。
- 写之前**校验这条 context 归当前用户**：沿 context → user_words.user_id 查。
- 过滤后对话串为空时什么也不写，直接返回 `{ok:true}`。

### 4.6 `POST /api/extension/explain`（已有，需要扩展）
- 请求体与 `/api/explain` 相同，包括 `prompt` 和 `signals`。插件发送 `word = quote`，`prefix/suffix/withPrevSentence` 取自 `/record` 返回的 `aiContext`，`signals` 原样带上；拼法与 `Reader.tsx` 的 `triggerAI` 完全一致（`dictHit`、`forceWord` 清零 `repeatCount` 这些细节也照抄）。
- 「整句没看懂」这一项与网站一样：`word = 整句`、`prefix/suffix` 为空、不带 `signals`。
- 返回 `text/event-stream`。如果流里出现 `STREAM_RESET`（`src/lib/config.ts`），要丢掉它之前已经收到的内容。
- 用站点模型时会扣每日免费次数，429 表示今天的次数用完；这些逻辑已经在 `handleExplain` 里。

### 4.7 `GET /api/extension/word/:id`：点已存词的高亮时回看
- 返回这个词**最新一条** context 的回看数据，格式与 `/record` 的响应相同（`dict` 用 `contexts.dict_entry` 快照，`thread` 来自 `ai_gloss`），另加 `autoExplain:false`。
- 这一步不查词典，也不调 AI。这与网站点回绿色划线的回看逻辑一致，见 `Reader.tsx` 的 `recall` 分支。

### 4.8 `GET /api/extension/words`（已有，需要调整）
- 每个词的 `gloss` 字段改为 `inlineGloss(最新 context 的 aiGloss, translation) || shortGloss(translation)`。这两个函数都在 `src/lib/gloss.ts`。这样网页上悬停时显示的中文与阅读页一致，优先用 AI 的「释义：」行。

---

## 5. 插件端

### 5.1 文件
- `extension/src/content.js`：选词、侧栏 UI、调用 background。查词卡片相关代码重写，其余保留。
- `extension/src/background.js`：新增消息类型和流式转发，见 §5.5。
- `extension/src/content.css`：只放注入到网页正文里的高亮样式，侧栏样式写在 shadow DOM 里。
- `extension/src/matcher.js`：纯函数都放这里，方便在 Node 里做单元测试。
- `extension/manifest.json`：`version` 改为 `0.3.0`。

### 5.2 侧栏（决策 D1）
- 挂在现有 `#rf-ext-host` 的 **shadow root** 里，`position:fixed; top:0; right:0; height:100vh; width:380px`，白底，左边一条 1px 线，阴影用 `0 24px 64px rgba(24,36,58,.18)`，`z-index` 用最大值。
- 滑入、滑出用 200ms 动画。
- 内容超出高度时**侧栏内部**滚动，不影响网页滚动。
- 关闭方式：右上角 × 按钮、`Esc`、点网页空白处（复用现有 `closeCard`，改名为 `closePanel`）、再点一次同一个词。
- 打开侧栏时**不移动、不缩放**网页本身。
- 浮动工具条（`.rf-bar`）的位置不变。侧栏打开时它会被盖住，这是可以接受的。

### 5.3 侧栏内容（从上到下，与 `PickCard` 一一对应）
1. **标题行**
   - 左侧：选中的原文。字号 24px、加粗，最多 4 行，超出省略。
   - 下方一行：音标 `/…/`，可点击朗读，字体用 `-apple-system, "Segoe UI", sans-serif`，不要用等宽字体；音标先经过 `normalizePhonetic` 同款规则处理（见 `src/lib/text.ts`，需要移植到 `matcher.js`）。旁边是 🔊 按钮，用 `speechSynthesis`。
   - 右侧：「取消记录」按钮。拿到 `contextId` 之前禁用，悬停提示「正在保存…」。
2. **词典区**（同 `DictView`）
   - 加载中显示「查词典中…」。
   - 词形还原后不同（`lemmaForm ≠ originalForm`）时，先显示徽章 `bloat`，后面跟「← 原形」。
   - 中文释义：经过 `normalizeTranslation` 处理（把字面的 `\n` 还原成换行），保留多行，字号 16px、字重 600。
   - 「英文释义」做成折叠的 `<details>`，默认收起。
   - 「柯林斯」后面跟 ★×N，N 最多 5，用橙色。
   - 词典没有收录时显示：`{短语不在词典中｜词典未收录} · {交给 AI 老师解释｜可用 AI 解释}`，后半句取决于 `autoExplain`。
3. **AI 对话串**
   - 每问一次，下面追加一段：如果有问题标题（`ask`）就先显示它，再显示回答。
   - 回答边收到边显示（流式）。
   - Markdown 只需要支持：`**粗体**`、换行、以 `- ` 开头的列表、以 `释义：` 开头的行（加粗）。**必须先转义 HTML 再做替换**，禁止把模型输出直接塞进 `innerHTML`。
   - 失败的那一段显示错误原因和「重试」按钮（同 `retry`）。
4. **问 AI**
   - 紫色按钮「✨ 问 AI ▾」，样式与网站 `.rf-ai-primary` 一致：紫底 `#f5ecff`、紫字 `#7a3cc0`、紫边 `#ce82ff`，底边 4px。
   - 点开后是一列选项，**选项文案和 prompt 一字不差地从 `Reader.tsx` 的 `askOptions` 复制过来**，包括出现条件：
     - 「这个词／短语在这句里什么意思」：还没有默认讲解时才出现。
     - 「只讲这个词，不讲整句」：已有默认讲解且 `repeatCount ≥ 2` 时出现。
     - 「整句没看懂」：选中的不是整句时出现。
     - 「讲讲句子结构」。
     - 「再给个例句」。
     - 最后一行是「自己写个问题…」输入框，发送图标在框内右侧，回车也能发送。
   - AI 正在回答时，按钮禁用。
5. **上下文**：折叠的 `<details>`，默认收起。内容是前文、后文、来源网址，来源网址显示 host。

### 5.4 交互流程
- **单击一个词**（命中判断沿用现有的 `wordAtPoint` + `pointInRects`），或**拖选**一段文字（`isLookupSelection` 为真）：
  1. 找到选区所在的块元素：`closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, figcaption, pre")`。找不到时用最近的 `div`。
  2. 取块文本：`normalizeBlockText(block.textContent)`。注意要先排除插件自己加的 `.rf-gloss`：克隆一份，删掉 `.rf-gloss` 再取文本。
  3. 计算选区在块文本里的 `start/end`。可以用 `Range` 从块元素开头到选区开头的 `toString()` 长度来算，**算之前同样要排除 `.rf-gloss`**；然后对照 `normalizeBlockText` 的规则校正。最后用 `block.slice(start, end) === word` 校验，不相等就放弃记录，只查词典（降级）。
  4. 立刻打开侧栏，显示标题行和「查词典中…」。
  5. 发 `rf:record` 请求，拿到响应后渲染词典区，给「取消记录」按钮写入 `contextId`。
  6. 响应里 `autoExplain` 为真时，立刻发起默认讲解（相当于 `triggerAI({})`）。
  7. 每段 AI 回答结束后，把**所有成功的回答**整串发给 `rf:gloss` 保存，与网站 `onAIGloss` 的做法一致。
  8. 记录成功后发一次 `rf:sync` 刷新词表，网页上的高亮会随之更新。
- **点击已存词的高亮（`.rf-hl`）**：请求 `rf:word`（对应 §4.7），只读回看，不自动讲解。
- **取消记录**：发 `rf:unrecord`，成功后关闭侧栏并 `rf:sync`。
- 连续点不同的词时，**中止**上一个词还没完成的 AI 流（参考网站的 `aiAbortRef`），旧请求返回的结果不能渲染到新词的侧栏里。

### 5.5 background.js 消息
沿用 `rf:api` 的封装（自动带 Token、遇到 4xx 时取出 `error` 字段），新增：

| 消息 | 做什么 | 是否自动重试 |
|---|---|---|
| `rf:record` | POST `/api/extension/record` | 可以重试 1 次（按锚点幂等） |
| `rf:unrecord` | DELETE `/api/extension/record` | 不重试 |
| `rf:gloss` | POST `/api/extension/gloss` | 可以重试（覆盖写，幂等） |
| `rf:word` | GET `/api/extension/word/:id` | 可以重试 |
| `rf:explainStream` | **用 `chrome.runtime.connect` 建一个 port**：content script 发起，background 用 `fetch` 读流，每收到一块就 `port.postMessage({chunk})`，结束时发 `{done:true}`，出错时发 `{error}`。content script 断开 port 时 background 要 `abort()` 这个请求 | 不重试 |

### 5.6 同一句里的连续提问（`repeatCount`）
- 在 content script 内存里维护一个 `Map<句子文本, number>`，只在当前页面有效，刷新就清空。每次对同一句里的新选区发起记录，就把计数加 1，并随 `/record` 请求带上 `repeatCount`。
- 这是网站「同一句里连续查第 2 个词，自动追加整句讲解」规则的输入（见 `shouldAutoExplain` 和 `noteSelection`）。

---

## 6. 网站端：词库与列表

### 6.1 词库 `/words`
文件：`src/app/words/page.tsx`、`src/components/WordList.tsx`、`src/lib/word-library.ts`。

- 查询 contexts 时额外取出 `contexts.via`、`texts.source_type`、`texts.source_url`，并一路传到每条 context 和每个词上。
- **来源一栏**（`.wl-source`）：
  - 来源 context 的 `via === 'extension'` 时，标题前加一个徽章 **「🧩 插件」**，用中性灰 `.duo-badge` 样式。悬停提示：「通过浏览器插件在网页上记录」+ 完整网址。
  - 文章 `source_type === 'web'`（网页摘录）时，链接改成 `<a href={textFragmentUrl(sourceUrl, quote, prefix, suffix)} target="_blank" rel="noopener noreferrer">`，标题后面加一个 ↗ 表示站外链接。
  - 其它情况保持现状：`/texts/{textId}?p={paragraphId}`。
- **展开详情里的原句**：网页摘录的原句同样提供「在原网页中打开 ↗」。
- **左侧「文章」列表**：网页摘录用 🌐 图标，导入的文章仍用 📖。`articleOptions` 的返回值要加 `kind: "article" | "web"`。
- 「已导出」「星标」等筛选不受影响。

### 6.2 隐藏网页摘录（决策 D4）
- 首页「我的文本」列表、`GET /api/texts`、战绩页的「读过的文本」数量和书架列表，都过滤掉 `source_type = 'web'`。
- 用 `grep -rn "from(texts)" src/app` 找出所有列文章的查询，逐个检查。
- 摘录的数据和对应记录**保留不删**。

---

## 7. 测试与验收

### 7.1 单元测试（`tests/unit/`，`npm test` 会跑）
- `web-anchor.test.ts`：
  - `normalizeBlockText`：处理 ` ` 和多个空格。
  - `locateInParagraphs`：完全相等、互相包含、同一段里出现多次（靠前文区分）、找不到返回 null；每个命中都断言 `content.slice(start, end) === quote`。
  - `textFragmentUrl`：结果里含 `#:~:text=`，`-` 被编码成 `%2D`、`,` 被编码成 `%2C`，原网址里的 `#` 被去掉，前后文为空时也能正确拼接。
- `extension.test.ts`（已有）：补上新移植到 `matcher.js` 的纯函数，包括 Markdown 转义渲染：`<img onerror>` 必须原样以文本显示。

### 7.2 端到端：扩展 `scripts/e2e-extension.mjs`
沿用现有做法：隔离数据库、临时端口 3133、本地测试网页、真实 Chromium 加载插件。至少加入以下检查：

1. 单击网页上的一个词 → 侧栏打开，显示词条和词典释义；数据库里多出一条 `via='extension'` 的 context。
2. 「取消记录」→ 这条 context 被删掉。如果这个词再没有其它记录，词条也一起删掉。
3. 点一个词典查不到的短语（拖选两个词）→ 自动发起 AI 讲解。测试里用 `page.route` 或服务端假模型，**不调真实模型**；讲解完成后 `contexts.ai_gloss` 有值。
4. 「问 AI」的选项和网站一致：断言选项文案列表与 `askOptions` 相同。
5. 先把某个网址整篇导入，再在这个网页上点词 → context 挂在导入的那篇文章上（`texts.source_type='url'`），坐标满足 `content.slice(start, end) === quote`。
6. 在没导入过的网页上点词 → context 挂在 `source_type='web'` 的摘录上。
7. 词库页：插件记录的词显示「🧩 插件」；摘录类词的来源链接以 `#:~:text=` 结尾，并且 `target="_blank"`。
8. 首页「我的文本」里不出现网页摘录。
9. 原有的 C1–C7（点击命中）、B1–B7（导入）、A1–A13 全部仍然通过。

### 7.3 必须全部通过的命令
```bash
npx tsc --noEmit -p .
npm test                      # 含设计规范检查 + 单元测试
DB_PATH=<数据库快照> npm run build    # 构建时用快照，避免和本机正在运行的服务抢 SQLite 锁；做法见 deploy/release-local.sh
npm run test:word-library
npm run test:invite
npm run test:account
node scripts/e2e-extension.mjs
```

### 7.4 人工验收（在真实 Chrome 里）
1. `chrome://extensions` 里重新加载插件，版本号应为 0.3.0。
2. 打开一篇英文博客，单击一个词 → 右侧滑出侧栏，内容、顺序和措辞与网站阅读页右栏一致。
3. 点空白处侧栏关闭；点链接只跳转，不弹侧栏。
4. 到 ReadFlow「我的词库」，确认这个词带「🧩 插件」标记，点来源能回到原网页并高亮那句话。

---

## 8. 容易踩的坑

1. **坐标基准**：阅读页里 context 的 `start/end` 指的是 `paragraphs.content` 中的位置。插件提交的坐标必须先换算成这个基准（§4.2）。坐标错一位，阅读页的绿色划线就会画错位置。
2. **不要把插件自己加的东西当成正文**：`.rf-gloss` 小标签是插在网页 DOM 里的，算块文本和坐标之前要先剔除它。
3. **流式请求不要走 `rf:api`**：`rf:api` 会等整个响应读完才返回，看不到逐字显示，必须用 port（§5.5）。
4. **不要在插件里另写一份「要不要自动讲解」的规则**：一律以服务端 `/record` 返回的 `autoExplain` 为准（§4.3 第 5 步）。
5. **安全**：
   - 模型输出必须先转义再渲染。
   - 所有插件接口都要校验数据归 Token 的主人。
   - `rf:openReadflow` 只允许打开以 serverUrl 开头的地址，现有代码已经这样处理，不要放宽。
6. **词典性能**：查词依赖 `idx_ecdict_word_nocase` 索引（`src/lib/dict.ts` 的 `ensureNocaseIndex`），不要改成没有索引可用的查询写法。
7. **导入接口不能自动重试**：`/api/extension/import` 不是幂等的，现有 background 只发一次请求，这一点保持不变。新加的接口按 §5.5 的表格处理。

---

## 9. 交付物清单
- 数据：`src/db/schema.ts`、`src/db/index.ts`（加列 + 回填）。
- 公共库：`src/lib/word-store.ts`（`via`、`deleteWordContexts`）、新增 `src/lib/web-anchor.ts`。
- 新接口：`src/app/api/extension/record/route.ts`（POST、DELETE）、`src/app/api/extension/gloss/route.ts`、`src/app/api/extension/word/[id]/route.ts`。
- 调整：`src/app/api/extension/words/route.ts`（写 `via`、`gloss` 改用 `inlineGloss`）、`src/app/api/words/[id]/route.ts`（改为调用 `deleteWordContexts`）。
- 网站：`src/app/words/page.tsx`、`src/components/WordList.tsx`、`src/lib/word-library.ts`；首页、`/api/texts`、战绩页过滤掉网页摘录。
- 插件：`extension/src/{content.js, background.js, matcher.js, content.css}`、`extension/manifest.json`。
- 测试：`tests/unit/web-anchor.test.ts`、`tests/unit/extension.test.ts`、`scripts/e2e-extension.mjs`。
- 每完成一组改动就跑一次 §7.3 的全部命令，提交信息以 `P31：` 开头。
