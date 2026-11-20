/**
 * 右栏 AI 回答的「对话串」（P26）。
 *
 * 用户在一条记录上可以连续提问（这个词什么意思 → 整句没看懂 → 再给个例句…），
 * 新回答一律追加在下面，词典内容和之前的回答都不覆盖。整串存进同一条
 * `contexts.ai_gloss`，回看时原样还原、取消记录时一起删除 —— 不新增表、不改接口。
 *
 * 存储格式：第一段是默认讲解（点词时自动 / 手动触发的那次，没有问题标题）；
 * 之后每一段以一行「【追问】问题」开头。默认讲解缺席时（词典查到、用户直接问了
 * 「整句没看懂」），整串就从「【追问】」开始。
 *
 * 纯函数、无依赖，前后端与单测共用。
 */

/** 一条「回复」（P58）：用户在 AI 回答里划选的原话 + 他针对这段话写的批注（可空） */
export type Reply = { text: string; note?: string };

/** 一次提问最多带几条回复；引用 / 批注的字数上限（前后端、存储共用） */
export const MAX_REPLIES = 5;
export const REPLY_TEXT_MAX_CHARS = 500;
export const REPLY_NOTE_MAX_CHARS = 200;

export type ThreadTurn = {
  /** 用户这次问的是什么；默认讲解为空 */
  ask?: string;
  /** 用户在 AI 回答里划选、这次提问所针对的原文片段（可空）。= replies 的第一条原话，保留给旧调用方 */
  quote?: string;
  /** P58：这次提问带的全部回复（引用 + 批注），按顺序；旧数据里只有单条引用时也会还原成一条 */
  replies?: Reply[];
  text: string;
};

const ASK_LINE = /^【追问】(.*)$/;
const QUOTE_LINE = /^【引用】(.*)$/;
const NOTE_LINE = /^【批注】(.*)$/;
/** 引用片段压成一行存：换行换成空格，避免破坏「一行一标记」的格式 */
const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();

/** 一轮的引用 / 批注行：一条引用 + 可选批注为一组，按顺序；只有一条无批注时与旧格式逐字相同 */
function quoteLines(t: ThreadTurn): string {
  const replies: Reply[] = t.replies?.length ? t.replies : t.quote?.trim() ? [{ text: t.quote }] : [];
  return replies
    .slice(0, MAX_REPLIES)
    .filter((r) => r.text?.trim())
    .map((r) => `【引用】${oneLine(r.text)}\n${r.note?.trim() ? `【批注】${oneLine(r.note)}\n` : ""}`)
    .join("");
}

export function serializeThread(turns: readonly ThreadTurn[]): string {
  return turns
    .filter((t) => t.text.trim())
    .map((t, i) => {
      if (i === 0 && !t.ask) return t.text.trim();
      return `${quoteLines(t)}【追问】${(t.ask ?? "").trim()}\n${t.text.trim()}`;
    })
    .join("\n\n");
}

export function parseThread(raw: string | null | undefined): ThreadTurn[] {
  if (!raw || !raw.trim()) return [];
  const turns: ThreadTurn[] = [];
  let cur: ThreadTurn = { text: "" };
  // 引用 / 批注行一定紧跟在【追问】之前；暂存到下一条追问用（一条引用 + 可选批注为一组）
  let pending: Reply[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const q = line.match(QUOTE_LINE);
    if (q) {
      if (q[1].trim() && pending.length < MAX_REPLIES) pending.push({ text: q[1].trim() });
      continue;
    }
    const n = line.match(NOTE_LINE);
    if (n) {
      // 批注只认紧跟在引用后面的；前面没有引用的孤立批注丢弃
      const last = pending[pending.length - 1];
      if (last && !last.note && n[1].trim()) last.note = n[1].trim();
      continue;
    }
    const m = line.match(ASK_LINE);
    if (m) {
      if (cur.text.trim() || cur.ask !== undefined) turns.push({ ...cur, text: cur.text.trim() });
      cur = { ask: m[1].trim(), text: "" };
      if (pending.length > 0) {
        cur.quote = pending[0].text;
        cur.replies = pending;
        pending = [];
      }
    } else {
      cur.text += (cur.text ? "\n" : "") + line;
    }
  }
  if (cur.text.trim() || cur.ask !== undefined) turns.push({ ...cur, text: cur.text.trim() });
  return turns;
}

/**
 * 默认讲解那一段（第一段且没有问题标题）。行内中文、卡片背面只从这一段取 ——
 * 「整句没看懂」「例句」这类追问的第一行不是这个词的意思。
 */
export function defaultTurnText(raw: string | null | undefined): string {
  const first = parseThread(raw)[0];
  return first && !first.ask ? first.text : "";
}

/**
 * P34 F4：回看时给对话串的每一段对上它保存过的回答（answerId + 反馈）。
 * 对话串仍以批注里的整串为准渲染，不改变回看内容；对每一段按顺序找「去掉首尾空白后文字完全相同」
 * 且还没被占用的回答。对不上的段（改动前的老讲解、或讲解记录已过期删除）不带 answerId。
 */
export function attachAnswers<T extends ThreadTurn>(
  turns: readonly T[],
  answers: readonly { answerId: string; text: string; feedback: string | null; feedbackReason?: string | null }[],
): (T & { answerId?: string; feedback?: string | null; feedbackReason?: string | null })[] {
  const used = new Set<number>();
  return turns.map((t) => {
    const want = t.text.trim();
    const i = answers.findIndex((a, j) => !used.has(j) && a.text.trim() === want);
    if (i < 0) return { ...t };
    used.add(i);
    return { ...t, answerId: answers[i].answerId, feedback: answers[i].feedback, feedbackReason: answers[i].feedbackReason ?? null };
  });
}
