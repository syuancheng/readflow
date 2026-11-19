/**
 * 追问上下文的压缩（P45）。纯函数，只用相对路径 import，前后端和单测共用。
 *
 * 为什么：同一处批注上可以一直追问，每一轮都要把之前的问答带给模型。轮数多了，请求会越来越大；
 * 原来的做法是只留最近 12 轮、每条砍尾，等于最先丢的就是最重要的首次讲解。
 *
 * 怎么压（不额外调用模型）：
 * 1. 钉住：首次讲解（第 1 轮）一直完整保留——它是 AI 最初怎么讲这个词的依据；
 * 2. 近期：最近 3 轮完整保留；
 * 3. 更早：中间的每一轮压成「要点」（学生的问题 + 回答开头的约 300 字）。
 * 按位置压，不是超了预算才压：同一轮一旦变成要点就一直是要点，每次请求的前缀不变，模型缓存还能命中。
 * 总预算只做兜底：超了就先丢最早的要点，再缩短近期几轮，最后才缩短首次讲解。
 * 所有历史回答都先去掉末尾的「制卡建议」行和句子地图行——它们对后面的回答没用，纯属占地方。
 */
import { splitCardSuggestion } from "./cards/suggestion";

export type HistoryTurn = { ask?: string; text: string };

/** 最近几轮完整保留 */
export const HISTORY_RECENT_TURNS = 3;
/** 完整保留时，单条回答的字数上限（超出的从中间截） */
export const HISTORY_FULL_MAX_CHARS = 2000;
/** 压成要点后的字数 */
export const HISTORY_DIGEST_MAX_CHARS = 300;
/** 历史总预算（估算 token，只做兜底） */
export const HISTORY_BUDGET_TOKENS = 6000;
/** 超预算时继续缩短的下限 */
export const HISTORY_RECENT_FLOOR_CHARS = 1200;
export const HISTORY_PINNED_FLOOR_CHARS = 800;
/** 历史里学生问题的字数上限 */
export const HISTORY_ASK_MAX_CHARS = 60;

/** 估算 token：中文约 1.5 个/字，其余约每 4 个字符 1 个。只用来比预算，不求精确 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[　-鿿＀-￯]/.test(ch)) cjk++;
  return Math.ceil(cjk * 1.5 + ([...text].length - cjk) / 4);
}

/** 去掉历史回答里对后面没用的部分：末尾的制卡建议行、句子地图行（含两个以上 == 标记的行） */
export function cleanAnswer(text: string): string {
  const body = splitCardSuggestion(text).body;
  const kept = body.split(/\r?\n/).filter((line) => (line.match(/==/g) ?? []).length < 2);
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || text.trim();
}

/** 超过 max 字就从中间截，保留开头和结尾；结果恰好 max 字 */
export function clipMiddle(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const mark = "…（中间省略）…";
  const room = Math.max(0, max - [...mark].length);
  const head = Math.ceil(room * 0.6);
  return chars.slice(0, head).join("") + mark + chars.slice(chars.length - (room - head)).join("");
}

/** 要点：回答开头（「释义：」那一行加后面的第一段），最多 max 字 */
export function digestOf(text: string, max = HISTORY_DIGEST_MAX_CHARS): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = lines.slice(0, 2).join("\n");
  const chars = [...head];
  return chars.length <= max ? head : chars.slice(0, max - 1).join("") + "…";
}

export type Tier = "pinned" | "full" | "digest" | "dropped";

export type HistoryPlan = {
  /** 每一轮最终是哪一档，和输入一一对应 */
  tiers: Tier[];
  /** 压缩后真正要发给模型的轮次（丢掉的不在里面） */
  turns: HistoryTurn[];
  /** 被整轮丢掉的轮数 */
  omitted: number;
};

/** 要点前缀：让模型知道这条是压缩过的 */
export const DIGEST_PREFIX = "[要点] ";

/**
 * 给一串历史排一个压缩方案。输入必须是已经筛过的、有内容的轮次（进行中 / 出错的不在里面）。
 * 输入少于等于「1 + 最近 3」轮时，所有轮次都是完整的，内容和原来逐字一致（只做清理和超长截断）。
 */
export function planHistory(input: readonly HistoryTurn[], budget = HISTORY_BUDGET_TOKENS): HistoryPlan {
  const n = input.length;
  const cleaned = input.map((t) => cleanAnswer(t.text));
  const tiers: Tier[] = input.map((_, i) => (i === 0 ? "pinned" : i >= n - HISTORY_RECENT_TURNS ? "full" : "digest"));
  const caps = input.map(() => HISTORY_FULL_MAX_CHARS);

  const askOf = (i: number) => input[i].ask?.trim().slice(0, HISTORY_ASK_MAX_CHARS) || undefined;
  const contentOf = (i: number): string =>
    tiers[i] === "digest" ? DIGEST_PREFIX + digestOf(cleaned[i]) : clipMiddle(cleaned[i], caps[i]);
  const cost = () => {
    let sum = 0;
    for (let i = 0; i < n; i++) if (tiers[i] !== "dropped") sum += estimateTokens((askOf(i) ?? "") + contentOf(i));
    return sum;
  };

  while (cost() > budget) {
    const digest = tiers.findIndex((t) => t === "digest");
    if (digest >= 0) {
      tiers[digest] = "dropped"; // 先丢最早的要点
      continue;
    }
    const recent = tiers.findIndex((t, i) => t === "full" && caps[i] > HISTORY_RECENT_FLOOR_CHARS);
    if (recent >= 0) {
      caps[recent] = HISTORY_RECENT_FLOOR_CHARS; // 再缩短最早的近期几轮
      continue;
    }
    if (tiers[0] === "pinned" && caps[0] > HISTORY_PINNED_FLOOR_CHARS) {
      caps[0] = HISTORY_PINNED_FLOOR_CHARS; // 最后才缩短首次讲解
      continue;
    }
    break; // 已经压到底，不再动
  }

  const turns: HistoryTurn[] = [];
  for (let i = 0; i < n; i++) {
    if (tiers[i] === "dropped") continue;
    const ask = askOf(i);
    turns.push({ ...(ask ? { ask } : {}), text: contentOf(i) });
  }
  return { tiers, turns, omitted: tiers.filter((t) => t === "dropped").length };
}

/** 对话里有没有被压缩的轮次（界面据此显示「更早的对话已压缩」） */
export function firstCompressedIndex(tiers: readonly Tier[]): number {
  return tiers.findIndex((t) => t === "digest" || t === "dropped");
}
