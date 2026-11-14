/**
 * P34 F3 / F6：每晚整理老师笔记与旧数据过期的纯函数（时间判断、门槛、截止时间）。
 * 不碰数据库、不发请求。单测把本目录编译成 CommonJS 直接运行，这里只能用相对路径 import。
 */
import { splitCardSuggestion } from "../cards/suggestion";
import { buildNotePrompt, NOTE_SYSTEM_PROMPT, type NotePromptInput } from "./note";
import { formatFeedbackLine, type RecentFeedbackItem } from "./recent-feedback";

/** 每天几点整理（北京时间） */
export const NIGHTLY_HOUR = 3;
/** 自上次整理以来，新的反馈 + 查词 + 讲解合计满几次才整理 */
export const NIGHTLY_MIN_NEW_EVENTS = 10;
/** 讲解记录（含反馈、回答原文）：已整理过的保留 30 天 */
export const EXPLAIN_RETENTION_DAYS = 30;
/** 讲解记录：无论是否整理过，最多保留 90 天 */
export const EXPLAIN_RETENTION_MAX_DAYS = 90;
/** 查词记录：保留 90 天（P32 行为推断的统计窗口） */
export const LOOKUP_RETENTION_DAYS = 90;

const DAY_MS = 24 * 3600 * 1000;

/** 北京时间的日期，如 2026-11-14 */
export function shanghaiDay(now: number): string {
  return new Date(now).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

/** 北京时间的小时 0–23 */
export function shanghaiHour(now: number): number {
  const h = new Date(now).toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" });
  return Number(h) % 24;
}

/**
 * 现在该不该跑每晚整理：北京时间到了 hour 点之后，且今天还没跑过。
 * 也覆盖「凌晨没开机、启动后补做」。
 */
export function nightlyDue(now: number, lastRunDay: string | null, hour: number = NIGHTLY_HOUR): boolean {
  if (shanghaiHour(now) < hour) return false;
  return lastRunDay !== shanghaiDay(now);
}

/** 这个用户今晚要不要整理：个性化开启，且新动静合计够数 */
export function nightlyEligible(input: { personalized: boolean; newEvents: number }, min: number = NIGHTLY_MIN_NEW_EVENTS): boolean {
  return input.personalized && input.newEvents >= min;
}

/** 三个过期截止时间（早于它的记录要删） */
export function retentionCutoffs(now: number): { explain: number; explainMax: number; lookup: number } {
  return {
    explain: now - EXPLAIN_RETENTION_DAYS * DAY_MS,
    explainMax: now - EXPLAIN_RETENTION_MAX_DAYS * DAY_MS,
    lookup: now - LOOKUP_RETENTION_DAYS * DAY_MS,
  };
}

/** 设置页「AI 眼中的你」里的时间：今天 03:00 / 昨天 21:10 / 11月12日 03:00（北京时间） */
export function formatNoteTime(at: number, now: number): string {
  const hm = new Date(at).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const d = shanghaiDay(at);
  if (d === shanghaiDay(now)) return `今天 ${hm}`;
  if (d === shanghaiDay(now - DAY_MS)) return `昨天 ${hm}`;
  const [, m, day] = d.split("-").map(Number);
  return `${m}月${day}日 ${hm}`;
}

/** 每晚整理最多带几组「问题、回答、反馈」 */
export const NIGHTLY_ANSWERED_MAX = 30;
/** 每段回答截取前多少字 */
export const NIGHTLY_ANSWER_EXCERPT = 300;
/** 同一类情况至少几次才写进笔记 */
export const NOTE_PATTERN_MIN = 3;

export const NIGHTLY_SYSTEM_PROMPT = [
  NOTE_SYSTEM_PROMPT,
  "这次是每晚整理：根据下面的全部材料完整重写笔记，合并重复的判断、去掉已经过时的判断。",
  "「带回答的反馈」是学生对你讲解的评价，来自他读过的所有文章：看清被评「太深」「太浅」「刚好」的分别是什么样的讲法，把讲解偏好写进笔记。",
  `同一类情况至少出现 ${NOTE_PATTERN_MIN} 次才写进笔记；只出现一两次的不要下结论。`,
].join("\n");

/** 每晚整理的提示词：在原有笔记提示词里插入「带回答的反馈」一节（不写英文原词） */
export function buildNightlyNotePrompt(
  input: NotePromptInput & { answered: RecentFeedbackItem[] },
): { system: string; user: string } {
  const base = buildNotePrompt(input);
  const lines: string[] = ["【带回答的反馈（来自所有文章，从新到旧）】"];
  const items = input.answered.slice(0, NIGHTLY_ANSWERED_MAX);
  if (items.length === 0) {
    lines.push("暂无。");
  } else {
    for (const it of items) {
      lines.push(`- ${formatFeedbackLine(it)}`);
      const excerpt = answerExcerpt(it.answerText);
      if (excerpt) lines.push(`  回答开头：${excerpt}`);
    }
  }
  const marker = "【上一版老师笔记】";
  const i = base.user.indexOf(marker);
  const user = i >= 0 ? `${base.user.slice(0, i)}${lines.join("\n")}\n\n${base.user.slice(i)}` : `${base.user}\n\n${lines.join("\n")}`;
  return { system: NIGHTLY_SYSTEM_PROMPT, user };
}

/** 回答开头：去掉建议行，压成一行，截到 NIGHTLY_ANSWER_EXCERPT 字 */
export function answerExcerpt(text: string | null | undefined): string {
  if (!text) return "";
  const one = splitCardSuggestion(text).body.replace(/\s+/g, " ").trim();
  return one.length > NIGHTLY_ANSWER_EXCERPT ? `${one.slice(0, NIGHTLY_ANSWER_EXCERPT)}…` : one;
}
