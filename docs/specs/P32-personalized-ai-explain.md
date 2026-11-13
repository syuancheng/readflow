# P32 实现说明：个性化 AI 讲解

> **先读产品需求 `docs/prd/P32-personalized-ai-explain.md`**。PRD 说明「做什么、为什么、做到什么程度算完成」，本文说明「怎么做」以及**必须遵守的约束**。两份文档有冲突时，以 PRD 的产品行为为准，并在提交说明里写清楚冲突点。
>
> 仓库：ReadFlow（Next.js 16 + React 19 + Tailwind 4 + SQLite/better-sqlite3 + drizzle）。插件在 `extension/`（Chrome MV3，原生 JS）。

---

## 0. 硬性约束（任何一条不满足都不算完成）

### 0.1 代码与框架
- **先读 `AGENTS.md`**。这是 Next.js 16：
  - `middleware` 已改名为 `src/proxy.ts`。
  - 页面的 `params` 和 `searchParams` 都是 Promise。
  - `route.ts` 只能导出 HTTP 方法和 `runtime/dynamic` 这类配置项；共用逻辑放进 `src/lib/`。
  - 拿不准的地方查 `node_modules/next/dist/docs/`。
- 所有接口都在服务端用 `currentUser()`（网站）或 `requireExtensionUser()`（插件）确认身份，并且**校验数据归当前用户**。只在前端做校验不算数。
- 不允许新增 npm 依赖。确实需要时，先在提交说明里写清理由，由产品负责人确认。
- 不改动、不删除现有字段，也不改变现有接口已有的返回结构。只允许**新增**。

### 0.2 UI（新做的界面必须符合设计规范）
- 读 `docs/design-system.md`，颜色、字号、间距、圆角、阴影**只能用 `src/styles/tokens.css` 里的 token**，或者 Tailwind 里已经对齐 token 的类（`text-xs … text-3xl`、`rounded-sm/md/lg/xl`、`shadow-sm/md/lg`）。
- `npm test` 的第一步是 `scripts/check-tokens.mjs`。出现以下情况会直接失败：裸 hex 颜色、`text-[13px]` 这类任意值字号、`mb-1.5` 这类半步间距、不是 4 的倍数的间距、自定义的圆角或阴影。**禁止**用 `token-ok` 注释绕过检查，除非提交说明里写了理由。
- **颜色语义**（规范 §1.1）：
  - 绿色只用于主按钮、进度和成功状态。
  - 紫色用于和 AI 相关的一切：「学习档案」里 AI 的判断、老师笔记、反馈行。
  - 选中状态一律是中性灰（`--rf-bg-selected`）。
  - **一屏最多一个绿色主按钮。**
- **复用现有组件样式，不另造一套**：
  - 按钮：`.duo-btn` / `.duo-btn-primary` / `.duo-btn-white` / `.duo-btn-sm`
  - 单选、多选的选项：`.duo-filter-chip`，选中时加 `.duo-filter-chip-on`
  - 分段控件：`.rf-seg` + `.duo-tab`
  - 卡片：`.duo-card`
  - 设置弹窗内部：沿用 `.st-panel`、`.st-field`、`.st-label`、`.st-help`、`.st-switch` 等现有类
- **手机宽度**：390px 下不能出现横向滚动，问卷整页一屏看完（PRD F1）。
- **可访问性**：
  - 选项按钮带 `aria-pressed`。
  - 开关带 `role="switch"` 和 `aria-checked`。
  - 图标按钮带 `aria-label`。
  - 只用键盘（Tab / Enter / 空格）就能填完问卷。
- **文案**：所有面向用户的中文文案**逐字使用 PRD 里写好的**（问卷题目和选项、「这次讲得：太浅 · 刚好 · 太深」、F6 的各种提示）。PRD 没写到的文案，语气要和现有界面一致：简短、口语化、不用感叹号。
- 截图核对：每完成一个界面，用 `.verify/design/shots.mjs` 的方式（数据库副本 + 临时会话）截 1440px 和 390px 两种宽度，在提交说明里列出截图路径。

### 0.3 测试与质量门槛
- **单元测试覆盖率**：新增的纯函数模块（`src/lib/learner/**`）要求**行覆盖率 ≥ 90%、分支覆盖率 ≥ 85%、函数覆盖率 ≥ 90%**，用 §8.2 的 `npm run test:coverage` 强制检查，不达标命令就失败。
- **每条业务规则都要有至少一个对应的单测**，测试名称用中文写清这条规则。需要覆盖的规则包括：PRD 里的所有数字阈值（30 次、90 天、25 次 + 24 小时、300 字、每天 1 次）、问卷到起始水平的换算表、各种边界值。
- **端到端测试**：新增 `scripts/e2e-personalized.mjs`，至少覆盖 §8.3 列出的场景。**不允许调用真实模型**，统一用 §8.4 的假模型服务。
- **回归**：§8.6 的所有命令全部通过，包括已有的 E2E。
- **人工评审材料**：`scripts/eval-personas.mjs`（§8.5）生成三个测试人设的对比报告，提交时附上报告路径。
- 测试**只能**用隔离数据库和临时端口，不能碰 `data/readflow.db`。

### 0.4 性能与成本
- 个性化画像在服务端计算后缓存，**单次讲解请求多出的服务端耗时不超过 20ms**（计算画像要读的数据，最多取最近 500 条事件）。
- 发给模型的画像文本**不超过 600 个字符**（约 400 token），由 `buildLearnerBlock` 截断并保证这一点，并且要有单测。
- 老师笔记的生成**不能阻塞**任何用户请求：在后台异步执行，失败只记日志。
- 老师笔记**不扣**用户每天的免费 AI 次数（PRD F3）。
- **失败不能形成重试风暴**（P32-修复）：失败后至少 1 小时不再调用模型，每个用户每天最多尝试 3 次（成功与否都算）；非流式 `completeChat` 统一 60 秒超时，超时按失败处理并进入上述冷却。

### 0.5 开关与回退（PRD §9、Q-D）
- 站点级开关 `ai.personalized`（存在 settings 表的站级行 `user_id='local'`，值为 `on` / `off`，**默认 `on`**）。站长在「设置 → 模型」里切换，**马上生效，不需要重启**。
- 环境变量 `READFLOW_PERSONALIZED=off` 可以强制关闭，用于紧急情况，优先级高于设置。
- 开关为 `off` 时，**讲解行为必须和现在完全一致**：
  - 系统提示词逐字不变。
  - 不附加学生档案。
  - 不显示反馈行。
  - 问卷照常显示（收集数据不受影响）。
  - 现有的 `tests/unit/ai-prompt.test.ts` 必须原样通过，不允许修改它来迁就新代码。

### 0.6 依赖 P31
- 插件侧栏里的反馈行（PRD Q-E）依赖 P31（`docs/specs/P31-extension-lookup-alignment.md`）的侧栏。
- 如果 P31 还没完成，本期**先做插件以外的部分**；插件相关条目（§7）留到 P31 完成后补上，在提交说明里注明。
- 服务端接口要一开始就支持插件，见 §5.4。

---

## 1. 范围

按 PRD §9 分三个阶段交付。**每个阶段单独提交**，每个阶段都要让 §8.6 全部通过：

| 阶段 | 内容 | 本文章节 |
|---|---|---|
| 一 | F1 问卷 + F4 把画像交给 AI + 开关 | §3.1、§4.1、§4.3、§5.1–5.3、§6.1–6.3、§6.5 |
| 二 | F2 行为推断 + F5 反馈（含事件记录） | §3.2、§4.2、§5.4–5.5、§6.4、§7 |
| 三 | F3 老师笔记 + F6「AI 眼中的你」 | §3.1 笔记字段、§4.4、§5.6–5.7、§6.3 下半部分 |

---

## 2. 总体设计

```
问卷答案(F1) ──┐
行为事件(F2) ──┼─► 学习画像 LearnerProfile（服务端计算 + 缓存）──► buildLearnerBlock() ──► 讲解提示词(F4)
老师笔记(F3) ──┘                     ▲                                                        │
                                     └──── 反馈(F5) / 追问 / 「整句没看懂」 等事件 ◄─────────────┘
```

- 所有规则（问卷题目、换算、估算、画像文本、笔记校验）写成**纯函数**，放在 `src/lib/learner/`。它们不碰数据库、不发请求，因此能完整地做单测。
- 读写数据库的逻辑放在 `src/lib/learner-store.ts`。
- 网站的讲解（`/api/explain`）和插件的讲解（`/api/extension/explain`）都经过 `src/lib/explain-handler.ts` 的 `handleExplain`，**个性化只在这一处接入**，两边自动保持一致。

---

## 3. 数据模型

所有新表都在 `src/db/ensure-auth.ts` 里用 `CREATE TABLE IF NOT EXISTS` 创建（和 `invites` / `ai_usage` 放在一起），同时在 `src/db/schema.ts` 里加上对应的 drizzle 定义。

### 3.1 `learner_profiles`：每人一行

```sql
CREATE TABLE IF NOT EXISTS learner_profiles (
  user_id TEXT PRIMARY KEY,
  survey TEXT,                     -- 问卷答案 JSON，格式见 §4.1 SurveyAnswers；没填是 NULL
  survey_completed_at INTEGER,     -- 提交过问卷（哪怕全部跳过题目）
  survey_dismissed_at INTEGER,     -- 点了「以后再说」/ 关掉首页卡片
  show_feedback INTEGER NOT NULL DEFAULT 1,   -- F5 反馈行开关
  stats TEXT,                      -- F2 行为推断结果缓存 JSON（§4.2 BehaviorStats）
  stats_updated_at INTEGER,
  note TEXT,                       -- F3 老师笔记（≤300 字）
  note_updated_at INTEGER,
  note_user_edited INTEGER NOT NULL DEFAULT 0, -- 用户手动改过笔记（下次 AI 更新时作为参考保留）
  note_lookup_cursor INTEGER NOT NULL DEFAULT 0, -- 上次生成笔记时的查词事件总数
  note_last_error TEXT,
  updated_at INTEGER NOT NULL
);
```

### 3.2 `explain_events`：行为事件（F2 的数据来源）

```sql
CREATE TABLE IF NOT EXISTS explain_events (
  id TEXT PRIMARY KEY,             -- 讲解事件的 id 同时就是「这段回答」的 id，反馈靠它定位
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'lookup' | 'explain'
  ask_kind TEXT,                   -- explain 才有：'auto'|'default'|'word_only'|'whole_sentence'|'structure'|'example'|'custom'
  via TEXT NOT NULL DEFAULT 'reader', -- 'reader' | 'extension'
  word TEXT,                       -- 选区原文（最多 120 字）
  lemma TEXT,
  freq_rank INTEGER,               -- 词频排名（frequencyRank），短语或查不到时为 NULL
  is_phrase INTEGER NOT NULL DEFAULT 0,
  dict_hit INTEGER,
  repeat_count INTEGER,
  text_id TEXT,
  text_cefr TEXT,                  -- 当时这篇文章的 CEFR 难度（texts.cefr_level）
  context_id TEXT,
  feedback TEXT,                   -- 'shallow' | 'right' | 'deep'，只有 explain 才有
  feedback_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explain_events_user_time ON explain_events(user_id, created_at);
```

- 「清空 AI 记忆」（F6）只清空 `learner_profiles` 里的 `stats / note` 相关字段和游标，**不删 `explain_events`**（PRD：查词记录本身不删）。之后的画像改为只从清空时间以后的事件算起，因此还要加一个字段 `memory_reset_at INTEGER`，计算画像时用 `created_at > memory_reset_at` 过滤。
- 账号删除时这两张表要一起清理，按 `user_id` 删除。

---

## 4. 纯函数模块 `src/lib/learner/`

> 这些文件**只能用相对路径 import**（例如 `../cefr`），不能用 `@/` 别名，因为单测把它们编译成 CommonJS 后直接运行。
> 每个文件都要加进 `tsconfig.unit.json` 的 `include`。

### 4.1 `survey.ts`：问卷定义（唯一来源）

```ts
export type SurveyAnswers = {
  identity?: "middle" | "high" | "college" | "graduate" | "work_1_3" | "work_3_10" | "work_10_plus" | "other";
  exam?: "none" | "gaokao" | "cet4" | "cet6" | "kaoyan" | "ielts_toefl" | "tem";
  examScore?: string;            // 分数段的 key，取值见 EXAM_SCORE_BANDS；"unknown" 表示不记得了
  goals?: Goal[];                // Q3，多选
  readingFeel?: "every_sentence" | "few_per_paragraph" | "occasional" | "fluent";
  stylePref?: "detailed" | "balanced" | "concise";
};
export const SURVEY_QUESTIONS: SurveyQuestion[]; // 题目、选项的中文文案逐字取自 PRD F1
export const EXAM_SCORE_BANDS: Record<Exam, { key: string; label: string }[]>;
export function normalizeSurvey(input: unknown): SurveyAnswers;  // 白名单校验，非法值丢弃
export function surveyPrior(a: SurveyAnswers): { vocab: number | null; cefr: Cefr | null };
```

- 问卷页面、设置页、服务端校验和单测**都从这里读取**题目和选项，不允许在别处重复写一份。
- `surveyPrior` 的换算规则如下。先由 Q2 / Q2a 给出基础词汇量，再按 Q1、Q4 调整，最后限制在 1500–15000 之间：

| 考试 / 分数 | 基础词汇量 |
|---|---|
| 没考过 / 不填 | Q1 决定：初中 1500、高中 2500、大学 4000、研究生 5000、工作过 4000、其他 null |
| 高考 | 3000 |
| 四级 <425 / 425–499 / 500–549 / 550+ / 不记得 | 3500 / 4000 / 4500 / 5000 / 4000 |
| 六级 <425 / 425–499 / 500–549 / 550+ / 不记得 | 4500 / 5500 / 6500 / 7500 / 5500 |
| 考研英语 | 5500 |
| 雅思 <6 / 6–6.5 / 7+；托福 <80 / 80–99 / 100+ | 5000 / 6500 / 8000（托福同档） |
| 专四 / 专八 | 7000 / 9000 |

  - Q4 调整：每句都要查 ×0.8，每段查几个 ×1.0，偶尔查生词 ×1.15，基本无障碍 ×1.3。
  - 工作 3 年以上并且主要阅读目的含「技术文档」或「工作资料」：再 ×1.1。
  - 词汇量换算成 CEFR 等级：<2500 为 A2，2500–4000 为 B1，4000–6500 为 B2，6500–10000 为 C1，>10000 为 C2。
  - 全部未填时返回 `{ vocab: null, cefr: null }`。

### 4.2 `model.ts`：行为推断与画像合成

```ts
export type LearnerEvent = { kind: "lookup" | "explain"; askKind?: AskKind; freqRank: number | null; isPhrase: boolean;
  repeatCount: number | null; textCefr: string | null; feedback: Feedback | null; createdAt: number; contextId: string | null };

export type BehaviorStats = {
  lookups: number;                 // 计入的查词次数
  vocab: number | null;            // 估算词汇量（不足 MIN_LOOKUPS 时为 null）
  cefr: Cefr | null;
  typicalTextCefr: Cefr | null;    // 读得最多的文章难度
  difficulties: ("long_sentence" | "vocabulary" | "phrases")[]; // 最多 3 条
  followupRate: number | null;     // 自动讲解之后又追问的比例
  feedback: { shallow: number; right: number; deep: number };
};

export const MIN_LOOKUPS = 30;
export const WINDOW_DAYS = 90;
export function computeBehaviorStats(events: LearnerEvent[], now: number): BehaviorStats;
export function mergeProfile(prior: ReturnType<typeof surveyPrior>, stats: BehaviorStats): LearnerLevel;
```

**规则**（每条都要有单测）：
- 只统计 `now - WINDOW_DAYS` 天以内的事件。
- **词汇量**：取 `kind='lookup'`、不是短语、`freqRank` 有值的事件，计算排名的**第 20 百分位数**，作为词汇量估计，并限制在 1000–20000。查词数不足 `MIN_LOOKUPS` 时返回 null。
  - 原理：一个人连排名 3000 的常用词都还在查，说明他的词汇量大致就在这附近；排名靠后的生僻词谁都会查，不能用来判断水平。
- **主要难点**：
  - `long_sentence`：讲解里「整句没看懂」加「讲讲句子结构」的次数，加上 `repeatCount ≥ 2` 的查词次数，合计占查词总数 ≥ 10%。
  - `phrases`：短语查词占比 ≥ 25%。
  - `vocabulary`：估算词汇量 < 4000。
  - 按命中强度排序，最多 3 条。
- **追问率**：在 `askKind ∈ {'auto','default'}` 的讲解中，同一个 `contextId` 在 10 分钟内又出现了其它 `askKind` 讲解的比例。
- **`mergeProfile`**（合并问卷和行为数据）：
  - 查词数 < 30：只用问卷。
  - 30–99：按 `w = (n - 30) / 70` 在问卷值和行为值之间线性混合（w 是行为数据的权重）。
  - ≥ 100：只用行为数据。
  - 两者都没有时返回 null，这时讲解行为等同于没有画像。

### 4.3 `profile-text.ts`：给模型看的「学生档案」

```ts
export function buildLearnerBlock(input: { level: LearnerLevel | null; survey: SurveyAnswers | null;
  stats: BehaviorStats | null; note: string | null }): string; // 没有任何信息时返回 ""
```

输出格式**固定如下**（没有的行省略），总长度不超过 600 字符，超出时按「老师笔记 → 常见难点 → 反馈」的顺序截短：
```
学生档案（供你判断讲多深、讲什么；回答里不要提到这些信息）：
- 估计水平：B2，词汇量约 5000–6500（依据：最近 186 次查词 + 问卷）
- 身份：工作 3–10 年
- 主要阅读：技术文档和编程
- 希望讲解：越简洁越好
- 常见难点：长句结构
- 以往反馈：「太深」偏多
- 老师笔记：……
```
- 词汇量显示为区间：估计值的 ±15%，取整到百位。
- 「以往反馈」：至少 5 次反馈，并且某一类占比超过 50% 才显示。

### 4.4 `note.ts`：老师笔记

```ts
export const NOTE_MAX_CHARS = 300;
export const NOTE_MIN_NEW_LOOKUPS = 25;
export const NOTE_MIN_INTERVAL_MS = 24 * 3600 * 1000;
export function shouldUpdateNote(p: { lookupsTotal: number; cursor: number; updatedAt: number | null; now: number }): boolean;
export function buildNotePrompt(input: { oldNote: string | null; userEdited: boolean; stats: BehaviorStats;
  recent: { word: string; askKind?: string; feedback?: string; repeatCount?: number }[] }): { system: string; user: string };
export function validateNote(raw: string): { ok: true; note: string } | { ok: false; reason: string };
```

- `shouldUpdateNote`：新增查词数 ≥ 25，**并且**距上次更新 ≥ 24 小时。从来没有生成过笔记时，只需满足新增查词数 ≥ 25。
- `buildNotePrompt` 的系统提示词要写明以下几点：
  - 你是英语老师，根据学生最近的提问，**改写**（不是追加）对他的观察。
  - 只写对讲解有用的内容：水平、常见卡点、偏好。
  - **不要列出具体单词**，不要评价人格。
  - 不超过 300 字，纯中文段落，不分点。
  - 用户手动改过的内容要作为重要参考保留。
  - 关于水平的判断如果和统计数据冲突，以统计数据为准。
- `validateNote` 拒绝以下情况：空内容；超过 300 字（先尝试截到最后一个句号，仍超长就拒绝）；包含 6 个以上英文单词；包含评价性用词（维护一个小词表，例如「懒」「笨」「差劲」）；包含 Markdown 标记。

---

## 5. 服务端

### 5.1 `src/lib/learner-store.ts`（读写数据库）
- `getLearner(userId)`：读取或创建 `learner_profiles` 这一行。
- `saveSurvey(userId, answers)`、`dismissSurvey(userId)`、`setShowFeedback(userId, bool)`。
- `loadEvents(userId, now)`：最近 90 天、最多 500 条，并且在 `memory_reset_at` 之后。
- `getProfileForPrompt(userId)`：缓存的 `stats` 超过 6 小时才重新计算，然后返回 `buildLearnerBlock` 需要的输入。
- `logLookup(...)`、`logExplain(...) → eventId`、`setFeedback(userId, eventId, feedback)`（校验归属）。
- `resetMemory(userId)`、`editNote(userId, text)`（经过 `validateNote` 的长度和 Markdown 检查，置 `note_user_edited = 1`）。

### 5.2 开关 `src/lib/learner/flag.ts`（纯函数）+ 读取
- `isPersonalizedOn(settings, env)`：`env.READFLOW_PERSONALIZED === "off"` 时返回 false；否则读取站级设置 `ai.personalized`，没有设置时视为 `on`。
- 把 `SETTINGS_KEYS.aiPersonalized = "ai.personalized"` 加进 `src/lib/config.ts`。

### 5.3 讲解接入（F4）
- **`src/lib/ai.ts`**：
  - 给 `buildSystemPrompt` 加第 4 个参数 `opts?: { personalized?: boolean }`。
    - `personalized` 为假时返回值**逐字不变**。
    - 为真时，把现在「答案深度」里「同句第 2 次 / 第 3 次」的硬规则，替换为下面这段**深度指引**；其余内容（包括「释义：」第一行的格式约定）一个字都不改：
      > 根据「学生档案」和「观察」判断讲多深：L1 只给这句里的意思；L2 加上在这句里怎么理解或搭配；L3 再加「整句大意：」一句话概括；L4 再加句子地图，必要时给一个例句。同句连续请教、拖选长片段、档案显示长句是难点时往深处走；档案显示水平高、偏好简洁、以往反馈「太深」偏多时往浅处走。偏好简洁的学生即使同句连续请教，也只加「整句大意：」，不主动画句子地图。阅读目的会影响义项选择（例如技术文档读者优先给技术含义）。不论讲多深，第一行永远是「释义：」。
  - `ExplainParams` 增加可选字段 `learnerBlock?: string`。`buildUserMessage` 在 `contextBlock` 之前插入它；为空时不插入任何内容。
  - `streamExplain`：偏好「讲细一点」时 `maxTokens` 用 600，其余情况保持 400。
- **`src/lib/explain-handler.ts` 的 `handleExplain`**：
  1. 开关为 on 时，调用 `getProfileForPrompt(user.id)`，用 `buildLearnerBlock` 生成档案文本，填进 `params.learnerBlock`，并把 `personalized: true` 传给提示词。
  2. 写一条 `explain` 事件：`ask_kind` 从请求体的新字段 `askKind` 读取（白名单校验，缺省为 `'default'`）。
  3. 在响应头里返回 `X-RF-Answer-Id: <事件 id>`。
  4. 在后台触发一次 `maybeUpdateNote(user.id)`（§5.6）。**不要 await**。
- 阅读页的 `triggerAI` 在请求体里带上 `askKind`：
  - 自动触发的讲解：`'auto'`。
  - 「这个词在这句里什么意思」：`'default'`。
  - 「只讲这个词」：`'word_only'`。
  - 「整句没看懂」：`'whole_sentence'`。
  - 「讲讲句子结构」：`'structure'`。
  - 「再给个例句」：`'example'`。
  - 自己写的问题：`'custom'`。
- `src/lib/explain-policy.ts` 的 `shouldAutoExplain` **不改**：什么时候自动讲解的规则不变，变的是讲多深。

### 5.4 事件记录点（F2）
- **查词事件**：在 `ensureContextByAnchor` 的调用方记录（`/api/contexts/ensure`，`via='reader'`）。P31 的 `/api/extension/record` 完成后也在那里记录（`via='extension'`），现在的 `/api/extension/words` POST 先记录 `via='extension'`。
- 需要记录的字段：`word`、`lemma`、`freq_rank`（`frequencyRank(lemma)`，查不到为 null）、`is_phrase`、`dict_hit`、`repeat_count`（请求里有就带上）、`text_id`、`text_cefr`、`context_id`。
- 记录事件失败**不能**影响查词本身：用 try/catch 包住，只记日志。
- `src/lib/extension-http.ts` 的 `EXTENSION_CORS` 增加 `Access-Control-Expose-Headers: X-RF-Answer-Id`，否则插件读不到这个响应头。

### 5.5 反馈接口（F5）
- `POST /api/explain/feedback`（网站，cookie 登录）和 `POST /api/extension/feedback`（插件，Token）。
- 请求体 `{ answerId, rating: "shallow" | "right" | "deep" }`；可以改选，以最后一次为准。
- 返回 `{ ok: true }`。事件不存在或不属于当前用户，返回 404。

### 5.6 老师笔记生成（F3）
- `maybeUpdateNote(userId)`：
  - 同一个用户在**同一个进程里同时最多只跑一个**（用一个模块级的 `Set` 加锁）。
  - 先检查 `shouldUpdateNote`，满足才继续。
  - 模型用**站点配置**：`resolveProvider(allSettings(), process.env)`，不用用户自己的 Key，**不调用** `consumeAiQuota`。站点没配置模型时直接返回。
  - 用 `buildNotePrompt` 生成提示词，非流式调用（参考 `providers.ts` 里测试连接用的非流式写法，或者收集 `streamTurns` 的全部输出），`temperature 0.3`，`maxTokens 400`。`completeChat` 统一 60 秒硬超时，超时抛 `ProviderError(504)`。
  - 经过 `validateNote` 后，写入 `note / note_updated_at / note_lookup_cursor`，并把 `note_user_edited` 置回 0。
  - 校验失败、模型抛错或超时时，写入 `note_last_error`，游标不动。**因为游标不动，`shouldUpdateNote` 会一直为真，不能靠 24 小时间隔限制失败后的重试**（它只约束成功路径）。
  - **失败冷却 / 每日上限（P32-修复）**：`src/lib/learner/note-throttle.ts` 是纯函数，`note-generator.ts` 用进程内的 `Map` 保存每个用户的当日次数与最近失败时间；调用模型前先过闸门，调用结束后（成功或失败）结算一次尝试。
    - 失败后 `NOTE_FAILURE_COOLDOWN_MS`（1 小时）内不再调用模型；
    - `NOTE_MAX_ATTEMPTS_PER_DAY`（3 次/用户/天）按本机本地日期清零，成功也计入；
    - 不满足 25 次 + 24 小时、或站点没配模型，都不算一次尝试；
    - 选进程内存而不是加列：不需要迁移、不增加失败时的 DB 写入，与已有的 `running` 并发锁同生命周期；服务重启后计数清空可接受，**权威的成功节奏仍是落库的 `note_updated_at` / `note_lookup_cursor`**。

### 5.7 学习档案接口（F1 / F6）
- `GET /api/learner`：返回问卷题目定义、当前答案、`show_feedback`、合成后的水平（含依据，例如「最近 186 次查词 + 问卷」）、主要难点、笔记全文和更新时间、没有笔记的原因（`need_more_lookups: N` 或 `no_model`）、`needsSurvey`（首页卡片和注册后页面用来判断是否显示）。
- `PUT /api/learner`：`{ survey?, showFeedback?, note? }`。`survey` 经过 `normalizeSurvey` 处理，`note` 经过 `editNote` 处理。
- `POST /api/learner/dismiss`：「以后再说」，或关掉首页卡片。
- `POST /api/learner/reset`：清空 AI 记忆。前端要先二次确认。

---

## 6. 前端

### 6.1 注册后的问卷页 `/welcome`（阶段一）
- `src/components/AuthForm.tsx`：注册成功（`mode === "register"` 或 `"setup"`）后跳转到 `/welcome?next=/`；登录成功的跳转不变。
- `src/app/welcome/page.tsx`：
  - 页面结构：标题「让 AI 老师更懂你」，一句说明「花 30 秒，讲解会更贴合你的水平。每题都可以跳过。」，然后是问卷，底部两个按钮。
  - 按钮：绿色主按钮「开始阅读」负责提交，`.duo-btn-white`「以后再说」负责跳过。
  - 题目和选项从 `SURVEY_QUESTIONS` 渲染。单选题用 `.duo-filter-chip` 一行排开、放不下就换行，再点一次已选中的选项可以取消选择。Q3 是多选。Q2a 只在 Q2 选了某项考试之后才出现。
  - 已经填过问卷或已经跳过的用户访问这个页面时，直接跳到 `next`。
  - `src/proxy.ts`：这个页面需要登录，按默认规则处理即可。`SiteHeader` 和 `BottomNav` 在这个页面上隐藏，做法参考它们对 `/register` 的处理。
- 手机宽度下整页不能横向滚动，问卷在 390×844 的屏幕里滚动不超过一屏半。

### 6.2 首页提示卡片（老用户，阶段一）
- `src/app/page.tsx`：`needsSurvey` 为真时，在页面头部下方显示一张 `.duo-card`。
  - 左边：「花 30 秒告诉 AI 老师你的英语情况」。
  - 右边：`.duo-btn-sm` 主按钮「去填写」（跳到 `/welcome?next=/`）和关闭按钮 ×（调用 dismiss 接口）。
- 这张卡片**不能**让首页出现第二个绿色主按钮。首页现有的「导入并开始阅读」已经是绿色主按钮，所以卡片里的「去填写」用 `.duo-btn-white` 白色次要按钮。

### 6.3 设置 →「学习档案」（阶段一做上半部分，阶段三做下半部分）
- `src/lib/settings-form.ts`：`NavId` 增加 `"learner"`，放在「账户」分组里「个人资料」的下面，标题「学习档案」，关键词包括「问卷、水平、AI 老师、记忆、学习」。
- `SettingsDialog.tsx` 新增面板：
  - **上半部分「我的情况」**：问卷的全部题目（同 6.1 的组件，**抽成共享组件** `src/components/SurveyForm.tsx`，问卷页和设置页共用），加「保存」按钮。
  - **「讲解下方显示『太浅 · 刚好 · 太深』」**：开关，`.st-switch`。
  - **下半部分「AI 眼中的你」**（阶段三）：
    - 内容：估计水平和依据；主要难点（最多 3 条）；老师笔记全文，带更新时间，用紫色系 `--rf-ai-soft` 底色的块；没有笔记时显示原因（文案逐字取自 PRD F6）。
    - 操作：「这不准确，我来改」把笔记变成可编辑的文本框，旁边显示字数（最多 300），保存时调用 PUT；「清空 AI 记忆」用 `.st-btn-danger`，点击后弹出 `window.confirm` 二次确认。
- 站长在「设置 → 模型」里多一个开关「个性化讲解」，下方说明「关闭后恢复为按同句查询次数决定讲解深度」。

### 6.4 讲解下方的反馈行（阶段二）
- `src/components/Reader.tsx` 的 AI 对话串里，**每段已完成**（status 为 done，并且不是 `isNotAGloss`）的回答下面显示一行：
  ```
  这次讲得：太浅 · 刚好 · 太深
  ```
  - 字号 `text-xs`，颜色 `--rf-text-secondary`。三个选项都是 `<button>`，选中的那个加粗并用 `--rf-ai-text` 颜色，带 `aria-pressed`。
  - 点击后乐观更新界面，调用反馈接口；失败时恢复原状，并在 `title` 里写明失败原因。
  - `answerId` 从流式响应头 `X-RF-Answer-Id` 获取，存进这一段 Turn。回看历史记录时没有 answerId，就不显示反馈行。
  - `show_feedback` 为 0，或者站点开关为 off 时，都不显示。
- 反馈行不能挤压对话串的布局：前面用 8px 的间距隔开，不加边框。

### 6.5 站长开关 UI（阶段一）
- 见 6.3 的最后一条。切换时调用现有的 `PUT /api/settings`，新增字段 `aiPersonalized: "on" | "off"`，**只有站长能改**；非站长发这个字段，返回 403。

---

## 7. 插件（依赖 P31，阶段二）
- P31 侧栏的 AI 对话串里，加上和 6.4 一样的反馈行。样式抄 token 数值，做法同 `extension/src/popup.html` 顶部的 `:root`。
- background 的流式 port 在 fetch 拿到响应头时，先发 `{ answerId }` 给 content script，然后再转发内容片段。
- 反馈通过新消息 `rf:feedback` 调用 `POST /api/extension/feedback`，可以自动重试一次（覆盖写入，幂等）。
- 插件发起的讲解同样带 `askKind`（与 5.3 的取值相同），并且 `via='extension'`。

---

## 8. 测试

### 8.1 单元测试（`tests/unit/`）
| 文件 | 至少覆盖 |
|---|---|
| `learner-survey.test.ts` | 题目和选项文案与 PRD 一致（写成快照式断言）；`normalizeSurvey` 丢弃非法值和多余字段；`surveyPrior` 的换算表**每一格**都要测；Q4 和工作年限的系数；上下限 1500 和 15000；全部空着返回 null |
| `learner-model.test.ts` | 30 次的阈值（29 次和 30 次）；90 天窗口（89 天和 91 天）；第 20 百分位的计算和上下限；三种难点的阈值，以及最多 3 条；追问率的 10 分钟窗口；`mergeProfile` 在 29、30、65、99、100 次时的取值；`memory_reset_at` 之前的事件被排除 |
| `learner-profile-text.test.ts` | 格式固定（逐行断言）；缺少的字段省略对应行；600 字符上限和截断顺序；「以往反馈」的显示条件（少于 5 次、占比没超过 50% 都不显示）；没有任何信息时返回 "" |
| `learner-note.test.ts` | `shouldUpdateNote` 的四种组合（够数和不够数 × 满 24 小时和不满）以及从未生成过的情况；`validateNote` 的每一种拒绝原因，以及截到最后一个句号的情况；提示词里包含「不要列出具体单词」和「以统计为准」，用户改过笔记时提示词包含原文 |
| `learner-note-throttle.test.ts`（P32-修复） | 1 小时冷却与每天 3 次的常量、边界、跨天清零；**假模型持续返回不合格笔记时连续 8 次请求只调用模型 1 次**、请求间隔超过 1 小时时最多 3 次；成功也计入次数 |
| `providers-timeout.test.ts`（P32-修复） | `completeChat` 默认 60 秒；超时抛 `ProviderError(504)` 并 abort 底层请求（OpenAI / Anthropic 两条路径都测）；未超时时两种协议返回不变 |
| `learner-flag.test.ts` | 环境变量 off 优先；设置为 off 或 on；没有设置时视为 on |
| `ai-prompt.test.ts`（已有） | **原样通过**。另外新增一个测试文件 `ai-prompt-personalized.test.ts`：`personalized` 为假时，`buildSystemPrompt` 的结果和改动前一致（用快照断言）；为真时包含深度指引，并且仍然包含「释义：」第一行的约定；`learnerBlock` 出现在 user 消息开头，为空时 user 消息和原来逐字相同 |

### 8.2 覆盖率门槛
在 `package.json` 里新增：
```json
"test:coverage": "tsc -p tsconfig.unit.json && node --test --experimental-test-coverage --test-coverage-include='.unit/src/lib/learner/**' --test-coverage-lines=90 --test-coverage-branches=85 --test-coverage-functions=90 .unit/tests/unit/*.test.js"
```
- 达不到门槛时命令以非 0 退出。**提交说明里要贴出覆盖率汇总表。**
- 不允许为了凑覆盖率写没有断言的测试。

### 8.3 端到端 `scripts/e2e-personalized.mjs`
用隔离数据库和临时端口 **3135**，结构参考 `scripts/e2e-extension.mjs`。至少覆盖：
1. 注册后自动跳到 `/welcome`；全部跳过也能进首页；`needsSurvey` 变为假；首页不再出现提示卡片。
2. 老用户（没有档案）的首页出现提示卡片，点 × 后不再出现。
3. 在 `/welcome` 填写问卷后，**下一次讲解请求发给模型的 user 消息里包含「学生档案」**，并且包含对应的水平和阅读目的。这一点通过假模型服务记录收到的请求来断言。
4. 站长把开关切到 off 之后，系统提示词和改动前**逐字相同**，也不再包含档案。非站长切换开关返回 403。
5. 讲解的响应头里有 `X-RF-Answer-Id`；页面上出现反馈行；点「太深」之后数据库里有记录，改选为「刚好」后记录被覆盖；别人的 answerId 返回 404；关闭 `show_feedback` 后反馈行消失。
6. 模拟 30 次查词（用接口直接写事件，或批量调用 ensure）之后，`GET /api/learner` 返回行为推断的结果，依据里写着「最近 30 次查词」。
7. 满足 25 次加 24 小时（测试里通过直接修改数据库里的时间来模拟）之后，再触发一次讲解，后台生成笔记：笔记不超过 300 字，**用户的 `ai_usage` 次数不增加**。站点没配模型时不生成，`GET /api/learner` 返回原因 `no_model`。
8. 编辑笔记后保存，`note_user_edited` 为 1；清空记忆后笔记为空，下一次讲解的档案里不再有笔记。
9. 插件 Token 调用 `/api/extension/explain` 时，同样附带档案，并且 `via='extension'`。插件侧栏的反馈行在 P31 完成后补测。
10. 1440px 和 390px 下截图 `/welcome`、首页卡片、「学习档案」设置面板，检查 390px 时没有横向溢出（`scrollWidth <= clientWidth`）。

### 8.4 假模型服务（测试专用）
- 在测试脚本里用 `http.createServer` 实现一个 OpenAI 兼容接口：`POST /v1/chat/completions`。
  - `stream: true` 时返回 SSE：多行 `data: {"choices":[{"delta":{"content":"…"}}]}`，最后是 `data: [DONE]`。
  - 非流式时返回 `{ "choices": [{ "message": { "content": "…" } }] }`。
- **每次请求的 messages 都记下来**，供断言使用。
- 回答内容固定，例如流式回「释义：测试\n测试讲解」，非流式回一段合法的笔记。
- 测试开始时，用站长身份通过 `PUT /api/settings` 把 `custom` 供应商的 baseUrl 指向这个服务（`http://127.0.0.1:<port>/v1`），模型名随意。

### 8.5 人工评审：`scripts/eval-personas.mjs`
- 在隔离数据库里创建 PRD §8 的三个测试人设（小林、老陈、小王），写入问卷答案，再按人设生成合理的历史查词事件（小林以中频词为主、常点「整句没看懂」；老陈只查低频的技术词；小王连常用词都查）。
- 对同一组 10 个查词场景（固定在脚本里：单词、短语，以及同一句里连续查第 2、3 次各若干）分别请求讲解，并在开关 on 和 off 下各跑一次。
- 用环境变量 `EVAL_PROVIDER` / `EVAL_API_KEY` / `EVAL_MODEL` 指定真实模型；没有提供时退回假模型，只用来验证脚本本身能跑通。
- 输出 `.verify/personas/report.md`：每个场景一张表，列出三个人设在 on 和 off 下的讲解原文和字数，供产品负责人对照 PRD §4「他需要什么」进行评审。

### 8.6 每个阶段都必须全部通过
```bash
npx tsc --noEmit -p .
npm test                      # 设计规范检查 + 全部单测
npm run test:coverage         # 新模块覆盖率门槛
DB_PATH=<数据库快照> npm run build    # 快照的做法见 deploy/release-local.sh，避免和本机正在运行的服务抢 SQLite 锁
npm run test:word-library
npm run test:invite
npm run test:account
node scripts/e2e-extension.mjs
node scripts/e2e-personalized.mjs
```

---

## 9. 交付要求
- 每个阶段一个提交，提交信息以 `P32-阶段一：` / `P32-阶段二：` / `P32-阶段三：` 开头，正文包括：
  1. 做了什么，对应 PRD 的哪些功能；
  2. §8.6 每条命令的结果；
  3. 覆盖率汇总表；
  4. 截图路径；
  5. 偏离本文或 PRD 的地方，以及原因；
  6. 已知的限制。
- 阶段三完成后，额外附上 `.verify/personas/report.md`。

---

## 10. 容易踩的坑
1. **「释义：」第一行绝不能变**：正文上方的中文小标签、词库释义、墨墨卡片都依赖它（`src/lib/gloss.ts` 的 `inlineGloss` / `cardGloss`）。个性化只能改变第一行**之后**讲多少。
2. **开关关闭时必须和现在逐字一致**：不要顺手「优化」旧的提示词，旧行为就是回退的保障。
3. **单测里不要用 `@/` 导入**：会编译失败，见 §4 的开头。
4. **事件记录不能拖慢或打断查词**：一律 try/catch，失败只记日志；`explain_events` 一定要建 `(user_id, created_at)` 索引。
5. **老师笔记不要 await**，也不能扣用户的免费次数；要有并发锁，避免同一个人同时生成两份。
6. **插件读不到自定义响应头**：必须加 `Access-Control-Expose-Headers`（§5.4）。
7. **隐私**：画像和笔记只能本人看到，站长也看不到别人的（PRD §6）。`GET /api/learner` 永远只返回当前登录用户的数据，不要加任何「按 userId 查别人」的参数。
8. **词频排名**：`frequencyRank` 依赖词典的大小写不敏感索引（`src/lib/dict.ts` 的 `ensureNocaseIndex`），不要换成会全表扫描的查询。
