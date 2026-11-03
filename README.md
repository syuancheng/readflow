# Inkwell

**读你喜欢的，记住不会的。**

一个给中文母语者的英文阅读器：上传文章 → 边读边点词查义（词典 + AI 结合上下文）→ 生词带着原句收进词库 → 之后导出到墨墨记忆卡复习。

> **状态**：MVP 全链路跑通 P0–P4 + P6（能读、能查、能收词、能导出墨墨记忆卡、有学习日历）。
> 技术实现细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，长文性能实测见 [`docs/PERF.md`](docs/PERF.md)。

---

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 为什么做这个（项目背景）](#2-为什么做这个项目背景)
- [3. 当前能做什么](#3-当前能做什么)
- [4. 快速开始](#4-快速开始)
- [5. 技术栈](#5-技术栈)
- [6. 目录结构](#6-目录结构)
- [7. 三个关键设计](#7-三个关键设计)
- [8. API 一览](#8-api-一览)
- [9. 数据与密钥](#9-数据与密钥)
- [10. 路线图](#10-路线图)
- [11. 已知限制](#11-已知限制)

---

## 1. 这是什么

一句话：**把「读英文文章」和「背单词」之间那道断掉的桥接上。**

现在的流程通常是断的——你在文章里遇到生词，要么当场查完就忘，要么复制到别处（Anki / 备忘录）就丢了上下文，最后复习时看到一张「abandon = 放弃」的卡，完全不记得它出现在哪句话里、为什么当时看不懂。

Inkwell 把这个流程压成一条链，只做三个动作：

| 动作 | 实现 |
|---|---|
| **读** | 粘贴文本 / 上传 txt·md / 贴网页链接，自动提取正文、切段、索引 |
| **查** | 点单词或拖选短语，弹出释义卡：先查 77 万词条的本地词典，不够再调 AI 结合整句解释 |
| **收** | 一键收进词库，连同**它出现的那句话、段落、字符位置**一起存下来 |

复习环节不重造——交给墨墨记忆卡（间隔重复已经足够好）。Inkwell 只负责把「词 + 上下文」以墨墨能吃的格式喂过去。

设计上大量参考了 **Readlang**（同类产品里做了十年的一家），包括它的三层释义结构、句子级 context、以及「点词即出翻译」的交互节奏。差异在下面第 2 节说明。

---

## 2. 为什么做这个（项目背景）

### 2.1 现有工具的缺口

| 工具 | 问题 |
|---|---|
| **Readlang** | 面向西→英/法→英等语言对，释义默认翻成英文；付费墙（免费版每天 10 次 AI 解释、有词数上限）；词库无法导出到中文 SRS |
| **墨墨背单词 / 不背单词** | 复习算法强，但**没有阅读输入**——只能背别人给的词表 |
| **浏览器翻译插件** | 只翻译，不留存；关掉页面就没了 |
| **Anki 手工制卡** | 制卡成本太高，读十篇文章能坚持做三张卡已经算多 |

所以缺口很清楚：**「在真实阅读中采集、并自动带上下文」这一步没有人做好**，而它恰好是记忆质量最高的一环。

### 2.2 三个产品判断

1. **复习不重造。** 间隔重复是成熟品类，墨墨在国内的体验和词库质量都够用。我们做输入，它做输出。
2. **中文母语是默认视角，不是附加功能。** 释义默认中文；同时保留「用英文解释英文」（monolingual）模式给进阶用户。
3. **上下文是核心数据，不是装饰。** 「词」只是一行记录，「词 + 那句话 + 在段落里的位置」才是可复习、可回跳的资产。所以数据库从第一天就把 `contexts` 独立成表，而不是塞进词的 JSON 字段里。

### 2.3 明确不做的事

先把范围收窄，才能做深：

- ❌ 自建 SRS 算法、练习界面、选择题闯关
- ❌ 连续天数（streak）惩戒机制、排行榜、社交
- ❌ 内置词典编辑器、离线发音包
- ❌ 多用户 / 云端同步（**但表结构已预留 `user_id`**，见 7.4 与技术文档）

阅读进度、累计词量、学习日历这类统计：界面已有雏形（战绩页），但按约定「以后再做，先把核心跑通」。

---

## 3. 当前能做什么

| 模块 | 能力 | 状态 |
|---|---|---|
| **导入** | 粘贴文本、上传 `.txt`/`.md`、贴 URL（Readability 提取正文） | ✅ |
| **阅读器** | 段落渲染、确定性分词、点词命中、拖选短语、Esc 关闭、已收词绿色高亮 | ✅ |
| **词典层** | ECDICT 77 万词条本地查询（<5ms）、`exchange` 字段反查词形还原（went → go） | ✅ |
| **AI 层** | DeepSeek 流式释义，带整句 context；支持「追问」自定义问题；无 key 时优雅降级 | ✅ |
| **收词** | 落库（`user_words` 按 lemma 去重 + `contexts` 每次一条）、收词动效、进度条 +1 | ✅ |
| **词库页** | 按时间倒序、每词展示最多 3 条原句 + 来源文章、可删词 | ✅ |
| **战绩页** | 收集总数 / 连续天数 / 文本数、14 天柱状图、最近收的词、书架 | ✅ |
| **游戏化 UI** | 多邻国风格：粗底边实体按钮、大圆角、进度条 + 终点旗标、`+1 词` 飘字、底部导航 | ✅ |
| **导出墨墨** | 三种卡片（看词猜义 / 挖空 / 选择）、牌组章节选择器、语法预览、幂等去重、限速与日配额 | ✅ |

---

## 4. 快速开始

前置：**Node.js ≥ 22**（本项目实测在 24.x 上开发；`better-sqlite3` 需要本机编译，首次 `npm install` 会慢一点）。

```bash
# 1. 安装依赖
npm install

# 2. 准备词典（必需，否则点词会报「词典库不存在」）
#    下载 ECDICT 到 data/dict/ecdict.csv（约 63MB）
mkdir -p data/dict
curl -L -o data/dict/ecdict.csv \
  https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

# 3. 导入 SQLite（约 3–5 秒，产出 data/dict/ecdict.db，约 94MB）
npm run import:ecdict

# 4. 配置 AI 释义（可选；不配则 AI 层返回提示文案，其余功能正常）
export DEEPSEEK_API_KEY=sk-xxxxxxxx

# 5. 配置墨墨开放 API 令牌（可选；不配则导出页只提示，其余功能正常）
#    墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API
export MARKJI_TOKEN=xxxxxxxx

# 6. 启动
npm run dev
```

打开 <http://localhost:3000>：粘贴一段英文 → 开始阅读 → 点任意单词 → 收进词库 → 去「导出」页推到墨墨。

> **导出前请注意**：墨墨开放 API 只能写卡片，**不能建牌组、也不能建章节，更没有删除接口**。
> 所以要先在墨墨 App 或网页端把牌组和章节建好，卡片推错了只能在 App 里手删。
> 界面上的「预览」会把真正要发送的原始语法摊开给你看，确认后再点写入。

> **代理提示**：若本机设置了 `http_proxy`，`localhost` 请求可能被代理拦截（表现为页面 502、脚本连不上）。用 `NO_PROXY=localhost,127.0.0.1` 或 `curl --noproxy '*'` 绕过。

---

## 5. 技术栈

| 层 | 选择 | 为什么 |
|---|---|---|
| 框架 | **Next.js 16.4**（App Router）+ TypeScript | 一个进程同时提供页面与 API，AI key 与密钥不出服务端 |
| 渲染 | React 19 + Server Components | 列表/词库走 SSR 直查 SQLite，零客户端请求 |
| 样式 | Tailwind CSS 4 + 手写设计 token | 多邻国风格靠 CSS 变量成体系，不引组件库 |
| 数据库 | **SQLite**（better-sqlite3）+ Drizzle ORM | 单用户零运维，备份就是拷一个文件 |
| 词典 | **ECDICT** 导入独立 SQLite | 77 万词条本地查，免费、离线、毫秒级 |
| 正文提取 | `@mozilla/readability` + `jsdom` | Firefox 阅读模式的同款算法 |
| AI | **DeepSeek**（OpenAI 兼容接口）+ `openai` SDK | 中文好、便宜；只做兜底，用量小 |
| 流式 | 原生 `ReadableStream` + `TextDecoder` | 不需要框架，核心 30 行 |

---

## 6. 目录结构

```
inkwell/
├── src/
│   ├── app/
│   │   ├── layout.tsx            全局壳：顶栏 + 底部导航
│   │   ├── page.tsx              首页：我的文本 / 导入 / 战绩卡
│   │   ├── globals.css           多邻国设计系统（色板、按钮、进度条、弹层）
│   │   ├── texts/[id]/page.tsx   阅读页（SSR 查出段落 + 已收词）
│   │   ├── words/page.tsx        词库页
│   │   ├── export/page.tsx       导出页：选牌组/章节、选卡片类型、预览、写入
│   │   ├── stats/page.tsx        战绩页
│   │   └── api/
│   │       ├── texts/route.ts        GET 列表 / POST 导入（粘贴·文件·URL）
│   │       ├── texts/[id]/route.ts   GET 详情 / DELETE
│   │       ├── words/route.ts        GET 列表 / POST 收词
│   │       ├── words/[id]/route.ts   DELETE 删词或删单条 context
│   │       ├── dict/route.ts         GET 词典查询（含词形还原）
│   │       ├── explain/route.ts      GET AI 流式释义
│   │       ├── export/route.ts       GET 导出状态 / POST 生成并写入卡片
│   │       └── markji/decks/route.ts GET 牌组 / 章节列表（服务端代理，token 不出后端）
│   ├── components/
│   │   ├── Reader.tsx            核心：分词渲染 + 命中 + 三层释义弹层（575 行）
│   │   ├── ReaderShell.tsx       进度条 + 阅读卡片外壳
│   │   ├── ExportPanel.tsx       导出交互：牌组章节选择、类型勾选、预览与结果
│   │   ├── DuoProgress.tsx       多邻国式进度条
│   │   ├── BottomNav.tsx         底部四 tab 导航
│   │   └── ImportForm.tsx        三种导入方式
│   ├── db/
│   │   ├── schema.ts             Drizzle 表定义
│   │   └── index.ts              连接单例 + WAL + 建表 + 轻量迁移（带退避重试）
│   └── lib/
│       ├── tokenize.ts           确定性分词 + W3C 式锚点（build/resolve）
│       ├── split.ts              切段、词数统计、按句截取
│       ├── readability.ts        URL → 正文段落
│       ├── dict.ts               ECDICT 查询 + lemma 反查 + 选择题干扰项
│       ├── ai.ts                 DeepSeek prompt 与流式生成
│       ├── cardgen.ts            Markji 卡片模板（三种）+ 发送前语法自检
│       ├── markji.ts             墨墨开放 API 客户端（读牌组/章节、写卡片、限速）
│       ├── text.ts               释义清洗（ECDICT 的字面量 `\n` 还原）
│       └── stats.ts              按天聚合统计
├── scripts/
│   ├── import-ecdict.mjs         CSV → SQLite 批量导入
│   ├── verify-export.ts          离线验证：收词 → 生成卡片 → 语法自检
│   └── verify-markji.ts          只读联调：用自研客户端列牌组/章节
├── docs/ARCHITECTURE.md          技术实现文档
└── data/                         本地数据（已 gitignore）
    ├── inkwell.db              用户数据
    └── dict/ecdict.db            词典
```

---

## 7. 三个关键设计

完整论证见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，这里是结论。

### 7.1 锚定单位是「段落」，不是全局 offset

在长文里存 `{word, offset: 12456}` 是脆的——文章重导入、切段逻辑一改、前面多一个空行，全部偏移就错位了。

所以锚定拆成两级：**段落 uuid 是稳定基准，段内字符偏移只在段内有效**。再按 W3C Web Annotation 的模型存 `quote + prefix + suffix`（前后各 40 字符），定位时先信偏移，对不上就用「前文 + 原文 + 后文」全文搜，再不行只按 quote 搜且必须唯一命中，否则降级为「只显示原句、不提供跳转」——**宁可退让，不要跳错位置**。

### 7.2 分词必须确定性

`Intl.Segmenter` 看起来是免费午餐，但它的结果依赖运行环境的 ICU 版本：服务端 Node 和客户端 Chrome 可能切得不一样，长文本下 React hydration 会直接失败（整棵树丢弃重建）。

于是换成**纯正则 + 无状态**的分词器：同一输入永远同一输出，SSR 与客户端必然一致。代价是中文按字切（没有词典分词），等真正做中文阅读时再换跨环境一致的纯 JS 分词器。

### 7.3 释义是三层递进，不是三选一

对齐 Readlang 的心智模型——用户先要「够用的答案」，不满意才升级：

```
第 1 层  点词 → ECDICT 查词典        ~1ms、免费、离线    覆盖约 80% 的点击
第 2 层  不够 → DeepSeek 结合整句    流式、按 token 计费   歧义词 / 短语 / 习语
第 3 层  还不懂 → 追问（askAI）      同一接口 + prompt    用户自由提问
```

短语（含空格）直接跳到第 2 层——词典里查不到，AI 才有意义。这样 80% 的点击不花钱，成本可控。

### 7.4 单用户今天，多用户明天

所有表都有 `user_id`，单机模式固定写 `'local'`（`LOCAL_USER` 常量）。将来加登录时，把常量换成真实用户 id 即可，**不需要改表结构、不需要数据迁移**。这是第一天就付的「架构保险费」，几乎零成本。

---

## 8. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/texts` | 文本列表 |
| `POST` | `/api/texts` | 导入文本，body `{title?, text?, url?}`；带 `url` 时走 Readability |
| `GET` | `/api/texts/{id}` | 文本 + 全部段落 |
| `DELETE` | `/api/texts/{id}` | 删文本（段落级联） |
| `GET` | `/api/dict?word=went` | 词典查询，返回 `{entry, originalForm, lemmaForm}` |
| `GET` | `/api/explain?word=&context=&language=&monolingual=&prompt=` | AI 流式释义，纯文本分块 |
| `GET` | `/api/words` | 词库列表（`?textId=` 过滤某篇文章） |
| `POST` | `/api/words` | 收词：写 `user_words`（按 lemma upsert）+ `contexts` |
| `DELETE` | `/api/words/{id}` | 删词；带 `?contextId=` 时只删单条上下文 |
| `GET` | `/api/export` | 导出状态：token 是否就绪、目标牌组/章节、各类已推数量、今日已推 |
| `POST` | `/api/export` | 生成并写入卡片；`{deckId, chapterId, types, dryRun}`，`dryRun` 只返回卡片原文 |
| `GET` | `/api/markji/decks` | 牌组列表；带 `?deckId=` 返回该牌组的章节 |

---

## 9. 数据与密钥

- 用户数据：`data/inkwell.db`（SQLite，WAL 模式）。**不入库**，备份直接拷文件。
- 词典：`data/dict/ecdict.db` + `ecdict.csv`，**不入库**（94MB / 63MB），由 `scripts/import-ecdict.mjs` 重新生成。
- AI key 只读服务端环境变量 `DEEPSEEK_API_KEY`，墨墨令牌同理 `MARKJI_TOKEN`，两者都不写前端、不进仓库。参考 `.env.example`。
- 单机模式下所有记录挂 `user_id = 'local'`；将来加登录只需把常量换成真实用户 id，表结构不动。

---

## 10. 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | Next.js + SQLite 骨架、建表、文本导入 | ✅ |
| P1 | 阅读器：分词、点击命中、拖选短语、锚点 | ✅ |
| P2 | 三层释义：ECDICT + AI 流式 + 追问 | ✅ |
| P3 | 收词落库 + 词库页 + 已收词高亮 | ✅ |
| **P4** | **导出墨墨记忆卡**：三种卡片、预览、幂等、限速、日配额 | ✅ |
| P6 | 学习日历热力图 + 真实连续天数（streak / 最长连续 / 活跃天数） | ✅ |
| P6b | 阅读进度：记住读到哪一段，下次打开自动定位 | 待定 |
| **P5** | **长文性能：实测基准，决定不做虚拟滚动**（见 [`docs/PERF.md`](docs/PERF.md)） | ✅ |
| P7 | 多用户 + 云端同步（表结构已预留） | 待定 |

P4 落地时被墨墨的 API 边界改写了设计（详见技术文档 11 节）：

1. **不能建/删牌组，也不能建/删章节**，只能写卡片 → 牌组和章节由用户在 App 里先建好，我们只做「往里写」，页面上给出选择器。
2. **没有删除端点** → 幂等必须是硬约束：`exports` 表上 `(user_word_id, deck_id, card_type)` 唯一，已推过的直接跳过。
3. **频控 10 秒 20 次 + 每天 600 条** → 写请求串行 + 最小间隔 600ms，并且按天计数封顶。

---

## 11. 已知限制

- **无鉴权**：单机 `local` 用户，同一台机器上任何访问 3000 端口的人都能读写数据。
- **无虚拟滚动（实测后决定不做）**：全部段落一次性渲染进 DOM。实测（[`docs/PERF.md`](docs/PERF.md)）：4 千词的真实文章在 4 倍 CPU 降速下 TTFI 0.8s、交互满帧；4 万词才在弱设备出现可感知劣化（TTFI 2.5s），瓶颈是 SSR HTML 体积与水合，不是交互渲染。将来若常态读 2 万词以上的文本，改做分段懒渲染而不是虚拟滚动。
- **`/api/explain` 的 Content-Type 是 `text/event-stream`，但 body 是纯文本分块**（没有 `data:` 帧）。前端直接读 `res.body` 所以能工作，但如果将来要接标准 EventSource，需要补 SSE 帧格式。
- **AI 层无缓存**：同一个词重复点会重复计费。Readlang 用内存 + 服务端缓存规避，我们还没做。
- **中文按字切**：分词器对 CJK 只做单字切分，中文阅读需替换分词实现。
- **移动端未适配**：弹层宽度固定 360px，小屏靠 `max-height` 兜底，没有专门的移动布局。
- **无自动化测试**：目前靠 `tsc --noEmit` + 两个验证脚本（`npm run verify:cards` / `npm run verify:markji`）手工回归。
- **词形还原受 ECDICT 数据限制**：`leaves` 的 exchange 指向 `leave`（离开），但阅读中更常见的意思是「树叶」。我们优先展示变形词自己的释义（树叶），lemma 仍按 exchange 落库，所以 `leaves` 和 `leaf` 在词库里可能是两条。`was → be`、`went → go` 这类规则变形还原正常。
- **音标是 ECDICT 原文的近似写法**：多数条目用 `'`/`,` 表示主/次重音（`'glisn`），我们统一显示成 `ˈ`/`ˌ`，但音值本身仍是 ECDICT 的记音，不保证是标准 IPA。
- **导出不可逆**：墨墨没有删除接口，推错的卡片只能在 App 里手删。幂等只保证「不重复推」，不保证「推对了」——所以写入前必须先看预览。
- **一个词只取一条上下文**：导出时用该词最近一条 `contexts` 生成卡片，多语境暂不生成多张卡。
- **导出是同步的**：一次请求最多处理 200 个词 × 3 种卡，全部串行发（600ms/次）。词多时要分几次点，没有后台任务队列。

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 数据模型、请求全链路、关键取舍、踩坑记录、Readlang 逆向结论 |
| [`docs/PERF.md`](docs/PERF.md) | 长文性能实测数据与"不做虚拟滚动"的决策依据，含 `npm run bench` 复跑方法 |
