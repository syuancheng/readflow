# P44 实现说明：阅读页右栏改成对话式

- 需求：`docs/prd/P44-chat-style-ai-panel.md`（先读，决策 D1–D9 不得改）
- **视觉与交互参照 ChatGPT、Claude Code 的对话界面，并必须满足 `non-designer-frontend` 技能**（产品硬性要求，D9）。§9 是技能要求的逐条落地，§0.2 的五道门槛缺一不可。
- 涉及代码（现状）：`src/components/Reader.tsx` 的 `PickCard`（约 1580–2200 行）、`src/components/MakeCardButton.tsx`、`src/components/FeedbackRow.tsx`、`src/lib/cards/suggestion.ts`、`src/lib/ai-thread.ts`、`src/app/globals.css`（`.reader-aside`、`.rf-ai-*`、`.rf-ask-*`、`.rf-card-*`）

---

## 0. 硬性约束（任何一条不满足都不算完成）

### 0.1 代码与框架
- 先读 `AGENTS.md`：本项目是 Next.js 16，写代码前读 `node_modules/next/dist/docs/` 里相关的指南。
- **不新增 npm 依赖，不改数据库，不改接口，不改提示词。** 所有改动都在前端展示层和纯函数。
- 纯函数模块（`src/lib/*.ts`）**只能用相对路径 import**（单测编译到 `.unit`，不认 `@/`）。
- 不删除已有的存储字段；`contexts.ai_gloss` 的串格式（`【追问】…`）不变。

### 0.2 前端设计规范（必须满足，验收见 §9）
本期所有**新增和改动的界面**必须满足 `non-designer-frontend` 技能的五道门槛，缺一项不得宣称完成：

1. **先读规则**：写界面代码前，读技能的 `references/book-rules-full.md`、`principles-frontend.md`、`color-frontend.md`、`typography-frontend.md`、`page-playbooks.md`。
2. **设计简报**：按 §9.1–§9.8 实现；交付时把简报连同验收结论保存为 `docs/design/P44-DESIGN.md`。
3. **只用令牌**：颜色、字号、字重、间距、圆角只用 `src/styles/tokens.css` 的变量；间距取 4 的倍数（`--rf-space-*`）。`scripts/check-tokens.mjs` 必须通过，不得用 `token-ok` 绕过。
4. **自动检查**：对新增和改动的界面源文件运行技能的 `scripts/check_design.py`：**新文件 HARD = 0**；已有文件（`globals.css`、`Reader.tsx`）HARD **不得比改动前增加**。
5. **人工验收**：逐条填写技能 `references/acceptance-checklist.md` 的 A–K 全部行和例外登记表，附在 `docs/design/P44-DESIGN.md`。任何一行留空都不得交付。

### 0.3 测试
- 新增的纯函数模块各配单测；`npm test`（check-tokens + tsc + node:test）通过；覆盖率门槛 90/85/90 不得下降。
- 不得碰 `data/readflow.db` 和正在运行的 :3000 服务；E2E 全部用独立库、独立端口、假模型。
- 受影响的 E2E 脚本要**更新到新界面**，不是跳过（见 §8）。

### 0.4 范围
- 只做桌面宽度（≥ 768px 的左右两栏）。窄屏保持现在的行为（右栏堆到文章下面），输入框在窄屏同样挂在对话区底部，**不做**软键盘 / 底部导航避让（D1）。

---

## 1. 不变量（改完必须仍然成立）

1. `/api/explain` 的请求体、`askKind`、`history`、`refs` 一字不改；`triggerAI` 的流式、中止、重试逻辑保留。
2. `onAIGloss` 写回的串格式不变：首次讲解无标题，追问以 `【追问】问题` 开头。**做卡状态块不写进这个串**。
3. 反馈接口 `/api/explain/feedback`、`rate()`、`FeedbackRow` 不改。
4. 做卡接口 `/api/cards/generate`、`/api/cards/state`、`trackCardJob`（P43 通知）不改。
5. 「取消记录」按钮：位置、文案、`onCancel`、禁用条件都不变。
6. 切换选区时 `PickCard` 按锚点卸载，状态重置（现有行为）。

---

## 2. 新结构

### 2.1 版面（`PickCard` 外壳）
```
.reader-aside （右栏，sticky）
 └ .reader-note  .rf-chat            flex 纵向，高度 = 右栏可用高度
    ├ .rf-chat-log                    flex:1；overflow-y:auto；唯一的滚动区
    │   ├ 词头行（词 / 音标 / 发音 / 取消记录）      ← 随内容滚动（决策 D10）
    │   ├ 词典释义 DictView（英文释义默认展开）
    │   ├ 「上下文锚点」折叠（紧跟英文释义下面，默认收起）
    │   ├ 对话流 turns…
    │   │    ├ 首次讲解（无用户气泡）+ FeedbackRow
    │   │    ├ 用户气泡（右）→ AI 回答（左）
    │   │    ├ 建议行（最近一条带建议的回答末尾）
    │   │    └ 做卡：用户气泡「做成卡片」+ 做卡状态块
    └ .rf-composer                    固定在底部，不滚动
        ├ .rf-quick（快捷问题一排）
        └ .rf-composer-box（输入框 + 发送图标）
```
- **D10（新增，实现层决策）**：词头和词典释义跟着对话一起滚，不固定在顶部。原因：词典释义可能很长，固定后会挤占对话区。输入区固定。
- `.reader-aside` 现在只有 `max-height`；当右栏显示的是 `PickCard` 时，要让 `.rf-chat` 有确定高度，输入区才能贴底。做法：给 `.reader-aside` 加一个修饰类（例如 `.reader-aside-chat`，仅在 `pick` 存在时加），设 `height: calc(100vh - var(--rf-bar-h) - 32px)`、`overflow: hidden`，`.rf-chat` 设 `height: 100%`。滚动交给 `.rf-chat-log`。`pick` 不存在时（右栏显示已存批注列表）完全保持现状。
- 窄屏（≤ 当前断点，右栏堆到下面）：`.reader-aside-chat` 取消固定高度，改 `height: auto; max-height: 70vh`，其余不处理。

### 2.2 文件拆分（`Reader.tsx` 已 2200+ 行，新增逻辑不再往里堆）

| 新文件 | 内容 |
|---|---|
| `src/lib/ask-presets.ts`（纯） | `buildAskPresets({ isPhrase, isWholeSentence, hasDefault, quote, sentence })` → 快捷问题数组（原 `askOptions`，逻辑和提示词原样搬过来） |
| `src/lib/chat-view.ts`（纯） | `showFeedback(turn)`、`suggestionHolderIndex(turns)`、`cardBlockVisible(state)`、`cardPresetVisible(state)`、`shouldStickToBottom(el)` 所需的判断函数 |
| `src/lib/use-card-job.ts`（客户端 hook） | 从 `MakeCardButton` 抽出的状态逻辑：`state / pct / eta / start(force) / error`；轮询、`trackCardJob`、进度估算原样保留 |
| `src/components/ChatTurn.tsx` | 一条对话：用户气泡 + AI 回答 + 重试 + 首次讲解的 `FeedbackRow` + 建议行 |
| `src/components/CardRunBlock.tsx` | 做卡状态块（四种状态） |
| `src/components/AskComposer.tsx` | 快捷问题 + 输入框 + 发送 |
| `src/styles/p44-chat.css` | 本期全部新样式，`globals.css` 顶部 `@import`（紧跟 p43 之后） |

`MakeCardButton.tsx` 在新结构里不再被引用：状态逻辑搬进 `use-card-job.ts`，展示搬进 `CardRunBlock.tsx`，完成后**删除** `MakeCardButton.tsx` 和 `globals.css` 里 `.rf-ai-section / .rf-ai-actions / .rf-ai-btn / .rf-ask-menu / .rf-ask-chips / .rf-ask-sep / .rf-card-suggest / .rf-card-btn* / .rf-card-again / .rf-card-error / .rf-card-progress-note` 等不再使用的规则（用 `grep` 确认无引用后再删）。

---

## 3. 纯函数规格（单测必须覆盖）

### 3.1 `buildAskPresets`
输入与原 `askOptions` 相同，输出 `{ key; label; req }[]`，顺序：
1. 「这个词在这句里什么意思」/「这个短语在这句里什么意思」：仅当 `!hasDefault`。
2. 「整句没看懂」：仅当 `!isWholeSentence`。`req` 的 `word / wholeSentence / prompt / askKind:"whole_sentence"` 与现在**逐字相同**。
3. 「讲讲句子结构」(`structure`)、「再给个例句」(`example`)、「从内容角度讲讲」(`domain`，整句提问)：与现在相同。
4. 「做成卡片」**不在这个数组里**（它不走 `/api/explain`），由 `AskComposer` 单独追加，见 §4.3。

单测：各条件组合下的 label 序列；`whole_sentence` 与 `domain` 的 `req` 带 `wholeSentence:true` 与 `word=sentence`；提示词文本与现有字符串完全一致（直接对比，防止搬运时改字）。

### 3.2 `showFeedback(turn)`
`feedbackEnabled && turn.status==="done" && !isNotAGloss(turn.text) && Boolean(turn.answerId) && !turn.ask`
→ **只有首次讲解（没有 `ask`）显示**。单测：首次讲解 true；带 `ask` 的 false；没有 `answerId` 的 false；失败文案 false；`feedbackEnabled=false` 时 false。

### 3.3 `suggestionHolderIndex(turns)`
返回「最近一条 `status==="done"`、不是失败文案、且 `splitCardSuggestion(text).suggestion !== null` 的 turn 的下标」，没有则 `-1`。只看**最近一条完成的回答**：如果最后一条回答没有建议，就不显示（建议属于那条回答，不跨回答漂移）。单测：多条带建议只取最后一条；最后一条无建议返回 -1；进行中的回答不算。

### 3.4 `cardBlockVisible(state)` / `cardPresetVisible(state)`
- 状态块：`state !== "none"` 时显示。
- 快捷项「做成卡片」：`state === "none"` 显示；`generating` 显示但置灰；`ready / pushed` 不显示；`failed` 不显示（状态块里有「重试」）。
单测：五种状态各一条断言。

---

## 4. 组件规格

### 4.1 对话流（`PickCard` 里 `turns.map` 的替换）
- `turn.ask` 为空 → 首次讲解：用户气泡用统一的默认问题 `defaultQuestion({isPhrase,isWholeSentence})`（`ask-presets.ts`：整句「这句话是什么意思」/ 短语「这个短语在这句里什么意思」/ 单词「这个词在这句里什么意思」），自动触发、手动点、回看都一样；AI 回答前没有「AI 释义」徽章；回答下面按 `showFeedback` 画 `FeedbackRow`。
- `turn.ask` 有值 → 先画**用户气泡**（文本 = `turn.ask`，纯文本、`overflow-wrap:anywhere`），再画 AI 回答。去掉「💬 追问」徽章和 `.rf-turn-ask`。
- 状态文案（「正在思考…」「生成中…」）放在 AI 回答的**上方一行**（小号次要灰），不再放在标题行；流式光标保留。
- 失败 / 没配模型：回答位置显示原有文案 + 「重试」小按钮（`.rf-ask-mini`，样式保留），逻辑仍是 `retry(index)`。
- 每条 `ChatTurn` 的 `key` 仍用 index（turns 只会追加或整条移除重试）。

### 4.2 建议行（F4）
- 位置：`suggestionHolderIndex(turns) === i` 的那条回答**正文下面**，`FeedbackRow` 之前或之后均可，但同一条里顺序固定为：正文 → 建议行（首次讲解的反馈放最后）。
- 内容：`💡 建议做成卡片：{理由}` + 一个文字按钮「做成卡片」（点击 = 触发做卡，与快捷项等价）。
- 显示条件：该回答是 holder，且做卡状态为 `none` 或 `failed`。已开始 / 做好后不再显示。
- 理由完整显示：`overflow-wrap:anywhere`，不设行数上限。
- 正文仍走 `shownText`（去掉末尾「制卡建议：」行，流式时先藏半截）。

### 4.3 `AskComposer`
- **快捷问题**：`buildAskPresets(...)` 的结果 + 末尾一个「做成卡片」。按钮样式统一（`.rf-quick-chip`），用「状态」区分：普通 / `disabled`（busy 或做卡进行中）。
- 快捷问题只在输入框**为空**时显示（用户开始输入就收起，避免挤占）。输入框清空后重新出现。
- **点击行为**：
  - 普通快捷项：`triggerAI(preset.req)`，不再需要 `menuOpen`；`menuOpen` 状态整个删除。
  - 「做成卡片」：见 §4.4。
- **输入框**：沿用现有 textarea 行为：Enter 发送、Shift+Enter 换行、随内容自动增高、上限 160px、超过内部滚动；发送图标在右下角；发送后清空并保持焦点。占位符沿用现有文案（「我有别的问题…」，**不改文案**）。
- `busy` 时：快捷项和发送按钮不可用；输入框可输入。
- 没有 `pick.contextId`（还没保存完）时，「做成卡片」置灰并带 title「正在保存这条记录…」，其余不受影响。

### 4.4 做成卡片（D3：像工具调用）
- 点击「做成卡片」或建议行里的按钮 → 调 `useCardJob().start(false)`。
- **对话流里追加两项（只在前端展示，不进 `ai_gloss`）**：
  1. 用户气泡「做成卡片」；
  2. `CardRunBlock`（AI 一侧、左对齐、满宽）。
- `CardRunBlock` 四种状态（都在**原位变化**，不整块换元素，不跳版式）：

| 状态 | 展示 |
|---|---|
| generating | `.rf-progress-ring` + 「正在做卡 N% · 预计约 X 秒（估算）」；`aria-busy`、`aria-live="polite"`；到 95% 停住，真实状态落地再收尾（沿用现有估算曲线） |
| ready | 「✓ 已做成 N 张卡 · 查看」（`<a target=_blank rel=noreferrer>`，地址同 `cardViewHref`）；没有「再做一组」（D11） |
| failed | 失败原因（`st.error` 或 `error`，`role="alert"`）+ 「重试」按钮（`start(true)`） |
| pushed | 「✓ 已在墨墨」 |

- **位置规则**：状态块以**服务端状态**为准。
  - 本次会话里点击做卡：块插在点击当时的对话末尾（记下当时的 `turns.length`，之后新追问出现在它下面，顺序和实际发生一致）。
  - 回看 / 刷新后：服务端状态 ≠ `none` 时，块放在**对话串最后**（顺序信息不持久化，已在 PRD 接受）。
  - 状态为 `none` 且从未点击：不画块，也不画「做成卡片」用户气泡。
- 同时只有一个状态块；失败后「重试」原位复用，不另起一块。
- **通知不丢**：`card-toast-store.ts` 把正在跟踪的任务存进 `localStorage`（`rf-card-jobs`，10 分钟有效），页面加载时接着跟踪；通知的 20 秒倒计时只在页面可见时走。
- P43 通知：`use-card-job` 里保持 `trackCardJob` 的两处调用（生成成功后、进行中时），行为不变。

### 4.5 自动滚动
- `.rf-chat-log` 记录「用户是否在底部附近」（`scrollHeight - scrollTop - clientHeight < 80`）。
- 追加新 turn、流式文本增长、做卡状态块出现时：仅当此前在底部附近才 `scrollTo(bottom)`；用户已经往上翻就不动。
- 首次打开（词典、首次讲解还在加载）不滚动。切换选区重置（组件卸载重建）。
- `prefers-reduced-motion` 下用 `behavior:"auto"`，其余用 `"smooth"`。

### 4.6 词典区改动（D7）
- `DictView` 里的「英文释义」`<details>` 改成**直接显示**：一个小标题「英文释义」（`--rf-text-xs`、次要灰）+ 下面的英文文本（`--rf-text-sm`、`--rf-text-secondary` 沿用现有）。去掉 `<details>/<summary>` 和展开三角。
- 「上下文锚点」`<details>` 从 `PickCard` 的最底部**移到 `DictView` 的正下方**（`DictView` 之后、对话流之前）。仍是 `<details>`、默认收起、内部三行（前文 / 后文 / 位置）不变。词典没命中时（没有 `DictView`）它仍紧跟在词头行之后。
- 与对话流之间用组间距（`--rf-space-6`）隔开，让「词的信息」和「对话」成为清楚的两组。

### 4.7 保持不动
- 标题行、`rf-cancel-record` 及其容器：不改。发音小喇叭按钮保留（它是词头的一部分，不是 AI 按钮）。
- **按钮清单（改完后右栏里允许存在的）**：「取消记录」；发音喇叭；首次讲解下的反馈按钮；对话流里状态块 / 建议行内的「查看」「重试」「做成卡片」；底部输入区的快捷项和发送。**除此之外不得再有独立的 AI 操作按钮**，验收时按这张清单逐个核对。
- 回看（`recall`）时拉取 `/api/explain/answers`、`attachAnswers`：不改；只是回看后只有首次讲解会显示反馈。

---

## 5. 样式规格（`src/styles/p44-chat.css`）

全部使用令牌，间距取 4 的倍数。数值是起点，验收时可微调，但必须仍是令牌。

| 选择器 | 要点 |
|---|---|
| `.reader-aside-chat` | `height: calc(100vh - var(--rf-bar-h) - 32px)`；`overflow: hidden`；窄屏降级见 §2.1。`--rf-bar-h` 不在 tokens.css，沿用 `.reader-aside` 现有写法（它在 globals 里已有定义），不要自造 |
| `.rf-chat` | `display:flex; flex-direction:column; height:100%; min-height:0` |
| `.rf-chat-log` | `flex:1; min-height:0; overflow-y:auto; padding: 0 var(--rf-space-1) var(--rf-space-4)`；`scrollbar-width: thin` |
| `.rf-chat-turn` | 相邻两轮（一问一答）间距 `--rf-space-6`；轮内「气泡 → 回答」间距 `--rf-space-3`（亲密性：轮内 < 轮间） |
| `.rf-bubble-user` | `margin-left:auto; max-width:85%; padding: var(--rf-space-2) var(--rf-space-3); border-radius: var(--rf-radius-md); background: var(--rf-bg-subtle); color: var(--rf-text-primary); font-size: var(--rf-text-sm); line-height: var(--rf-leading-sm); text-align:left; overflow-wrap:anywhere`；`width: fit-content`（短问题不要拉成整行） |
| `.rf-ai-reply` | 满宽，无底色、无边框；沿用 `.rf-md` 排版 |
| `.rf-chat-status` | 回答上方小字：`--rf-text-xs`、`--rf-text-secondary`；流式时「生成中…」沿用现有绿色强调 |
| `.rf-suggest-line` | `--rf-text-sm`、`--rf-text-secondary`、浅紫底 `--rf-ai-soft`、`padding: var(--rf-space-2) var(--rf-space-3)`、`--rf-radius-md`；「建议做成卡片」几字用 `--rf-ai-text`；末尾按钮是文字按钮（`--rf-ai-text` + 加粗字重，无下划线），**不是**实体按钮 |
| `.rf-run-block` | 一条 `1px` 边框（`--rf-border-width`/`--rf-border`）、`--rf-radius-md`、`padding: var(--rf-space-2) var(--rf-space-3)`、`--rf-text-sm`；左对齐，满宽；内部 `display:flex; align-items:center; gap: var(--rf-space-2); flex-wrap: wrap` |
| `.rf-run-block[data-state=failed]` | 文字用 `--rf-danger-text`，其余不变 |
| `.rf-composer` | `flex:none; padding-top: var(--rf-space-3); border-top: var(--rf-border-width) solid var(--rf-border); background` 与右栏底色一致（用现有表面令牌，不新增色值） |
| `.rf-quick` | `display:flex; flex-wrap:wrap; gap: var(--rf-space-2); margin-bottom: var(--rf-space-3)` |
| `.rf-quick-chip` | 直接**复用** `.rf-ask-chip` 的视觉：搬到本文件并改名（原规则随 `globals.css` 清理一并删掉）；`:disabled` 用 `opacity` 与 `cursor:default`；有 `:focus-visible` 焦点环 |
| `.rf-composer-box` | 复用 `.rf-ask-custom / .rf-ask-input / .rf-ask-send` 的现有规则，搬进本文件改名 |

- 禁止：新增色值、`!important`、`text-align:center`、`text-align:justify`、`text-decoration:underline` 做强调（建议行里的文字按钮用 `font-weight` + `--rf-ai-text` 颜色区分，不用下划线，避免新增例外）。
- 动效：气泡与新回答不做入场动画（保持简单）；转圈沿用 `.rf-progress-ring`；`prefers-reduced-motion` 沿用现有降级。

---

## 6. 删除与迁移清单（做完逐项勾掉）

- [ ] `PickCard` 里删除：`menuOpen`、`.rf-ai-section` 整块、`.rf-ask-menu`、`MakeCardButton` 的渲染、「AI 释义」「💬 追问」徽章、标题行里零散的「整句没看懂」文字按钮。
- [ ] 「上下文锚点」`<details>` 从底部移到 `DictView` 下方；`DictView` 的英文释义改为直接展开。
- [ ] `askOptions` 搬到 `ask-presets.ts`；`PickCard` 只调用。
- [ ] `askCustom` 搬进 `AskComposer`（调用 `triggerAI`）。
- [ ] `MakeCardButton.tsx` 删除；`use-card-job.ts` 接管；`card-toast-store` 的引用保持。
- [ ] `globals.css` 里 §2.2 列出的废弃规则删除，并确认 `grep -rn` 无残留引用。
- [ ] `docs/design-system.md`（若有「问 AI」「做成卡片」条目）同步更新。

---

## 7. 边界情况

1. **进行中的回答 + 点快捷项**：快捷项和发送禁用，不会并发出两条流（现有 `busy` 语义）。
2. **切词**：`PickCard` 卸载，进行中的流被中止（现有行为）；做卡在服务端继续，P43 通知兜底。
3. **没配模型 / 限流 429**：错误文案出现在 AI 回答位置，有「重试」；用户气泡仍保留（它代表用户的问题）。
4. **词典没命中**：沿用 `autoExplain`：自动发首次讲解，此时没有用户气泡。
5. **已存批注回看**：`recall` 时不自动问 AI；快捷问题可用（没有首次讲解时第一项是「这个词在这句里什么意思」）。
6. **划的就是整句**：`isWholeSentence` 为真时隐藏「整句没看懂」（沿用）。
7. **做卡已完成又追问**：状态块留在原位，新追问在下面；建议行不再出现。
8. **长问题**：用户气泡 `overflow-wrap:anywhere`，不撑破右栏。
9. **反馈 + 追问同条数据**：旧数据里追问回答已有的反馈保持在库里；UI 不再显示，也不再提供修改入口。长期记忆读取这些旧反馈的逻辑不改（实现时 `grep` 确认 `recent-feedback` 不依赖 UI）。

---

## 8. 测试

### 8.1 单测（`tests/unit/`）
- `ask-presets.test.ts`、`chat-view.test.ts`：见 §3 的断言清单。
- 做卡进度估算如果从 `MakeCardButton` 抽出，补一个 `pct/eta` 的纯函数测试（`pct = min(95, round(100*(1-exp(-t/20))))`、`eta = max(0, 45-t)`）。

### 8.2 E2E（独立库 + 假模型；先在 `.verify` 的 worktree 里跑）
需要**更新到新界面**的脚本：`e2e-ask-thread`、`e2e-cards-ui`、`e2e-cards`、`e2e-auto-explain`、`e2e-gloss-persist`、`e2e-personalized`（反馈只在首次讲解）、`e2e-card-toast`（入口改为对话里的「做成卡片」）、`e2e-extension`（若涉及右栏）。
> 其中 `ask-thread`、`cancel-record`、`cards`、`cards-ui` 在 main 上本来就有失败（已落后于用户之前的改版）。这次要把它们改到**全部通过**，而不是继续带着失败。

新增 / 重点断言：
1. 点词后底部有输入框；快捷问题在输入框为空时出现，输入文字后收起。
2. 点「整句没看懂」→ 右侧出现用户气泡、左侧出现回答；再点一次 → 追加第二条，不替换。
3. 用户气泡靠右（`getBoundingClientRect().right` 接近对话区右边缘），回答靠左且无气泡背景。
4. 首次讲解下有「这次讲得」；追问回答下**没有**。
5. 点「做成卡片」：出现用户气泡 + 状态块（进行中 → 成功 / 失败）；失败时有「重试」，点后重新进入进行中；成功时「查看」是新标签链接。
6. 建议行：回答带「制卡建议：」时，建议行出现在该回答末尾；点其中的按钮等同于点快捷项；开始做卡后建议行消失。
7. 滚动：输入区始终在右栏底部可见；往上翻时新内容不抢滚动。
8. 取消记录仍在词头右侧，行为不变。
9. 1440 宽度截图；768 以下只确认没有横向溢出（不验收手机体验）。

### 8.3 全量
`npm test`、`npm run test:coverage`、`node scripts/check-tokens.mjs`、`npm run build`（若首次因 Next 的安全公告校验报错，重跑一次）。

---

## 9. 界面设计简报与验收（`non-designer-frontend` 规范）

范围：右栏 `PickCard` 的对话区与输入区（U1 对话流、U2 做卡状态块与建议行、U3 底部输入区）。不新增页面、弹窗或提示条。

### 9.0 参照对象与做法（D9）
- 参照 ChatGPT / Claude Code 的共同点，**只取它们的版式结构，不照抄具体像素和配色**：
  1. 对话区占满中间，输入区贴底，输入框是一个圆角容器，发送图标在里面；
  2. 用户消息有浅色底、靠右；AI 回答没有底色、满宽、像一段排好版的文章；
  3. 工具 / 任务执行以一个紧凑的、有边框的状态行出现在 AI 一侧；
  4. 快捷提示以一排小标签出现在输入框上方；
  5. 整体克制：无头像、无入场动画、无气泡尖角、一个主操作。
- 所有取值都用项目的令牌，颜色只用 `tokens.css` 现有色值；若令牌不够用，先补令牌（改 `tokens.css` 并说明），不许在组件里写死。
- 技能的五道门槛（§0.2）是硬门槛：**写代码前先读规则文件并填好 §9 简报；写完跑 `check_design.py`；交付时附验收表和例外登记。** 缺任何一项不得宣称完成。

### 9.1 中心点（C-02 / TIP-03 / PR-01）
- 对话区的中心点是**最新一条 AI 回答的正文**（`--rf-text-sm`、主文字色）。用户气泡是浅灰底、次要权重；建议行、状态块是附属信息，权重低于正文。
- 全栏只有一个主导元素：正文。输入区用中性色，不用绿色或紫色实体按钮抢焦点。

### 9.2 分组 · 亲密性（P-01 ~ P-11）
- 信息组：词头与词典区（词头、释义、英文释义、上下文锚点）；一轮对话（用户气泡 + AI 回答）；建议行 / 做卡状态块；输入区。
- 组内间距 4–12px，组间 24px，输入区与对话区之间一条 1px 分隔线（靠留白与线分区，不套框）。
- 「气泡 → 回答」12px，一轮与下一轮 24px；反馈行贴着首次讲解 8px。
- 眯眼测试目标：视觉停顿点 ≤ 5（词头、词典、一两段回答、输入区）。

### 9.3 对齐（A-01 ~ A-11）
- 主对齐线：对话区左边缘。AI 回答、状态块、建议行、反馈行、词典全部落在这条线上，文字一律左对齐。
- **有意识的破格**（登记 E-44-01）：用户气泡整体靠右。依据：产品要求「追问放右边」。补偿：气泡内文字仍左对齐，气泡右边缘落在对话区右内边线上，且只有用户气泡这一种元素靠右。
- 不使用居中、两端对齐。

### 9.4 重复（R-01 ~ R-09）
- 圆角：气泡、建议行、状态块都用 `--rf-radius-md`；快捷项 `--rf-radius-sm`（沿用）。
- 次要信息统一 `--rf-text-xs` / `--rf-text-secondary`；AI 相关强调统一 `--rf-ai-text` / `--rf-ai-soft`。
- 1px 边线全栏一致；按钮型文字（「重试」「做成卡片」）形态一致。

### 9.4b 与全站的一致性
- 快捷项、输入框、发送图标沿用现有视觉，只是换位置，用户熟悉的东西不改样子（R-06）。

### 9.5 对比（C-01 ~ C-09 / TX-01 ~ TX-11）
- 回答正文 `--rf-text-sm` 常规字重 vs 状态与反馈 `--rf-text-xs`：字号阶梯 14 / 12，叠加颜色（主文字 vs 次要灰）两个维度。
- 用户气泡靠「浅灰底 + 靠右」与 AI 回答（无底、满宽）区分：位置、底色两个维度。
- 状态块靠边框与进度图形区别于正文；失败用 `--rf-danger-text`。

### 9.6 配色关系（COL-01 ~ COL-13）
- 沿用项目现有关系：中性灰为主，绿色只用于主操作与反馈选中，紫色（AI）只做点缀（图标、「建议做成卡片」几个字、`--rf-ai-soft` 浅底）。本期不新增色值。
- 正文 / 背景对比度 ≥ 4.5:1，状态与次要文字 ≥ 4.5:1；深色模式下重新核对 `--rf-ai-soft` 底上的文字。

### 9.7 字体（TC / TF / TX / T）
- 沿用项目字体，不新增字族。数字（百分比、秒数）加 `font-variant-numeric: tabular-nums`（沿用）。
- 中文标点、引号用全角 / 弯引号；不用下划线强调；不出现全大写。

### 9.8 媒介与状态
- 状态：默认 / hover / `:focus-visible` / `:active` / `disabled` / loading（`aria-busy`）/ error（`role="alert"`）/ 空（没有对话时只显示词典）。
- 可访问性：输入框有 `aria-label`；快捷项是 `<button>`；状态块用 `aria-live="polite"`；Tab 顺序：对话区链接 / 按钮 → 快捷项 → 输入框 → 发送。
- 窄屏、打印：不做专门处理（D1）；打印时输入区隐藏（`@media print` 里 `.rf-composer{display:none}`）。
- 「言之有理」：每个元素都有理由——没有装饰性头像、没有入场动画、没有气泡尖角。

### 9.9 例外登记表

| 编号 | 规则 | 内容 | 原因 | 补偿 | 确认 |
|---|---|---|---|---|---|
| E-44-01 | A-01 / A-08 | 用户气泡靠右 | 产品要求，对话式布局的通用约定 | 气泡内文字左对齐；只有这一种元素靠右；右边缘落在内边线上 | siyuancheng 2026-11-19 |
| E-44-02 | 沿用 P34 E-06 | 反馈行字号小、不显眼 | 反馈不能抢正文的焦点 | 沿用既有样式 | 已有 |

### 9.10 自动检查的范围与做法
- 对 `AskComposer.tsx`、`ChatTurn.tsx`、`CardRunBlock.tsx`、`p44-chat.css` 运行 `check_design.py`，要求 HARD = 0；对 `Reader.tsx`、`globals.css` 记录改动前后的 HARD 数，不得增加。
- 先用 `scripts/check-tokens.mjs` 保证令牌；再用技能的检查器；最后填验收表。

---

## 10. 实施顺序（每步都能独立验证）

1. 在隔离 worktree 里截**改前**图（首次讲解、追问、做卡三种状态；1440 宽度）。
2. 纯函数：`ask-presets.ts`、`chat-view.ts` + 单测，`npm test` 通过。
3. `use-card-job.ts`、`CardRunBlock.tsx`（先接到旧页面上验证行为不变）。
4. `ChatTurn.tsx`、`AskComposer.tsx`、`p44-chat.css`，替换 `PickCard` 的渲染；删除旧结构。
5. 反馈收敛（`showFeedback`），**单独提交**。
6. 更新 E2E，构建后全量跑；`check_design.py` 与 `check-tokens`；填 `docs/design/P44-DESIGN.md`；截**改后**图对比。
7. 提交到功能分支；合并、推送、重启本地服务、部署远程，**由你决定**。

---

## 11. 修订：输入框改版（对应 PRD §13，D12–D16）

### 11.1 组件
- `AskComposer.tsx` 重写：`.rf-composer`（相对定位的外壳）→ 向上展开的 `.rf-menu`（`role="menu"`）+ `.rf-composer-box`（圆角 `--rf-radius-xl`，内含 `.rf-composer-plus`、textarea、条件渲染的 `.rf-composer-send`）。
- 原来的 `.rf-quick` 一排按钮和 `.rf-quick-chip` 样式删除；`cardPresetState` 的三种状态不变，只是展示位置换成菜单项。
- 菜单行为：`aria-haspopup="menu"` / `aria-expanded`；点外面（`mousedown`）、Esc、选完一项都收起；Esc 要用 `nativeEvent.stopImmediatePropagation()`，因为 Next 的 React 根就是 `document`，阅读页「Esc 关右栏」的监听也挂在 `document` 上，只 `stopPropagation` 拦不住。
- 发送按钮：圆形（`--rf-space-8`，和「＋」同尺寸），实心 `--rf-ai-text`，向上箭头；`text.trim() !== ""` 才渲染；`busy` 时禁用。「＋」展开时图标转 45° 成「×」。

### 11.2 常用问题的数据
- 表 `quick_questions(id, user_id, text, created_at)`，`src/db/ensure-quick-questions.ts` 在启动时 `CREATE TABLE IF NOT EXISTS`（`src/db/index.ts` 里调用）。
- 纯规则 `src/lib/quick-questions.ts`：`normalizeQuestion`（空白压成一个空格、1～100 字）、`checkAdd`（不重复、不超过 20 条）；单测 `tests/unit/quick-questions.test.ts`。
- 存取 `src/lib/quick-question-store.ts`；接口 `src/app/api/quick-questions/route.ts`（GET / POST）和 `[id]/route.ts`（DELETE，只删自己的，删不到返回 404）；未登录一律 401。
- 前端 `src/lib/use-quick-questions.ts`：第一次打开菜单才读取，页面内共用一份缓存；添加返回失败原因（重复 / 超限 / 空），删除先从界面拿掉、失败放回。
- 点自己的常用问题：`onAsk({ ask: 文字, prompt: 文字, askKind: "custom" })`，和手打完全一样（右边出现这句话、记成一次 custom 提问）。

### 11.3 测试
- `e2e-chat-panel.mjs` 新增：C1（没输入时右边没有发送按钮、没有语音按钮）、C1b/C1c（菜单内容、Esc 收起）、C3（发送按钮出现、贴右、垂直居中）、C20a–e（添加、重复提示、点击使用、服务器存了、删除、未登录 401）。其余 E2E 的「点快捷问题」都改成「点＋再选项」。

### 11.4 设计简报修订（并入 `docs/design/P44-DESIGN.md` §6）
- 分组：输入区内部「＋ / 输入 / 发送」同属一个容器，间距 4px；菜单两组（内置 / 我的）之间一条 1px 线 + 8px。
- 对齐：菜单文字、「我的常用问题」标题、添加按钮全部落在菜单内左边线；「＋」与发送同为 32px 圆形，分居容器两端。
- 对比：发送是整个输入区里**唯一的实心色块**（AI 紫），只有输入后才出现，所以它是焦点；「＋」是无底色的次要灰。
- 新增色值：无。

### 11.5 双栏各自滚动（PRD §14，D17–D19）
- 新文件 `src/lib/reader-scroll.ts`：`readerScroller()`（正文自己是滚动容器时返回 `.reader-main`，否则 null）、`readScrollMetrics()`、`scrollElementIntoReading()`。
- `use-read-progress.ts`、`ReadingChrome.tsx`（目录高亮、目录点击跳转）改用它；`scroll` 监听改挂在 `document` 的**捕获阶段**（scroll 事件不冒泡，这样整页滚动和正文滚动都能收到）。块位置换算为「滚动区内容坐标」：`rect.top - originTop + scrollY`。
- 样式在 `p44-chat.css` 末尾的 `@media (min-width: 1024px)`：`.rf-reading-layout` 固定为 `100vh - 顶栏`；`.reader-main` `overflow-y:auto`；`.reader-aside` 不再 sticky，高度 100%、贴窗口右边；AI 栏右侧留白放在里面的内容上，滚动条才能贴边。选择器带 `.rf-reading-layout` 前缀，因为 `globals.css` 的同名规则排在 `@import` 之后，同权重会覆盖。
- 测试：`e2e-chat-panel.mjs` C23–C23d（整页不滚动、两栏紧挨、AI 栏贴右、正文滚到底进度 100%、回顶 0%）。
