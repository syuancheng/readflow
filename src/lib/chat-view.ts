/**
 * 右栏对话流的展示判断（P44）。纯函数，只用相对路径 import。
 * 把「什么时候显示什么」从组件里拿出来，单测直接覆盖。
 */
import { splitCardSuggestion } from "./cards/suggestion";
import { isNotAGloss } from "./explain-policy";

/** 判断用到的一轮对话的最小字段 */
export type TurnLite = {
  /** 用户这次问的是什么；首次讲解没有 */
  ask?: string;
  text: string;
  status: "loading" | "streaming" | "done" | "error";
  answerId?: string;
};

/** 反馈（太浅 / 刚好 / 太深）只给首次讲解：目的是让 AI 第一次就讲对，追问本身就是信号 */
export function showFeedback(turn: TurnLite, feedbackEnabled: boolean): boolean {
  return (
    feedbackEnabled &&
    !turn.ask &&
    turn.status === "done" &&
    !isNotAGloss(turn.text) &&
    Boolean(turn.answerId)
  );
}

/**
 * 制卡建议显示在哪条回答的末尾：只看**最近一条完成的回答**，它带建议才显示。
 * 建议属于那条回答，不会跨回答漂移到别的回答下面。没有返回 -1。
 */
export function suggestionHolderIndex(turns: readonly TurnLite[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.status !== "done" || isNotAGloss(t.text)) continue;
    return splitCardSuggestion(t.text).suggestion !== null ? i : -1;
  }
  return -1;
}

export type CardStatus = "none" | "generating" | "ready" | "failed" | "pushed";

/** 对话流里要不要画「做成卡片」的状态块 */
export function cardBlockVisible(status: CardStatus): boolean {
  return status !== "none";
}

/** 快捷项「做成卡片」：没开始时显示；进行中显示但置灰；其余（做好 / 失败 / 已推送）由状态块负责 */
export function cardPresetState(status: CardStatus): "hidden" | "enabled" | "disabled" {
  if (status === "none") return "enabled";
  if (status === "generating") return "disabled";
  return "hidden";
}

/** 建议行里的「做成卡片」：还没开始或失败（可重试）时才有意义 */
export function suggestionActionable(status: CardStatus): boolean {
  return status === "none" || status === "failed";
}

/**
 * 做卡进度的估算：服务端只有「生成中」，百分比按已等待秒数给，最高 95%，
 * 真正完成由状态切换收尾。预计剩余按 45 秒总时长估。
 */
export function cardProgress(elapsedSec: number): { pct: number; eta: number } {
  const t = Math.max(0, elapsedSec);
  return { pct: Math.min(95, Math.round(100 * (1 - Math.exp(-t / 20)))), eta: Math.max(0, 45 - t) };
}

/** 用户是不是停在对话底部附近：是才自动滚到最新，往上翻时不抢滚动 */
export function nearBottom(m: { scrollHeight: number; scrollTop: number; clientHeight: number }, slack = 80): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < slack;
}
