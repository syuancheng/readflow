# P35 实现说明：用句子学词、练开口的记忆卡（含句子音频）

| 项 | 内容 |
|---|---|
| 对应 PRD | `docs/prd/P35-sentence-speaking-cards.md`（F1–F5；决策见 PRD §12，2026-11-16 全部确认） |
| 依赖 | P33 做卡全流程（`src/lib/cards/**`、`pusher.ts`、`CardPreview.tsx`）、P32 问卷（`examFamilyOf`）、P34 出题不设输出上限 |
| 前端设计规范 | **《写给大家看的设计书》前端强制规范**（技能 `non-designer-frontend`，141 条规则）＋ 项目的 `docs/design-system.md`。两者冲突时按 §9.9 例外登记表执行 |
| 墨墨语法 | `~/.claude/skills/markji/references/card-syntax.md` §8.2、`api.md` §8（`POST /files`） |
| 语音合成 | 阿里云百炼 Qwen-TTS：<https://help.aliyun.com/en/model-studio/qwen-tts-api>、<https://help.aliyun.com/zh/model-studio/model-qwen-tts> |

---

## 0. 硬性约束（任何一条不满足都不算完成）

### 0.1 代码与框架
- 先读 `AGENTS.md`：本项目是 Next.js 16。`route.ts` 只导出 HTTP 方法和 `runtime` / `dynamic`，共用逻辑放 `src/lib/`；动态路由的 `params` 是 Promise。
- 每个接口在服务端确认身份（网站 `currentUser()`，插件 `requireExtensionUser()`），所有读写都校验数据属于当前用户。
- **不新增 npm 依赖**。语音合成、下载音频、上传墨墨都用 Node 自带的 `fetch`、`FormData`、`Blob`。不调用 ffmpeg 等外部程序。
- 不删除已有的表和字段，只新增。P33 时删掉的 `tts_audio`、`markji_media` 按 §1.1 建回。

### 0.2 前端设计规范（必须满足，验收见 §9）
本期所有**新增和改动的界面**必须满足 `non-designer-frontend` 技能的五道门槛，缺一项不得宣称完成：

1. **先读规则**：写界面代码前，读技能的 `references/book-rules-full.md`、`principles-frontend.md`、`color-frontend.md`、`typography-frontend.md`、`page-playbooks.md`。
2. **设计简报**：按 §9.1–§9.8 实现。交付时把简报连同验收结论保存为 `docs/design/P35-DESIGN.md`。
3. **只用令牌**：颜色、字号、字重、间距、圆角只用 `src/styles/tokens.css` 的变量。`npm test` 第一步的 `scripts/check-tokens.mjs` 必须通过，不得用 `token-ok` 注释绕过。
4. **自动检查**：对本期新增和改动的界面源文件运行技能的 `scripts/check_design.py`，`HARD = 0`（范围见 §9.10）。
5. **人工验收**：逐条填写技能 `references/acceptance-checklist.md` 的 A–K 全部行和例外登记表，附在 `docs/design/P35-DESIGN.md`。任何一行留空都不得交付。

### 0.3 测试
- 新增纯函数要有单测，并纳入 `npm run test:coverage`（`src/lib/cards/**` 与新文件 `src/lib/tts.ts` 的纯函数部分：行 ≥ 90%、分支 ≥ 85%、函数 ≥ 90%）。
- PRD 里的每个数字都要有对应的单测，测试名用中文写明测的是哪条规则：
  - 每组至少一张使用类卡；有考试目标时多一张考试风格的卡；
  - 「情景说一句」和「搭配与用法」的参考说法 2～3 句；
  - 回译的原句不超过 35 个词。
- **不得碰 `data/readflow.db`**：单测用 `DB_PATH=.unit/unit-test.db`，端到端用隔离库和临时端口。构建和端到端都在 worktree `.verify/wt-p32` 里跑，不在主目录跑。
- **不得调用真实的模型、墨墨或百炼**：统一用假服务（§8.2）。
- 回归：`npm test`、`npm run test:coverage`、空库构建、`test:word-library`、`test:invite`、`test:account`、`test:extension`、`e2e-personalized`、`e2e-cards`、`e2e-cards-ui` 全部通过，没有残留进程。

### 0.4 墨墨与百炼
- 写墨墨（上传音频、建卡）**只能**由用户在「待推送」里点推送触发。生成、换一道、修改都只改 ReadFlow 自己的数据库和本地音频文件。
- 上传请求和建卡请求**一起**计入 P33 的限速器（10 秒 20 次、60 秒 40 次、间隔 ≥ 500ms）。
- 卡片里只能写 `POST /files` 返回的 `file.id`，原样写入，大小写敏感。
- 发给百炼的只有卡片上的英文句子，不带用户 id、问卷或学生档案。
- 提交里不得出现任何真实的墨墨 Token、模型 Key 或百炼 Key。

---

## 1. 数据模型

### 1.1 建回两张表（`src/db/` 的启动迁移里 `CREATE TABLE IF NOT EXISTS`）

```sql
-- 语音合成的结果：按内容复用，所有用户共用（PRD F3「同一句话只合成一次」）
CREATE TABLE IF NOT EXISTS tts_audio (
  key TEXT PRIMARY KEY,            -- audioKey(text)，见 §3.1
  text TEXT NOT NULL,
  model TEXT NOT NULL, voice TEXT NOT NULL,
  file_path TEXT NOT NULL,         -- 相对数据目录：tts/<key>.wav
  mime TEXT NOT NULL,              -- 百炼返回什么就记什么，目前是 audio/wav
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 墨墨的 file.id 属于上传它的墨墨账号，所以按用户分别记录
CREATE TABLE IF NOT EXISTS markji_media (
  user_id TEXT NOT NULL,
  audio_key TEXT NOT NULL,
  file_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, audio_key)
);
```

- **音频文件位置**：数据库文件所在目录下的 `tts/`。本机是 `data/tts/`，服务器是 `/var/lib/readflow/data/tts/`。路径从 `DB_PATH` 推出来，这样测试用隔离库时音频也落在临时目录里。
- `docs/DATABASE.md` 同步加上这两张表、`tts/` 目录和 §1.2 的设置项。

### 1.2 站级设置
| 键 | 默认 | 含义 |
|---|---|---|
| `cards.audio` | `on` | 卡片句子配音（PRD F4）。只有开关打开**并且**拿得到百炼 Key 时，新生成的卡才带音频 |

- 加进 `SETTINGS_KEYS`（`src/lib/config.ts`），名字是 `cardsAudio`。
- 加进 `src/lib/cards/flags.ts`：`sentenceAudioEnabled(siteSettings)`。
- P33 的 `cards.listening` 保持不变，和本期互不影响。

---

## 2. 题型与 CardSpec（`src/lib/cards/spec.ts`、`labels.ts`）

### 2.1 新增四种 kind
| kind | 标签（`KIND_LABELS`） | 类别 |
|---|---|---|
| `back_translate` | 🔁 回译 | 使用类 |
| `situation_say` | 💬 情景说一句 | 使用类 |
| `rephrase` | 🔀 换个说法 | 使用类 |
| `usage` | 🧩 搭配与用法 | 使用类 |

- `spec.ts` 导出 `PRODUCTIVE_KINDS: ReadonlySet<CardKind>`，就是上面四个。其余 kind 都算认识类。
- P33 的 `collocation`（🧩 搭配）和新的 `usage` 用同一个 emoji，标签文字不同，可以接受。`paraphrase_fill`（🔄 改写填空）和 `rephrase`（🔀）用不同的 emoji，免得两者混淆。
- **不新增 Block 类型**。各题型用现有块组合：

| kind | front | hints | back.answer | 其它 |
|---|---|---|---|---|
| `back_translate` | `text`（原句的中文意思）+ `instruction`（「用英文说出这句话」） | 可选：`text`（目标词或短语） | `sentence`（source=original，mark=highlight 目标词） | `explanation` 可选 |
| `situation_say` | `text`（中文场景）+ `instruction`（「用 X 说一句」） | — | 2～3 组：`sentence`（source=paraphrase，包含目标词）+ `text`（中文） | — |
| `rephrase` | `sentence`（source=paraphrase，不含目标词）+ `instruction`（「用 X 改写这句话」） | — | `sentence`（source=paraphrase，包含目标词） | `explanation` 可选：原句对照 |
| `usage` | `sentence`（source=original，mark=highlight）+ `instruction` | — | 2～3 组：`text`（搭配，如 *fall behind on sth*）+ `sentence`（source=paraphrase 短例句）+ `text`（中文） | `explanation` 可选：一句易错点 |

### 2.2 张数
- **张数由 AI 决定**（PRD F2，用户 2026-11-16 决定），产品上不设固定数量。
- `parseCardGen` 去掉「1～3 张」的限制，只保留：
  - 至少 1 张；
  - 防异常的保险上限 `CARDS_SAFETY_MAX = 8`（写在 `spec.ts`）。它只用来挡住模型输出异常（比如同一张卡重复十几遍），不是产品规则，提示词里**不提**这个数。超出时保留前 8 张，记一条日志。

---

## 3. 句子音频的纯函数（`src/lib/cards/audio.ts`，新文件，纯函数）

### 3.1 键与取句
- `normalizeAudioText(text)`：去掉首尾空白，把连续空白合成一个空格。
- `audioKey(text, voice: { model; voice })`：`sha256(normalizeAudioText(text) + "\n" + model + "\n" + voice)` 取前 32 个十六进制字符。
- `audioTextsOf(spec): string[]`：取**背面**所有英文句子，去重，保持出现顺序：
  - `back.answer`、`back.explanation` 里的所有 `sentence` 块；
  - `back.example.en`。
  - 正面和提示层的句子**不取**（PRD 原则 6：正面不放音频，免得读出答案）。
  - 超过 `AUDIO_TEXT_MAX = 400` 个字符的句子跳过（百炼单次上限是 600 个字符，留出余量）。

### 3.2 占位符与替换
- 草稿里的写法：`[Audio#M,ID/@AUDIO:<key>@#]`。显示文字为空，第二个 `#` 必须保留（`card-syntax.md` §8.2）。
- `audioPlaceholderKeys(content): string[]`：从渲染结果里找出所有 key。正则是 `/@AUDIO:([0-9a-f]{32})@/g`。
- `fillAudioIds(content, ids: Record<key, fileId | null>): string`：
  - 有 fileId 的，把 `@AUDIO:<key>@` 替换成 fileId；
  - 值为 null 的，把整个 `[Audio#M,ID/@AUDIO:<key>@#]` 连同它前面的一个空格一起删掉。
  - 必须用 `split` / `join` 或回调函数替换，**不能**把 fileId 拼进正则或模板字符串。墨墨语法里到处是方括号和 `#`，`$` 也可能出现在 id 里。
- `lintCard` 要接受草稿里的占位符，也要接受替换后的内容。单测要覆盖这两种情况。

---

## 4. 出题（`prompt.ts`、`style.ts`、`generate.ts`）

### 4.1 提示词（`buildCardPrompt`）
`CardPromptInput` 新增一个字段：`examFamily: ExamFamily | null`。

- **PARTS**：在 P33 原有零件基础上补一句：「背面的英文句子系统会自动配上音频，你不用写音频块」。
- **PRINCIPLES**，按 PRD §5 改写：
  - 第 2 条改为：「每张卡只练一个词或短语。认识类卡只考一个能判断对错的点；使用类卡（回译、情景说一句、换个说法、搭配与用法）背面给参考说法，学生自己对照。」
  - 第 3 条改为：「正面不泄露答案。认识类卡的题干不能出现目标词的中文意思；使用类卡的正面可以出现目标词和整句的中文意思，但不能出现背面的英文参考说法。」
  - 其它各条照旧。
- **MENU**，分成三段：
  1. **默认题型（使用类）**：四种题型各写一行，把 §2.1 的结构用中文写给模型。
  2. **认识类**：语境理解、分层提示。只用于「只需要认识、不太会主动用」的词。
  3. **考试题型**：P33 原有的菜单。**只在 `examFamily` 不为 null 时出现**。
- **组卡规则**，逐条写给模型（PRD F2）：
  - 出几张由你按这个词决定：难的、用法多的可以多出几张，简单的一张就够；至少 1 张是使用类卡。
  - 回译适合大多数词；原句超过 35 个词或者结构太复杂时，换成情景说一句。
  - 情景说一句更适合口语里常用的词，换个说法更适合偏书面的词；用法丰富的词两种都可以出。
  - 搭配与用法只给搭配特征明显的词。
  - 有考试目标的，最后加一张考试风格的卡。
- **观察**：「已经做过卡又查到」那一行改成：「优先出情景说一句或换个说法，不要重复上一次的题型」。
- **JSON_FORMAT**：kind 枚举加上四个新值，最后一行改成「返回 `{ "cards": CardSpec[] }`，张数由你决定」。

### 4.2 `style.ts`
- `stylePromptLines` 改写：
  - **有考试目标**：「最后一张出 X 风格的考试题，题目指令的措辞和选项的设计向真实考试靠拢」。
  - **没有考试目标**：不再写「以托福和雅思的风格为主」，改成「不出考试题型」。
  - 「读英文吃力 / 基本无障碍」两条保留，并加一句：吃力的学生，情景说一句的场景和参考说法要用简单的词，参考说法不超过 12 个词。
- `examStyleLabel` 不改：`KIND_QUESTION` 里没有新 kind，所以使用类卡永远不带考试风格标签。

### 4.3 `generate.ts`
1. 读站级设置和问卷，算出 `examFamily`，以及 `audioOn = sentenceAudioEnabled(site) && ttsKeyAvailable()`。
2. 照旧调用 `completeJson`（不设上限）→ `parseCardGen` → 逐张 `validateCard`，不通过的走原有的 `redo`。
3. **组卡检查**（新增纯函数 `checkComposition(cards, examFamily)`，单测）：
   - 不按张数裁剪。
   - 有考试目标但一张认识类卡都没有时，只记日志，不重出、不失败。
   - 一张使用类卡都没有时，整组 `redo` 一次，原因写「至少要有一张使用类卡」。仍然没有就照常保存，不让整组失败。
4. 渲染时传 `renderCard(spec, { …, audio: audioOn ? VOICE : null })`，让占位符随渲染结果一起写进 `cards.content`。
5. **合成音频**：所有卡入库以后、把这组标成 `ready` 之前，对这组所有卡的 `audioTextsOf` 去重后调用 `ensureAudio`（§5.2）。
   - 并发 3 个，整组最多等 `AUDIO_BUDGET_MS = 45_000`。
   - 超时或失败都不影响这组变成 `ready`；超时的那部分在后台继续合成。
6. 「换一道」和 PATCH 修改：重新渲染以后，把新句子丢给 `ensureAudio` 在后台合成，不等结果。预览时如果还没合成好，会在播放时按需合成（§6）。

---

## 5. 语音合成（`src/lib/tts.ts`、`src/lib/cards/voices.ts`）

### 5.1 接口（2026-11-16 查阅百炼文档）
- `POST {base}/api/v1/services/aigc/multimodal-generation/generation`
  - `base` 默认是 `https://dashscope.aliyuncs.com`（北京地域）。环境变量 `READFLOW_TTS_BASE_URL` 可以覆盖，测试时指向假服务。
  - 请求头：`Authorization: Bearer <key>`、`Content-Type: application/json`。非流式请求**不带** `X-DashScope-SSE`。
  - 请求体：`{ "model": "qwen3-tts-flash", "input": { "text": "...", "voice": "<音色>", "language_type": "English" } }`
- 响应：`output.audio.url` 是完整音频的下载地址（wav），24 小时内有效。拿到以后**立即下载**到本地，不保存这个 URL。
  - `output.audio.expires_at` 和 `usage.characters` 记进日志，方便核对成本。
- 单次文本不超过 600 个字符。
- **Key**：先读环境变量 `DASHSCOPE_API_KEY`；没有的话，读站级设置里「通义千问 / 阿里云百炼」那一栏的 Key（和 `src/lib/config.ts` 里 qwen 的 `envKey` 是同一个 Key）。
  - 两个都没有时，`ttsKeyAvailable()` 返回 false，新卡不带音频。
  - 北京地域和新加坡地域的 Key 不通用。设置页说明里写明要用**北京地域**的 Key。
- **音色**：`voices.ts` 导出 `VOICE = { model: "qwen3-tts-flash", voice: "Cherry" }`。
  - 实现时先查百炼「系统音色列表」，在 Cherry、Ethan 等支持英文的音色里各用 3 句测试句听一遍，选出美式发音最自然的一个，写进 `voices.ts`。
  - 提交说明里写明最终用的模型和音色。
- **格式**：百炼返回 wav（24kHz、16 位、单声道，约 48KB/秒）。
  - 墨墨是否接受 wav，在上线前实测（§10 第 1 条）。
  - 如果不接受，改用 CosyVoice 的 HTTP 接口，指定 `format: "mp3"`。CosyVoice 同样只在北京地域。这一步只改 `tts.ts` 和 `voices.ts`，其它代码不受影响。

### 5.2 `ensureAudio(text): Promise<{ key; filePath; mime } | null>`
1. 算出 key；`tts_audio` 里已经有记录、文件也在，就直接返回。
2. 同一进程里，同一个 key 同时只能有一个合成任务在跑：用 `Map<key, Promise>` 合并并发请求。
3. 全局最多同时发 3 个合成请求。
4. 合成请求和下载请求各自超时 20 秒。按 `isRetryableError` 判断（429、5xx、网络错误）重试 1 次。
5. 先写到 `tts/<key>.wav.tmp`，再 rename 成正式文件名，然后写 `tts_audio`。
6. 失败返回 null，并记日志 `[tts] 合成失败 {key, status, reason}`。日志里不打印 Key，也不打印句子全文，只打印前 40 个字符。

---

## 6. 预览接口 `GET /api/tts/[key]`
- `currentUser()`；没有登录返回 401。
- key 必须匹配 `/^[0-9a-f]{32}$/`，否则返回 404。
- **只返回本人卡片里用到的音频**：`SELECT spec FROM cards WHERE user_id = ? AND content LIKE ?`，第二个参数是 `%@AUDIO:<key>@%`。一行都没有就返回 404。key 已经过十六进制校验，不会出现 LIKE 注入。
  - 因此 pusher **不改写** `cards.content` 里的占位符（§7），替换后的版本只发给墨墨。
- 有文件就直接返回。没有文件的话，从这几张卡的 `audioTextsOf(spec)` 里找出对应的句子，调用 `ensureAudio` 现场合成。
  - 合成失败返回 503，`{ error: "音频暂时没生成" }`。
- 响应头：`Content-Type` 用 `tts_audio.mime`，`Cache-Control: private, max-age=86400`。

---

## 7. 推送（`src/lib/cards/pusher.ts`、`src/lib/markji.ts`）
- `markji.ts` 新增 `uploadFile(deckId, bytes, filename, mime, token)`：
  - 用 `FormData` 发出两个字段：`file`（`Blob`，文件名 `<key>.wav`）和 `deck_id`。
  - 返回 `file.id`。
- pusher 删掉「内容里有 `@AUDIO:` 就判这张卡失败」的逻辑，换成：
  1. `audioPlaceholderKeys(card.content)` 取出这张卡的所有 key。
  2. 对每个 key：
     - 先查 `markji_media(user_id, key)`，有记录就直接用；
     - 没有记录：先 `ensureAudio`（本地没有文件就再合成一次），然后经过 `paced()` 调用 `uploadFile`，再写入 `markji_media`；
     - 合成失败、或者上传返回 4xx：这个 key 记为 null。
     - 上传遇到 429 或 5xx：沿用 P33 的退避重试。
  3. 用 `fillAudioIds` 生成要推送的内容，`lintCard` 再检查一遍，然后 `createCard`。
  4. 这张卡有任何一个 key 是 null，就把它计入任务的 `audio_missing`。
- **不重复建卡**的认领逻辑按内容比对，所以比对时要用替换以后的内容。同一个音频的 `file.id` 不会变（墨墨按内容去重，`markji_media` 也有记录），重启以后替换出来的内容和上次一样。
- `push_jobs` 新增一列 `audio_missing INTEGER NOT NULL DEFAULT 0`。`GET /api/cards/push/:jobId` 的返回里加上 `audioMissing`。
- 上传 `POST /files` 计入限速器（10 秒 20 次、60 秒 40 次）。P33 的「每天 600 条」只按建卡计数，上传不计入。

---

## 8. 前端（界面规格；视觉规则见 §9）

### 8.1 卡片预览 `src/components/CardPreview.tsx`
- `PreviewModel` 的每一行新增 `audioKey?: string`，`back.example` 新增 `audioKey?: string`。由 `renderPreview` 按 §3.1 的规则填写；音频关闭时不填。
- 新组件 `src/components/AudioButton.tsx`：
  - 一个 32×32 的图标按钮，放在英文句子**之后**，和句子同一行（行内）。
  - `aria-label="播放：<句子前 30 个字>"`；正在播放时 `aria-pressed="true"`。
  - 四种状态：
    | 状态 | 外观 |
    |---|---|
    | 待播放 | ▶ |
    | 加载中 | 12px 转圈，`aria-busy="true"` |
    | 播放中 | ■（再点一下停止） |
    | 失败 | ⊘，按钮禁用，`title="音频暂时没生成"` |
  - 同一时间只播放一段：模块级保存当前的 `HTMLAudioElement`，播放新的之前先停掉旧的。
  - 音频地址是 `/api/tts/<key>`，第一次点击时才请求，不预加载。
- **使用类卡的背面**：
  - 分区标题用 `SECTIONS.reference = "🗣 参考说法"`，代替「✅ 答案」。
  - 分区第一行是固定的一行说明，用次要灰色：
    - 有 AI 补充的句子时：「AI 补充 · 说法不唯一：意思对、用上了目标词，就算说对了」；
    - 只有原句时：「说法不唯一：意思对、用上了目标词，就算说对了」。
  - 这一节里的 paraphrase 句子**不再逐句**加「（AI 补充）」，由上面这行统一说明。墨墨渲染（`render.ts`）也按同样的规则处理。

### 8.2 墨墨里的卡面（`render.ts`）
- `RenderOpts` 新增 `audio?: { model: string; voice: string } | null`。
- 背面每个英文 `sentence` 块渲染完以后，在**同一行**末尾追加 ` [Audio#M,ID/@AUDIO:<key>@#]`；`back.example.en` 同样处理。正面和提示层一律不加。
- 使用类卡的 answer 分区标题和说明行按 §8.1 处理。
- 回译的正面：中文段落 + 灰色题目指令。提示层：目标词（`[T#B#…]` 加粗）。
- 渲染出来的内容必须能通过 `lintCard`，字数上限照旧（1800 / 4000）。音频标签也算字数，单测要覆盖「3 句参考说法加 3 个音频标签，仍在 1800 以内」。

### 8.3 待推送 `src/components/PendingCards.tsx`
- 推送完成时，`audioMissing > 0` 的话，在原来的结果提示下面加一行：「有 N 张卡没配上音频」（次要灰色，没有按钮）。

### 8.4 设置 → 模型 `src/components/SettingsDialog.tsx`（只有站长能看到）
- 在「做卡」开关下面加一行同样形态的开关「卡片句子配音」（`.st-reading-row` + `.st-switch`）。
- 说明文字（`<span>`）按状态显示 PRD F4 的两种文案：
  - 有 Key：「用阿里云百炼合成，Key 和『通义千问』那一栏共用（北京地域）」；
  - 没有 Key：「还没有填阿里云百炼的 Key，卡片会先不带音频」。
- `GET /api/settings` 增加两个字段：`cardsAudio: "on" | "off"`、`ttsKeyReady: boolean`。`PUT` 接受 `cardsAudio`。
- 「做卡」关闭时，这一行开关禁用，`aria-disabled`。

---

## 9. 界面设计简报与验收（`non-designer-frontend` 规范）

本期改动三处界面，都是既有页面里的局部组件，不新增页面、弹窗或提示条：
- **U1**：卡片预览背面的播放按钮，以及「🗣 参考说法」分区（`CardPreview` + `AudioButton`）；
- **U2**：设置 → 模型的「卡片句子配音」开关行；
- **U3**：待推送结果下方的「有 N 张卡没配上音频」。

### 9.1 中心点（C-02 / TIP-03 / PR-01）
- 卡片预览背面的中心点是**英文参考句**。播放按钮是句子的附属操作：图标用次要灰，不使用绿色或紫色，没有边框和阴影，视觉权重低于句子（C-06）。
- 「🗣 参考说法」的说明行是附属信息，权重低于句子：字号小一级，次要灰。
- 设置页和待推送沿用现有的中心点，U2、U3 都不抢焦点。

### 9.2 分组 · 亲密性（P-01 ~ P-11）

| 组 | 成员 | 组内间距 | 与相邻组的间距 |
|---|---|---|---|
| 一句参考说法 | 英文句 + ▶ / 中文意思 | 句子与 ▶ 之间 `--rf-space-1`（4px）；英文与中文之间 `--rf-space-1`（4px） | 句与句之间 `--rf-space-3`（12px） |
| 参考说法分区 | 分区标题 / 说明行 / 各句 | 标题与说明行之间 `--rf-space-1`（4px） | 与上一分区之间 沿用 `.cp-title` 的 8px |
| U2 | 标题 / 说明 / 开关 | 沿用 `.st-reading-row` | 沿用 |
| U3 | 推送结果 / 音频缺失说明 | `--rf-space-1`（4px） | 沿用 |

- ▶ 紧贴它要读的那句英文（P-01、P-04），不集中放到卡片底部：每句一个按钮，按钮和句子一一对应。
- 一句英文和它的中文是一组，句与句之间的间距（12px）明显大于组内（4px）（P-05）。
- 不新增边框、底色块，也不在框里再套框（P-10、TIP-15）。
- 视线路径：分区标题 → 说明行 → 第一句英文 → ▶ → 中文 → 下一句。DOM 顺序和视觉顺序一致（P-09）；Tab 键顺序也按这个走。

### 9.3 对齐（A-01 ~ A-11）
- 唯一主对齐线：卡片预览内容区的**左边缘**。标签行、正文各行、分区标题、说明行都左对齐到这条线。
- ▶ 不单独占一列，也不右对齐，跟在句末，避免出现第二条竖向对齐线（A-03）。
- 中文意思不缩进，和英文句子左对齐在同一条线上（A-06）。
- 唯一的文本对齐方式是**左对齐**。不用居中、两端对齐和绝对定位（A-01、A-04、A-05、A-07）。

### 9.4 重复（R-01 ~ R-09）
- **加强已有重复**：
  - 分区标题沿用 `.cp-title`，emoji + 文字的形态和「✅ 答案」「💡 解析」一致。
  - 说明行沿用 `.cp-ai` 的次要说明样式，和「（AI 补充）」同一个形态。
  - U2 完全复用 `.st-reading-row` + `.st-switch`，和上面的「做卡」「个性化讲解」行一模一样。
  - U3 复用待推送现有的结果说明样式。
  - 转圈沿用 P33 做卡按钮的 12px 转圈。
  - 焦点环沿用全站的 `:focus-visible`。
- **新增重复元素**：▶ 播放按钮。在一张卡里会出现多次，所以每一个的尺寸、颜色、位置（句末、间距 4px）都必须完全一样，靠重复建立「每句英文都能听」的规律（R-03）。

### 9.5 对比（C-01 ~ C-09 / TX-01 ~ TX-11）

| 相邻元素 | 字号 | 对比维度 |
|---|---|---|
| 英文参考句 vs 中文意思 | 16 / 14 | 大小（`--rf-text-md` vs `--rf-text-sm`）+ 颜色（主文字色 vs 次要灰） |
| 分区标题 vs 说明行 | 14 / 12 | 字重（800 vs 400）+ 颜色（主文字色 vs 次要灰） |
| ▶ 待播放 vs 播放中 | — | 形状（▶ vs ■）+ `aria-pressed`；播放中图标改用主文字色 |
| ▶ vs 英文句子 | 图标 14px / 16px | 颜色（次要灰 vs 主文字色）+ 结构（图标 vs 文字） |

- 不新增分隔线（C-09）。
- 不出现 12 / 14 / 16 以外的新字号。

### 9.6 配色关系（COL-01 ~ COL-13）
- 沿用项目固定的调色板（COL-13），本期**不新增任何颜色**。
- 配色关系：**互补**。主色黄绿（`--rf-green-*`，用于品牌、主操作和成功）和紫色（`--rf-purple-*`，用于 AI 产出）大致在色轮两端，大面积用中性灰白。
  - ▶ 是普通操作，用中性灰，不用绿（绿色只给主操作）。
  - 也不用紫：音频是系统生成的，不是 AI 的判断。
- 对比度（COL-08，正文 ≥ 4.5:1；图标按非文字元素 ≥ 3:1）：沿用 P34 的实测值（2026-11-14）。令牌变了要重测。

| 前景 | 背景 | 对比度 |
|---|---|---|
| `--rf-text-secondary` #6b6b6b（▶、说明行、中文意思） | 白 #ffffff | 5.33 : 1 |
| `--rf-text-secondary` #6b6b6b | `--rf-bg-hover` #f7f7f7（▶ 悬停底色） | 4.97 : 1 |
| `--rf-text-primary` #3c3c3c（■ 播放中） | 白 #ffffff | 10.30 : 1 以上 |

- 失败状态不靠变淡来表达：图标仍用次要灰（5.33 : 1），形状换成 ⊘，并且按钮禁用、带 `title`。不得用透明度把对比度降到 3:1 以下。
- 暖色面积：本期没有用到暖色（COL-09 满足）。

### 9.7 字体（TC / TF / TX / T）
- 字族：沿用项目唯一的正文字族 `--rf-font-sans`（DM Sans + 苹方，六类中的**无衬线体**），不新增字族。单一字族属于「协调」方案（TF-01），层级靠大小、字重、颜色建立（§9.5）。
- ▶ 和 ■ 用 Unicode 字符或内联 SVG，不引入图标字体。
- 排版细节：
  - 中文用全角标点和「」引号；
  - 英文参考句保留英文标点和弯引号（’ 而不是 '），由提示词要求，校验不强制（T-02）；
  - 不加下划线（T-06）；不用全大写（T-05）；
  - 说明行加 `text-wrap: pretty`（T-08）。

### 9.8 媒介与状态
- **窄屏（390px）**：英文句子较长时自然换行，▶ 跟在最后一个词后面。▶ 不能单独掉到下一行开头：最后一个词和 ▶ 之间用不换行的空格，或者把它们包在 `white-space: nowrap` 的 span 里。整页不能有横向滚动。
- **触控**：▶ 的可点区域是 32×32。项目在 390px 下的其它小按钮也是 32px，保持一致（例外 E-07）。
- **状态**：四种状态见 §8.1。加载中显示转圈；`prefers-reduced-motion: reduce` 时转圈不旋转，换成静态的「…」。
- **键盘**：Tab 能逐个聚焦 ▶，空格或回车播放 / 停止，焦点环清晰可见。
- **深色模式、打印**：产品没有（例外 E-05）。
- 「言之有理」（PR-03）：不加「点击收听」之类的文字，▶ 本身就说明可以听。说明行只写一次，不在每句后面重复。

### 9.9 例外登记表

| 编号 | 被覆盖的规则 | 类别 | 原因 | 补偿手段 |
|---|---|---|---|---|
| E-01 | TX-02、TC-04（字重覆盖 300–900）、验收 G12 | 用户既有设计系统 | `docs/design-system.md` 只允许 400 / 600 / 700 / 800 | 本期只用 400 和 800，并始终叠加颜色维度 |
| E-02 | C-01、TX-01（相邻字号比 ≥ 1.5） | 用户既有设计系统 | 项目字号阶梯是 12 / 14 / 16 / 18 / 20 / 24 / 32，相邻两级之比小于 1.5 | 英文 16 对中文 14、标题 14 对说明 12，都叠加颜色或字重 |
| E-03 | COL-10（硬编码颜色） | 用户既有设计系统（检查器误报） | `tokens.css` 是调色板的唯一来源 | 本期的界面文件不出现任何颜色值 |
| E-04 | 现有文件里原本就有的 HARD 项 | 用户要求（本期范围限定） | 本期之前就存在 | 本期不新增任何一项（§9.10 前后对比） |
| E-05 | 验收 F8（深色模式）、F9 / TIP-04（打印） | 媒介映射 | 产品没有深色模式和打印样式 | 不适用 |
| E-06 | 墨墨卡面的版式 | 媒介映射 | 墨墨里的卡面由墨墨渲染，ReadFlow 只能控制标签和顺序 | §8.2 保证结构与预览一致：同样的分区、同样的说明行、每句一个播放按钮 |
| E-07 | 平台触控目标 44px 的建议 | 用户既有设计系统 | 项目里的小按钮统一是 32px | 32px 的点击区域，按钮之间至少隔一个词，不会误触 |

### 9.10 自动检查的范围与做法
- 本期新增的样式全部写进**新文件** `src/styles/p35-cards.css`，在 `globals.css` 顶部紧跟 tokens 之后 `@import`（和 `p34-feedback.css` 一样）。`globals.css` 不新增规则。
- 检查范围：`src/styles/p35-cards.css`、`src/components/AudioButton.tsx`。先复制到一个临时目录，再运行 `python3 <技能目录>/scripts/check_design.py <临时目录>`，要求 **`HARD = 0`**。`REVIEW` 项逐条在 `docs/design/P35-DESIGN.md` 里写结论。
- 改动的既有文件 `CardPreview.tsx`、`PendingCards.tsx`、`SettingsDialog.tsx`：改动前后各跑一次检查，**HARD 的数量不得增加**。两次结果都附在 `docs/design/P35-DESIGN.md`。
- `npm test` 里的 `check-tokens.mjs` 必须通过。

### 9.11 人工验收
交付时在 `docs/design/P35-DESIGN.md` 里：
1. 附上 §9.1–§9.8 的简报，写明实际取值。
2. 逐行填写技能 `references/acceptance-checklist.md` 的 A–K 全部行（通过 / 不通过 / 例外 E-xx），重点检查：
   - 眯眼测试：卡片背面的视觉停顿点不超过 5 个（P-03）。三句参考说法加三个 ▶，▶ 不能比句子更显眼。
   - 在 1440px 和 390px 的截图上画出预览内容区的左边缘对齐线，标题、说明、英文、中文都落在线上（A-03、A-09）。
   - 一张卡里所有 ▶ 的尺寸、位置、颜色完全一致（R-03）。
   - 390px 下没有 ▶ 单独掉到行首的情况。
3. 截图（隔离库 + 假模型 + 假百炼），放在 `.verify/p35/`：
   - `preview-back-translate-{1440,390}.png`：正面、提示层、背面各一张；
   - `preview-situation-{1440,390}.png`、`preview-usage-{1440,390}.png`；
   - `preview-audio-states-1440.png`：同一张卡里同时出现待播放、播放中、失败三种状态；
   - `settings-audio-{on-key,no-key}-{1440,390}.png`；
   - `push-audio-missing-{1440,390}.png`。
4. 附上例外登记表（§9.9）；有新增的例外，按同样的格式登记。

> 实现后的实际取值与本节的差异（标题→说明行 8px、减少动效时转圈停住、U3 间距 8px、截图拆分、▶ 用负外边距不撑高行距等）记在 `docs/design/P35-DESIGN.md` §5。

---

## 10. 上线前的检查
1. **墨墨实测**（`scripts/markji-probe.mjs` 只做只读检查；写入测试需要产品负责人同意，在测试牌组里手动做）：
   - 上传一段百炼生成的 wav，确认墨墨能接受。不接受就按 §5.1 改成 CosyVoice 的 mp3。
   - 一张卡里放 3 个 `[Audio#M,ID/…#]`，显示文字为空，确认每个都显示成播放按钮、能单独播放。显示文字为空时如果不显示按钮，就改成「▶」，并同步修改 `render.ts` 和单测。
   - 结论写进 `docs/specs/P35-markji-probe.md`。
2. **成本**：在百炼控制台核对 `qwen3-tts-flash` 当前的单价，按「每天 30 个词 × 约 500 个字符」算出每天的上限成本，写进提交说明。
3. **服务器**：用户自己部署时需要：
   - 在环境变量或站级设置里配置北京地域的百炼 Key；
   - 确认 `/var/lib/readflow/data/tts/` 可写。
   - 本说明不包含任何远程操作。

---

## 11. 测试

### 11.1 单元测试（`tests/unit/`）
| 文件 | 至少覆盖 |
|---|---|
| `cards-spec.test.ts` | 四种新 kind 能解析；1 张、6 张都通过；超过 8 张时只保留前 8 张；0 张不通过；`PRODUCTIVE_KINDS` |
| `cards-compose.test.ts`（新） | `checkComposition`：任何张数都不裁剪；一张使用类卡都没有时要求重出；有考试目标但缺考试卡时只记日志 |
| `cards-validate.test.ts` | §11.2 的每条新规则都有通过和不通过两种用例；老题型的用例全部照旧通过 |
| `cards-audio.test.ts`（新） | `audioKey` 稳定（空白不同、key 相同；音色不同、key 不同）；`audioTextsOf` 只取背面、去重、跳过超过 400 字符的句子；`audioPlaceholderKeys`；`fillAudioIds` 的替换、删除，以及 id 里带 `$` 的情况 |
| `cards-render.test.ts` | 四种新 kind 的标签；参考说法分区和两种说明行；音频标签只出现在背面句子的同一行末尾；音频关闭时没有任何音频标签；渲染结果能通过 `lintCard`；3 句参考说法加 3 个音频标签仍在 1800 字以内 |
| `cards-preview.test.ts` | `renderPreview` 的 `audioKey` 和 `renderCard` 的占位符一一对应 |
| `cards-prompt.test.ts` | 没有考试目标时不出现考试菜单；有考试目标时出现考试菜单和「再加一张考试风格的卡」；提示词里不出现任何固定张数；「已做过卡」的观察行 |
| `tts.test.ts`（新） | 请求体（model、voice、`language_type: "English"`、没有 SSE 头）；从响应里解析 `output.audio.url`；缺少 url 时报错；Key 的读取顺序（环境变量 → 站级设置 → 都没有） |

### 11.2 `validateCard` 新增的规则
1. 使用类卡：正面要有 `sentence` 块或 `text` 块；`back.answer` 至少有一个英文 `sentence` 块。
2. 使用类卡跳过「题干不能出现目标词中文意思」这一条，改为检查：正面和提示层的可见文字里，不能出现 `back.answer` 中任何一句英文（忽略大小写、标点和多余空白后比较）。
3. `back_translate`：answer 里必须有 source=original 的句子；原句不超过 35 个词。
4. `situation_say`、`usage`：answer 里有 2～3 句英文。
5. `situation_say`、`rephrase`：answer 里每一句英文都要包含目标词或它的词形变化（复用 `sameWord`）。
6. `rephrase`：正面的英文句子**不能**包含目标词，而且不能和 answer 里的句子相同。

### 11.3 端到端
- **假百炼**：在 `scripts/e2e-cards.mjs` 里加一个本地服务。
  - `POST /api/v1/services/aigc/multimodal-generation/generation` 返回指向自己 `/audio/<n>.wav` 的 url；
  - `/audio/*` 返回一个固定的、44 字节的 wav 文件头；
  - 用 `ttsMode` 切换 `ok` / `fail` / `slow`。
  - 构建和启动服务时设置 `READFLOW_TTS_BASE_URL` 和 `DASHSCOPE_API_KEY=fake`。
- **假墨墨**：在现有的 `mjFake` 里加上 `POST /files`。按内容哈希返回 `mkjf_<hash前8位>`，并记录收到的上传次数。
- 新增断言（编号接在现有的后面）：
  - **A1**：生成一组卡后，`cards.content` 里有 `@AUDIO:` 占位符，假百炼收到的请求数等于去重后的句子数。
  - **A2**：本人请求 `GET /api/tts/<key>` 返回 200 和 wav；朋友请求同一个 key 返回 404；不合法的 key 返回 404。
  - **A3**：推送以后，假墨墨收到的卡片内容里有 `[Audio#M,ID/mkjf_`，没有 `@AUDIO`；同一句话第二次推送不会再上传。
  - **A4**：`ttsMode = fail` 时，这组卡照常变成 ready；推送成功，内容里没有音频标签，`audioMissing` 等于卡片张数。
  - **A5**：`cards.audio = off` 时，新卡里没有占位符，假百炼收不到任何请求。
  - **A6**：问卷里有考试目标的用户，出题提示词里有考试菜单；没有考试目标的用户，提示词里没有考试菜单。
- `e2e-cards-ui.mjs`：
  - 预览背面每句英文后面都有 ▶；点击后 `aria-pressed="true"`；
  - 失败的那一句按钮禁用；
  - 设置页开关的两种说明文案；
  - 按 §9.11 截图。

---

## 12. 实施顺序
1. 先在 worktree 里截下「改前」的预览截图，存到 `.verify/p35/before/`。
2. `spec.ts` / `labels.ts` / `audio.ts` 和单测。
3. `validate.ts`、`render.ts`、`prompt.ts`、`style.ts` 和单测，跑 `npm test`。
4. 两张表的迁移、`tts.ts`、`voices.ts`、`ensureAudio`、`GET /api/tts/[key]`。
5. `generate.ts`（组卡检查、合成音频）、`pusher.ts`、`markji.ts` 的 `uploadFile`。
6. 前端：`AudioButton`、`CardPreview`、`PendingCards`、`SettingsDialog`、`p35-cards.css`。
7. 端到端测试、覆盖率、设计检查、截图，写 `docs/design/P35-DESIGN.md`。
8. 按 §10 第 1 条做墨墨实测（需要产品负责人同意），把结论写进 `docs/specs/P35-markji-probe.md`。
9. 提交到功能分支。是否合并、推送、重启本地服务，由用户决定。
