# ReadFlow 技术实现文档

> 面向要改这个仓库的人（包括三个月后的自己）。
> 产品定位与背景见 [`../README.md`](../README.md)。

**版本**：本地单机可用（P0–P4、P6、P8 CEFR 粗估、P9 结构化导入、P10 AI 释义重构、P11 词典未命中自动问 AI、P12 AI 释义持久化与批注锚点修复、P13 AI 释义语义回归已完成）
**代码规模**：`src/` + `scripts/` 约 6k 行（TypeScript / TSX / CSS）
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
│ data/readflow  │        │ data/dict/ecdict.db│   │ api.deepseek.com│
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
| `texts` | `id`(uuid), `user_id`, `title`, `source_type`(paste/file/url/**web**), `source_url`, `language`, `word_count`, `created_at`(ms), `cefr_level`, `cefr_score`, `cefr_detail`(JSON), `cefr_method`, `cefr_overridden`, `source_format`(plain/markdown/html), `source_raw` | 一篇文章；难度字段可空（3.4）；`source_raw` 存原始源，供换解析器时无损重跑（3.5，>2MB 不落库）；`web` 是插件查词自动建的**网页摘录**（12.9），不是完整文章，不进首页 / 书架 / 战绩 |
| `paragraphs` | `id`(uuid), `text_id`, `idx`, `content`, `block_type`, `block_meta`(JSON), `inline_ranges`(JSON) | **锚定基准**。`content` 只存可见纯文本，是 `contexts.start/end` 唯一坐标基准；后三列只描述排版，不参与定位。索引 `(text_id, idx)` |
| `user_words` | `id`(uuid), `user_id`, `lemma`, `display_form`, `pos`, `phonetic`, `translation`, `note`, `created_at` | 唯一索引 `(user_id, lemma)` —— 一个词只存一行 |
| `contexts` | `id`, `user_word_id`, `text_id`, `paragraph_id`, `start`, `end`, `quote`, `prefix`, `suffix`, `ai_gloss`, `dict_entry`(JSON 快照), `via`(reader/extension), `created_at` | 收词一条；锚点路径（`ensureContextByAnchor`）幂等，手动收词刻意不去重；`via` 记「从哪儿记的」，粒度是单条记录（12.9） |
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

`src/lib/dict.ts` 的 `lemma()` 用一行正则就从 exchange 里拿到了原形——**不需要任何 NLP 库、不需要规则表**。这是整个项目性价比最高的一个发现。

⚠️ 但这行正则踩过两个坑，都是实测数据才暴露的：

```
1. `0:` 不一定在首位
   went      "0:go/1:p"        （0: 在首位）
   glistened "1:pd/0:glisten"  （0: 在第二段）← 原来的 ^0: 正则直接失配
   glasses   "1:s3/0:glass"
   → 改成 /(?:^|\/)0:([^\/]+)/

2. 有些变形词 exchange 是空的，只在中文释义里留了指针
   was → exchange = null，translation = "be的过去式"
   → 退一步解析中文，正则必须锚在开头，否则
     "下雨（rain的过去式）" 里括号内的补充说明会被误当成原形来源
```

`lookup()` 的三步：

```
1. 先算原形：exchange 的 0: 段 → 中文指针 → 自己
2. 是变形词（lemma ≠ 自己）就查原形词条，然后决定展示哪条释义：
   - 变形词自己是正经词条（有柯林斯星级 / 牛津核心词 / 词频）→ 用自己的
     glasses 眼镜、better 较好的、running 赛跑 —— 这些义项丢了很亏
   - 释义是「xx 的过去式」这种指针 → 用原形的（went → go）
   - 释义和原形释义**没有汉字重合** → 用自己的
     leaves 的 exchange 指向 leave「离开」，但它自己的释义是「树叶」；
     直接用原形会把阅读时的意思讲错
   - 其余 → 用原形的（glistened → glisten、studies → study）
3. 原形查不到 → 用直查结果；都没有则 entry = null（前端切第 2 层走 AI）
```

**旧实现（已废弃）**：用 `translation.length > 10` 猜「有没有实义释义」。结果是 `glistened`
的 "v. 湿物闪耀, 闪亮( glisten的过去式和过去分词 )" 被当成独立词条，lemma 存成了
`glistened` —— 词库里 glisten / glistened 分成两条，卡片标题也是变形。

改完之后**历史数据要用 `npm run backfill:lemma` 对齐**（默认 dry-run，加 `--apply` 才写库）：
它按新规则重算每个词的 lemma，顺带刷新指针式释义；lemma 撞上已有词时合并
（上下文和导出记录一起迁过去，导出记录撞唯一键则丢弃）。

### 2.4 账户体系的数据模型（P20）

新增两张表，**业务表一列没动**（第一天预留的 `user_id` 兑现了）。

| 表 | 关键列 | 说明 |
|---|---|---|
| `users` | `id` (UUID)、`username` UNIQUE、`phone` UNIQUE（P21，归一化 11 位，可空：老账号补列后为 NULL）、`password_hash`、`display_name`、`is_owner`、`created_at` | 密码是 `scrypt$<salt hex>$<hash hex>`，绝不存明文。只有 `/setup` 建的首个账号 `is_owner=1` |
| `sessions` | `token_hash` PK、`user_id` → users、`expires_at`、`created_at` | 只存原始 token 的 sha256；原始 token 只在 cookie 里。DB 泄露也换不到登录态 |
| `settings` | 主键改成 `(user_id, key)` | 从单行 KV 变成「站级默认 + 用户覆盖」，规则见 8.7 |

**`'local'` 的语义变了**：`LOCAL_USER` / `GLOBAL_USER` 不再是「当前用户」，只用于①各表 `user_id` 的 DEFAULT、②`settings` 里站级共享配置的行标识。真实账号 id 是 `users` 表的 UUID。业务代码写入必须显式给 `currentUser().id`，不能依赖默认值，否则数据又堆回站级行。

`ensureAuthSchema()` 放在**连接层** `db/sqlite.ts` 而不是 `db/index.ts`：登录 API 与设置中心可能先于主 schema 初始化被读取。它幂等地建 `users` / `sessions`，并把老 `settings` 表（`key` 单列主键）重建成复合主键——SQLite 不能 ALTER 主键，只能 `CREATE new → INSERT SELECT → DROP → RENAME`，全程包在事务里。老配置全部归到站级，一条不丢；老库的 `profile.*` 与 `user_id='local'` 的文章/词，在 `/api/auth/setup` 建号事务里迁到 owner 名下。

**老库迁移必须容忍主表不存在**：全新空库上连接层只建了账户表，`texts` / `user_words` 要等第一次 `import @/db` 才由 `db/index.ts` 建立。setup 事务里的 `UPDATE ... SET user_id` 因此先查 `sqlite_master`，否则事务抛错会被 catch 误判成「账号已存在」而返回 403。这个 bug 正是 `test:account` 在全新库场景下抓到的。

---

## 3. 链路一：文本导入

```
ImportForm（客户端）
  ├ 粘贴：textarea         ┐
  ├ 上传：File.text()      ├ format: auto | plain | markdown（前端只做提示）
  └ 网页：只传 URL         ┘
        │
        ▼  POST /api/texts { title?, text?, url?, format?, sourceType? }
src/app/api/texts/route.ts
  1. 有 url → extractFromUrl()：优先站点官方 .md，否则 Readability 正文 HTML（3.1）
              ├ markdown → parseMarkdown()
              └ html     → parseHtmlBlocks()
     无 url → parsePasted(raw, format)：服务端独立探测 → parseMarkdown() / parsePlain()
  2. 得到 Block[]（统一 IR，3.5）；空 → 400；无标题 → 取首段可见文本前 40 字
  3. parts = proseTexts(blocks)  ← 只留自然语言正文，代码/hr/figure 不进统计
  4. countWords(parts) + estimateCefrForParts(parts)  ← 事务外，失败不影响导入（3.4）
  5. db.transaction：插 texts（cefr_* + source_format/source_raw）
                    + 批量插 paragraphs（content + block_type/block_meta/inline_ranges）
  6. 返回 { id, title, paragraphCount, wordCount, sourceFormat, blockKinds, cefr* }
        │
        ▼  前端 router.push(`/texts/${id}`)
```

### 3.1 URL 提取（`lib/readability.ts`）

**先问站点要结构化源，再考虑自己刮。** Mintlify / Docusaurus 一类文档站会在 HTML 里放：

```html
<link rel="alternate" type="text/markdown" href="/docs/en/best-practices.md">
```

同时页面上有「Copy page」按钮——它复制出来的就是这份官方 Markdown。所以 `extractFromUrl()` 的顺序是：

1. `fetch`（桌面 UA，20s 超时）→ `new JSDOM(html)`；
2. 找 `link[rel~="alternate"][type="text/markdown"]`，解析成绝对 URL 后再 `fetch` 一次；
3. **双保险校验**：`content-type` 含 `text/markdown` 且正文有 Markdown 特征，才认它是 Markdown。否则 HTML 404 页会被误当正文；
4. 拿到官方 `.md` → `{ markdown, html: null }`，交给 `parseMarkdown()`；
5. 没有官方源 → `Readability.parse()` 拿 `article.content` 的**内容 HTML**，交给 `parseHtmlBlocks()`（3.5）。

返回类型从旧的 `{ title, text }` 改成 `{ title, markdown, html, sourceUrl }`。**旧版 `htmlToParagraphs()` 已删除**：它按块级元素取 `textContent` 再用 `\n\n` 拼回纯文本，这一步会永久丢掉表格的行列关系、`<pre>` 里的换行和链接的 href。现在 HTML 交给 `jsdom` 直接遍历 DOM 生成 Block[]，不经过 Turndown 这类二次有损转换。

失败信息是给人看的：「没能从这个页面提取出正文（可能是登录墙或纯前端渲染）」。

### 3.2 切段（`lib/split.ts`）

```
原文 → 归一化换行(\r\n→\n) → trim
  ① 按空行切（\n\s*\n+）
  ② 按单换行切（\n+）
  若 ① 只得 1 段且 ② 得 > 3 段 → 判定为「单换行文本」（小说/字幕）→ 用 ②
```

每段再归一化：多空格压成一个、内部换行变空格、trim。

**这条路现在只服务纯文本输入**（`parsePlain()`，见 3.5）。Markdown / HTML 走 AST 或 DOM，不再经过切段与归一化——正是「内部换行变空格」这一步，以前把表格和代码块压成了不可恢复的一行。

`splitParagraphs` 是**所有位置语义的起点**：切段规则一改，历史 `contexts` 的段内偏移全部失效（`paragraph_id` 还在，但同一个 id 对应的 content 可能变了）。所以**不要动切段逻辑，除非接受旧锚点失效**——真要改，用 `resolveAnchor()` 的降级路径兜住。

### 3.3 词数统计

英文按空白、CJK 按字。用于列表展示与每日目标计算（`goal = max(20, round(wordCount * 0.05))`）。

结构化导入后，输入是 `proseTexts(blocks)` 而不是全部 Block：`code` / `hr` / `figure` 被 `isProse()` 过滤掉。`/api/summarize` 的分段小结和 `Reader.planSections()` 用同一套过滤规则，保证 `startIdx/endIdx` 仍能对上段落下标。这也解释了 3.4 里技术文档按 Markdown 导入时词数下降的原因。

### 3.4 CEFR 难度粗估（导入时算一次）

**问题定义。** CEFR 是描述「人」的能力框架，不是文本标准。分级读物是作者按词汇大纲 / 语法大纲**写**到某一级；我们要做的是反过来，拿任意文本**测**它大概需要什么水平才读得动。这是预测问题，不是认证，级别边界天然模糊。Readlang 的做法是服务端在导入时算好 metrics、前端只显示一句 *"Rough estimate of the CEFR level required based on the vocabulary and complexity of the text"*，我们照抄这个信息架构（也是用户确认的第一版方案）。学术界用 XGBoost + 200 多项特征约 70.9% 准确率、Top-2 95%；单用 Flesch 这类可读性公式只有 31–42%。所以：**词汇是主判据，句法只当修正项**。

**代码分层。**

```
src/lib/cefr.ts         纯函数：不碰 DB、不依赖 Node 模块，可单测
  ├ wordsOf / splitSentences     确定性切词切句
  ├ analyzeFeatures(parts, rankOf)  ← 词典查询由调用方注入
  └ scoreFeatures(features)      → level / score / confidence / adjacentLevel / detail
src/lib/cefr-dict.ts    服务端适配：frequencyRank() 接 ECDICT + 按词形缓存 + try/catch
src/db/ensure-cefr.ts   给老库 ALTER 补列（应用启动与回填脚本共用同一份定义）
src/components/CefrBadge.tsx  纯 CSS hover 弹层，服务端组件
```

**词汇路（权重 0.7）。** ECDICT 的 `frq` 是 COCA 词频排名（1 最常用，最大 47062；77 万词条里只有 42231 个有排名）。一篇文本要读得动，绝大部分**词次**必须落在学习者已掌握的高频词里。按词次取平均 `log(rank)`，再叠加低频词（`rank > 8000`）占比：

```
logScore   = clamp((meanLogRank - 4.2) / 2.8) × 100     4.2≈rank 67，7.0≈rank 1100
rareScore  = clamp(rareRatio / 0.35) × 100
vocabScore = 0.75 × logScore + 0.25 × rareScore
```

取 `log` 是因为排名跨 4 个数量级，直接平均会被少数极生僻词拖飞。两个必须绕开的数据坑：

1. **变形词本身没有 `frq`**（`was` / `are` / `said` 都是 null），不还原成原形会把最普通的功能词当生僻词，实测能把短篇的高频覆盖率拉低十几个点 → `frequencyRank()` 查不到时按 `lemma` 规则（`exchange` 的 `0:` 或中文指针）回查原形。
2. **LaTeX / 公式 / 单字母变量不是词汇**：`Scaling Laws` 那篇有 685 个 `n / d / c / beta / frac`，过滤掉后平均句长才从 20.2 回到合理区间 → `wordsOf()` 丢掉所有单字母 token。

**复杂度路（权重 0.3）。** `complexityScore = 0.5×lenScore + 0.35×longScore + 0.15×subScore`，分别由平均句长（8→0 分、28→100 分）、≥25 词长句占比（35% 饱和）、含从句/衔接标记的句子占比（50% 饱和）线性映射。切句用纯正则 + 学术缩写白名单（`et al.` / `e.g.` / `Dr.`），刻意不用 `Intl.Segmenter`：结果要落库，不同 ICU 版本必须给出同一个值。

最终 `score = 0.7×vocabScore + 0.3×complexityScore`，6 级等分 0–100（每级约 16.67 分）。

**落库而非只存级别。** `texts` 存 `cefr_level`、`cefr_score`（连续分，算法升级可离线重算）、`cefr_detail`（JSON：三档词汇占比、句法统计、置信度、caveats）、`cefr_method`（`heuristic-v1`）、`cefr_overridden`。相邻级别与置信度不单独占列：前者由 `adjacentOfScore(score)` 纯函数推出，后者写进 detail JSON。

**置信度是工程判断，不是模型概率**：词数 <150 / 句数 <8 / 未收录词 >25% → `low`；词数 ≥500 且句数 ≥25 且未收录 ≤10% → `high`；其余 `medium`。未收录词多是专有名词、术语、公式符号的信号，会高估难度，所以弹层里直接把这条偏差写出来。

**实测校准（本机 4 篇真实文本，`npm run backfill:cefr`）**：

| 文本 | 词/句 | 平均 log(rank) | 低频词占比 | 平均句长 | 结果 |
|---|---|---|---|---|---|
| The Night Rain | 87 / 6 | 4.80 | 12.6% | 14.5 | **A2** 23.9 分，置信度低 |
| Prompt Engineering — Lilian Weng | 3546 / 215 | 6.35 | 24.3% | 16.5 | **B2** 65.6 分（接近 C1） |
| Best practices for Claude Code | 8223 / 356 | 5.98 | 22.3% | 23.1 | **B2** 66.7 分（接近 C1） |
| Scaling Laws, Carefully | 4535 / 213 | 6.35 | 24.8% | 21.3 | **C1** 71.4 分 |

词汇路把短篇故事与技术长文分开（4.80 vs 6.0–6.35），复杂度路把技术长文之间再分开（16.5 / 21.3 / 23.1 词/句）——这正是双路设计的预期效果。注意 Best practices 词汇更简单（5.98）但句子更长，两条路互相抵消后落在 B2 上沿：这正是我们保留连续分和明细、而不是只显示一个字母的原因。单测里用「控制变量」锁住这个性质：只改词汇难度时复杂度分必须完全不动，只改断句时词汇分必须完全不动。

**展示。** 首页列表与阅读页常驻顶栏各一个低调徽章（P19 前阅读页放在标题行下方）；悬停（或键盘聚焦）用纯 CSS 展开明细。不用 click 是因为列表整行是一个 `<Link>`，嵌套可点击元素会互相打架；组件也因此不需要 `"use client"`。文案明确写「粗略估计」「不是 CEFR 官方评级」。

**回填与重算。** `npm run backfill:cefr` 默认 DRY-RUN；`node .verify/scripts/backfill-cefr.js --apply` 写入，加 `--force` 用当前算法重算全部（`cefr_overridden = 1` 的行永远跳过）。脚本加载 `src/db/ensure-cefr.ts` 自行补列，不依赖服务已重启。改完代码记得 `npm run build && bash scripts/service.sh restart` —— 本机跑的是 `next start` 生产构建。

### 3.5 结构化导入：Block IR（P9）

**问题定义。** 用户把 Claude Code 官方文档的「Copy page」粘进来，看到的是一张糊成一段的表格、一坨带围栏标记的 JSON 代码块和全部消失的标题层级。第一反应容易是「URL 抓取把 HTML 压平了」，但查库发现那篇是 `source_type = "paste"`、`source_url = null` —— 用户粘贴的本来就是**完整正确的官方 Markdown**。是我们把它当纯文本吞了：

```
官方 .md → splitParagraphs() → normalize() 把段内换行压成空格 → paragraphs.content 只剩纯文本
         → Reader.tsx 对纯文本 tokenize() → 没有任何结构信息可渲染
```

根因不在 CSS，也不在渲染：**结构信息在入库那一刻被丢弃了**。旧 `content` 里 `| | Non-deterministic ... |` 已经无法反推原来的行列，所以旧文章不可逆，按约定不做迁移工具，只能重新导入。

**为什么不是三套解析器。** 需求是同时兼容「新闻只有段落 / 论文有图表 / AI 博客有代码块」。如果按体裁写三套分支，等于把「格式」和「内容类型」耦合：一篇带表格的新闻会走错分支，MDX 里一个代码块又得再开特例。正确切法是按**输入格式**分层，与体裁无关：

```
                  ┌ 粘贴/上传 Markdown ─ remark-parse + remark-gfm ─┐
  多种输入 ───────┼ URL 官方 .md ───────────────────────────────────┼→ Block[] ─→ 一套渲染后端
                  ├ URL 普通网页 ─ Readability HTML → jsdom ────────┤   (Reader.tsx)
                  └ 纯文本 ─────── splitParagraphs() ───────────────┘
                        统一中间表示 IR
```

**IR 契约（`src/lib/import/types.ts`）。** 一个 Block 只有四个字段：

```ts
type Block = {
  kind: "heading" | "paragraph" | "list_item" | "table_cell" | "quote" | "code" | "hr" | "figure";
  text: string;          // 用户可见纯文本，不含任何 Markdown / HTML 标记
  ranges: InlineRange[]; // 相对 text 的 [start, end) 样式/链接区间
  meta: BlockMeta;       // depth / listId / tableId / row / col / lang / callout / skip
};
```

三条不变量，破坏任何一条都会让锚点错位：

1. **一个 Block = 一条 `paragraphs` 记录 = 一个 `data-pid` 容器。** 表格每个 cell、列表每个 item 各自独立成 Block，`idx` 连续。
2. **`text` 是唯一坐标基准。** `contexts.start/end`、`tokenize()` 的 `data-s/data-e`、`Range.toString()` 的段落偏移全部相对它。样式和结构信息只能进 `ranges` / `meta`，绝不进 `text`。
3. **`ranges` 只加 className，不插入字符。** 单测锁住控制变量：`A **bold** word.` 与 `A bold word.` 的 `text` 必须完全相同、只有 `ranges` 不同；`# Title` 与 `## Title` 的 `text` 必须完全相同、只有 `meta.depth` 不同。CSS 里的 callout 标签用 `::before` + `attr(data-label)`，因为**伪元素不进入 DOM 文本** —— 用真标签会被 `Range.toString()` 算进段落偏移。

**适配器分工。**

| 文件 | 职责 | 关键取舍 |
|---|---|---|
| `builder.ts` | `TextBuilder` 把 inline 节点摊平成 `text`，`range(fn)` 在追加前后记长度差 | 段间补空格必须在追加**之前**做，否则 `range.start/end` 与最终文本错位 |
| `markdown.ts` | `unified().use(remarkParse).use(remarkGfm)` 直接读 mdast | 不走 Markdown→HTML→文本的有损往返；`cleanInfoString()` 把 MDX 的 info string（如 `text theme={null}`）处理成合法语言名；`[!NOTE]` 只进 `meta.callout` 不进可见文本；过滤 Mintlify 的 `Documentation Index ... llms.txt` 隐藏块 |
| `html.ts` | `jsdom` 遍历 Readability 正文 HTML | 保住 `<table>` 行列与 `<pre>` 换行；忽略 `script/style/nav/svg/form/button` 与 `sr-only`；相对链接用 `JSDOM({url})` 的 `el.href` 解析成绝对地址 |
| `plain.ts` | 复用 `splitParagraphs()` | 新闻 / 小说行为与改造前逐字一致，零回归 |
| `detect.ts` | 保守探测 | **至少 1 个强特征（heading/fence/table/callout/link）+ 总共 ≥2 类特征**才判 Markdown。小说里一个 `#`、一段单列表都不能误判；前端用同一函数做提示，服务端独立再判一次，不信任前端 |
| `group.ts` | `groupBlocks()` 纯函数把 cell/item 重组成 `<table>` / `<ul>` / `<ol>` | 不用随机 id、不依赖 ICU，服务端与客户端结果一致（8.1 的 hydration 约束延续到这里） |

**落库与迁移。** `texts` 加 `source_format`（plain/markdown/html）与 `source_raw`（原始源，>2MB 不落库，供以后换解析器无损重跑）；`paragraphs` 加 `block_type`、`block_meta` JSON、`inline_ranges` JSON。`src/db/ensure-blocks.ts` 与 `ensure-cefr.ts` 一样是**共享轻量迁移模块**：应用启动和离线脚本必须补出完全相同的列，避免两处表结构漂移。它刻意不 import `src/db/index.ts` —— `schema.ts` 里的 `export const exports` 在 CommonJS 编译链会撞保留字（9 节同类坑）。

旧库没有这三列，`ALTER TABLE ... DEFAULT 'paragraph'` 让老段落自动降级成普通段落，旧文章照常打开、`contexts` 锚点全部有效。

**渲染（`Reader.tsx`）。** `renderTokens()` 仍以 `tokenize(p.content)` 为骨架，词 span 带 `data-s/data-e`，`ranges` 只叠加 `.rf-i-strong` / `.rf-i-em` / `.rf-i-code` 等 class；链接跨多个 token 时用单个 `<a class="rf-inline-link">` 包住它们，点击时 `e.preventDefault()`，保证**点词优先弹释义而不是跳走**。`SingleBlock` 按 `blockType` 渲染 `h2–h6` / `blockquote` / `pre` / `hr` / `figure` / `li` / `p`，`GroupView` 负责表格与列表重组。代码块**不生成 `.w` span**：`pnpm`、`__init__`、`settings.json` 不是要背的单词。

**非正文过滤。** `NON_PROSE_KINDS = ["code","hr","figure","math"]`，`isProse()` 同时被三处使用：导入时的 `proseTexts()`（词数 / CEFR）、`/api/summarize` 的分段小结、`Reader.planSections()`。三处规则必须一致，否则 `startIdx/endIdx` 会指向错误的段。

**控制变量实验：同一篇文档，只换解析器。** 拿 `https://code.claude.com/docs/en/best-practices.md`（52,515 bytes / 635 行）分别强制 `plain` 与 `markdown` 导入：

| 指标 | 强制纯文本 | Markdown 结构化 | Δ |
|---|---|---|---|
| CEFR | **B2** / 66.65 | **B1** / 47.55 | −19.10 |
| 词数 | 8223 | 6798 | −1425 |
| 未登录词占比 | 16.36% | 9.52% | −6.84pp |
| 生僻词占比 | 22.34% | 14.31% | −8.03pp |
| COCA 前 1000 覆盖 | 59.76% | 68.18% | +8.42pp |
| 平均句长 | 23.1 | 20.29 | −2.81 |

强制纯文本精确复现了旧文章的 B2 / 66.65，说明估级算法本身没变。差掉的 1425 个「词」是代码标识符、URL、表格分隔语法 —— 旧路径把它们当成 ECDICT 查不到的生僻英文词，难度被虚高。所以 **B1 是去掉噪声后更真实的结果，不是回归**；`cefr_detail` 里那条「16% 的词不在 COCA 内，难度可能被高估」的 caveat 也随之消失。这个副作用必须写进文档，否则用户重新导入旧文章看到级别掉一级会以为是 bug。

**验证结果。** `tests/unit/import.test.ts` 21 个单测（含上述两个控制变量、range 不越界、`tokenize()` 坐标严格对齐、`parsePlain()` 与 `splitParagraphs()` 逐字一致、JSON 解析失败降级）。官方 Markdown 离线解析出 306 个 Block（28 heading / 20 quote / 103 paragraph / 100 list_item / 40 table_cell / 15 code），range 越界 0、可见文本残留 Markdown 标记 0；真实 HTML 路径 355 个 Block，table_cell 40 / code 15 / list_item 100 与 Markdown 路径对齐。真实浏览器 DOM 检查：3 张 `<table>`（首表 6 行、3 表头 cell、15 表体 cell、可横向滚动）、15 个 `<pre>`（10 个多行、最长 13 行）、19 个 callout、28 个列表 / 100 个 item、79 个链接、306 个 `data-pid` 容器，代码块内 `.w` 为 0，可见文本里管道行与代码围栏均为 0。E2E 覆盖粘贴自动识别、详情 API、SSR 标签、表格 cell 内点词收词后 `content.slice(start,end) === quote`、导出 dryRun 卡片无 Markdown 残留、纯文本零回归、URL 官方 Markdown 优先、旧文章仍可打开。

**已知边界（故意不做）。** `colspan`/`rowspan`、嵌套表格、脚注、语法高亮配色不还原；给 agent 看的隐藏 `llms.txt` 索引块会被过滤；旧文章不迁移。

### 3.6 数学公式与配图（P14）

**公式分两级，分界线是锚点安全。** 块级 `$$…$$` 独立成段 → 新增 `math` 块（`NON_PROSE_KINDS` 追加 `"math"`，与 `code` 同待遇：不计词数 / CEFR / 小结，不生成可点词）；`content` 存 LaTeX 源、保留换行，`Reader` 用 KaTeX `renderToString()`（`throwOnError: false`）渲染成 `dangerouslySetInnerHTML` —— KaTeX 是纯函数、无环境依赖，SSR 与客户端输出逐字节一致，不踩 9.1 节的 hydration 坑；它默认转义所有输入（不开 `trust` 选项），XSS 面可控。`remark-math` 的 flow 语法要求 `$$` 独占一行，而实际文档大量 `$$J=r$$` 单行写法（mdast 里是「只含一个 inlineMath 的段落」），`displayMathFromParagraph()` 把这种段落提升成 `math` 块。

行内 `$s \in \mathcal{S}$` → `InlineKind: "math"` 区间：`content` 仍存 LaTeX 源，DOM 文本与坐标基准不变；`renderTokens()` 对区间内 token 不生成 `.w`（`\rho`、`\arg\max` 不是要背的单词），样式降为 `.rf-i-math` 弱化等宽；`proseTexts()` 的 `stripInlineMath()` 在统计前把区间替换成空格（倒序替换防错位）——与 3.5 节「代码标识符虚高难度」同一个坑的第二次预防。（P14 时的结论：渲染后 DOM 文本长度 ≠ `content` 长度，拖选跨公式偏移必错，所以先不渲染；P17 已用下文的方式解决，P22 起选词直接读词 span 的坐标，不再数 DOM 字符。）

HTML 路径在 walk 之前跑 `normalizeMath()`：KaTeX / MathJax v3 读 `<annotation encoding="application/x-tex">`（容器找最近的 `.katex-display` / `.katex`，连 MathML 一起换掉，双份渲染文本不进可见文本）；MathJax v2 读 `<script type="math/tex">`（`mode=display` 判块级）。替换产物是 `data-rf-math`（行内）/ `data-rf-math` + `data-display`（块级）占位元素，`inlineDom` / `walk` 各自识别。

**配图只对「独占一段的图片」渲染真图。** Markdown：`figureBlocks()` 检测段落 children 全是 image（兼容 `[![alt](img)](link)` 包链写法）或空白 → 每张图一个 `figure` 块，`meta.src` 存地址（`parseMarkdown(src, baseUrl)` 把 `/img/a.png` 按站点解析成绝对地址），`content` = alt 当 figcaption。HTML：`<figure>`（caption 取 `figcaption`）、纯图 `<p>`（`isImageOnly()` 把 img/picture/source 剔除后无可见文字）、裸 `<img>` 三种形态都提升。`FigureBlock` 渲染 `<img loading="lazy" referrerPolicy="no-referrer">`，`onError`（防盗链 / 失效）回退占位文字 +「查看原图」链接；只接受 `^https?://` 地址，`data:`/`javascript:` 按无图处理。**夹在句子中间的行内小图仍是占位文字**：真图必然改变 DOM 文本长度、破坏 `contexts` 坐标，不为边缘场景冒险。

验证：`tests/unit/import.test.ts` 追加 10 个单测（块级/行内公式、单行 `$$` 提升、KaTeX/MathJax HTML 还原、figure 三形态、相对路径解析、含公式文档的 range 不越界 + tokenize 对齐）；真实浏览器冒烟：hydration 无错、`katex-display` 在场、`<img>` 渲染、行内公式无 `data-s`、点普通词仍弹批注卡。

### 3.7 裸定界符扫描与「视觉是图、坐标是文本」（P17）

**第三种公式形态。** 3.6 节覆盖了 Markdown 的 `$…$` 和「站点已渲染好」的 KaTeX/MathJax，但漏了中间态：**MathJax 站点在浏览器现场渲染，Readability 抓正文时把渲染 JS 当杂质丢掉**，`source_raw` 里只剩裸 `$…$` 文本（lilianweng.github.io 实测）。`html.ts` 的 `splitMathText()` 在文本节点层面扫描四类定界符：`$…$`（行内）、`$$…$$`（块级）、`\(…\)`（行内）、`\[…\]`（块级）。货币防误伤对齐 Pandoc：开 `$` 后不接空白、闭 `$` 前非空白且后不跟数字/美元（`$5 and $10` 不中招）、`\$` 是字面美元。**remark-math 的判定比 Pandoc 宽**（闭 `$` 前的空白不挡），所以 markdown.ts 对首尾带空白的 inlineMath 做二次过滤、字面还原 `$…$`。整段只剩一个块级公式时 `promoteDisplayMath()` 提升成 math 块（与 markdown 路径的单行 `$$J=r$$` 提升对称）。

**行内公式的「视觉是图、坐标是文本」。** 用户对原站的观感是「公式像图片、复制不了」——那是 MathJax 渲染成 HTML/CSS 的效果，不是真 `<img>`。我们复刻这个观感但保住锚点：

- 视觉层 `.rf-math-view`（标 **`data-rf-skip`**）是 KaTeX 输出；
- 坐标层 `.rf-math-src` 用 `display:none` 保留 LaTeX 原文。

关键陷阱（实测踩过）：**`Range.toString()` 不受 CSS 影响，但会把 KaTeX 视图里的字符全数计入**——一段 56 字符的 content，DOM 文本被撑到 94（MathML 注解 + 渲染字形 + 隐藏原文三份）。所以光藏原文不够，`offsetIn()` 从 `Range.toString().length` 重写为**手动树遍历计数**：`data-rf-skip` 子树零贡献、隐藏原文照常计数——整段「有效 DOM 文本」与 content 严格等长。终点落进公式复合体（视图或原文）时按原子吸附到 `data-s/data-e`（起点贴公式头、终点贴公式尾）。第二个陷阱：`tokenize` 把非词字符合并成段（`) ` 一个 token），跨公式边界的 token 被整体消费时会把边界外的空格从 DOM 里吞掉——跨界 token 的公式外部分必须拆出来照常渲染。

**公式兼容面**：`lib/math.ts` 挂 mhchem 扩展（`\ce{…}` 化学式）+ 常用宏（`\bm`/`\argmax`/`\norm`/`\abs`/`\E`/`\R`…）；未知命令走 `throwOnError:false` 的红色原文降级，不崩页面。

**图片兼容面**：`imgSrc()` 识别懒加载三件套（`data-src`/`data-original`/`data-lazy-src` 覆盖 1x1 占位 gif）与 `srcset`/`<picture><source>`（取最大档）；`data:image/*` 内联图直接放行。新增 **`GET /api/img?u=`** 服务端图片代理：直连 403（Referer 校验型防盗链）时前端自动换代理重试，代理无 Referer + 浏览器 UA，按 URL 哈希落盘 `data/img-cache/`；只代理 http(s)、content-type 必须 `image/*`、上限 15MB。

验证：单测 175 全过（含四类定界符、货币防误伤、懒加载地址解析、mhchem/宏渲染、坏输入不抛异常）；合成文档 Playwright 11 项全过（含**跨公式拖选的批注 quote 与 content 切片逐字一致**——锚点契约的直接证据）；真实文章（lilianweng 2026-07-04 harness）重导入：38 行内 + 4 块级公式 + 18 配图全部渲染、可见文本零 `$…$` 残留、无运行时错误。

---

## 4. 链路二：点词命中与锚定

这是唯一有真正技术含量的一段，全部在 `src/components/Reader.tsx`。

### 4.1 渲染：段落 → span

`Tokens`（`memo` 包裹）把每段可见文本 `tokenize()` 成 token 数组，词 token 渲染成 `<span class="w" data-s data-e>`，非词 token（空格、标点）用裸 `<span>`；`inlineRanges` 只往词 span 上叠 `.rf-i-*` class，链接用 `<a class="rf-inline-link">` 跨多个词包一层。

```tsx
tokenize("She sat on the river bank.")
→ [{text:"She",s:0,e:3,word:true}, {text:" ",s:3,e:4,word:false}, ...]
```

外层 `GroupView` 先跑纯函数 `groupBlocks()`，把连续的同 `listId` / `tableId` Block 重组；`SingleBlock` 再按 `blockType` 选标签（`h2–h6` / `p` / `li` / `blockquote` / `pre` / `hr` / `figure`）。无论外面套 `<table><tr><td>` 还是 `<ul><li>`，**`data-pid` 仍在最内层那个装词的容器上**，`onClick` 的 `closest("[data-pid]")` 与 4.2 的锚点计算完全不用改（详见 3.5）。

- 一段 100 词 ≈ 200 个 DOM 节点。视口内 10 段也就 2000 个，无压力。
- `Tokens` 用 `memo` + `useMemo` 按 `content` 缓存分词结果，同段落不会重复切；代码块不生成 `.w`。

**行内中文短释义（P23）**：查过的选区在绿色下划线上方常驻一行中文短义，点划线仍在右栏看详解。短义随 `rangeKey` 编码成 `start-end:<encodeURIComponent(短义)>` 传给 memo 化的 `Tokens`；区间左端词（`.w-annotated-l`）带 `data-gloss`，由 CSS `::before { content: attr(data-gloss) }` 生成小字、`::after` 生成指向三角，两者都 `pointer-events: none`。

关键是**绝不插真实文本节点**：`.rf-callout::before` 与 P17 行内公式早已定下这条契约——插入的中文会被 `Range.toString()` 算进段落偏移，`data-s/data-e` 与 `contexts.start/end` 随即错位。伪元素不进 `textContent`、不进选区，锚点零改动。短义由 `inlineGloss()` 从 `contexts.ai_gloss`（语境义优先）或 `user_words.translation`（词典义兜底）提炼；`/api/annotations` 必须把 `translation` 一起下发，因为前端 `savedWords` 是 SSR 快照，刚落库的新词不在里面。AI 释义第一屏若是一整句解释而非短语，宁可回退词典义，也不把半句话挂到正文上。

同一版还**移除了「自动收词」开关**：点词 / 拖选恒定落库，「查过 = 已有批注 = 显示标签」三者等价。反悔靠 delete-on-deselect（只删本次新建的词条），`/api/contexts/gloss` 的服务端按锚点补建逻辑保留——并发竞态与时序错位仍会用到它。

**删除只有一个入口，回看零请求（P25）**：右栏原来有 ✓（看着像状态，点了却删整个词库里的词）、+（P23 后基本用不到）、×（关闭）和「撤销」四个控件，外加「再点同一个词 = 删除」的隐藏手势。现在只剩一个「取消记录」：`DELETE /api/words/{wordId}?textId=` 删掉这个词**在本文**的记录，词条在别的文章还有记录就保留，没有了才连词条（和导出记录）一起删，服务端返回 `prunedWord`。点词不再删除任何东西：点绿色划线永远是回看，再点一次正在看的那条只是收起右栏。

回看不再查词典，也不再问 AI：`contexts.dict_entry` 存查词当时的词典结果快照（`{entry, originalForm, lemmaForm}`，由 `saveWordAndContext()` 落库），`/api/annotations` 随批注下发；右栏的 `recall` 由「点的是不是一条已存记录」决定，不再要求有 AI 释义。快照上线前的老记录在 `/api/annotations` 首次读取时按原文补查一次并写回。删除后仍沿用 P24 的教训：`cancelRecord()` 显式 `loadAnnotations()`，正文划线和行内中文由 `annotations` 派生，不刷新就是陈旧的。回归脚本 `scripts/e2e-cancel-record.mjs`（隔离库）：点词落库 → 再点只收起 → 回看零请求 → 取消记录后三者消失 → 跨文章只删本文 → 短语整条回看与取消。

**行内中文、逐级加深与「问 AI」（P26）**
- 行内中文：系统提示要求 AI 第一行固定写「释义：<最直接的中文>」，`inlineGloss()` 只取这一行；旧答案按几种常见句式取含中文的那对引号（跳过英文原词、否定句里的词），取不到干净的短释义就不显示，绝不截半句加「…」。标签默认 `opacity: 0`，只在整条悬停（`.w-ann-hover`）或正在右栏看（`.w-anchor`）时显示——重读时不让眼睛直接扫到答案。
- 同句计数：`noteSelection()` 以「这句里已存的记录」为准，并上本次会话还没落库的选区；旧版只在内存里记最近一句，跨句来回、刷新都会清零。`shouldAutoExplain()` 新增 `repeatCount ≥ 2` 时即使词典命中也自动请教——第二个卡点出现时才有整句大意 / 结构可给。
- 「问 AI」：合并原「AI 释义」「追问」。回答是对话串（`lib/ai-thread.ts`）：第一段默认讲解，之后每段以「【追问】问题」开头，整串存进同一条 `contexts.ai_gloss`；新回答只追加不覆盖，词典内容始终在最上面。行内中文和卡片背面只从默认讲解那一段取。「整句没看懂」以整句为选区提问。回归：`scripts/e2e-ask-thread.mjs`（拦截 `/api/explain` 返回模拟回答，不花钱）。

### 4.2 选词：按下即整词，按词扩展（对齐 Readlang）

**不用浏览器原生选区。** 原生选区按字符走：从 "defined" 的 d 后面按下，高亮从 e 开始，
还会和悬停底色叠成两层，直到松手才吸附成整词。逆向 Readlang 的 `app.js` 后改成同样的做法：

```ts
mousedown(词 .w 上)  → preventDefault()（不起原生选区）
                     → drag = { pEl, words: 段内全部 .w, from: i, to: i }
                     → 立刻把这个词整词涂成 .w-drag
mousemove           → elementFromPoint 取指针下的词；段内 → to = 它的下标
                       在段落上方 / 下方 → 段首 / 段尾（批注只落在单个段落）
                       其它（空格、页边）→ to 不变
                     → [min(from,to), max(from,to)] 整词 + 中间空白标点连成一条 .w-drag
mouseup             → from === to ? pickWord(那个词) : pickRange(pEl, words[a].data-s, words[b].data-e)
```

- 坐标全部来自每个词 span 的 `data-s / data-e`，不读 DOM 文本长度，所以行内公式（KaTeX 视图）不影响锚点。
- 单击 = 按下后没离开这个词就松开，与拖选同一条路径；再点同一个词 = 收起。
- 松手后浏览器补发的 `click` 被吞掉，`onClick` 只负责「点空白收起」和挡住链接跳转。
- **按住 Option（⌥）拖动**交还原生选区，用来复制原文，不弹卡片。

**颜色只有一种底色。** 悬停、拖动中（`.w-drag`）、当前选中（`.w-anchor`）、悬停到已存批注（`.w-ann-hover`）都是 `--duo-green-soft`；当前选中 / 已存批注另加主题绿底线（`.w-annotated` 是常驻的 3px 实线）。
「当前选中」「拖动预览」「已存批注」「整条悬停」都由 `Tokens` 按 `rangeKey`（`批注区间,…|选中区间|拖动预览|悬停区间`）渲染，不命令式改 class——否则批注首次落库时整段重渲染会把手动加的样式冲掉。

**已存批注是一等交互单位。** 短语/整句批注的下划线覆盖整段区间（含词间空白），所以悬停到区间内任意一个词，整条一起亮；单击区间内的词则直接回看当初那条短语存下的释义（词典与 AI 都不再请求，`PickCard` 的 `recall` 模式跳过自动查询），而不是把这个词当成新选区再查一遍。用户点短语里的词往往说明当初那条答案没把它讲清楚，属于答案质量问题，不该用「再查一遍」生成另一条答案；答案质量本身留给 prompt 单独迭代。多条批注重叠时取区间最短、起点最早的一条；单词批注仍走原来的点词路径（查词典 + 摊开已存释义）。

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
点词 / 拖选短语
 │
 ├─▶ 点词 / 拖选一律 → POST /api/contexts/ensure {锚点}（P12；P23 起无开关）
 │      服务端 ensureContextByAnchor() 按 (textId, paragraphId, start, end) 幂等
 │      已有 context 原样返回 / 没有就补建 → 「本文这一处」一定有批注
 │      ⚠️ 不看 savedMap（全量词库）、也不看前端 annotations 快照
 │
 ├─▶ savedGlossFor(paragraphId, start, end) 命中 → 直接摊开已存答案
 │     ✋ 不发 AI 请求、不计费（P12：同一锚点再点开）
 │
 └─▶ GET /api/dict?word=bank ──▶ ECDICT（<5ms）
          │
          ├ 有结果 → 第 1 层结束（音标 / 中文释义 / 英文释义折叠 / 柯林斯星级）
          │          ✋ 不发 AI 请求；「✨ AI 释义」按钮留给主动深挖
          │
          └ 无结果 ──▶ shouldAutoExplain() 判边界
                       │  ├ 词典命中 / 已有 ai_gloss / 回看旧批注 → 不自动，保留手动按钮
                       │  └ 新选区 → **自动进入第 2 层**（不再要求多点一次）
                       │
                       ├ aiContextOf(段落, start, end)      → 段落级 prefix / suffix，按句子边界裁
                       ├ selectionSignals(段落, start, end) → 客观信号 + dictHit + repeatCount
                       └ POST /api/explain {word, prefix, suffix, withPrevSentence?, signals?, prompt?}
                            → 服务端 narrowSignals() 白名单裁剪（客户端数据不能直接进模型）
                            → ReadableStream 逐块 enqueue
                            → 前端 res.body.getReader() + TextDecoder 逐块 setState
                            → MarkdownText 逐帧重解析 + 内容区自动滚动
                            → 完成且不是降级文案
                            → POST /api/contexts/gloss {textId, paragraphId, start, end, quote, prefix, suffix, word, aiGloss}
                                 → 服务端按锚点找 context：命中更新 ai_gloss / 未命中补建词条 + context
```

追问（Ask AI）与「改按词答」复用同一个 `triggerAI()`，只是多带 `prompt` 或把 `repeatCount` 覆写为 0。

`GET /api/explain?word=&context=` 仍保留，只带一句话上下文、不带 signals，供扩展与旧脚本兼容；阅读器新链路一律走 POST。

**成本闸门放在哪里？** 旧版是「用户主动点按钮」，理由是 80% 的点词词典就够，打开弹层就调 AI 等于每次点击都烧钱。P11 把闸门换成**词典命中率**：只有 ECDICT 确认查不到才自动进第 2 层，命中词典的点击依然零 AI 请求。短语在词典里必然查不到，让它再点一次按钮只是纯粹摩擦，不是成本控制。判定固化在 `lib/explain-policy.ts` 的 `shouldAutoExplain()`，三个例外（词典命中 / 已有释义 / 回看旧批注）各有控制变量单测。

自动触发挂在**词典 fetch 的回调**里，而不是一个「看 `dict` state」的 effect：组件复用时 state 会短暂残留上一次的结果，只有请求自己确认「这次没命中」才可靠。回调带 `cancelled` 标记，选区切换后旧请求不会替新选区发 AI 请求。`fromAnnotation` 由 `openAnnotation()` 打标，回看旧批注时只是展示，不悄悄计费。

### 5.2 上下文与证据是怎么来的

已不是 `sentenceOf(anchor)` 那种「锚点前后各砍到句末再拼一句」的做法。`lib/sentence.ts` 提供两个确定性纯函数：

- **`aiContextOf(paragraph, start, end)`**：从完整段落里截前文/后文。单词或短语截到所在句边界（保证主语完整）；选区盖满句子 ≥75% 词汇，或句中已收生词密度 ≥75% 时，前文额外带上一句（可能跨段），并置 `withPrevSentence=true` 提示模型注意指代与衔接。理由见 8.2。
- **`selectionSignals(paragraph, start, end, source)`**：给出 `source`、选区词数、所在句原文与词数、`coverage`、选区位置、句子在段内的字符区间。前端再补 `dictHit` 与同句连续请教次数 `repeatCount`。

**关键取舍：前端只送证据，不送结论。** 早期版本让服务端用 `selectionKind()` 反猜「这是单词 / 短语 / 句子」再切模板，结果同一个几何动作被换了好几套人格。现在判断「选区是不是主干、该给多深的答案、要不要画句子地图」全部交给模型，`selectionKind()` 降级为普通几何信号。这也对应产品判断：用户说不清自己是「不认识这个词」还是「不懂这个语法」，几何动作完全相同，硬分类必然误判。

`repeatCount` 只存在 `Reader.tsx` 的 `sentenceAskRef`（内存），key 是 `${paragraphId}:${sentenceStart}:${sentenceEnd}`；换句、刷新、重挂载自动清零，**不落库**。≥3 时模型按整句分析，批注卡给「已按整句分析 · 改按词答」的撤销入口。

### 5.3 Prompt 契约（`lib/ai.ts`，P10 重构 → P13 修正）

**一套 system，不按选区类型分叉。** 人设是「英语为母语、并且懂中文的英语老师」；唯一任务是把学生**选中的那段文字，在它所在句子里的意思**讲清楚，让他能继续往下读。默认释义与追问共用同一个 system 和同一个上下文块，只有 user message 最后一行不同：默认写「学生没有说出具体问题……」，追问换成「学生的问题: …」。这条性质有单测做控制变量。

**P13 的核心裁决：按范围给，不按内容禁。** 用户裁定「只要选中了一段文本，不管一个词还是多个词，就给选中部分的翻译（在当前句子上下文中）」。判据不是「这是不是整句通顺译文」，而是「这是不是选区」：选区是整句就译整句，是一个词就只给这个词；禁止的是把选区以外、没被选中的英文顺手译成中文。

P10 曾把「不给整句通顺译文」写成硬禁令（怕替用户读完），同时给了模型一个极具体、极好凑字的替代品：句子地图（emoji + 原句 + 每个成分挂全角括号）。在「不能给意思」的前提下，最安全、最容易填满 `max_tokens: 400` 的输出就是语法结构——用户实测的两张卡里语法术语出现 7~13 次，语义只剩夹在中间的一两句话。**禁令生效了，却把「选区的语境义」和「整句译文」一起误伤了。** P13 删掉内容禁令，改成客观可判的范围规则，模型不用再猜「我这句算不算替他读完」。

| 位置 | 内容 | 是否可省 |
|---|---|---|
| 第一屏（主体） | 选中部分在这句话里的中文意思（语境义，不是词典义项）+ 一句为什么是这个意思（搭配 / 介词 / 词性 / 指代、还原后的读法） | 否 |
| 第二段 | 一句话点出选区在句里充当什么，只定位不展开 | 是 |
| 第三段（永远殿后） | 「句子地图」：2~3 行，emoji 句型标签 + 原句照抄、只把主干用 `==...==` 标下划线 + 一行易错点 | 是 |

**三层要分开看**：选区语境义（要给，且第一屏）/ 整句通顺译文（选区是整句时才给，因为那正是用户划的范围）/ 句子骨架（要给，但殿后、视觉化）。参考产品那种「译名 → 通常含义 → 在这句话的语境中 → 简言之」的分段，值得学的是**每段都装语义**，不是分几段；P10 弃用的旧三段式不该因为这次改动被搬回来。

**句子地图从「标全部成分」改成「只突主干」**：原句照抄，主干（主语 / 谓语或系动词 / 宾语或表语）用成对的 `==...==` 包起来，其余成分保持原样、不再逐个挂括号。渲染在 `MarkdownText.tsx` → `<span class="rf-md-spine">`，下划线样式**内联在组件里**：全局 CSS 走增量构建缓存，实测出现过「类名已渲染、新规则却没进 CSS 产物」的漂移（computed `text-decoration-line: none`），把样式和渲染器放同一处才不会再分叉。`lib/markdown-inline.ts` 的 `stripUnclosedSpine()` 在流式帧里抹掉未闭合的半边 `==`，避免每帧重解析时裸记号闪烁；只影响渲染，存进 `contexts.ai_gloss` 的仍是模型原文。

结构分析**不是一句话带过，也不是长篇大论**：详细来自标记密度（原句 + 主干下划线 + emoji），不来自字数；没把握标「（存疑）」，整句结构拿不准就整块不写；主干标错比不标更糟。中文说明 ≤150 字（长难句 / 重答 180 字），被标注的英文原句不计入。

**范围规则不是一句「别越界」就完事**：真模型 A/B 里，删掉旧禁令后模型开始用「这句在说：」「整句说的是：」把选区外的英文译成中文；点名挡住后又换皮成「这里说的是：」「整句在讲」。最后用「点名句式 + 正例（选区 `benefits from` → 「受益于」，`from` 引出好处来源）」才收敛。单测同时锁住「挡越界」与「不恢复旧禁令」，防止有人为了省事把内容禁令搬回来——那会重新把模型逼回语法课。

答案深度由模型从 `observations()` 拼的「观察」块判断：边缘成分且首次请教 → 轻答（意思 + 一句为什么，不写地图）；主干成分 / 被动 / 倒装 / 从句 → 带句子地图；同句连续 ≥3 次 → 先给选区意思，再用地图定位整句主干。判断过程不输出。观察块只列客观证据（操作、词数、覆盖率、位置、所在句原文、词典命中、连续次数），不含「这是主干」「应该给」这类结论。

参数：provider 由配置中心决定（`resolveProvider()`，可换 DeepSeek / OpenAI / Claude / 千问 / 任意 OpenAI 兼容端点），`stream: true`、`temperature: 0.3`、`max_tokens: 400`（旧版 1200；短答案 + 2~3 行地图足够，也是防长篇大论的硬兜底）。monolingual 模式是同一套契约的英文版本，同样不按选区分叉。

无可用模型时 `resolveProvider()` 返回 `null`，`streamTurns()` 直接 yield `NO_MODEL_NOTICE` 并 return——**不抛错、不白屏**。这段文案定义在没有服务端依赖的 `lib/explain-policy.ts`（`lib/ai.ts` 只 re-export），前端用同一份 `NO_MODEL_MARKER` 识别：`isNotAGloss()` 为真时既不写回 `contexts.ai_gloss`、也不收进词库（见 5.5），弹层改显示「配置好模型后重试」。P11 之前这只是手动点按钮的兜底；现在每个词典未收录的选区都会自动走到，所以「服务端文案 / 前端识别 / 词库过滤」必须共用一份字符串，这条零漂移有单测断言。

**真实样本收敛（2026-11-05）**：拿 `The opposite problem is the classifier repeatedly stopping something that is routine in your setup.` 在生产 3000 真调模型，用四个控制变量（点 `classifier` / 点 `routine` / 同句第 3 次 / 追问 `is`）验输出，暴露四处执行偏差，已写进 system 并由单测固化：

| 观察到的偏差 | 为什么不行 | 收敛后的约束 |
|---|---|---|
| 主体段出现「整句在说：…」 | 换皮的整句翻译，等于替学生读完 | 点名禁止这类开头，只给半句意译提示 |
| 追问答案写出「第二段：」 | 把给模型的组织说明照抄成用户可见标签 | 明确段落序号只是组织说明，不是标题 |
| 重答把表语里的 `the classifier` 标成全句主语 | 主干标错比不标更糟 | 句子地图加「别把表语／修饰语里的名词误标成主语」 |
| 边缘词首次请教仍给完整地图 | 一次点词变成语法课 | 轻答硬约束为 1~2 句 + 不写地图 |

复验后：换皮翻译与段落标签消失，主干标注修正为 `The opposite problem is …`。涉及定语从句的场景模型仍给地图，符合「从句 → 中答」的契约，不算误判；模型偶尔仍会在主体末尾带一句半句意译，那是 prompt 允许的「还原后的读法」，不是整句通顺译文。**单测只能锁住契约字面，模型输出质量必须真调一次**——这也是 12.6 把真实样本列为必做项的原因。

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

### 5.5 AI 全文只留在批注里，不进卡片背面

这是 P10 容易被忽略的一条约束：句子地图**贴死在原句上**，而 `user_words.translation` 是墨墨卡片背面的数据源。把整段照抄过去，复习时看到的是一堆脱离原文的 emoji、`==` 记号和英文原句，既没意义也误导。P13 之后第一屏的「选区译法」反而是最适合进卡片的内容，但整段照抄仍会把地图带进去，所以提炼逻辑不变（`cardGloss()` 顺带清掉 `==`）。

```
AI 全文
 ├─▶ contexts.ai_gloss       原样存，回看批注时完整展示
 └─▶ cardGloss(aiGloss)      只提炼主体段 → user_words.translation → 卡片背面
```

`lib/gloss.ts` 的 `cardGloss()` 是确定性纯函数：遇到句子地图标记（🧩 / ⚠️ / 🔗 / 「句子地图」）整块截断，丢掉带成分标注的英文原句行与旧三段式纯小标题，清掉 Markdown 记号，合并成一行并限长 100 字；无模型提示 / `[Error:]` 文案（`isNotAGloss()`）返回 `undefined`。同文件的 `shortGloss()` 是给浏览器扩展小标签用的 24 字版本，两者用途不同，别混用。

**成分标注行的判据是「≥2 处标注」，不是「出现过一次」**：P11 的浏览器验证里真调模型，老师在第一段顺手写了一句「（主语 The tradition 是单数）」，旧规则只要看到「（主语」就删整行，卡片背面于是只剩第二段的「dates back to 整体作谓语…」——比不提炼更没用。改成数标注个数后主体段保住了，另有单测锁这个回归。

三个写入口都走它，规则统一收口在 `lib/word-store.ts`：

| 入口 | 规则 |
|---|---|
| `POST /api/words` | 词典查得到 → 用词典释义；查不到 → `cardGloss(aiGloss)` → `(待补充释义)` |
| `PATCH /api/contexts/[id]` | 短语覆盖为短释义；单词只在还是占位符时才补 |
| `POST /api/contexts/ensure` | 只补批注、不带 AI 释义；走同一份 `saveWordAndContext()`，词典释义照常填 `translation` |
| `POST /api/contexts/gloss` | 已有 context → update `ai_gloss` + 同一套词条回填；没有 → 走 `/api/words` 的同一份 upsert 逻辑补建 |

`cardgen.ts` 无需改动：它拿到的 `translation` 本来就该是一行短文本（`translationLines()` 会按行拆成卡片列表项）。`tests/unit/card-gloss.test.ts` 用控制变量断言「地图不进卡片、主体仍在、全文不等于短释义」。

### 5.6 AI 释义写回：为什么不交给前端找 contextId（P12）

**用户实测的 bug**：点词 A（不查 AI）→ 点新词 B 并生成 AI 释义 → 点回 A → B 的词还在「已存批注」里，但 `ai_gloss` 是 `NULL`，翻回去还得重新问一次模型。真实浏览器复现显示：B 的 430 字答案已经流式输出完，却**一次 `PATCH /api/contexts/` 都没发**；数据库里那条 context 存在、`ai_gloss` 为空。

**根因不是模型，也不是流没跑完，而是旧写入链路有一个静默失败口**：

```
旧：persistGloss(pick, gloss)
      contextId = pick.contextId ?? annotationsRef 按锚点找
      if (!contextId) return;        ← 答案在这里被丢掉，前端毫无提示
```

`contextId` 依赖「自动收词已经落库、批注列表已经刷新回来」这一串异步时序。至少三条路径会让它落空：

| 触发条件 | 为什么没有 context |
|---|---|
| 词在别的文章里收过 | `savedWords` 是**全量词库**，`savedMap` 命中后点词直接 `return`，不会为本文这一处新建 context |
| 前端还没来得及落库（并发 / 时序错位） | `contextId` 此刻还不存在（P23 前还包括「关掉自动收词」，该开关已移除） |
| 连续点两个词 | 两次 `loadAnnotations()` 并发，旧响应晚到会覆盖含新批注的列表（偶发） |

**修法是把「存得下」变成服务端契约，而不是前端时序**：新增 `POST /api/contexts/gloss`，客户端只送锚点 + 释义全文；`lib/word-store.ts` 的 `persistGlossByAnchor()` 按 `(textId, paragraphId, start, end)` 找 context，命中就 update，没命中就按 `/api/words` 的同一套规则补建词条 + context。同一个锚点重复写（重试、追问）只覆盖，不堆重复批注；`isNotAGloss()` 在服务端再挡一次降级文案。

配套三处前端修正：

- `loadAnnotations()` 加请求序号，丢弃过期响应，消除上面第三条竞态。
- `glossCacheRef` 按锚点缓存本次会话已生成的答案，抹掉「刚写完、列表还没刷新回来」的窗口；删词 / 删批注时 `forgetGloss()` 同步清除。
- 点词 / 拖选时先查 `savedGlossFor(pid, start, end)`，命中即把答案作为 `initialGloss` 摊开并打上 `fromAnnotation`，`shouldAutoExplain()` 返回 `false` —— **同一锚点再点开不再重新请求模型**。

`onAIGloss` 传的仍是弹层打开那一帧的 `pick`，锚点稳定：流式答案迟到、用户已经切到别的词时，只会写回它自己那次选区，不会串到新词上。

### 5.7 「已收词」不等于「本文这一处有批注」（P12 续）

**用户实测的第二个 bug**：词 `delegate` 在正文里显示绿色 ✓、词典释义正常，却始终不出现在右侧「已存批注」列表里。只读查库确认：`user_words` 里确有 `lemma=delegate / displayForm=delegates`，但它唯一的 `contexts` 落在**另一篇文章**；当前文章只有 `delegation`。`/api/annotations?textId=...` 返回 97 条，没有 `delegate`。

根因和 5.6 是同一个概念混淆，只是发生在**点词自动收词**这条路径上：

```
旧：onClick(词)
      if (savedMap.get(key)) return;   ← savedWords 是全量词库，不是本文批注
      于是：不建 context、不调 loadAnnotations()、列表数字也不刷新
```

`savedWords` 由 `src/app/texts/[id]/page.tsx` 查出**全量 `user_words`**（对齐 Readlang：任何文本里收过的词都要高亮）。它被误当成「本文这一处已经批注过」。而「已存批注」查的是 `contexts`，按 `textId` 过滤并按 `wordId` 去重——两者根本不是一张表。

**修法**：新增 `POST /api/contexts/ensure` + `lib/word-store.ts` 的 `ensureContextByAnchor()`。点词 / 拖选自动收词统一走它，服务端按锚点裁决：已有 context 原样返回（`contextCreated: false`），没有就复用 `saveWordAndContext()` 补建词条 + context。`persistGlossByAnchor()` 也改为复用它，避免两份「找 / 补 context」逻辑漂移。重复点同一位置只多一次 SELECT，不会堆重复批注（E2E 用只读 SQLite 断言 `count(*) = 1`）。

**前端不再拿 `annotations` 快照做「已有批注就跳过」的乐观判断**。第一版修完曾加过 `hasAnnotationAt()`，结果完整 E2E 的 C3 / E 两项回归失败：delete-on-deselect 刚删掉词条后，前端快照里那条批注还是旧的，第三次点词被判定「已有批注」而跳过 ensure，于是 `justSaved` 拿不到、撤销按钮消失，后续点击反而把卡片收起。`loadAnnotations()` 是异步的，收起即撤销、并发刷新、别处补建 context 都会让快照过期。删掉这个判断后由服务端幂等裁决，53/53 恢复全绿。**这和 5.6 是同一条教训：落库决策不要建立在前端的异步快照上。**

`justSaved` 现在由 `ensure` 返回的 `created`（本次是否真新建词条）决定：只有真新建的词条才允许「收起即撤销」，不会误删老词。

历史数据不迁移：P12 之前在别的文章收过、但本文没有 context 的老词，要在正文里**再点一次**才会补上批注。

---

## 6. 链路四：收词与去重

```
弹层「+」按钮
  │  onSave(aiStatus === "done" ? aiText : undefined)   ← AI 全文顺带存成 contexts.ai_gloss
  ▼
POST /api/words { word, textId, paragraphId, start, end, quote, prefix, suffix, aiGloss? }
  │
  ├ 校验 textId / paragraphId 存在（404 兜底）
  ├ lookup(word) → lemmaForm / phonetic / translation / pos
  │   translation 优先级：词典释义 > cardGloss(aiGloss) 短释义 > "(待补充释义)"
  │      （句子地图不进卡片背面，见 5.5）
  ├ db.transaction:
  │    ├ 按 lemma 查 user_words
  │    │    ├ 命中 → 更新（更好的 phonetic / translation 覆盖旧的）
  │    │    └ 未命中 → 插入
  │    └ 无条件 insert contexts（同一词不同位置 = 多条）
  └ 返回 { lemma, displayForm, translation }
  ▼
前端：setSavedSet(add lemma + displayForm) → 立即高亮 + celebrate("+1 词") + 进度条 +1
```

**手动收词（弹层「+」）与自动收词（点词 / 拖选）是两条路径**：前者走 `/api/words`，每次新插一条 context；后者走 `/api/contexts/ensure`，按锚点幂等。两者最终都调用 `lib/word-store.ts` 的 `saveWordAndContext()`，词典 / 短释义规则不漂移。

**幂等性**：手动重复收同一个词 → `user_words` 仍 1 行，`contexts` 多 1 行。这是设计意图（同一个词在不同文章里出现，每处上下文都值得保留），实测已验证。自动收词与 `/api/contexts/gloss` 写回释义则按锚点幂等，不会重复插 context。

**别把 `savedWords` 当成「本文的批注」**：阅读页传的是**全量词库**（对齐 Readlang，任何文本收过的词都高亮）。所以「词已收过」不等于「本文这一处有 context」——这正是 P12 两个 bug 踩空的地方，详见 5.7。要判断本文有没有批注，以服务端的 `contexts` / `ensureContextByAnchor()` 为准，不要用 `savedMap` 或前端 `annotations` 快照代替。

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

### 7.1 文本管理：重命名 / 分类 / 删除 / 阅读进度（P16 / P18）

**一个入口收敛所有元数据操作。** 首页列表卡片右上角 ✏️ 打开 `TextManageDialog`：标题输入、分类选择（七个预设 chip + 自定义输入框）、创建时间与词数展示、两段式删除。列表本身抽成客户端组件 `TextList`（服务端查全量传入），分类 / 难度两排筛选 chip 在前端组合过滤——几条到几十条数据量不需要 URL 参数参与。

**表结构**：`texts` 加四列（`ensure-text-meta.ts` 轻量迁移，与 ensure-cefr 同模式）：`category TEXT`（可空 = 未分类；存自由字符串而非外键表，单用户应用换分类体系只改前端映射）、`read_idx INTEGER` + `read_ratio REAL`（可空 = 没读过）、`completed_at INTEGER`（可空 = 未标记读完）。补列后老数据默认 NULL，正好对应「从未手动标记」，**不需要数据迁移脚本**。

**PATCH /api/texts/{id}** 一套入口管四类字段，各字段独立校验：title trim + 非空 + ≤200 字符；category 空串 = 恢复未分类；readIdx/readRatio **覆盖写**（P18 起不再单调合并）；completedAt 显式覆盖（时间戳 = 标记，`null` = 取消）。删除语义不变（词库 / 原句 / AI 释义保留，见 5.7 与该路由的契约注释）。

**删除的两段式确认**：弹窗内点「删除这篇文本」→ 按钮原地变红「再点一次确认删除」+「手滑了，不删」取消入口，5 秒不点自动复原。不用 window.confirm（原生弹窗丑且样式不受控），也不做模态套模态。

**阅读进度与「已读完」（P6b / P18 重写）**：两条互相独立的轨道。

- **进度 = 滚动位置**：`src/lib/read-progress.ts` 的 `scrollProgress()` 用 `scrollY / (scrollHeight - innerHeight)` 算 0–1，一屏能看完的文章算 1、滚到底算 1、往回翻会下降。`useReadProgress()` hook（P19 从 `ReadProgressPill` 抽出）对 `scroll` / `resize` 做 **350ms debounce**，停止滚动就 `measure()` + 立即 PATCH 覆盖写（2s interval 仅兜底）——「滚完就退出」是最常见路径，不能干等定时器；`visibilitychange` / `pagehide` / 卸载用 **`navigator.sendBeacon`** 投递，`fetch keepalive` 仅作降级（实测关标签页时 keepalive 会丢，见下）。`currentBlockIdx()` 按视口 75% 深度取「读到线」以上的最大块 idx 作续读书签，不再把全 DOM 的最大 idx 当已读位置。
- **已读完 = 用户显式断言**：只有点「标记已读完」才写 `completed_at` 时间戳，再点一次传 `null` 取消。滚到 100% 只给轻提示、**绝不自动写完成状态**；按钮请求顺手带上当前进度，消除「滚到底 → 立刻标记 → 立刻返回」的落库不一致。列表「继续回味 →」与「✓ 已读完」徽章只由 `completed_at` 决定；「已读 N%」是顶栏文字 + 底边 2px 进度条（P19 前是紫色徽章），两者可并存。不设重置按钮：进度可下降、完成状态可取消，已覆盖全部修正路径。
- **续读有边界**：`shouldAutoResume()` 在「已读完 / 没读过 / `read_idx` 是最后一块 / `readRatio ≥ 0.999`」时**不**自动定位。否则滚到底记下的文末书签会让每次打开都跳到文末 → 一上来 100% → 又写回 100%，进度被锁死且无法从头重读。

**旧版 bug 与修复代价**：旧 `observe()` 用 `querySelectorAll("[data-idx]")` 遍历全 DOM 取最大 idx，注释写着「进入过视口」却没有任何视口判断；Reader 又不做虚拟滚动，于是打开页面就把 `read_ratio` 写成 1，服务端单调合并让错误值永远降不回来。P18 除改算法外，还把旧版写下的 `read_idx` / `read_ratio` 一次性清成 NULL；`completed_at` 补列默认 NULL 不需要迁移。

**P18 上线后用户实测又抓到四个问题**（都已修）：① 滚动后直接关标签页，进度停在旧值 —— `pagehide` 的 `fetch keepalive` 在页面销毁时丢失，改 `sendBeacon` + 停止滚动即上报；② 文末书签让打开即 100%，加 `shouldAutoResume()` 拦截；③ 「标记已读完」按钮在标题行，用户滚到底够不着，为点它滚回顶部会让进度按设计掉回 0% —— 当时先加了浮出视口内的小提示（只提示、不自动改状态），P19 常驻顶栏后按钮永远可见，该浮动提示已删除。抓包可见旧链路 `REQ 1/270 → 点标记 → REQ 0/2`，正是滚动回顶部引起的合法但反直觉的覆盖；④ 自动续读 / `?p=` 跳转时目标段落整块标绿 2.4 秒又消失，观感突兀 —— 删掉 `.para-flash` 的 class 调用与 CSS 动画，只保留 `scrollIntoView` 定位（滚动到位本身就是反馈）。

已知边界：`read_idx` 是段落序号，与正文绑定——本方案不支持编辑正文（会牵动全部锚点，另一个量级的工程），所以不会失配。放弃单调合并后，两个标签页同时开同一篇是「最后一次写入胜出」，单用户场景可接受；进度是位置估算，不代表真实理解程度。

### 7.2 字体与阅读页外壳（P19）

**字体分工**：`layout.tsx` 用 `next/font/google` 加载 DM Sans（`--font-dm-sans`）、Outfit（`--font-outfit`）与 Geist Mono（`--font-geist-mono`）。`globals.css` 里 `--font-sans` 指向 DM Sans、body 与标题全局继承；`--font-nav` 指向 Outfit，只应用在站点级 `.duo-nav`（`SiteHeader`），而 `SiteHeader` 在 `/texts/*` 整条隐藏，所以阅读页顶栏用的是 DM Sans。初版按 A① 让阅读器英文正文保留衬线（`--font-serif`，Iowan / Palatino / Georgia），但用户在实际页面里觉得「字体没改」，随后撤回了该决定：`.reading-body` 改为 `--font-sans` 走 DM Sans，`--font-serif` 变量删除；19px / 1.85 行高保留（原本给衬线体调的，换无衬线后略松，用户暂未要求调整）。DM Sans / Outfit 都不含中文字形，中文回退 PingFang SC，实际变化只在英文与数字。`next/font/google` 在 build 时下载、运行时自托管到 `.next/static/media`，离线可用。

**阅读页外壳 `ReadingChrome`**（客户端组件，包在 `ReaderShell` 外层）：54px sticky 顶栏含目录开关、返回、标题、CEFR 徽章、进度数字、标记按钮、原文链接与底边 2px 进度条；下方两列 grid（目录 | 整个 Reader）。目录默认收起，从 `paragraphs` 筛 `blockType === "heading"` + `blockMeta.depth` 生成树，点击用 `window.scrollTo` 手动减去顶栏高度（不用 `scroll-margin-top`，免得影响 Reader 的 `focusParaId` 续读定位），滚动时高亮最后一个越过读线的章节。

**为什么包在 Reader 外面**：右侧批注栏是 `Reader.tsx` 内部 `.reader-split` 的一部分，页面层做不了「目录 | 正文 | 批注栏」三栏。两列 grid 挤压的是 Reader 整体宽度，文本内容不变，`data-pid` 锚点与字符坐标契约不受影响；点词、批注、ReaderShell 一行未改。进度上报逻辑从 `ReadProgressPill` 抽成 `src/lib/use-read-progress.ts` hook，组件本身删除；P18 那套 sendBeacon / debounce / `shouldAutoResume` 逻辑一行未动。

**窄屏**：<900px 隐藏原文链接与进度数字；<720px 目录变 fixed 抽屉、阅读主区 `overflow-x: clip`。顺手修了两处既有内容溢出：长链接 `overflow-wrap: anywhere`、KaTeX 公式容器允许横向滚动。这些由文章里的长 URL / 长公式造成，与 P19 布局无关（P19 前后都存在），375px 实测 `scrollWidth` 从 449 降到 375。

**构建注意**：`globals.css` 的增量构建会漏新加的 CSS 规则（本项目踩过多次）。改动 CSS 后若浏览器里没生效，先 `rm -rf .next && npm run build && bash scripts/service.sh restart` 全量重建，别急着怀疑选择器写错。

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

**2026-11-05 更新**：现在默认走 `aiContextOf()` 的**段落级窗口**，但没有推翻这张表——窗口仍按句子边界裁：单词/短语只拿所在句，只有「划了大半句」或「句中已收生词密度 ≥75%」才额外带上一句。所以常规点击成本仍是 1x，多出的一句只在确有整句理解需求时出现。更准确的说法是：**默认不塞整段，但保留按需取相邻句的能力**。

### 8.3 为什么用 OpenAI SDK 调 DeepSeek

DeepSeek 官方文档第一句就是：API 格式兼容 OpenAI/Anthropic，改配置即可用 OpenAI SDK 访问。它自己没有独立的 Chat SDK。

我们只需要「发一次 chat completion，流式拿文本」——这就是个 HTTP 客户端的事。引入 LangChain / Vercel AI SDK / DeepSeek Harness 都属于用电梯送快递。

（顺带澄清一个易混点：**OpenAI SDK 不是 Agent Runtime**。它不跑 Agent Loop、不自动执行 tool call、不管多轮状态。我们当前的释义和未来的导墨墨都不需要 Agent Loop——都是「用户点按钮 → 确定性代码 → 拼参数调 API」。什么时候需要？当用户能用自然语言下复合指令时，比如「把我昨天读的文章里的动词都导出」。）

### 8.4 为什么 SQLite + 内联建表 SQL

- 单用户、单机、数据量在万级 → 任何服务端数据库都是过度设计。
- 备份 = `cp data/readflow.db`；迁移 = 拷两个文件。
- 不用 migration 框架：`CREATE TABLE IF NOT EXISTS` 内联在 `db/index.ts`，启动即建表，克隆下来 `npm run dev` 就能跑。

代价：schema 变更需要在 `schema.ts` 和 `SCHEMA_SQL` 两处同步改，且没有版本记录。表结构稳定前可以接受；一旦有真实用户数据，应切到 `drizzle-kit generate/migrate`。

### 8.5 为什么建表要重试

Next dev 热重载会让多个模块实例几乎同时求值 `db/index.ts`。`CREATE TABLE IF NOT EXISTS` 幂等，但**并发写会撞锁**。于是加 5 次指数退避重试（100/200/400/800ms）。

> 这段现在的退避用的是忙等 `while (Date.now() < until) {}`，会阻塞事件循环。正确写法是同步 sleep（`Atomics.wait`）或把初始化改成 lazy + async。属于「能用但不优雅」，改的时候注意别引入新的初始化竞态。

### 8.6 词典库与用户库分成两个文件

`data/dict/ecdict.db` 以 `readonly + query_only = ON` 打开，`data/readflow.db` 可写。

好处：词典是「可再生的大文件」（94MB，脚本 3 秒重建），用户数据是「不可再生的小文件」（64KB）。分开后可以单独备份/删除/替换，也不会因为词典写入把用户库锁住。

### 8.7 为什么自己写账户体系，以及站级/用户级配置的边界

不引 Auth.js / Clerk / Supabase：本地 SQLite + Node 内置 `crypto` 就够，零依赖、零月费、断网可用，也符合「要收费就放弃」的前提。真正要解决的不是「怎么登录」，而是**两类配置不能混在一张单行 KV 表里**：

- AI 密钥 / 墨墨 Token / 插件 Token 是**站点资源**：`ai.ts` / `markji.ts` 是无请求上下文的同步函数，插件 API 用站级 token 鉴权、根本没有 cookie。它们必须能从 `GLOBAL_USER` 行直接读到。
- `profile.*` 是**个人数据**：如果沿用「读不到就回退站级」，A 用户会看到 owner 的昵称，A 改昵称又会覆盖所有人。

所以 `settings-store.ts` 定了一条规则：`getSetting(key, userId)` 先读本人行，没有再回退站级；但 `isPersonalKey()`（`profile.*` 前缀）**不回退**。`allSettings(userId)` 同样先铺站级行（跳过站级 `profile.*`），再用本人行覆盖。`/api/settings` 的 GET 与 PUT 必须用同一个 `userId`，否则就是「保存成功但读回默认值」——P20 实测踩过，单靠 typecheck 抓不到，是 `test:account` 的断言读回来的。

守门分两层：`proxy.ts`（Next 16 起替代 `middleware.ts`）只检查 cookie 是否存在；真正的 token → sha256 → `sessions` → `users` → 过期校验全在 Node 侧 `currentUser()`。因此**每个页面和 API 都要自己调 `currentUser()`**，proxy 只是把未登录请求提前挡掉、省一次 DB 查询，不是安全边界。越权一律返回 404 而不是 403，避免向别的账号暴露「这个资源存在」。

`exports` 表没有 `user_id` 列，所以导出状态、每日配额、已推数量都必须 `innerJoin(userWords)` 按 `user_words.user_id` 过滤；插件链路没有 cookie，用 `ownerId()` 把数据归到 owner，查重也必须带上 `user_id`（唯一索引是 `(user_id, lemma)`），否则会改到别人的词。

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

- 连接挂 `globalThis.__readflowSqlite` 单例，热重载不新建连接；
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

### 9.7 `next dev` 页面没 hydrate，交互验证全是假阴性

**现象**：结构化导入改造后，用 Playwright 在 `next dev`（3100）点词，右栏始终停在空态。给 `.reading-body` 挂原生 `click` 监听能收到事件（target 是 `.w`、`closest("[data-pid]")` 也有值），但 React 的 `onClick` 完全不执行。普通段落与表格 cell 表现一致，控制台没有 JS 报错——很容易误判成「表格渲染破坏了点词委托」。

**排查（控制变量）**：在同一台机器上对比两个端口，检查元素上是否有 React 挂的 `__reactProps$*` / `__reactFiber$*` 键：

| 端口 | 运行方式 | `__reactProps` |
|---|---|---|
| 3100 | `next dev` | `[]`（未 hydrate） |
| 3000 | `next start`（生产构建） | 有 |

dev 控制台同时刷 `ws://127.0.0.1:3100/_next/hmr` 握手失败 `ERR_INVALID_HTTP_RESPONSE`。给 Chromium 加 `--no-proxy-server` 仍不恢复，说明是这台机器上 dev HMR 通道的问题，**不是交互代码的回归**。

**结论 / 验证纪律**：

1. 判断 hydration 是否完成，看 `__reactProps$*` 键，不要靠「等固定 1–2 秒」。
2. **SSR 结构、API、单元与离线解析可以在 dev 跑；交互级验证必须在 `npm run build && bash scripts/service.sh restart` 之后、对生产 3000 跑。**
3. 任何「点击没反应」的结论，先拿普通段落做对照，再怀疑新代码。

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
- 没有残留 Markdown 强调标记、代码围栏或 HTML 标签
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

现在有四层：单测与类型检查、离线验证、API/SSR 回归、真实浏览器交互。改完代码至少跑第一层。

### 12.1 单测与类型检查

```bash
npm run typecheck   # tsc --noEmit，必须零错误
npm test            # tsc -p tsconfig.unit.json + node --test .unit/tests/unit/*.test.js
```

单测覆盖 CEFR 与结构化导入，都用**控制变量**锁性质：`src/lib/cefr.ts` 里只改词汇难度时复杂度分必须不动；`tests/unit/import.test.ts` 里 `A **bold** word.` 与 `A bold word.` 的可见文本必须完全相同、`# Title` 与 `## Title` 亦然，且所有 inline range 不越界、`parsePlain()` 与 `splitParagraphs()` 逐字一致。

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

### 12.5 结构化导入专项（P9）

改 `src/lib/import/**`、`Reader.tsx` 的渲染分组、或 `globals.css` 的 `.rf-*` 样式时，按这个顺序验：

```bash
npm test                       # 21 个 import 单测 + CEFR / 锚点 / 卡片单测
npm run typecheck
tsc -p tsconfig.verify.json    # 离线脚本的 CommonJS 编译链（别把 src/db/index.ts 拉进来）
```

再拿真实源做离线解析（`https://code.claude.com/docs/en/best-practices.md`，52KB / 635 行，含 GFM 表格、MDX info string、callout、空锚点链接、`llms.txt` 隐藏块），核对四个数：**306 个 Block**、**range 越界 0**、**可见文本残留 Markdown 标记 0**、**prose parts 290**。HTML 路径用抓下来的原始页面核对 table_cell / code / list_item 数量与 Markdown 路径对齐。

API / SSR 回归（可在 dev 跑）与交互验证（**必须在生产 3000 跑，见 9.7**）清单：

| 检查 | 期望 |
|---|---|
| `POST /api/texts` 粘贴官方 Markdown | `sourceFormat: "markdown"`，`blockKinds` 含 40 table_cell / 15 code / ≥100 list_item |
| `GET /api/texts/{id}` | `inlineRanges` 全部 `0 ≤ start < end ≤ content.length`；非 code 段落不以标题、表格、引用或代码围栏标记开头 |
| SSR HTML | 含 `rf-table` / `<thead` / `rf-pre` / `<pre` / `rf-h2` / `rf-callout` / `rf-list` / `rf-inline-link`，且不含 `\| :- \|` |
| 浏览器 DOM | 3 张 `<table>`、15 个 `<pre>`（10 个多行）、19 个 callout、306 个 `data-pid`，`pre .w === 0` |
| 表格 cell 内点词 → 收词 | `content.slice(start, end) === quote`，右栏出释义卡 |
| `/api/export` dryRun | 卡片正文不含强调标记、代码围栏等 Markdown 残留 |
| 纯文本导入 | `sourceFormat: "plain"`，全部 `blockType === "paragraph"` |
| URL 导入 | `text.sourceFormat === "markdown"` 且 `sourceRaw` 含标题 —— 证明走了官方 `.md` |
| 旧文章 | 仍能打开，`block_type` 默认 `paragraph`，原有锚点有效 |

所有 E2E 脚本都在 `finally` 里删掉自己创建的文本与词，不污染用户库。

### 12.6 AI 释义专项（P10 / P11 / P12）

改 `lib/ai.ts` / `lib/sentence.ts` / `lib/explain-policy.ts` / `lib/gloss.ts` / `lib/word-store.ts` / `Reader.tsx` 的选区链路时，按顺序验：

```bash
npm test                       # 含 ai-prompt / sentence / card-gloss / explain-policy 的控制变量测试
npm run typecheck
npm run build                  # 交互验证前必须重建，并重启生产 3000
npm run test:auto-explain      # 真实浏览器：见下方 P11 段
npm run test:gloss-persist     # 真实浏览器：见下方 P12 段
npm run test:spine-render      # 真实浏览器：==主干== 下划线 DOM 与样式
BASE=http://127.0.0.1:3000 npm run test:e2e   # 全量回归：删词/撤销/收词按钮等基础链路
```

单测管的是**契约**，不是模型输出质量：

| 检查 | 期望 |
|---|---|
| `buildSystemPrompt("en", false, "steer")` vs 长句选区 | 逐字相同，同一个老师不按选区换人格 |
| 默认释义 vs 追问的 `buildUserMessage` | 前缀逐字相同，只有最后一行「学生的问题」不同 |
| 三段式固定栏目 | `**通常意思**` / `**翻译**` / `**主谓宾分析**` / 「不可省略」全部不存在 |
| `selectionSignals()` | 给出完整所在句原文；点词与拖短语只差 `source`；越界不崩 |
| `cardGloss()` | 地图 / emoji / 成分标注行不进卡片，降级提示返回 `undefined`；主体段只有一处「（主语 …）」时不能被删 |
| `shouldAutoExplain()` | 只改词典命中 / 已有释义 / 回看旧批注其中一个，各自翻转为 `false` |
| `isNotAGloss()` | 无模型引导与 `[Error:]` 为 `true`；含 🧩/⚠️ 的真释义为 `false` |

**模型输出必须真调一次**，单测替代不了：拿一段含被动 / 倒装 / 从句的真实句子，分别点 1 个边缘词、1 个主干词、连续点 3 次，肉眼核对三件事——第一段有没有给整句译文、句子地图是否殿后且带原句与全角括号、中文说明有没有超篇幅。没配 key 时页面出的是 `NO_MODEL_NOTICE`，这是预期降级，不是坏掉。

**交互验证必须在生产 3000 跑**（见 9.7）：`next dev` 页面可能没 hydrate，点词没反应是假阴性；判断是否 hydrate 看 DOM 上有没有 `__reactProps$*` 键。

**P11 的四个浏览器控制变量**（`npm run test:auto-explain`）：脚本自己造一篇临时文本，先断言已 hydrate，再验 ① 点词典命中的 `tradition` 不发 `/api/explain`；② 拖选 `dates back to` 完全不点按钮就自动发请求并流式出答案；③ AI 全文写回 `contexts.ai_gloss`，而 `user_words.translation` 不含句子地图 / 成分标注；④ reload 后回看一条没有 AI 释义的旧批注，不重复发请求且手动入口仍在。`finally` 里删掉自己造的文本与词。

没配模型时自动请求返回 `NO_MODEL_NOTICE`，弹层显示「配置好模型后重试」——这是预期降级，不是坏掉；`isNotAGloss()` 保证这段引导文案既不写回批注也不进词库（服务端新写入口再挡一次）。

**P12 的浏览器控制变量**（`npm run test:gloss-persist`）：脚本自造四篇临时文本，先断言已 hydrate，再验 ① 词典命中的 A 不发 `/api/explain`；② 词典未命中的 B 自动出答案并落到 `contexts.ai_gloss`；③ 点回 A 后 B 的释义仍在，且点回 A / 再点 B 都不再发 `/api/explain`，卡片直接摊开已存答案，列表出现「已存 AI 释义」；④ 同一个 B 出现在**另一篇文章**（全局词库已有、本文无 context）时服务端补建批注并写入释义；⑤ 自动收词关闭时点 D，释义仍被保存；⑥ **delegate 场景**：已在全局词库、但在新文章第一次点开的词，词典命中不发 AI，本文「已存批注」里仍要出现它，且同一锚点连续 `ensure` 两次只有 1 条 context（只读 SQLite 校验）。`finally` 里删掉自己造的文本与词。

**全量 E2E 不能省**：`BASE=http://127.0.0.1:3000 npm run test:e2e` 覆盖 delete-on-deselect、撤销按钮、批注卡按钮等基础链路。P12 第一版加 `hasAnnotationAt()` 时，三套专项脚本都过，只有全量 E2E 的 C3「首次自动收词出现撤销按钮」/ E「批注卡内含 AI 释义入口与收词按钮」失败，才暴露出前端快照在删词后过期的问题（5.7）。当前基线：`npm test` 151/151、`test:gloss-persist` 全通过、`test:auto-explain` 12/12、`test:spine-render` 7/7、`test:e2e` 53/53。

**P13 的真模型 A/B 控制变量**：同一模型（`deepseek-chat`）、同一 user message、同一 `temperature: 0.3` / `max_tokens: 400`，只换 system，跑用户截图里两个真实选区（`over rich states and artifacts`、`benefits from`）。量三件事：第一屏有没有选区译法、语法术语出现次数、有没有越界把选区外英文译成中文。结果：旧 prompt 语法术语 6~13 次、语义夹在中间；新 prompt 降到 0~4 次，两例第一屏都给译法、都带 `==` 主干下划线，还顺手纠正了旧版把 `and thus` 说成「两个谓语共用一个主语」的错误。中途发现删掉旧禁令后模型用「整句在说：」「这里说的是：」越界，补了「点名句式 + 正例」才收敛——**这一条是单测替代不了的，改 prompt 必须真调一次**。

`test:spine-render` 为什么不靠真模型：模型是否给句子地图是它自己的判断（轻答可以不写），拿它验渲染器会随机假阴性。脚本改为通过 `/api/contexts/gloss` 确定性注入一条带 `==...==` 的 `aiGloss`，再点正文的绿色标记回看，断言 `.rf-md-spine` 数量、computed `text-decoration-line`、页面无裸 `==`、卡片背面无记号。它抓到过一次真实问题：全局 CSS 增量构建缓存没把新规则带进产物，class 在但样式不在，于是改成组件内联样式（5.3）。

历史数据说明：P12 之前丢失的 `ai_gloss` 无法追回（答案当时就没落库），在别的文章收过但本文没有 context 的老词也不会自动补批注。在正文里再点那个词会重新请教一次 / 补上批注，这次会存下来；点回正文的绿色标记仍不自动发起请求。

---

### 12.7 真实写卡（不可逆，只在用户明确同意后跑）

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

```bash
# 改了词典规则或卡片版式之后，把已经推上去的卡一起修好
npm run push:one -- retouch <词> <qa|cloze|choice> <deckId>
```

`retouch` 从 `exports` 查回 card_id，按当前数据重新生成全文，再走更新接口
**全量替换**（更新接口和 create 不同：请求体要带 deck_id/card_id，且 content 是替换不是补丁）。
内容没变就直接跳过。

已验证过的结果（2026-11-02）：写入后 `GET /decks/{deck}/cards/{card}` 回读的 content
与提交内容逐字一致，`grammar_version` 为 3，章节卡片数 +1。

### 12.8 账户体系专项（P20）

```bash
npm run test:account   # 49 项：建号 / 手机号登录 / 双账号隔离 / 越权 / 假 cookie / 站级配置权限 / 改密码 / 登出 / 浏览器登录
npm test               # 单测含 auth-crypto（scrypt、token、过期）与 settings-store 隔离
```

`scripts/e2e-account.mjs` **绝不碰真实库**：用 `DB_PATH` 指向临时目录、另起一个 `next start`（默认 3107），跑完杀进程删库。这样既能验证「全新空库 → /setup 建号」的完整链路，也不需要替用户在真实库里造账号。末尾复用同一个临时服务跑一次 `e2e-spine-render`，确认带登录态时阅读页仍能 hydrate、点词链路没被 proxy 破坏。

P20 之后所有旧 E2E 脚本（裸 `fetch` / 裸 `goto`）都会得到一整片假阴性，统一由 `scripts/e2e-auth.mjs` 注入登录态：`ensureAuth(BASE)` patch Node 侧 `globalThis.fetch` 自动带 cookie，`authCookies(BASE)` 给 Playwright context 注入（限定目标域名，不外泄给文章里的外链图片）。在真实库上跑需要 `E2E_USER` / `E2E_PASS` 指定账号；helper **不会自动建号**，避免替用户创建账号。

### 12.9 浏览器插件查词（P31）

目标是一句话：**在网页上点一个词，等于在阅读页点一个词**——同一套锚点、同一套词典、同一套「要不要自动问 AI」的规则、同一套对话串。插件里不复制任何一条业务规则。

**为什么要有「网页摘录」**：插件不可能把所有网页都整篇导入（用户只想读那一段）。所以 `texts.source_type` 多了一个 `web`：一个网址一条，段落就是点过的那些块，`source_url` 记原网址。它只是锚点的宿主：首页「我的文本」、`GET /api/texts`、战绩页的「读过的文本」都把它过滤掉，数据和记录本身保留（决策 D4）。

**挂到哪篇文章（决策 D3）**：`POST /api/extension/record` 先查当前账号有没有 `source_type='url'` 且 `stripHash(source_url)` 相同的那篇；有就用 `locateInParagraphs()` 把「块 + 块内偏移」换算成「段落 + 段内偏移」，命中就 `imported=true`（词库点来源进阅读页）；没有或定位不到才落到网页摘录（点来源用 Chrome 文本片段回原网页）。同一处重复点按锚点幂等，不会多建记录。

**坐标换算最容易错**（`src/lib/web-anchor.ts`）：网页上的块文本和 `paragraphs.content` 往往不一样——`&nbsp;`、换行、多个空格、首尾空白，还有插件自己插进 DOM 的 `.rf-gloss` 小标签。所以插件取块文本前先克隆并删掉 `.rf-gloss`，再用 `normalizeBlockText()` 归一化、`normalizedIndex()` 把原文下标映射到归一化下标；服务端拿到 quote 后要在段落里**重新找位置**，并且必须满足 `content.slice(start, end) === quote`（归一化回映的右端取 `map[at + len]` 而不是 `map[at+len-1]+1`，这一位就是当初单测报错的地方）。校验不过一律降级成「只查词典、不记录」——宁可少记一条，也不能把绿色划线画错位置。

**插件侧只有三件事是自己的**：
1. **侧栏**（380px、固定右侧、`translateX(100%)` 滑入）：覆盖网页不挤压布局；点空白 / `Esc` / × / 再点同一个词都关闭。
2. **流式必须用 port**：`rf:api` 会等整个响应读完才返回，看不到逐字；“问 AI” 走 `chrome.runtime.connect({name:"rf:explainStream"})`，content 断开时 background `abort()` 上游请求。
3. **侧栏代次 `panelSeq`**：`openShell` / `closePanel` 各加一。请求是异步的，用户完全可能在看答案回来之前点空白关掉或点了别的词——迟到的 `/record` 响应必须丢掉，否则侧栏会「自己弹回来」（`npm run test:extension` 的 C4 就是这么抓到的）。

**「问 AI」的选项文案与出现条件和 `Reader.tsx` 的 `askOptions()` 一字不差**，改动时必须两边一起改；E2E 会拿 `Reader.tsx` 的源码逐条核对文案，漂移就红。

**网站侧的两处呈现**：词库来源栏按 `contexts.via === 'extension'` 出「🧩 插件」徽章；来源是网页摘录时链接改成 `textFragmentUrl()`（`#:~:text=前文-,选区,-后文`，`-`→`%2D`、`,`→`%2C`），新标签页打开并滚动高亮原句，其它情况仍走 `/texts/{id}?p={paragraphId}`。

**回归**：`npm run test:extension` 的 D 段（隔离库 + 临时端口 + 真实 Chromium）覆盖九件事——侧栏打开并显示词典、覆盖式 380px 不挤压布局、自动落库且 `via='extension'`、取消记录连词条一起删并清高亮、短语词典未命中自动请 AI（本地假模型，不花钱）并写进 `ai_gloss`、选项文案与阅读页一致、已导入网页上点词挂在 `source_type='url'` 且 `content.slice===quote`、词库页出 🧩 与文本片段外链、首页和书架看不到网页摘录。

---

## 13. 代码地图与改动指引

| 想改什么 | 改哪里 | 注意 |
|---|---|---|
| 换 AI 供应商 | 设置页 / `lib/config.ts` 的 `resolveProvider()` | 保持 OpenAI 兼容即可，`lib/ai.ts` 不用动 |
| 改 prompt | `lib/ai.ts` 的 `buildSystemPrompt` / `buildUserMessage` / `observations()` | 中文与 monolingual 两套人设同步；默认释义与追问必须共用同一 system；**别把「禁止整句译文」搬回来**（会逼模型只写语法），范围规则靠「只译选区 + 点名越界句式 + 正例」守住。改完必须真调一次模型做 A/B，单测只锁字面 |
| 改句子地图 / 主干标记 | `MarkdownText.tsx` 的 `==...==` 分支 + `lib/markdown-inline.ts` 的 `stripUnclosedSpine()` | 下划线样式内联在组件里，别挪回 `globals.css`（增量构建缓存会漏规则）；改完跑 `npm run test:spine-render` |
| 改卡片背面释义 | `lib/gloss.ts` 的 `cardGloss()` | `/api/words`、`/api/contexts/[id]`、`/api/contexts/gloss` 三个写入口都依赖它（统一在 `word-store.ts`）；改完跑 `tests/unit/card-gloss.test.ts` |
| 改 AI 释义落库 | `lib/word-store.ts` 的 `persistGlossByAnchor()` / `applyGlossToContext()` + `Reader.tsx` 的 `persistGloss()` | 别把写回重新绑回 `contextId`：按锚点幂等是「答案一定存得下」的保证；改完跑 `npm run test:gloss-persist` |
| 改自动收词 / 已存批注 | `lib/word-store.ts` 的 `ensureContextByAnchor()` + `POST /api/contexts/ensure` + `Reader.tsx` 的 `ensureAnnotation()` | P23 起开关已移除、点词恒定落库；`savedMap` 是全量词库、`annotations` 是异步快照，两者都不能用来裁决「本文这一处有没有 context」；改完必须跑全量 `test:e2e`（撤销按钮那条会抓到快照过期） |
| 改行内中文标签 | `lib/gloss.ts` 的 `inlineGloss()` + `Reader.tsx` 的 `rangeKey` / `renderTokens()` + `globals.css` 的 `.w-annotated-l[data-gloss]::before` | 中文只能用伪元素 + 属性生成，绝不插真实文本节点；`/api/annotations` 要带 `translation`；改完跑 `tests/unit/inline-gloss.test.ts` 与全量 `test:e2e` |
| 改「再点开不重问」 | `Reader.tsx` 的 `savedGlossFor()` / `glossCacheRef` / `forgetGloss()` | 缓存键是 `${paragraphId}:${start}:${end}`，跨文章不算同一个锚点；删词删批注要同步清 |
| 改阅读器证据 | `lib/sentence.ts` 的 `selectionSignals()` + `/api/explain` 的 `narrowSignals()` | 只送证据不送结论；新字段要同步白名单裁剪 |
| 改「何时自动问 AI」 | `lib/explain-policy.ts` 的 `shouldAutoExplain()` + `Reader.tsx` 词典 fetch 回调 | 自动触发必须挂在请求回调里（state 会残留上一次结果）；改完跑 `npm run test:auto-explain` |
| 改插件查词 / 侧栏 | `extension/src/content.js`（侧栏与交互）+ `src/lib/extension-record.ts`（落库与回放） | 插件不自己实现「要不要自动讲解」，一律看 `/record` 返回的 `autoExplain`；流式必须走 port；改完跑 `npm run test:extension` |
| 改网页坐标换算 | `src/lib/web-anchor.ts` 的 `normalizeBlockText` / `locateInParagraphs` / `textFragmentUrl` | 返回的坐标必须满足 `content.slice(start, end) === quote`；归一化回映取右端用 `map[at+len]`；改完跑 `tests/unit/web-anchor.test.ts` |
| 改无模型提示文案 | `lib/explain-policy.ts` 的 `NO_MODEL_NOTICE` / `NO_MODEL_MARKER` | `lib/ai.ts` 只 re-export；前端识别与词库过滤共用同一标记，别复制字符串 |
| 加词典字段 | `lib/dict.ts` 的 SELECT + `DictEntry` + `Reader.tsx` 的 `DictView` | 三处同步 |
| 改分词规则 | `lib/tokenize.ts` 的 `TOKEN_RE` | 必须保持确定性（不能依赖环境） |
| 改切段规则 | `lib/split.ts` | ⚠️ 会让历史锚点失效，先读 3.2 |
| 改卡片版式 | `lib/cardgen.ts` 的 `buildQaCard` / `buildClozeCard` / `buildChoiceCard` | 改完必须跑 `npm run verify:cards` + 官方 lint |
| 加卡片类型 | `CARD_TYPES` 数组 + `buildCard()` 分支 + `exports.card_type` 取值 | 幂等键含 card_type，新类型天然不冲突 |
| 换卡片样式参数 | `cardgen.ts` 顶部的 `GREY` / `RED` / `BLUE` | 颜色是不带 `#` 的 6 位小写十六进制 |
| 加页面 | `src/app/<route>/page.tsx` + `duo-card` 等现成类 | 记得挂进 `layout.tsx` 与 `BottomNav.tsx` |
| 改视觉 | `src/app/globals.css` 的 CSS 变量 + `.duo-*` 类 | 颜色改变量，别硬编码 |
| 加表/字段 | `db/schema.ts` **和** `db/index.ts` 的 `SCHEMA_SQL` + `migrate()` | 三处必须一致（8.4 / 11.5） |
| 改登录 / 会话 | `lib/auth.ts` / `lib/auth-crypto.ts` / `proxy.ts` | proxy 只查 cookie 存在，真校验在每个页面与 API 的 `currentUser()`；改完跑 `npm run test:account` |
| 改配置归属 | `lib/settings-store.ts` + `api/settings/route.ts` | `profile.*` 绝不回退站级；GET 与 PUT 必须用同一个 `userId`，否则保存后读回默认值 |
| 加账号 / 重置密码 / 改手机号 | `npm run add-user -- <用户名> --phone=<手机号>` / `npm run reset-password -- <用户名或手机号>` / `npm run set-phone -- <账号> <手机号>` | `/setup` 只在 `users` 表为空时可用；两者都走 `scripts/account.ts`（独立 tsconfig，别卷进 verify 编译链） |
| 改词典还原规则 | `lib/dict.ts` 的 `lemma()` / `lookup()` | 改完跑 `npm run backfill:lemma`，否则历史数据是旧规则 |
| 改音标显示 | `lib/text.ts` 的 `normalizePhonetic()` | ECDICT 用 `'`/`,` 表示重音，别再把它当普通标点 |

### 建议优先修的三件事

1. `explain` 的 SSE 帧格式（5.4）——现在能用但是「假 SSE」，早晚要接标准事件流。
2. `db/index.ts` 的忙等退避（8.5）——阻塞事件循环，改动小、收益明确。
3. 导出改成后台任务（11.6）——现在是同步串行，词一多请求就长；应该有 job 表 + 进度轮询。

（`lookup()` 的 lemma 判断已于 2026-11-02 修掉，见 2.3。）

---

## P33 更新：做卡与推送（取代旧的「导出」）

> 本文件前面讲 `cardgen.ts` / `/api/export` / 导出页 / `verify:cards` / `push:one` 的部分是 P33 之前的设计，**已全部下线**：
> `src/lib/cardgen.ts`、`ExportPanel`、`/export` 页（现在只跳转到 `/words?status=pending`）、`/api/export`（一律 410）都已删除或改成跳转。`exports` 表和 `src/lib/markji.ts` 保留。

- **纯函数（`src/lib/cards/`，单测编译）**：`spec`（AI 输出解析）、`validate`（11 条校验，渲染后统一查长度）、`render`（CardSpec → 墨墨语法 + 预览）、`lint`、`style`（考试风格）、`prompt`、`explain-cache`、`rate-limit`、`quota`、`flags`、`suggestion`、`edit`。
- **有副作用的**：`store`（数据库读取）、`generate`（出题流程）、`pusher`（推送任务）。
- **流程**：阅读页讲解 → 末尾「制卡建议：」行（`splitCardSuggestion` 拆出）→ 「＋ 做成卡片」→ `POST /api/cards/generate`（命中讲解缓存则前缀复用）→ 草稿 → 词库「待推送」检查 / 修改 / 换一道 → `POST /api/cards/push`（后台任务，限速、重试、防重复）→ 墨墨。
- **防重复建卡**：建卡前标 `pushing`；重启遗留或 5xx 后先在章节末尾认领「内容一致且未登记」的卡，找不到才重建。
- 一个词的多张卡在 `exports` 里用 `card_type = exam:<卡 id>` 区分。
- 测试：`npm run test:coverage`（含 cards）、`scripts/e2e-cards.mjs`（后端 + 推送，假模型 + 假墨墨）、`scripts/e2e-cards-ui.mjs`（前端冒烟 + 截图）。
