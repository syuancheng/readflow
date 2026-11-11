/**
 * 「要不要替学生去问 AI」的策略，以及「这段文本算不算一条真释义」。
 *
 * 单独放一个无依赖的纯函数模块，是因为阅读器（客户端组件）和 API 写入口
 * 必须用同一份判断：词典查不到就自动问老师，但没配模型时服务端吐回来的是
 * 「去哪里配置」的引导文案，不能当成释义写进批注和词库。
 *
 * 这里只做判断，不发请求、不碰 DOM、不读数据库，因此可以直接单测每个边界。
 */

/** 没配置模型时提示文案里的固定识别标记，前端据此判断「这不是释义」 */
export const NO_MODEL_MARKER = "还没有配置 AI 模型";

/**
 * 没配置模型时的统一提示（释义与分段小结共用）。
 * 定义在无依赖模块里，让「服务端吐文案 / 前端识别 / 词库过滤」用同一份字符串，
 * 改文案时不会出现前端认不出、于是把引导文案写进批注的漂移。
 * `lib/ai.ts` 直接 re-export，保持原有导入路径不变。
 */
export const NO_MODEL_NOTICE =
  `⚠️ ${NO_MODEL_MARKER}。\n\n点击右上角头像 → **设置** → 勾选一个模型并填入 API Key；也可以继续用环境变量 \`DEEPSEEK_API_KEY\` 等作为兜底。`;

/**
 * 词典查询**已完成**且未命中时，是否直接开始 AI 释义。
 *
 * 旧逻辑是显示一行「可用 AI 解释」再等用户点按钮。但对短语来说词典必然查不到，
 * 这一次点击只是纯粹的摩擦：用户已经停下来请教了，答案却还要再要点一下才来。
 * 所以成本闸门从「用户多点一次」换成「词典命中率」——词典命中的约 80% 点击
 * 依然一分钱不花，只有词典给不出答案时才自动进第 2 层。
 *
 * 三个例外，都不该替用户发起请求：
 * - `dictHit`：词典已经够用；
 * - `hasInitialGloss`：这条批注存过 AI 释义，回看时原样展示即可；
 * - `fromAnnotation`：点回正文里已存批注的绿色标记，用户只是想看一眼，不是在请教。
 */
export function shouldAutoExplain(input: {
  dictHit: boolean;
  hasInitialGloss: boolean;
  fromAnnotation: boolean;
  /** 同一句里这是第几次请教（含本次）；缺省视为 1 */
  repeatCount?: number;
}): boolean {
  if (input.hasInitialGloss) return false;
  if (input.fromAnnotation) return false;
  // P26：同一句查到第 2 个及以上选区，说明卡的不止一个词 —— 即使词典查得到，
  // 也自动在词典下面追加老师的整句大意 / 句子结构，否则逐级加深永远不会发生。
  if ((input.repeatCount ?? 1) >= 2) return true;
  if (input.dictHit) return false;
  return true;
}

/** 无模型引导 / 报错文案不是释义，不能写进 `contexts.ai_gloss` 或卡片背面。 */
export function isNotAGloss(raw: string | null | undefined): boolean {
  if (!raw) return true;
  return raw.includes(NO_MODEL_MARKER) || raw.includes("[Error:");
}
