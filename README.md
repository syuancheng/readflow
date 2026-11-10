# ReadFlow

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

ReadFlow 把这个流程压成一条链，只做三个动作：

| 动作 | 实现 |
|---|---|
| **读** | 粘贴文本 / 上传 txt·md / 贴网页链接，自动提取正文、切段、索引 |
| **查** | 点单词或拖选短语，弹出释义卡：先查 77 万词条的本地词典；**查不到就自动**问「英语为母语且懂中文的老师」，不用再点一次按钮——先帮他把句子读顺，需要时才给符号化的句子结构标注 |
| **收** | 一键收进词库，连同**它出现的那句话、段落、字符位置**一起存下来 |

复习环节不重造——交给墨墨记忆卡（间隔重复已经足够好）。ReadFlow 只负责把「词 + 上下文」以墨墨能吃的格式喂过去。

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
| **导入** | 粘贴文本 / 上传 `.txt`·`.md` / 贴 URL；URL 优先抓站点官方 Markdown，否则 Readability 正文 HTML | ✅ |
| **结构化排版** | Markdown / HTML → Block IR：标题、有序/无序列表、GFM 表格、代码块、引用与 callout、行内链接与强调都按原结构渲染；公式全覆盖（`$$…$$` 块级 KaTeX 居中、行内 `$…$`/`\(…\)` 渲染成「视觉是图、坐标是文本」、HTML 里未渲染的裸定界符与已渲染的 KaTeX/MathJax 都能还原，含 mhchem 化学式与常用宏）；配图渲染真图（懒加载/srcset 识别 + 防盗链自动走服务端代理）；格式自动识别，可手动覆盖 | ✅ |
| **阅读器** | 按 Block 渲染 + 确定性分词、点词命中、拖选短语、Esc 关闭、已收词绿色高亮 | ✅ |
| **词典层** | ECDICT 77 万词条本地查询（<5ms）、`exchange` 字段反查词形还原（went → go） | ✅ |
| **AI 层** | DeepSeek 流式释义：老师人设 + 段落级上下文 + 阅读器客观信号；第一屏给选区在这句里的中文意思，句子地图只把主干标下划线、殿后可选；支持「追问」；无 key 时优雅降级 | ✅ |
| **收词** | 落库（`user_words` 按 lemma 去重 + `contexts` 每次一条）、收词动效、进度条 +1 | ✅ |
| **词库页** | 按时间倒序、每词展示最多 3 条原句 + 来源文章、可删词 | ✅ |
| **战绩页** | 收集总数 / 连续天数 / 文本数、14 天柱状图、最近收的词、书架 | ✅ |
| **游戏化 UI** | 多邻国风格：粗底边实体按钮、大圆角、进度条 + 终点旗标、`+1 词` 飘字、底部导航 | ✅ |
| **导出墨墨** | 三种卡片（看词猜义 / 挖空 / 选择）、牌组章节选择器、语法预览、幂等去重、限速与日配额 | ✅ |
| **文章难度** | 导入时服务端算一次的 CEFR 粗估（A1–C2）：词汇 + 句法双路打分，列表 / 阅读页徽章，悬停看词汇分档与置信度 | ✅ |
| **文本管理** | 重命名、分类（预设 + 自定义，按分类 / 难度筛选列表）、两段式确认删除（词库记录保留）；阅读进度按滚动位置落库（可回退）、「已读完」由用户手动标记，列表徽章 + 重开自动续读 | ✅ |

### 3.1 关于 CEFR 难度

CEFR 原本是描述**人**的能力框架，不是文本标准。「分级读物」是作者按词汇大纲**写**到某一级；我们要做的是反过来，拿任意文本**测**它大概需要什么水平才读得动——这是预测，不是认证。所以：

- **导入时算一次并落库**（对齐 Readlang：`POST /api/texts` → `estimateCefrForParts()` → 写进 `texts.cefr_*`），前端只展示，不重复计算，也不调用任何外部 API。
- **两路特征**：词汇路占 0.7（ECDICT 的 COCA 词频排名 `frq`，按词次取平均 `log(rank)` + 低频词占比），复杂度路占 0.3（平均句长、≥25 词长句比例、从句/衔接标记比例）。纯可读性公式单独预测 CEFR 准确率只有 31–42%，所以只当修正项。
- **输出不只有一个字母**：`cefr_score` 是 0–100 连续分，`cefr_detail` 存各档词汇占比、句法统计、置信度和已知偏差；贴近级别边界时徽章会写「也可能是相邻一级」。
- **措辞承认粗估**：徽章悬停明确写「不是 CEFR 官方评级」。专有名词、术语、公式符号不在 COCA 前 47,062 词内，会被当成生僻词，这类文本置信度自动降级。
- 老文章用 `npm run backfill:cefr` 试算、`node .verify/scripts/backfill-cefr.js --apply` 回填；算法升级后加 `--force` 重算（手动改过级别的行会跳过）。

实现见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 3.4 节。

### 3.2 关于结构化导入（Markdown / HTML）

**起因**：文档站、技术博客、论文页面普遍提供「Copy page」或 `.md` 源。粘贴进来的是 Markdown 源码，而早期版本把所有输入都当纯文本 `splitParagraphs()` —— 段内换行被压成空格，表格变成一行 `| | Non-deterministic ... |`，代码块变成一坨「围栏 + json + 代码」连在一起，标题和列表全糊在一起。阅读器再怎么改 CSS 也救不回来，因为**结构信息在入库那一刻就没了**。

**现在的做法**是「多种输入 → 统一中间表示 IR → 一套渲染后端」，不是给新闻 / 论文 / 博客各写一套解析器：

| 输入 | 适配器 | 说明 |
|---|---|---|
| 粘贴 / 上传的 Markdown | `remark-parse` + `remark-gfm` | 直接读 mdast，不经 Markdown→HTML→文本的有损往返 |
| 没有官方 `.md` 的网页 | `jsdom` 遍历 Readability 正文 HTML | 保住表格行列与 `<pre>` 换行，不用 Turndown 二次转换 |
| 纯文本新闻 / 小说 | 原 `splitParagraphs()` | 行为与改造前逐字一致，零回归 |
| URL | 优先读 `<link rel="alternate" type="text/markdown">` | 站点主动递结构化源时直接接住，拿不到才降级 HTML |

导入框提供「自动识别 / 纯文本 / Markdown」三档；自动识别要求**至少 1 个强特征（标题、围栏、表格、callout、链接）且命中 ≥2 类特征**，避免小说里一个 `#` 或一段单列表被误判。服务端独立再判一次，不信任前端。

**必须守住的不变量**：一个 Block = 一条 `paragraphs` 记录 = 一个 `data-pid` 容器。`content` 只存用户可见纯文本（无 Markdown / HTML 标记），是 `contexts.start/end` 的**唯一坐标基准**；`inline_ranges` 只描述相对这段文本的样式/链接区间，`block_meta` 只描述结构（深度、列表/表格 id、行列号、语言）。表格每个 cell、列表每个 item 各自成为一个 Block，渲染时用纯函数 `groupBlocks()` 重新组装成 `<table>` / `<ul>` / `<ol>`。所以标题变大、单元格变成 `<td>`，点词、拖选、收词、跳回原文的位置全部不动。

**两个刻意的行为**：

- 代码块、分隔线、图片不是 prose：不计入词数、不参与 CEFR 估级、不进分段小结，也不生成可点词 span（`pnpm` / `json` 不是要背的单词）。链接用 `<a>` 包住词 span，点击时 `preventDefault()`，点词优先弹释义而不是跳走。
- 同一篇技术文档，**按 Markdown 导入可能比按纯文本导入判低一级**。实测 Claude Code 官方最佳实践：强制纯文本 B2 / 66.65 分，Markdown B1 / 47.55 分。差的那 1425 个「词」是代码标识符、URL 和表格语法——旧路径把它们当成 ECDICT 查不到的生僻英文词（未登录词 16.4% → 9.5%，生僻词 22.3% → 14.3%），难度被虚高。新值更真实，不是回归。

**旧文章不做迁移工具**：改造前 `content` 里的表格换行已经被压平，无法从压平结果反推原来的行列，只能重新粘贴官方 Markdown 重新导入。新导入的文本会把 `source_format` 和 `source_raw` 一并存下，以后换解析器可以无损重跑。

### 3.3 关于数学公式与配图（P14 → P17）

**公式分两级处理，锚点安全是分界线**：

- **块级公式（`$$…$$` 独立成段）→ 新增 `math` 块**：`content` 存 LaTeX 源（保留换行），前端用 KaTeX `renderToString()` 渲染。KaTeX 是纯函数，SSR 与客户端输出逐字节一致，不引入 hydration 风险；`math` 与 `code` 同等待遇——不计词数、不进 CEFR、不生成可点词。remark-math 的 flow 语法要求 `$$` 独占一行，但实际文档大量使用 `$$J=r$$` 单行写法（会被解析成「只含一个 inlineMath 的段落」），导入时把这种段落提升成 `math` 块。
- **行内公式（`$s \in \mathcal{S}$`）→ `math` 行内区间**：`content` 仍存 LaTeX 源；区间内不生成 `.w` 可点 span（`\rho`、`\arg\max` 不是要背的单词）。词数 / CEFR 统计时 `stripInlineMath()` 把整段区间替换成空格——同一个 bug 预防了两次（README 3.2 节的代码标识符问题是先例）。P17 起前端把行内公式渲染成「**视觉是图、坐标是文本**」：KaTeX 视图负责观感（对齐原站 MathJax 的效果），同层隐藏原文 + `data-rf-skip` 零计数让 `offsetIn()` 的字符计数与 `content` 严格等长——公式变成图，但拖选跨公式、点公式前后的词，锚点分毫不差。P14 曾判断「渲染行内公式必然破坏锚点」，P17 的解法是重写 `offsetIn()` 为跳过标记子树的手动计数，不再依赖 `Range.toString()`。
- **HTML 路径的公式有三种形态，全部接住**：① 站点已渲染的 KaTeX/MathJax（读 annotation / script 还原源）；② **Readability 剥掉 MathJax JS 后剩下的裸 `$…$` 文本**（lilianweng 博客实测）——`splitMathText()` 按 Pandoc 规则扫描四类定界符，`$5 and $10` 货币不误伤，remark-math 的宽松判定在 markdown 路径二次收紧；③ Markdown 源的 remark-math 解析。
- **兼容面**：mhchem 化学式（`\ce{H2O}`）+ 常用宏（`\bm`/`\argmax`/`\norm`/`\abs`…）；未知命令走红色原文降级不崩页。
- **配图**：懒加载（`data-src` 系列 + 1x1 占位识别）与 `srcset`/`<picture>` 都能拿到真地址；直连 403（Referer 型防盗链）自动换 `/api/img` 服务端代理重试（无 Referer + 浏览器 UA + 磁盘缓存）；`data:image/*` 内联图直接放行。
- **HTML 路径**：`normalizeMath()` 在 walk 之前把站点已渲染的公式还原成 LaTeX 源——KaTeX 读 `<annotation encoding="application/x-tex">`，MathJax v2 读 `<script type="math/tex">`；块级/行内分别替换成占位元素。KaTeX 渲染残影（aria-hidden span + MathML 双份文本）不会再混进可见文本。

**配图只对「独占一段的图片」渲染真图**：`![alt](url)` 单独成段（或 HTML 的 `<figure>` / 纯图 `<p>` / 裸 `<img>`）→ 提升为 `figure` 块，`meta.src` 存地址（URL 导入时按站点地址解析相对路径），前端渲染 `<img loading="lazy" referrerPolicy="no-referrer">`；加载失败（防盗链 / 失效）自动回退为占位文字 +「查看原图」链接。`figure` 在 `NON_PROSE_KINDS` 里——alt 说明不算词数。夹在句子中间的行内小图仍是占位文字：渲染真图必然改变 DOM 文本长度、破坏锚点，不值得为边缘场景冒险。`<img>` 只接受 `http(s)` 绝对地址，`data:`/`javascript:` 一律按无图处理。

实现见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 3.5 节。

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

**首次打开会先进 `/setup`**：输入用户名、手机号和密码创建第一个账号（手机号只作登录名，不发验证码；以后登录框填用户名或手机号都行）。这是唯一一次开放建号，之后关闭注册；你原有的文章、词库和设置会在这次建号时自动归到这个账号名下，不会丢数据。以后每次访问需要登录。

账号运维（在项目目录运行）：

```bash
npm run list-users                       # 列出账号
npm run add-user -- alice --phone=13800138000                # 加人，自动生成随机初始密码并只打印一次
npm run add-user -- alice --phone=13800138000 --password=... # 指定密码（也可用环境变量 READFLOW_PASSWORD）
npm run reset-password -- alice          # 忘记密码时重置（也可填手机号），同时吊销该账号全部会话
npm run set-phone -- alice 13900139000   # 补填 / 修改手机号
```

打开 <http://localhost:3000>：粘贴一段英文 → 开始阅读 → 点任意单词 → 收进词库 → 去「导出」页推到墨墨。

> **导出前请注意**：墨墨开放 API 只能写卡片，**不能建牌组、也不能建章节，更没有删除接口**。
> 所以要先在墨墨 App 或网页端把牌组和章节建好，卡片推错了只能在 App 里手删。
> 界面上的「预览」会把真正要发送的原始语法摊开给你看，确认后再点写入。

> **部署到云服务器**：见 [`deploy/README.md`](deploy/README.md)（一键初始化服务器、上传数据、发布、回滚、每日备份）。

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
readflow/
├── src/
│   ├── app/
│   │   ├── layout.tsx            全局壳：顶栏 + 底部导航
│   │   ├── page.tsx              首页：我的文本 / 导入 / 战绩卡
│   │   ├── globals.css           多邻国设计系统（色板、按钮、进度条、弹层）
│   │   ├── texts/[id]/page.tsx   阅读页（SSR 查出段落 + 已收词）
│   │   ├── words/page.tsx        词库页
│   │   ├── export/page.tsx       导出页：选牌组/章节、选卡片类型、预览、写入
│   │   ├── stats/page.tsx        战绩页
│   │   ├── login/page.tsx        登录页（Suspense 包 AuthForm）
│   │   ├── setup/page.tsx        首次建号页（仅 users 表为空时可用）
│   │   └── api/
│   │       ├── auth/                setup / login / logout / me / status / password
│   │       ├── texts/route.ts        GET 列表 / POST 导入（格式探测 + Block IR + 算 CEFR）
│   │       ├── texts/[id]/route.ts   GET 详情 / DELETE
│   │       ├── words/route.ts        GET 列表 / POST 收词
│   │       ├── words/[id]/route.ts   DELETE 删词或删单条 context
│   │       ├── dict/route.ts         GET 词典查询（含词形还原）
│   │       ├── explain/route.ts      GET/POST AI 流式释义（POST 带 signals 客观信号）
│   │       ├── export/route.ts       GET 导出状态 / POST 生成并写入卡片
│   │       └── markji/decks/route.ts GET 牌组 / 章节列表（服务端代理，token 不出后端）
│   ├── components/
│   │   ├── Reader.tsx            核心：Block 分组渲染 + 确定性分词 + 命中 + 三层释义
│   │   ├── ReaderShell.tsx       进度条 + 阅读卡片外壳
│   │   ├── ExportPanel.tsx       导出交互：牌组章节选择、类型勾选、预览与结果
│   │   ├── DuoProgress.tsx       多邻国式进度条
│   │   ├── BottomNav.tsx         底部四 tab 导航
│   │   ├── CefrBadge.tsx         CEFR 徽章 + hover 判定明细（纯 CSS，服务端组件）
│   │   └── ImportForm.tsx        三种导入方式 + 格式自动识别/手动覆盖
│   ├── db/
│   │   ├── schema.ts             Drizzle 表定义
│   │   ├── index.ts              连接单例 + WAL + 建表 + 轻量迁移（带退避重试）
│   │   ├── ensure-cefr.ts        texts 表补 CEFR 列（应用启动与回填脚本共用）
│   │   ├── ensure-blocks.ts      texts/paragraphs 补结构化列（同上，共用定义）
│   │   └── ensure-auth.ts        users/sessions 建表 + settings 复合主键重建（连接层执行）
│   ├── proxy.ts                 粗守门：只查 cookie 存在，真校验在 currentUser()
│   └── lib/
│       ├── import/               Block IR 契约层与适配器
│       │   ├── types.ts          Block / InlineRange / BlockMeta + JSON 安全解析
│       │   ├── builder.ts        inline 节点摊平成可见文本，记录 [start,end) 区间
│       │   ├── detect.ts         保守格式探测（强特征 + 多类命中）
│       │   ├── markdown.ts       remark mdast → Block[]
│       │   ├── html.ts           jsdom DOM → Block[]
│       │   ├── plain.ts          复用 splitParagraphs()，纯文本零回归
│       │   ├── group.ts          渲染前把 cell/item 纯函数重组成表格/列表
│       │   └── index.ts          统一出口 + proseTexts() 过滤非正文
│       ├── cefr.ts               纯函数：词汇/句法两路特征 → 级别 + 分数 + 明细
│       ├── cefr-dict.ts          服务端适配：接 ECDICT 词频、加缓存、失败不影响导入
│       ├── tokenize.ts           确定性分词 + W3C 式锚点（build/resolve）
│       ├── split.ts              切段、词数统计、按句截取
│       ├── readability.ts        URL → 官方 Markdown（优先）或 Readability 正文 HTML
│       ├── dict.ts               ECDICT 查询 + lemma 反查 + 选择题干扰项
│       ├── ai.ts                 DeepSeek prompt 与流式生成
│       ├── explain-policy.ts     自动问 AI 的边界判定 + 降级文案识别（前后端共用）
│       ├── gloss.ts              插件短释义 / 卡片背面提炼（shortGloss / cardGloss）
│       ├── markdown-inline.ts    流式渲染时抹掉未闭合的 ==主干== 标记（纯函数）
│       ├── word-store.ts         收词 / 批注写回的服务端唯一落库入口：saveWordAndContext / ensureContextByAnchor / persistGlossByAnchor（按锚点幂等）
│       ├── cardgen.ts            Markji 卡片模板（三种）+ 发送前语法自检
│       ├── markji.ts             墨墨开放 API 客户端（读牌组/章节、写卡片、限速）
│       ├── text.ts               释义清洗（ECDICT 的字面量 `\n` 还原）
│       ├── auth-crypto.ts        scrypt 密码哈希 / token 生成与 sha256 / 过期判断（纯函数）
│       ├── auth.ts               currentUser / session 增删 / 登录限速 / ownerId
│       ├── settings-store.ts     站级默认 + 用户覆盖（profile.* 不回退站级）
│       └── stats.ts              按天聚合统计
├── scripts/
│   ├── import-ecdict.mjs         CSV → SQLite 批量导入
│   ├── account.ts                账号运维：list / add / reset（独立 tsconfig.account.json）
│   ├── e2e-account.mjs           临时库 + 临时端口跑 49 项登录与双账号隔离验证
│   ├── e2e-auth.mjs              旧 E2E 脚本共用的登录态注入（patch fetch + Playwright cookies）
│   ├── verify-export.ts          离线验证：收词 → 生成卡片 → 语法自检
│   ├── verify-markji.ts          只读联调：用自研客户端列牌组/章节
│   ├── backfill-cefr.ts          给老文本补 CEFR（默认 DRY-RUN，--apply 写入）
│   ├── e2e-auto-explain.mjs      真实浏览器验证：词典命中不自动 / 未命中自动问 AI / 写回批注 / 回看不重复请求
│   ├── e2e-gloss-persist.mjs     真实浏览器验证：AI 释义必落库 / 再点开不重问 / 全局已收词 / 自动收词关闭 / delegate 案例与 ensure 幂等
│   ├── e2e-spine-render.mjs      真实浏览器验证：注入带 ==主干== 的批注，检查下划线 DOM 与样式、卡片背面无裸记号
│   ├── service.sh                launchd 常驻服务（install / restart / status / logs）
│   └── ...                        另有 E2E、性能基准、扩展打包等脚本
├── tests/unit/                     node:test 单测（npm test）
├── docs/ARCHITECTURE.md          技术实现文档
└── data/                         本地数据（已 gitignore）
    ├── readflow.db              用户数据
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

**词典查不到就直接进第 2 层**：短语（含空格）在 ECDICT 里必然没有，专有名词、生僻词也常查不到。旧版这里只显示一行「可用 AI 解释」再等用户点按钮，现在词典请求确认未命中就自动开始流式释义——用户已经停下来请教了，不该再要一次点击。成本闸门因此从「多一次点击」换成「词典命中率」：命中词典的约 80% 点击仍然一分钱不花。

三个例外不自动，判定固化在 `lib/explain-policy.ts` 的 `shouldAutoExplain()`（有控制变量单测）：词典已命中、这条批注已存过 AI 释义、从「已存批注」列表回看旧批注（用户只是想看一眼）。没配模型时服务端返回的是配置引导文案，不会被当成释义写进批注或词库；弹层改给「配置好模型后重试」。

**第 2 层的输出契约（P10 重构，P13 修正）**：不是三段式固定栏目。AI 的身份是「英语为母语且懂中文的英语老师」，原则是**语义为体、语法为用**——用户要的是把句子读懂，不是语法课。

- **按范围给，不按内容禁**（P13 定稿）：第一屏先给「选中部分**在这句话里**的中文意思」——按语境译，不搬词典义项（`over` 不是「在…之上」、`benefits from` 不是「好处」）。选区多大就译多大：划了整句就译整句，划一个词就只给这个词。范围由用户自己划定，不必因为怕「直接给答案」而克制。
  - P10 曾把「禁止整句通顺译文」写成硬禁令，结果模型为了避险退回去只写语法：实测一张卡里语法术语出现 7~13 次，语义只剩夹在中间的一两句话。P13 删掉这条内容禁令，换成**范围规则**——禁止的是把选区以外的英文顺手译成中文，不是翻译本身。
  - 真模型 A/B 又抓到模型用「整句在说：」「这里说的是：」换皮越界，于是补了点名约束 + 正例；单测锁住「挡越界」和「不恢复旧禁令」这两条不能互相替换。
- **第一屏两小句**：先给译法，再给一句「为什么是这个意思」（搭配 / 介词 / 词性 / 指代、还原后的读法）。不堆语法术语、不罗列词典义项。
- **结构分析殿后、可选、符号化**：需要时才给 2~3 行「句子地图」——emoji 句型标签 + 原句照抄、**只把主干用 `==...==` 标成下划线**（`MarkdownText.tsx` 渲染），其余成分保持原样、不再逐个挂括号 + 一行易错点。没把握标「（存疑）」，整句结构拿不准就整块不写。轻答保留一句定位说明。
- **前端只送证据，不下结论**：`source`（点词/拖选）、选区词数、所在句原文、`coverage`、选区位置、词典命中、同句连续请教次数，随 `POST /api/explain` 的 `signals` 送给模型；判断句法权重与答案深度是老师本职，不在前端分类。
- **同一句连续请教 ≥3 次**视为「生词太密」，模型自动切到整句分析，批注卡上给「改按词答」的撤销入口。计数只放前端内存，换句/刷新清零，不落库。
- **默认释义与追问共用同一套 system**，只有「学生的问题」一行不同。

AI 全文写回 `contexts.ai_gloss` 供回看，但**不进墨墨卡片背面**：句子地图贴死在原句上，脱离语境就失去意义。词典未收录时，`cardGloss()` 从第一屏的选区译法提炼一行短释义填 `user_words.translation`；句子地图、`==` 记号、成分标注、无模型提示都不会进卡片（技术文档 5.5）。

**只要点了 AI 释义，结果就一定存得下来**（P12）：流式答案生成完，前端只把「锚点 + 释义全文」交给 `POST /api/contexts/gloss`，由服务端按 `(textId, paragraphId, start, end)` 更新已有批注；没有批注就补建词条 + 批注。旧实现要求前端先拿到 `contextId`，找不到就静默丢弃——自动收词关闭、这个词在别的文章收过、或两次并发请求竞态时，答案就「看得见、查不到」。现在落库由服务端保证，与前端闭包时序无关。同一个锚点再次点开直接摊开已存答案，**不会重新请求模型**；换一个位置（不同锚点）才算新的一次请教。落库规则统一收口在 `lib/word-store.ts`，`/api/words`、`/api/contexts/[id]`、`/api/contexts/gloss` 共用。

**「已收词」和「已存批注」是两件事**（P12 续）：`user_words` 是全局词库，一个词在任意文章收过就存在；`contexts` 是「某篇文章某一处」的批注，右侧「已存批注」列表按 `textId` 查它。阅读页为了高亮拿到的是**全量词库** `savedWords`，旧版点词时却用 `if (savedMap.get(key)) return` 把它当成「本文这一处已批注」——于是一个在别的文章收过的词（如 `delegate`）在当前文章显示绿色 ✓，却永远建不出 context，也进不了列表。现在点词 / 拖选统一走 `POST /api/contexts/ensure`，服务端 `ensureContextByAnchor()` 按锚点幂等补建，重复点同一位置不会堆重复批注。前端也不再拿 `annotations` 快照做「已有批注就跳过」的判断：收起即撤销、并发刷新、别处补建都会让快照过期，一跳过就会漏掉这一处的 context；裁决只在服务端做一次。P12 之前已经收过、但本文没有 context 的老词，需要在正文里**再点一次**才会补上批注（不做历史迁移）。

### 7.4 账户体系：站级默认 + 用户覆盖（P20）

不用 Auth.js / Clerk / Supabase：本地 SQLite + Node 内置 `crypto.scrypt` 就够，零依赖、零月费、断网可用。所有业务表第一天就预留了 `user_id`，所以这次上账户**没有改任何业务表的列**，只新增 `users` / `sessions` 两张表。

- **关闭开放注册**：唯一建号入口是 `/setup`，且只在 `users` 表为空时接受。建号事务把老库 `user_id='local'` 的文章与词一次性改挂到 owner 的 UUID 名下。之后加人只能由 owner 跑 `npm run add-user`。
- **守门分两层**：`proxy.ts`（Next 16 起替代 `middleware.ts`）只判断「有没有 session cookie」；真正的校验在 Node 侧 `currentUser()`：cookie → sha256 → `sessions` 表 → 关联 `users` → 查过期。伪造、过期、已登出都在这里挡掉。因此**所有页面与 API 必须自己调 `currentUser()`**，不能把 proxy 当安全边界——只带一个假 cookie 就能穿过它。
- **cookie 只存原始 token，库里只存它的 sha256**；DB 泄露也换不到登录态。密码是 scrypt 哈希串，绝不存明文。登录失败按 (IP, 用户名) 计数，5 次锁 60 秒；改密码吊销该账号全部 session 并给本机重发一个。
- **配置分两类**：AI 密钥 / 墨墨 Token / 插件 Token 是**站级默认**（`user_id='local'`，所有账号共享，插件链路没有 cookie 也要能读到同一个 token）；`profile.*` 是**个人资料**，只存本人行，且 `settings-store` 对它**不回退站级**，否则 A 会看到 owner 的昵称。牌组 / 章节这类导出目标也支持「本人覆盖站级」。
- **越权返回 404 而非 403**：知道别人的文章 id 时，不向对方暴露「这个资源存在」。`exports` 表没有 `user_id`，统计与每日配额一律经 `user_words` 关联过滤；插件链路用站级 token 鉴权，数据统一归到 `ownerId()`。

登录 / 建号页隐藏站点导航；右上角头像菜单显示当前账号，可改密码、退出登录。经公网访问时建议套一层 HTTPS 隧道（`x-forwarded-proto=https` 时 cookie 自动加 `Secure`）。

---

## 8. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/status` | 公开：`{needsSetup}`，登录页据此决定显示「建号」还是「登录」 |
| `POST` | `/api/auth/setup` | 首次建号（仅 `users` 表为空时可用；必填用户名、手机号、密码），下发 session cookie |
| `POST` | `/api/auth/login` | `{account, password}`：账号填用户名或手机号；连续失败 5 次锁 60 秒（同一账号的用户名 / 手机号共用计数） |
| `POST` | `/api/auth/logout` | 吊销当前 session 并清 cookie |
| `GET` | `/api/auth/me` | 当前登录态（用户名 / displayName / 是否 owner） |
| `POST` | `/api/auth/password` | 改密码 `{currentPassword, newPassword}`，吊销其它设备会话 |
| `GET` | `/api/texts` | 文本列表 |
| `POST` | `/api/texts` | 导入文本，body `{title?, text?, url?, format?: "auto"\|"plain"\|"markdown", sourceType?: "paste"\|"file"}`。带 `url` 时优先抓站点官方 `.md`，拿不到才降级 Readability HTML；粘贴/上传走格式探测 → Block IR。导入时同步算 CEFR，返回 `sourceFormat / blockKinds / cefrLevel / cefrScore / cefrConfidence` |
| `GET` | `/api/texts/{id}` | 文本（含 `sourceFormat` / `sourceRaw`）+ 全部段落（含 `blockType` / `blockMeta` / `inlineRanges`） |
| `PATCH` | `/api/texts/{id}` | 编辑元数据：`{title}` 重命名（≤200 字符）、`{category}` 分类（空串=未分类）、`{readIdx, readRatio}` 阅读进度（按滚动位置覆盖写，可下降）、`{completedAt}` 手动标记已读完（时间戳 / `null` 取消，与进度独立） |
| `DELETE` | `/api/texts/{id}` | 删文本（段落与分段小结级联；**词库、原句、AI 释义记录保留**，词库页标注「来自已删除的文章」） |
| `GET` | `/api/dict?word=went` | 词典查询，返回 `{entry, originalForm, lemmaForm}` |
| `GET` | `/api/explain?word=&context=&language=&monolingual=&prompt=` | AI 流式释义（兼容旧调用，纯文本分块，不带 signals） |
| `POST` | `/api/explain` | AI 流式释义（推荐）：`{word, prefix?, suffix?, withPrevSentence?, language?, monolingual?, prompt?, signals?}`。`signals` 为阅读器采集的客观信号，只含证据不含结论；服务端白名单提取并裁剪数值 |
| `GET` | `/api/words` | 词库列表（`?textId=` 过滤某篇文章） |
| `POST` | `/api/words` | 收词：写 `user_words`（按 lemma upsert）+ `contexts` |
| `POST` | `/api/contexts/ensure` | 按锚点确保本文这一处有批注（点词 / 拖选自动收词走这里）：入参同 `gloss` 但不必带 `aiGloss`。已有 context 原样返回，没有则补建；重复调用幂等 |
| `POST` | `/api/contexts/gloss` | AI 释义按锚点幂等写回：`{textId, paragraphId, start, end, quote, prefix, suffix, word, aiGloss}`。已有批注更新 `ai_gloss`，没有则补建；降级文案拒绝入库 |
| `PATCH` | `/api/contexts/{id}` | 已知 id 时回填 `aiGloss`（旧客户端 / 其他调用方兼容） |
| `GET` | `/api/annotations?textId=` | 本文已存批注（含 `aiGloss`），按词条去重 |
| `DELETE` | `/api/words/{id}` | 删词；带 `?contextId=` 时只删单条上下文 |
| `GET` | `/api/export` | 导出状态：token 是否就绪、目标牌组/章节、各类已推数量、今日已推 |
| `POST` | `/api/export` | 生成并写入卡片；`{deckId, chapterId, types, dryRun}`，`dryRun` 只返回卡片原文 |
| `GET` | `/api/markji/decks` | 牌组列表；带 `?deckId=` 返回该牌组的章节 |

---

## 9. 数据与密钥

- 用户数据：`data/readflow.db`（SQLite，WAL 模式）。**不入库**，备份直接拷文件。
- 词典：`data/dict/ecdict.db` + `ecdict.csv`，**不入库**（94MB / 63MB），由 `scripts/import-ecdict.mjs` 重新生成。
- AI key 只读服务端环境变量 `DEEPSEEK_API_KEY`，墨墨令牌同理 `MARKJI_TOKEN`，两者都不写前端、不进仓库。参考 `.env.example`。
- 业务数据按账号隔离，真实账号 id 是 `users` 表里的 UUID；`'local'`（`LOCAL_USER`）只是表默认值与站级配置的哨兵，**不是任何账号**。密钥类配置落在 `settings` 表的站级行，`profile.*` 落在本人行。密码哈希与会话 token 都只存在本地 `data/readflow.db`，不进仓库。

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
| P6b | 阅读进度：记住读到哪一段，下次打开自动定位 | ✅（P16 落地，P18 修订为滚动位置覆盖写 + 「已读完」手动标记） |
| P8 | 文章 CEFR 粗估：导入时算一次、双路打分、徽章与判定明细、老文本回填 | ✅ |
| **P9** | **结构化导入**：Markdown / HTML → Block IR，标题·列表·表格·代码块·callout 原样渲染，URL 优先官方 `.md`，锚点契约不变 | ✅ |
| **P10** | **AI 释义重构**：取消三段式 → 老师人设 + 阅读连续性优先 + 符号化句子地图；客观信号透传、同句连续请教累计、单测与文档同步 | ✅ |
| **P11** | **词典未命中自动问 AI**：成本闸门改为词典命中率，短语不再多点一次按钮；自动释义写回批注、降级文案不入库、回看旧批注不烧请求 | ✅ |
| **P12** | **AI 释义持久化 + 批注锚点修复**：按锚点服务端幂等写回 / 补建；同锚点再点开直接复用答案、不重复计费；`ensure` 让全局已收过的词在本文也能进「已存批注」；落库规则收口到 `word-store.ts` | ✅ |
| **P13** | **AI 释义语义回归**：删掉「禁整句译文」的内容禁令，改成「只译选区、不越界」的范围规则；第一屏给选区在这句里的意思，语法术语退到配角；句子地图只把主干标下划线；真模型 A/B + 渲染 E2E | ✅ |
| **P14** | **公式与配图**：块级公式 KaTeX 渲染、行内公式不可点且不进统计（`math` 块 / math 区间）；HTML 路径还原 KaTeX/MathJax 公式源；独立配图渲染真图 + 失败回退（`figure` 块）；锚点契约不变 | ✅ |
| **P16** | **文本管理**：重命名 / 分类（预设+自定义，列表按分类与难度筛选）/ 两段式确认删除；阅读进度（P6b）初版按累计词数落库、单调合并、重开自动续读（**该进度算法已被 P18 替换**） | ✅ |
| **P17** | **公式全链路**：HTML 路径裸 `$…$` 扫描（MathJax 站被 Readability 剥掉 JS 后的形态）；行内公式「视觉是图、坐标是文本」渲染（KaTeX 视图 + `data-rf-skip` 零计数 + 隐藏原文，offsetIn 重写）；mhchem + 常用宏；图片懒加载/srcset 识别 + `/api/img` 代理兜底防盗链 | ✅ |
| **P18** | **阅读进度与「已读完」解耦**：修复「打开即 100%」（旧版扫全 DOM 取最大 idx、无视口判断，叠加单调合并导致脏数据无法自愈）；进度改按滚动位置实时计算、可下降、滚到底 = 100%；「已读完」由用户点按钮显式标记（`completed_at`，再点取消），100% 不自动等于读完；进度改覆盖写、不设重置按钮；上线后补修关标签页丢上报（`sendBeacon` + 停止滚动即报）、文末书签自锁（续读拦截）、滚到底够不着标记按钮（当时加浮动提示，P19 常驻顶栏后已删除）；纯函数单测 + 生产 E2E 18 项 | ✅ |
| **P19** | **字体与阅读页外壳**：全站正文/标题（含阅读器英文正文，用户撤回了最初的衬线保留）统一 DM Sans、站点顶部导航换 Outfit（中文回退 PingFang SC）；阅读页 54px 常驻顶栏（返回 / 标题 / 难度 / 进度 / 标记 / 原文 + 底边进度条）+ 默认收起的目录（按 `heading` 块生成、scroll spy）；进度上报逻辑抽成 `useReadProgress` hook，Reader 与批注栏零改动；顺带修窄屏长链接 / KaTeX 公式溢出 | ✅ |
| **P5** | **长文性能：实测基准，决定不做虚拟滚动**（见 [`docs/PERF.md`](docs/PERF.md)） | ✅ |
| **P20** | **账户体系**：本地 scrypt 密码哈希 + sha256 会话表、关闭开放注册、`/setup` 首次建号自动迁移老数据、middleware 粗守门 + 服务端 `currentUser()` 真校验、站级密钥 / 个人资料分层、全链路归属校验（越权 404）、登录限速与改密码吊销会话；附运维脚本与 34 项隔离 E2E | ✅ |
| **P21** | **手机号登录**：建号必填中国大陆手机号（归一化 +86 / 空格 / 短横线，唯一），登录框接受用户名或手机号；不接短信验证码（按条收费），号码只作好记的登录名；用户名禁止手机号格式以免歧义；运维脚本支持 `--phone` / `set-phone` | ✅ |
| **P22** | **选词手感对齐 Readlang**：不再用浏览器原生选区——在词上按下即整词选中，拖动按整词扩展、出段落停在段首/段尾，单击与拖选同一路径；悬停 / 拖动 / 当前选中只用一种浅绿底色，已存批注改为下划线；按住 Option 拖动保留原生选区用于复制 | ✅ |
| P7 | 云端同步 / 多设备（账户体系已就位，同步机制待定） | 待定 |

P4 落地时被墨墨的 API 边界改写了设计（详见技术文档 11 节）：

1. **不能建/删牌组，也不能建/删章节**，只能写卡片 → 牌组和章节由用户在 App 里先建好，我们只做「往里写」，页面上给出选择器。
2. **没有删除端点** → 幂等必须是硬约束：`exports` 表上 `(user_word_id, deck_id, card_type)` 唯一，已推过的直接跳过。
3. **频控 10 秒 20 次 + 每天 600 条** → 写请求串行 + 最小间隔 600ms，并且按天计数封顶。

---

## 11. 已知限制

- **鉴权是本机级的，不是公网产品级的**：模型 / 墨墨 / 插件这些站级配置只有主账号能改，插件 Token 也只对主账号可见；登录限速默认按用户名计数（`X-Forwarded-For` 可被伪造，只有设了 `TRUST_PROXY=1` 才按 IP 区分），是进程内计数器（重启清零）、没有 CSRF token（靠 `SameSite=Lax` 兜底）、没有邮箱验证与找回（忘记密码用本地脚本重置）、session 30 天有效期不滑动续期。经公网访问前请套 HTTPS 隧道，且不要开放注册。
- **无虚拟滚动（实测后决定不做）**：全部段落一次性渲染进 DOM。实测（[`docs/PERF.md`](docs/PERF.md)）：4 千词的真实文章在 4 倍 CPU 降速下 TTFI 0.8s、交互满帧；4 万词才在弱设备出现可感知劣化（TTFI 2.5s），瓶颈是 SSR HTML 体积与水合，不是交互渲染。将来若常态读 2 万词以上的文本，改做分段懒渲染而不是虚拟滚动。
- **`/api/explain` 的 Content-Type 是 `text/event-stream`，但 body 是纯文本分块**（没有 `data:` 帧）。前端直接读 `res.body` 所以能工作，但如果将来要接标准 EventSource，需要补 SSE 帧格式。
- **AI 层没有跨位置的语义缓存**：同一个锚点（同一篇文章、同一处选区）再点开会直接读已存的 `ai_gloss`，不再计费；但同一个词出现在**另一个位置**会当成新的一次请教，重新请求模型。Readlang 用内存 + 服务端按词缓存规避，我们还没做。P11 之后词典未命中的每个新选区（短语 / 生僻词）都会自动发一次请求；词典命中的点击不受影响。
- **回看旧批注不会自动补释义**：P12 之前收的批注若当时没存下 AI 释义，`contexts.ai_gloss` 就是空的，历史答案无法追回；从「已存批注」列表打开只显示词典结果 + 手动入口，不会自动发请求（避免翻看旧内容时悄悄烧钱）。在正文里直接点那个词则会重新请教一次，这次的答案会被保存下来。
- **句子地图是模型判断，不是语法解析器**：轻答 / 中答 / 重答没有可解释的分类器，也没有句法树；prompt 要求「没把握标（存疑）、整句拿不准就整块不写」，但成分标注仍可能出错，且 temperature 0.3 下同一输入也可能略有波动。它是阅读脚手架，不是权威语法结论。
- **同句连续请教次数只在当前页面内存**：`repeatCount` 不落库，刷新 / 换页 / 组件重挂载清零；只影响这一次的答案深度，不形成长期学习画像。
- **AI 全文不进卡片背面**：完整释义只存在 `contexts.ai_gloss` 供回看；词典未收录的词/短语，卡片背面只有 `cardGloss()` 提炼的一行短释义，看不到句子地图。
- **中文按字切**：分词器对 CJK 只做单字切分，中文阅读需替换分词实现。
- **移动端未适配**：弹层宽度固定 360px，小屏靠 `max-height` 兜底，没有专门的移动布局。
- **CEFR 是启发式估算，不是标注模型**：没有用带 CEFR 标签的语料训练，阈值是拿 ECDICT 词频在真实文本上校准出来的。专有名词 / 术语 / 公式会被当成生僻词而高估难度（置信度会自动降级）；短文本（<150 词）的句法统计波动很大。将来可以用 `user_words` / `contexts` 里的个人收词行为做个性化校准。
- **旧文章的结构补不回来**：P9 之前入库的文本，表格换行已被压成空格，无法从压平结果反推行列。按约定不做迁移工具，需要重新粘贴原始 Markdown 重新导入；旧文章的锚点、词库、CEFR 都不受影响，仍可正常阅读。
- **结构化导入不是全保真**：支持 GFM 表格、多级列表、代码块、引用/callout、行内链接与强调；公式与配图见 3.3 节（覆盖 `$…$`/`$$…$$`/`\(…\)`/`\[…\]` 与 KaTeX/MathJax 已渲染产物；行内公式渲染成图但保留坐标；夹在句子中间的小图仍是占位文字）；`colspan`/`rowspan`、嵌套表格、脚注、语法高亮配色不还原。MDX 的 info string（如 `text theme={null}`）只取合法语言名。链接里的词可以点（不会跳走），代码块里的词刻意不可点。公式是模型渲染（KaTeX + mhchem + 常用宏），`throwOnError: false` 下坏公式显示红色错误提示而不是崩溃；纯文本粘贴路径不做 `$` 扫描（货币误伤风险，URL 导入不受影响）。
- **端到端靠脚本回归**：`npm test` 跑 `node:test` 单测（含 CEFR、密码哈希与配置隔离的控制变量测试），`npm run typecheck` 查类型；E2E 与导出验证另有 `npm run test:account`（临时库 + 临时端口，49 项登录与双账号隔离，不碰真实数据）/ `npm run test:e2e` / `npm run test:auto-explain` / `npm run test:gloss-persist` / `npm run test:spine-render` / `npm run verify:cards` / `npm run verify:markji`。P20 之后旧 E2E 脚本统一经 `scripts/e2e-auth.mjs` 注入登录态，在真实库上跑需先用 `E2E_USER` / `E2E_PASS` 指定账号。
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
