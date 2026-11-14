# P33 实现说明：阅读时做卡——考试题型卡片（含听力）

> **先读产品需求 `docs/prd/P33-exam-style-cards.md`**。PRD 回答「做什么、为什么、做到什么程度」，本文回答「怎么做」以及**必须遵守的约束**。两者冲突时，以 PRD 的产品行为为准，并在提交说明里写明冲突点。
>
> **前置依赖**：
> - **P32 阶段一**必须已经合入：学生档案、`handleExplain` 接入画像、响应头 `X-RF-Answer-Id`、请求体字段 `askKind`、`explain_events` 表。
> - 插件相关部分依赖 **P31**。
> - 动手前先确认这些代码都已存在，不存在就停下来报告，不要自己补一个简化版。
>
> 墨墨卡片语法以官方《制卡指南》为准，项目内整理版见 `/markji` 技能的 `references/card-syntax.md` 和 `references/api.md`（在 `~/.claude/skills/markji/`）。下文 §6 摘录了本功能用到的部分。

---

## 0. 硬性约束（任何一条不满足都不算完成）

### 0.1 代码与框架
- **先读 `AGENTS.md`**，本项目用的是 Next.js 16：
  - `middleware` 已改名为 `src/proxy.ts`。
  - 页面的 `params` / `searchParams` 是 Promise。
  - `route.ts` 只能导出 HTTP 方法和 `runtime` / `dynamic` 这类配置，共用逻辑放到 `src/lib/`。
- 每个接口都要在服务端确认用户身份：网站用 `currentUser()`，插件用 `requireExtensionUser()`。所有读写都要**校验数据属于当前用户**。
- **不新增 npm 依赖**。语音合成、墨墨上传都用 Node 自带的 `fetch` 和 `FormData` / `Blob` 完成。
- **不删除数据库里已有的表和字段**，`exports` 表也要保留。旧导出功能的**代码和页面**按 §9 删除。
  - **修订（2026-11-14，用户决定）**：`ai_usage` 与 `card_usage` 合并为 `daily_usage(user_id, day, kind, count)`（`kind` = `ai` / `card`），启动时自动迁移旧数据并删除旧表；`tts_audio`、`markji_media` 一直为空、阶段一不用，已删除（为空才删），阶段二再按 §3 建回。迁移代码见 `src/db/ensure-usage.ts`。

### 0.2 UI（遵守设计规范）
- 先读 `docs/design-system.md`。颜色、字号、间距、圆角、阴影**只能用** `src/styles/tokens.css` 里的 token，或者已经对齐 token 的 Tailwind 类。
- `npm test` 第一步跑 `scripts/check-tokens.mjs`。**禁止**用 `token-ok` 注释绕过检查，确有必要时要在提交说明里写清理由。
- **颜色含义**：
  - 绿色只用于主操作、进度和成功。
  - 紫色用于 AI 相关：「💡 建议」、做卡按钮的建议态、AI 补充的内容。
  - 选中状态用中性灰。
  - **一屏最多一个绿色主按钮**。
- **复用现有样式**：`.duo-btn*`、`.duo-filter-chip*`、`.rf-seg`、`.duo-card`、`.duo-badge*`、`.wl-*`（词库）、`.rf-ai-*`（阅读页 AI 区）、`.st-*`（设置）。
- **手机宽度**：390px 下不能有横向滚动，卡片预览、编辑、推送都要能正常操作。
- **无障碍**：
  - 图标按钮要带 `aria-label`。
  - 翻面、播放、展开这类按钮要带 `aria-pressed` 或 `aria-expanded`。
  - 只用键盘就能完成「换一道、删除、修改、推送」。
- **文案**：面向用户的中文文案逐字使用 PRD 里写好的。PRD 没写的，要简短、口语化、不用感叹号。
- **截图核对**：每个新界面都要按 `.verify/design/shots.mjs` 的方式（数据库副本 + 临时会话）截 1440px 和 390px 两张图，提交说明里列出截图路径。

### 0.3 测试与质量门槛
- **单元测试覆盖率**：新增的纯函数模块（`src/lib/cards/**`）要求**行 ≥ 90%、分支 ≥ 85%、函数 ≥ 90%**。把它加进 P32 已有的 `npm run test:coverage`：`--test-coverage-include` 增加 `.unit/src/lib/cards/**`。不达标时命令必须失败。
- **PRD 里的每条规则、每个数字都要有对应的单测**，测试名用中文写清楚测的是哪条规则。需要覆盖的数字包括：30 个词每天、1～3 张、1800 / 4500 字、20 次每 10 秒、40 次每 60 秒、10 分钟缓存窗口、30 字建议理由，以及 §5 的各项校验。
- **端到端测试**：新增 `scripts/e2e-cards.mjs`，至少覆盖 §11.3。**不能调用真实的模型、墨墨或语音合成**，统一用 §11.4 的三个假服务。
- **回归**：§11.6 的全部命令都要通过。
- **人工评审材料**：用 `scripts/eval-cards.mjs`（§11.5）生成报告，提交时附上路径。
- **测试只能用隔离数据库和临时端口**，绝不能碰 `data/readflow.db`，也不能用真实的墨墨 Token。

### 0.4 墨墨相关的硬规则
- **任何写墨墨的操作，都只能由用户在「待推送」里点击推送或撤回触发**。生成卡片、换一道、修改，都只改 ReadFlow 自己的数据库。
- **频率限制**：同一个墨墨 Token 下，所有写请求和上传请求合计不超过 **10 秒 20 次、60 秒 40 次**，请求之间至少间隔 0.5 秒。另外有「每天创建内容」的上限：按每天 600 条保守估算，超出时停下推送并提示用户。
- 墨墨的接口**不能删除卡片和章节**。所以新建章节之前**必须先列出已有章节，查重名**。
- 上传的媒体只能使用接口返回的 `file.id`，**原样写入，大小写敏感**。不能写文件名或 URL，更不能自己编。
- **卡片里不允许出现 `[Pic#…]`**（PRD：卡片不放图片），渲染器和校验器都要拦截。

### 0.5 开关
- 站点级开关存在 settings 表的站级行里，站长在「设置 → 模型」中切换，立即生效：
  - `cards.enabled`（默认 `on`）：关掉后隐藏「＋ 做成卡片」和「待推送」。已有的草稿和推送记录保留。
  - `cards.listening`（默认 `off`）：阶段二上线后再打开。关闭时 AI 不能使用音频零件。
- 环境变量 `READFLOW_CARDS=off` 强制关闭全部做卡功能。

---

## 1. 范围与阶段

| 阶段 | PRD 功能 | 本文章节 |
|---|---|---|
| 一 | F1 制卡建议、F2 做卡按钮（阅读页、词库）、F3 阅读类卡片（不含音频）、F5 待推送、删除旧导出 | §2–§5、§7、§8.1–8.3、§9 |
| 二 | F4 听力（语音合成 + 听力零件）、插件侧栏的做卡按钮 | §6.3、§8.4、§10 |
| 三 | F6 撤回、F7 已做卡又查过、一段多空卡 | §7.6、§7.7、§8.5 |

每个阶段单独提交，提交前 §11.6 必须全部通过。

---

## 2. 总体流程

```
阅读页 AI 讲解（P32 handleExplain，流式）
   │  讲解末尾可能有「制卡建议：…」 → 前端拆出来，显示成「💡 建议做成卡片：…」
   │  服务端把这次讲解的完整 messages 放进进程内缓存（answerId → messages + 讲解全文，保留 10 分钟）
   ▼
用户点「＋ 做成卡片」 → POST /api/cards/generate { contextId, answerId? }
   │  answerId 命中 10 分钟内的缓存 → 在原对话后面追加一轮「请出题」（命中模型缓存）
   │  没命中 → 用存下来的讲解（contexts.ai_gloss）和原句重新组织上下文
   ▼
AI 返回 JSON 格式的卡片描述（CardSpec[]，§4）
   │  校验（§5）→ 不合格就重出一次 → 选择题再做一次复核（§5.3）
   ▼
渲染器（§6）：CardSpec → 墨墨语法；统一的标签行、emoji、分区标题，用 lint 检查
   ▼
存为草稿（card_sets + cards）→ 在「我的词库 → 待推送」里预览、修改、换一道、删除
   ▼
用户点推送 → 服务端后台任务（§7.5）：限速、先上传音频、再建卡、可以断点续传
   ▼
推送记录 → 撤回（移动到「🗑 ReadFlow 待删除」章节）
```

---

## 3. 数据模型

所有新表都在 `src/db/ensure-auth.ts` 里用 `CREATE TABLE IF NOT EXISTS` 创建，同时在 `src/db/schema.ts` 里写对应的 drizzle 定义。

```sql
-- 一次「做成卡片」= 一组
CREATE TABLE IF NOT EXISTS card_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_word_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  text_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- 'generating' | 'ready' | 'failed'
  error TEXT,
  merged_from TEXT,                -- 一段多空卡：被合并的 card_set id 列表（JSON），普通组为 NULL
  regen_count INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER,        -- 模型返回的缓存命中 token 数（用于统计 PRD F2 的命中率）
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_sets_user ON card_sets(user_id, created_at);

-- 一张卡
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES card_sets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,            -- 组内顺序 0,1,2
  spec TEXT NOT NULL,              -- CardSpec JSON（§4），修改 / 换一道都改它
  content TEXT NOT NULL,           -- 渲染后的墨墨语法（推送用的就是它）
  status TEXT NOT NULL,            -- 'draft' | 'pushing' | 'pushed' | 'withdrawn' | 'discarded'
  needs_review TEXT,               -- 需要人工检查的原因；NULL = 不需要
  edited INTEGER NOT NULL DEFAULT 0,
  markji_deck_id TEXT, markji_chapter_id TEXT, markji_card_id TEXT,
  push_error TEXT,
  pushed_at INTEGER, withdrawn_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_user_status ON cards(user_id, status);

-- 语音合成结果：按内容复用，所有用户共享（PRD F4）
CREATE TABLE IF NOT EXISTS tts_audio (
  hash TEXT PRIMARY KEY,           -- sha256(text \n voice \n speed \n format)
  text TEXT NOT NULL, voice TEXT NOT NULL, speed TEXT NOT NULL,
  file_path TEXT NOT NULL,         -- data/tts/<hash>.mp3（相对 data 目录）
  bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
);

-- 音频在墨墨里的 file.id 只属于上传它的墨墨账号，所以按用户分别记录
CREATE TABLE IF NOT EXISTS markji_media (
  user_id TEXT NOT NULL, audio_hash TEXT NOT NULL, file_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, audio_hash)
);

-- 每天做卡次数（PRD Q1：单独计数，不占讲解次数）
CREATE TABLE IF NOT EXISTS card_usage (
  user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- 推送任务（断点续传）
CREATE TABLE IF NOT EXISTS push_jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL, chapter_mode TEXT NOT NULL,   -- 'fixed' | 'per_article'
  chapter_id TEXT,                                      -- fixed 模式下的章节
  card_ids TEXT NOT NULL,                               -- 本次要推的卡（JSON，按顺序）
  done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                                 -- 'running' | 'paused' | 'done' | 'error'
  error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

- **每人的设置**存在 settings 表本人的行里（`settings-store.ts`）：
  - `markji.lastDeck`、`markji.lastChapter`、`markji.chapterMode`
  - `markji.membership`（`basic` / `pro`，PRD Q7）
  - `cards.accent`（`us` / `uk`）、`cards.speed`（`normal` / `fast`）、`cards.backAudio`（`on` / `off`）
- **与旧的 `exports` 表衔接**：每推送成功一张卡，向 `exports` 写一行，字段为 `target='markji'`、`card_type='ai:<cards.id>'`、`status='done'`。这样词库里「已导出」的筛选和计数照常可用。同时把 `src/lib/word-library.ts` 的 `exportBadges` 改为按卡片张数显示「墨墨 · N 张」，**不再依赖** `CARD_TYPES`。
- **P32 的 `explain_events` 表**新增字段 `carded_before INTEGER`，表示查这个词时，它是否已经有推送成功的卡片（PRD F7）。

---

## 4. CardSpec：AI 输出的卡片结构

### 4.1 位置与原则
- 类型定义和校验放在 `src/lib/cards/spec.ts`（纯函数）。
- **AI 只负责输出 JSON，不写墨墨语法**。生成卡片的请求要求模型直接返回 JSON：`response_format: { type: "json_object" }`，DeepSeek 和千问的 OpenAI 兼容接口都支持这个参数。

### 4.2 类型定义

```ts
export type CardKind =
  | "context_meaning" | "word_completion" | "paraphrase_fill" | "sentence_understanding"
  | "true_false_ng" | "reference" | "collocation" | "listen_fill" | "listen_choose"
  | "layered_cloze" | "paragraph_cloze" | "custom";

export type Block =
  | { t: "sentence"; source: "original" | "paraphrase"; text: string;
      mark?: { start: number; end: number; as: "highlight" | "blank" | "prefix"; keep?: number } } // prefix：只露前 keep 个字母
  | { t: "instruction"; text: string }                       // 题目指令（中文或英文，按学生档案决定）
  | { t: "choice"; multi?: boolean; options: { text: string; correct: boolean }[] }
  | { t: "fill"; answer: string; hint?: string }             // 独立的填空行（例如听写）
  | { t: "audio"; of: "word" | "sentence"; text: string }   // 只有 cards.listening 打开时才允许
  | { t: "text"; text: string; emphasis?: string[] };        // 普通段落；emphasis 是要高亮的片段（2–4 处）

export type CardSpec = {
  kind: CardKind;
  customLabel?: string;            // kind = custom 时的题型名（≤6 个字），系统会配上通用 emoji ✳️
  examStyle?: string | null;       // 例如「托福 · 词汇题」，由系统按学生档案里的考试目标校正
  target: string;                  // 这张卡考的是什么（给人看的，≤30 个字），不出现在卡面上
  front: Block[];
  hints?: Block[];                 // 可选的提示层（PRD「分层提示」）
  back: {
    answer: Block[];               // ✅ 答案
    explanation?: Block[];         // 💡 解析
    sentenceMeaning?: string;      // 📝 整句意思
    structure?: string;            // 🔍 句子主干
    example?: { en: string; zh: string };   // 📌 补充例句（AI 写的，必须标「AI 补充」）
    audio?: ("word" | "sentence")[];         // 🔊 发音（cards.backAudio 打开时才生效）
  };
};

export type CardGenResult = { cards: CardSpec[] };   // 1–3 张（PRD Q6）
```

### 4.3 解析
- `parseCardGen(raw: string): { ok: true; cards: CardSpec[] } | { ok: false; reason: string }`。
- 白名单解析：未知字段丢弃，类型不对就判失败。必须有单测。

---

## 5. 校验（`src/lib/cards/validate.ts`，纯函数，逐条单测）

### 5.1 输入
```ts
validateCard(spec: CardSpec, ctx: {
  originalSentence: string;   // 这条记录所在句子（buildAnchor 的 prefix + quote + suffix）
  quote: string;              // 目标词或短语
  glossZh: string | null;     // 这个词在这句里的中文意思（讲解「释义：」那一行，或词典第一个义项）
  listeningEnabled: boolean;
  charLimit: number;          // 1800 或 4500（PRD Q7）
}): { ok: true } | { ok: false; reasons: string[] }
```

### 5.2 规则（每条对应 PRD §5 的一条原则）
1. **以句子为本**：`front` 里至少要有一个 `sentence` 块，或者一个 `audio(of: "sentence")` 块。
   正面只剩单词（去掉指令以后）的卡一律拒绝。
2. **原句一字不改**：`source: "original"` 的 `text` 必须是 `originalSentence` 的子串，去掉首尾空白后比较。
3. **标记位置正确**：`mark` 的区间必须落在 `text` 范围内；`as: "blank" | "prefix"` 时，被盖住的部分必须正好是 `quote`，或者是它的词形变化（与词元比对）。
4. **正面不泄露答案**：
   - `glossZh` 不能出现在 `front` 和 `hints` 的任何文字里。
   - 挖空类卡片（`blank` / `prefix` / `fill`），正面的其它文字里不能出现完整的 `quote`。
5. **选择题**：
   - 选项 3～5 个，去重后不能少。
   - 非多选题有且只有一个 `correct`；多选题至少 2 个 `correct`。
   - 选项文字不能含 `[`、`]`，除非渲染器会转义，这条要写测试。
   - 选项里不能出现音频、挖空、图片。
6. **只考一个点**：`back.answer` 不能为空；整张卡最多 1 个选择块。挖空最多 1 组，`paragraph_cloze` 除外。
7. **听力**：`listeningEnabled` 为假时，不能有 `audio` 块。`listen_*` 类卡片的正面不能显示被听的那个词：`listen_choose` 正面不能出现完整句子文字，`listen_fill` 正面的句子必须把目标词挖空。
8. **AI 补充的内容要标注**：`paraphrase` 句子和 `example` 必须在渲染后带「AI 补充」标记。这一条由渲染器保证，校验器检查渲染结果。
9. **长度**：按渲染后的墨墨语法计算，JS 字符串的 `.length`，即 UTF-16 码元数，不能超过 `charLimit`。
10. **没有图片**：渲染结果里不能出现 `[Pic#`。
11. **emoji 和标签只能由系统生成**：AI 写的文字里不能自带标签语法，也就是不能出现 `[T#`、`[P#`、`[F#`、`[Choice`、`[Audio`，以及独占一行的 `---`。出现了就判失败（防止 AI 绕过渲染器）。

### 5.3 选择题复核（`review`）
- 选择题卡片校验通过之后，再发一个独立的请求：只给题干、原句和选项，**不给答案**，问「作为考生，哪些选项可以是正确答案？请返回 JSON：{possible: number[]}」。
- `possible` 和 `correct` 的下标完全一致才算通过。
- 不一致时，用同样的上下文重出这一张卡（最多 1 次）。仍不一致就保留草稿，并把 `needs_review` 设为「复核发现可能有多个正确答案」。
- 复核请求用 `temperature 0`。

---

## 6. 渲染器（`src/lib/cards/render.ts`，纯函数）

`renderCard(spec, opts: { examStyle?: string | null; sourceTitle: string; audioIds?: Record<string, string> }): string`

### 6.1 版式（固定，AI 改不了）
```text
[P#L#[T#B,!ffffff,!!58a700# 📖 语境理解 ][T#B,!7a3cc0,!!f5ecff# 托福 · 词汇题 ][T#!888888# 文章标题]]
<正面各块>
---                       ← 有 hints 时，先放提示层，再放一条 ---
[P#L#[T#B#✅ 答案]]
<答案块>
[P#L#[T#B#💡 解析]]
<解析块>
[P#L#[T#B#📝 整句意思]] …  [P#L#[T#B#🔍 句子主干]] …
[P#L#[T#B#📌 补充例句]] <英文> [T#!888888#（AI 补充）]
[P#L#[T#B#🔊 发音]] [Audio#M,ID/<fileId>#单词] [Audio#M,ID/<fileId>#整句]
```

- **题型标签和 emoji 由 `kind` 决定**，映射表放在 `src/lib/cards/labels.ts`：
  - `context_meaning` → 📖 语境理解
  - `word_completion` → ✍️ 原句补全
  - `paraphrase_fill` → 🔄 改写填空
  - `sentence_understanding` → 🧠 整句理解
  - `true_false_ng` → ⚖️ 判断正误
  - `reference` → 👉 指代
  - `collocation` → 🧩 搭配
  - `listen_*` → 🎧 听力
  - `layered_cloze` → 🪜 分层提示
  - `paragraph_cloze` → 📄 一段多空
  - `custom` → ✳️ + `customLabel`
- **标签颜色**（墨墨语法里的颜色写法是 6 位小写十六进制，前面加 `!`，背景加 `!!`；数值取自设计规范）：
  - 题型标签：白字配 `58a700` 底色。
  - 考试风格标签：紫字 `7a3cc0` 配 `f5ecff` 底色。
  - 来源：灰字 `888888`，不加底色。
  - 每张卡最多这三种颜色组合。
- **原句的高亮和挖空**：
  - `highlight` 渲染成 `[T#B,!1cb0f6#…]`。
  - `blank` 渲染成 `[F#1#…]`。
  - `prefix` 渲染成「露出的前缀 + `[F#1#其余部分]`」。
  - `paragraph_cloze` 每个空依次编号 `[F#1#…]`、`[F#2#…]`。
- `emphasis`：每段最多 2～4 处，渲染成 `[T#B,!e53935#…]`。超过 4 处时只保留前 4 处，并写一个测试。
- **转义**：普通文字里的 `[`、`]` 一律写成 `\[`、`\]`。复用 `src/lib/cardgen.ts` 里的 `esc` 和 `oneLine`，把它们挪进 `src/lib/cards/markup.ts` 后共用。
- 渲染结束后调用 `lintCard`，从 `cardgen.ts` 挪到 `src/lib/cards/lint.ts`，并补充 §5.2 第 10、11 条的检查。

### 6.2 预览（给网页用）
- `renderPreview(spec, opts): PreviewModel` 返回结构化的预览数据：正面、提示层、背面分别是什么文字，标签有哪些，有哪些音频，挖空在哪里。前端按这个数据渲染，**不需要解析墨墨语法**。
- 预览和 `renderCard` 必须来自同一份 spec，要写单测验证两者的标签、分区、挖空答案一致。

### 6.3 音频（阶段二）
- 音频块在渲染时需要真实的 `file.id`。草稿阶段，`content` 里写占位符 `@AUDIO:<hash>@`。推送时上传音频拿到 `file.id`，再用 `str.replace` 替换。**不能用模板字符串格式化**，墨墨语法里有大量花括号和方括号。
- `listen_choose` 的正面：`[Audio#A,ID/<id>#]`，自动播放、不显示文字，下面接选择题。
- `listen_fill` 的正面：`[Audio#M,ID/<id>#▶ 播放整句]`，下面是挖空的原句。

---

## 7. 服务端

### 7.1 讲解里的「制卡建议」（F1）
- **`src/lib/ai.ts`**：在 `buildSystemPrompt` 的末尾追加一段「制卡建议」规则。P32 的个性化开关打开和关闭时**都**追加，因为 PRD 规定这两者互不依赖。规则内容：
  - 只有值得做卡时才在**最后一行**输出：`制卡建议：<理由，不超过 30 个字>`。
  - 不值得做卡时，什么都不输出。
  - 判断依据照抄 PRD F1。
  - 这一行之后不能再有任何内容。
  - **注意**：P32 要求「开关关闭时提示词逐字不变」，指的是讲解深度那一部分。制卡建议是 P33 新增的，所以要更新 P32 的快照测试：快照 = 改动前的提示词 + 这一段（只在 `cards.enabled` 打开时追加）。这一点要在提交说明里写明。
- **观察信息**（`observations`）新增两行：
  - 「这个词在其他文章里也查过 N 次」：N 从 contexts 里统计，统计的是**别的** text_id。
  - 「这个词已经做过卡（已推送到墨墨）」：取值同 `carded_before`。
- **`src/lib/cards/suggestion.ts`**（纯函数）：
  - `splitCardSuggestion(text) → { body: string; suggestion: string | null }`：只识别最后一个非空行，并且必须以「制卡建议：」开头。**不截断**（2026-11-13 用户决定修订）：「不超过 30 个字」只写在给模型的提示词里，模型写长了也完整显示，因为截到半句话会让人看不懂。
  - **所有读取讲解内容的地方都必须先调用它**，把建议行去掉：
    - `src/lib/gloss.ts` 的 `inlineGloss`、`cardGloss`、`shortGloss` 的输入。
    - `ai-thread.ts` 序列化时可以保留原文，但 `parseThread` 之后，给界面显示时要拆开。
    - 词库里显示的释义。
  - 单测要覆盖：建议行在中间（不识别）、出现多行（只取最后一行）、只有建议行没有正文。

### 7.2 讲解上下文缓存（为了命中模型缓存，F2）
- `src/lib/cards/explain-cache.ts`：一个进程内的 LRU，最多 500 条。键是 `answerId`，值是 `{ userId, contextId, messages: ChatTurn[], assistantText, provider, model, at }`，**10 分钟过期**。
- **P32 的 `handleExplain`**：流式输出结束时，把完整的 messages 和讲解全文（**包括**建议行）放进缓存。只缓存这一次讲解完整成功的结果。

### 7.3 `POST /api/cards/generate`（F2 / F3）
- **请求体**：`{ contextId: string, answerId?: string, force?: boolean }`。另有插件版 `POST /api/extension/cards/generate`，用 Token 认证。
- **处理流程**：
  1. 校验 `contextId` 属于当前用户。
  2. 去重：这条记录已经有 `generating` 或 `ready` 状态的组，并且 `force` 不为 true 时，直接返回那一组。
  3. **检查每天的额度**：用站点模型的用户每天最多做 30 个词（`card_usage`），填了自己 Key 的不限（判断方式沿用 `aiContextFor(user).metered`）。超出时返回 429，错误文案：「今天做卡的次数用完了（每天 30 个词），明天再来，或者在 设置 → 模型 里填自己的 Key」。
  4. 新建一个 `card_sets` 行，`status = 'generating'`，**立刻返回** `{ setId, status: "generating" }`。后续步骤在后台执行，**不要 await**。
  5. **后台**组织对话：
     - `answerId` 在缓存里、属于这个用户、属于这条记录、并且没过期：`messages = [...缓存的 messages, { role: "assistant", content: 缓存的讲解全文 }, { role: "user", content: 出题指令 }]`。
     - 否则：用 `buildSystemPrompt` 和 `buildUserMessage` 重新组织讲解时的上下文，把 `contexts.ai_gloss` 作为 assistant 的回答（没有就省略），再追加出题指令。
  6. **出题指令**由 `src/lib/cards/prompt.ts` 的 `buildCardPrompt(input)` 生成，必须包含：
     - 墨墨能做哪些卡：零件清单和每种零件的限制（§4、§5）。
     - PRD §5 的全部原则。
     - 示例菜单（PRD F3 的表格），**并说明不受菜单限制**。
     - 学生档案（P32 的 `buildLearnerBlock`）和考试风格规则。
     - `cards.listening` 打开时，加上听力零件的说明。
     - 一个词 1～3 张卡。
     - 只输出 JSON，以及 JSON 的格式说明（直接写 TypeScript 类型）。
  7. **调用模型**：用非流式的 `completeJson`（新增到 `src/lib/providers.ts`），`temperature 0.4`，`max_tokens 1800`。从返回值里读取 `usage`，缓存命中数取 DeepSeek 的 `prompt_cache_hit_tokens`，或者 OpenAI 兼容接口的 `prompt_tokens_details.cached_tokens`，写入 `card_sets`。
  8. `parseCardGen` → 每张卡 `validateCard` → 不通过的卡带上不通过的原因重出一次 → 选择题再做复核（§5.3）→ `renderCard` → 写入 `cards`（`status = 'draft'`）→ 组的 `status = 'ready'`。
  9. 任何一步出错：组的 `status = 'failed'`，把原因（中文）写进 `error`。**失败不扣次数**：只有生成成功才给 `card_usage` 加 1。
- **`GET /api/cards/sets/:id`**：返回组的状态和卡片预览（`renderPreview`）。前端每 2 秒查询一次，直到状态变成 `ready` 或 `failed`，最长查询 60 秒。

### 7.4 草稿操作
- **`PATCH /api/cards/:id`**：`{ spec }` 修改。
  - 修改后重新跑 `validateCard` 和 `renderCard`。
  - **`source: "original"` 的句子内容不能改**：和原来的比对，不一致就返回 400，提示「原句是从文章里引用的，不能修改」。
  - 设置 `edited = 1`。
- **`POST /api/cards/:id/regenerate`**：换一道。
  - 用这组的上下文重新出**这一张**卡，把原来那张卡的 spec 作为「不要和它重复」的参考。
  - 每组最多换 5 次（`regen_count`），**不计入每天的额度**。
- **`DELETE /api/cards/:id`**：把 `status` 设为 `discarded`，不物理删除，方便统计换一道率和推送率。
- **`GET /api/cards/pending`**：返回所有有草稿卡的词（`status = 'draft'`），按文章分组，「待推送」列表用这个接口。

### 7.5 推送（F5）
- **`POST /api/cards/push`**：`{ cardIds: string[], deckId, chapterMode: "fixed" | "per_article", chapterId? }`。
  - 校验所有卡片属于当前用户，并且处于 `draft` 状态。
  - 新建一个 `push_jobs` 任务，**立即返回** `{ jobId }`。
  - 把牌组、章节和章节模式记到用户设置里，作为下次的默认值。
- **后台执行器**：`src/lib/cards/pusher.ts`。每个用户同一时间只能有一个推送任务在跑。
  1. `per_article` 模式：先列出牌组里的章节，按文章标题查找同名章节，找不到才新建。章节名就是文章标题，超过 40 个字截断。
  2. 每张卡：
     - 先把卡片状态设为 `pushing`。
     - 有音频的：查 `markji_media`，没有记录就上传（multipart，字段名 `file`，同时带上 `deck_id`），然后记录返回的 `file.id`。
     - 替换音频占位符，调用 `createCard`。
     - 成功后把状态改为 `pushed`，写入 `markji_card_id` 等字段，同时写一行 `exports`。
  3. **限速器**：`src/lib/cards/rate-limit.ts`，纯函数加上时钟注入，方便单测。滑动窗口：10 秒最多 20 次、60 秒最多 40 次，请求间隔至少 500ms。上传和建卡都算请求。
  4. 遇到 429 或 5xx：等待 5 秒、10 秒，最多重试 3 次。遇到 4xx：这张卡标记失败，记下 `push_error`，继续推下一张。
  5. 服务重启后：`running` 状态的任务在下一次查询状态时继续执行。`pushing` 状态的卡，先查询墨墨上有没有这张卡；查不到就重新推，**不能重复建卡**。具体做法：建卡前把卡片 id 写进推送的内容里作为隐藏标记，例如在来源标签里带上卡片 id 的后 6 位；重启后列出章节里的卡片来比对：现有的 `listChapters` 不支持带卡片，需要给它加一个 `withCards` 参数，对应接口 `GET /decks/{deck}/chapters?with_cards=true`。实现时选一种可靠的方法，并写在提交说明里。
- **`GET /api/cards/push/:jobId`**：返回 `{ done, failed, total, status, failures: [{cardId, error}] }`。

### 7.6 撤回（F6，阶段三）
- **`POST /api/cards/:id/withdraw`**：
  1. 校验这张卡属于当前用户，并且状态是 `pushed`。
  2. 列出牌组里的章节，查找名为「🗑 ReadFlow 待删除」的章节，找不到才新建。
  3. 调用移动卡片接口：`POST /decks/{deck}/chapters/{markji_chapter_id}/cards/move`，参数 `{card_ids, to_chapter_id}`。在 `src/lib/markji.ts` 里新增 `moveCards`、`createChapter` 两个函数。
  4. 把卡片状态设为 `withdrawn`，并删除对应的 `exports` 行。如果这个词已经没有其它推送成功的卡，词库里会自动变回「未导出」。
  5. 返回 PRD F6 里写好的提示文案。

### 7.7 已做卡又查过（F7，阶段三）
- 记录查词事件时，如果这个词存在 `status = 'pushed'` 的卡片，就把 `carded_before` 设为 1。
- **词库标记**「做过卡，又查了 N 次」：N 是最早一次推送之后，这个词新增的查词次数（来自 contexts 或 explain_events）。

---

## 8. 前端

### 8.1 阅读页：建议和做卡按钮（阶段一）
- 改 `src/components/Reader.tsx` 的 `PickCard`：
  - 显示 AI 回答前，先经过 `splitCardSuggestion`。正文照常显示；有建议时，在对话串下面显示一行 `💡 建议做成卡片：<理由>`，文字用 `--rf-ai-text`，`text-sm`。
  - 在「✨ 问 AI」按钮旁边加一个「＋ 做成卡片」按钮。
    - 有建议时，用紫色强调样式（同 `.rf-ai-primary` 的配色）。
    - 没有建议时，用 `.duo-btn-white` 的小号按钮。
    - **不能用绿色**，因为阅读页右栏已经有绿色主操作。
  - 按钮的五种状态和文案逐字照抄 PRD F2 的表格。生成中每 2 秒查询一次状态。
  - 点击时带上最近一次讲解的 `answerId`。P32 已经把它存在对话串的每一段里，取最后一段的。
- 「已生成草稿」状态下点「查看」：跳到 `/words?status=pending&word=<wordId>`，并展开这个词。

### 8.2 词库：「待推送」（阶段一）
- **`src/components/WordList.tsx`**：
  - `StatusFilter` 新增 `"pending"`。左侧状态列表里，放在「已导出」之后，显示「待推送 (N)」，N 来自 `/api/cards/pending`。
  - 支持用 URL 参数 `?status=pending&word=` 打开时直接定位。
- **待推送视图**：
  - 列表上方是**推送栏**：牌组选择（沿用 `GET /api/markji/decks`）、章节选择（沿用 `GET /api/markji/decks?deckId=`，原来 `ExportPanel` 就是这样取章节的）、「按文章自动建章节」的复选框、「推送全部」（绿色主按钮，这一屏唯一的绿色按钮）。
  - 推送中显示进度条和「已推送 N / 共 M」；失败的卡单独列出，可以重试。
  - 没有配置墨墨 Token 时，推送栏换成一句提示，并给出去设置里填写的链接。
- **词的行展开后**：显示这个词的每张草稿卡，用新的共享组件 `src/components/CardPreview.tsx`：
  - 预览按 `PreviewModel` 渲染：标签行、正面、提示层、背面分区。挖空显示成下划线空格，选择题显示选项。
  - 「翻面」按钮在正面、提示层、背面之间切换。
  - 有音频时显示播放按钮。音频来自 `GET /api/tts/:hash`：需要登录，并且只返回本人卡片用到的音频。
  - 「需要人工检查」的卡放在最前面，顶部用 `.st-notice` 风格的提示条显示原因。
  - 操作按钮：「修改」「换一道」「删除」，用 `.duo-btn-sm` 的白色次要按钮。
- **修改界面**：
  - 不能直接改墨墨语法。按块显示成表单：每个文字块一个输入框，选项可以增删、可以改哪个是正确答案。
  - 原句的输入框只读，并显示提示「原句来自文章，不能修改」。
  - 保存时调用 PATCH；校验失败时，把服务端返回的中文原因显示在表单顶部。
- **已推送的卡**：在词的详情里显示「已推送 N 张」，展开后每张卡有「撤回」按钮（阶段三）。

### 8.3 设置（阶段一 / 二）
- 「墨墨记单词」页：新增「墨墨会员等级：普通 / 专业」（`.rf-seg` 分段控件），下面说明「决定每张卡最多多少字」。
- 「学习档案」页（P32）：新增「听力口音：美音 / 英音」「整句语速：正常 / 稍快」，以及「卡片背面附发音」开关。这些在阶段二上线时才显示。
- 站长在「模型」页多两个开关：「做卡」「听力卡」。

### 8.4 插件侧栏（阶段二，依赖 P31）
- P31 侧栏的对话串下方，加上同样的建议行和「＋ 做成卡片」按钮。插件通过 `POST /api/extension/cards/generate` 和 `GET /api/extension/cards/sets/:id` 调用，消息类型为 `rf:cardGenerate`、`rf:cardStatus`。
- 「查看」：在新标签页打开 `<serverUrl>/words?status=pending&word=<wordId>`，经过 `rf:openReadflow`，只允许打开 serverUrl 开头的地址。

### 8.5 一段多空（阶段三）
- 待推送视图里，某篇文章的**同一段**有 2 个及以上的词处于草稿状态时，在这几个词上方显示提示：「这一段有 N 个词，要合成一张一段多空卡吗？」，按钮「合成」。
- 点「合成」：`POST /api/cards/merge { setIds }` → 生成一个新组，`merged_from` 记录原来的组 → 让用户选择「保留原来的卡」或「删除原来的卡」。

---

## 9. 删除旧的导出功能（阶段一，PRD Q2）
- 删除 `src/app/export/page.tsx` 和 `src/components/ExportPanel.tsx`。
- 删除 `src/app/api/export/route.ts` 里的推送逻辑。整个路由改成只返回 410，提示「导出已改为在 我的词库 → 待推送 里完成」。
- `/export` 页面改为跳转到 `/words?status=pending`：可以在 `src/proxy.ts` 里重定向，也可以保留一个只做跳转的页面。
- **改所有引用旧功能的地方**：
  - 词库工具栏的「导出到墨墨」按钮，改成「待推送 (N)」。
  - 删除 `NavTabs`、`BottomNav` 里对 `/export` 的特殊处理。
  - 删除 `e2e-word-library` 里关于旧导出的断言，改成断言新的入口。
- `src/lib/cardgen.ts`：把还用得到的工具函数（`esc`、`oneLine`、`lintCard`、`normalizePhonetic` 的用法）挪进 `src/lib/cards/`，其余内容删除。用 `grep -rn "cardgen\|CARD_TYPES\|ExportPanel\|/api/export" src scripts tests` 确认没有残留引用。
- **保留**：`exports` 表及其数据、`src/lib/markji.ts`（还要新增 `uploadFile`、`createChapter`、`moveCards`）、`/api/markji/decks`。

---

## 10. 语音合成（阶段二）
- `src/lib/tts.ts`，接口：`synthesize(text, { voice, speed }): Promise<Buffer>`，输出 mp3。
  - 服务商：**阿里云百炼**的语音合成（PRD Q3）。用 `fetch` 调官方的 HTTP 接口，**接口地址、参数和英文音色名以百炼官方文档为准**。实现前先查文档，挑选美音和英音各一个音色，写进 `src/lib/cards/voices.ts`，并在提交说明里写明使用的接口和音色。
  - API Key 读环境变量 `DASHSCOPE_API_KEY`，没有的话读站级设置里的千问 Key。都没有时，听力零件不可用，AI 也不会收到听力零件的说明。
- 存储：文件放在 `data/tts/<hash>.mp3`，复用 `tts_audio` 表。按内容哈希生成**一次**，所有用户共用。
- 限制：单词不超过 40 个字符，整句不超过 400 个字符，超过的不合成。
- `GET /api/tts/:hash`：需要登录，只返回本人卡片用到的音频（通过 `cards.spec` 反查）。响应头 `Content-Type: audio/mpeg`，设置私有缓存。
- **上线前的墨墨实测**（PRD §11）：先写一个只读的验证脚本 `scripts/markji-probe.mjs`，**脚本本身不执行任何写操作**。写入测试需要产品负责人同意后，在测试牌组里手动执行。结论写进 `docs/specs/P33-markji-probe.md`。

---

## 11. 测试

### 11.1 单元测试（`tests/unit/`）
| 文件 | 至少覆盖 |
|---|---|
| `cards-spec.test.ts` | `parseCardGen`：合法 JSON、丢弃未知字段、类型错误、卡片数 0 张和 4 张被拒、非 JSON 文本 |
| `cards-validate.test.ts` | §5.2 的 11 条规则**每条都有通过和不通过两种用例**；`charLimit` 刚好 1800 时通过、1801 时不通过；多选题和单选题的正确答案数 |
| `cards-render.test.ts` | 每种 `kind` 的标签和 emoji；三种颜色的写法；`highlight` / `blank` / `prefix` / `paragraph_cloze` 的渲染；`[` `]` 转义；`emphasis` 最多 4 处；「AI 补充」标记；提示层的答案线顺序；音频占位符；渲染结果全部能通过 `lintCard`；不包含 `[Pic#` |
| `cards-preview.test.ts` | `renderPreview` 和 `renderCard` 的标签、分区、挖空答案一致 |
| `cards-suggestion.test.ts` | `splitCardSuggestion` 的各种边界情况；`inlineGloss` / `cardGloss` 处理带建议行的讲解后，输出里不出现「制卡建议」和「💡」 |
| `cards-prompt.test.ts` | 出题指令里包含：所有原则、「示例菜单不是限制」、JSON 格式、1～3 张；听力开关打开和关闭时，听力零件说明分别出现和不出现；学生档案出现在指令里 |
| `cards-rate-limit.test.ts` | 用注入的时钟验证：10 秒 20 次、60 秒 40 次、间隔 500ms；跨窗口后恢复 |
| `cards-explain-cache.test.ts` | 10 分钟过期；最多 500 条，超出时淘汰最旧的；用户、记录不匹配时不命中 |
| `cards-quota.test.ts` | 每天 30 次；自带 Key 不受限；按上海时区的日期切换；失败不计数 |

所有纯函数模块都要加进 `tsconfig.unit.json` 的 `include`，**只能用相对路径 import**，不能用 `@/` 这类别名。

### 11.2 覆盖率
- `npm run test:coverage` 的 include 加上 `.unit/src/lib/cards/**`，门槛同 §0.3。提交说明里贴出覆盖率汇总表。

### 11.3 端到端 `scripts/e2e-cards.mjs`
使用隔离数据库，端口 **3137**。至少覆盖：
1. 讲解里出现建议行（假模型返回带「制卡建议：」的回答）：右栏显示「💡 建议做成卡片」，按钮是强调样式；阅读页上方的中文小标签和词库释义里**都没有**建议行。
2. 点「＋ 做成卡片」：1 秒内显示「正在做卡…」，假模型返回 JSON 后显示「✓ 已做成 N 张卡 · 查看」。假模型记录下的出题请求，**messages 的前缀和刚才讲解的 messages 逐字一致**（这是命中缓存的前提）。
3. 超过 10 分钟（测试里修改缓存时间）或没有 answerId 时，照样能生成，并且出题请求里包含存下来的讲解。
4. 假模型故意返回违规的卡（正面只有单词 / 原句被改动 / 选择题有两个正确答案）：被拦截，并且重出；复核不通过时标记「需要人工检查」，在待推送里排在最前面。
5. 「待推送」筛选的数量正确；预览可以翻面；修改选项后保存，渲染内容随之更新；改原句返回 400；换一道最多 5 次；删除后数量减 1。
6. 选择牌组和章节后推送：使用假墨墨服务。验证：先查章节再建、请求速率符合限速、`exports` 写入、词库显示「已导出 · 墨墨 · N 张」；推送途中重启服务器，任务能继续，并且不重复建卡。
7. 每天额度：站点模型下第 31 个词返回 429，提示文案正确；填了自己的 Key 后不受限；生成失败不扣次数。
8. 旧入口：`/export` 跳转到待推送；`/api/export` 返回 410。
9. 阶段二：听力开关打开后，生成听力卡，推送时先上传音频（假墨墨服务收到 multipart 请求）再建卡；卡片内容里是真实的 file.id，不含占位符；同一段文字第二次不再请求假语音服务。
10. 阶段三：撤回后，假墨墨服务收到移动卡片的请求，「待删除」章节只建一次；`exports` 行被删除；一段多空卡能合成。
11. 截图：阅读页的按钮和建议、待推送列表、卡片预览（正面和背面）、修改表单、推送进度，各截 1440px 和 390px，并检查 390px 下没有横向溢出。

### 11.4 三个假服务（测试脚本里用 `http.createServer` 实现）
- **假模型**（OpenAI 兼容）：
  - 流式讲解按 P32 实现说明 §8.4 的方式实现。
  - 非流式出题：根据请求内容返回预先准备好的 CardGenResult JSON。用请求里的关键字切换「正常」「违规」「两个正确答案」等场景。
  - 复核请求：返回 `{possible:[...]}`。
  - 每个请求的 messages 都记录下来，供断言使用。
  - 通过站长的 `PUT /api/settings` 把 `custom` 供应商指向这个服务。
- **假墨墨服务**：
  - 至少实现这些接口：`GET /decks`、`GET /decks/:d/chapters`、`POST /decks/:d/chapters`、`POST /decks/:d/chapters/:c/cards`、`POST /decks/:d/chapters/:c/cards/move`、`POST /files`（multipart）。
  - 按墨墨的格式返回数据，并在服务端**校验频率限制**，超过时返回 429。
  - 通过环境变量 `MARKJI_BASE_URL` 指向它（`src/lib/markji.ts` 已经支持这个变量）。
- **假语音合成服务**：返回一个固定的、很小的 mp3。新增环境变量 `READFLOW_TTS_BASE_URL` 指向它（`src/lib/tts.ts` 要支持这个变量）。

### 11.5 人工评审：`scripts/eval-cards.mjs`
- 在隔离数据库里创建 P32 的三个测试人设，各准备 20 个查词场景，用真实模型生成卡片。模型通过环境变量 `EVAL_PROVIDER`、`EVAL_API_KEY`、`EVAL_MODEL` 配置；没有配置时退回假模型，只用来验证脚本能跑通。
- 输出 `.verify/cards/report.md`，内容包括：
  - 每个场景、每个人设的卡片预览（文字版：正面、提示层、背面）。
  - 校验和复核的结果。
  - 缓存命中的 token 数、输出的 token 数。
  - 一张汇总表：各种题型的分布，以及「单词卡」数量（必须为 0）。

### 11.6 每个阶段都必须全部通过
```bash
npx tsc --noEmit -p .
npm test
npm run test:coverage
DB_PATH=<数据库快照> npm run build
npm run test:word-library
npm run test:invite
npm run test:account
node scripts/e2e-extension.mjs
node scripts/e2e-personalized.mjs
node scripts/e2e-cards.mjs
```

---

## 12. 交付要求
- 每个阶段单独一个提交，提交信息以 `P33-阶段一：` / `P33-阶段二：` / `P33-阶段三：` 开头。正文写清楚：
  1. 对应 PRD 的哪些功能；
  2. §11.6 每条命令的结果；
  3. 覆盖率汇总表；
  4. 截图路径；
  5. `eval-cards` 报告的路径（阶段一和阶段二）；
  6. 和文档不一致的地方及原因；
  7. 已知的限制。
- **不得**在提交里包含任何真实的墨墨 Token、模型 Key 或语音合成 Key。

---

## 13. 容易踩的坑
1. **建议行污染释义**：所有读取 AI 讲解的地方都要先调用 `splitCardSuggestion`，否则「制卡建议：」会出现在正文上方的中文小标签、词库释义和卡片背面。
2. **缓存命中不了**：出题请求的 messages 必须是「讲解时的 messages + 讲解全文 + 出题指令」，**前面部分一个字都不能改**，包括 system 提示词和学生档案。学生档案必须用缓存里的那一份，**不能**重新计算，否则内容一变缓存就失效。
3. **AI 直接写墨墨语法**：校验器第 11 条一定要拦截。墨墨语法写错不会报错，只会显示成乱码。
4. **挖空把答案留在了题干里**：`prefix` 模式只露出前几个字母，其余部分必须放进 `[F#…]`；正面其它地方不能再出现完整的词。
5. **重复建卡**：推送中断后续传时，一定要先核对墨墨上已有的卡。墨墨删不掉卡，重复了就只能让用户手动处理。
6. **章节重名**：新建章节前必须先查已有章节。墨墨删不掉章节。
7. **file.id**：大小写敏感，必须原样写入；不同墨墨账号之间不能共用。
8. **模板格式化**：墨墨语法里到处是 `[`、`]`、`#`，替换占位符时只能用 `str.replace`，不能用模板字符串拼接用户内容。
9. **额度时区**：每天的计数按上海时区（Asia/Shanghai），沿用 P28 `quotaDay()` 的写法。
10. **隐私**：`GET /api/tts/:hash` 和所有卡片接口都只返回本人的数据。`card_sets` 和 `cards` 每次查询都要带上 `user_id` 条件。
