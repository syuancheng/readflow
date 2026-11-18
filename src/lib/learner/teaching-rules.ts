/**
 * 教学规则：学生明确要求的「希望老师做 / 不要做」，与 AI 观察到的老师笔记分开存。
 *
 * 关键性质：
 * - 只由用户写，AI 夜间整理无权改（不进 note 的重写流程）。
 * - 每条 ≤80 字、总数 ≤12 条，避免把 system prompt 撑爆。
 * - 注入时放在独立 system message，不改 legacySystemPrompt 的逐字快照。
 * 纯函数，只能相对路径 import（单测把本目录编译成 CommonJS 直接跑）。
 */
import type { Cefr } from "./types";

export const RULE_MAX_CHARS = 80;
export const RULE_MAX_COUNT = 12;
export const TEACHING_RULES_MAX_CHARS = 600;

export type TeachingRules = { can: string[]; cannot: string[] };

export const EMPTY_RULES: TeachingRules = { can: [], cannot: [] };

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim().slice(0, RULE_MAX_CHARS);
    if (s) out.push(s);
  }
  return out.slice(0, RULE_MAX_COUNT);
}

export function normalizeRules(input: unknown): TeachingRules {
  if (!input || typeof input !== "object") return EMPTY_RULES;
  const o = input as Record<string, unknown>;
  return { can: cleanList(o.can), cannot: cleanList(o.cannot) };
}

export function rulesFromJson(raw: string | null | undefined): TeachingRules {
  if (!raw) return EMPTY_RULES;
  try {
    return normalizeRules(JSON.parse(raw));
  } catch {
    return EMPTY_RULES;
  }
}

export function rulesToJson(rules: TeachingRules): string {
  return JSON.stringify(normalizeRules(rules));
}

export function hasRules(rules: TeachingRules): boolean {
  return rules.can.length > 0 || rules.cannot.length > 0;
}

/**
 * 独立 system message。有规则才返回文本，空串时调用方一条都不插，
 * 这样老调用（没填过规则）的 messages 与从前逐字一致。
 */
export function buildRulesSystemPrompt(rules: TeachingRules): string {
  if (!hasRules(rules)) return "";
  const lines = [
    "这是学生本人明确写下的讲解要求，优先于其它讲解偏好，必须遵守；回答里不要提到这些要求。",
  ];
  if (rules.can.length) {
    lines.push("学生希望老师做的：");
    for (const r of rules.can) lines.push(`- ${r}`);
  }
  if (rules.cannot.length) {
    lines.push("学生不希望老师做的：");
    for (const r of rules.cannot) lines.push(`- ${r}`);
  }
  return lines.join("\n").slice(0, TEACHING_RULES_MAX_CHARS);
}

const CEFR_LEVELS: Cefr[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function normalizeOverride(input: unknown): { cefr: Cefr | null; vocab: number | null } {
  if (!input || typeof input !== "object") return { cefr: null, vocab: null };
  const o = input as Record<string, unknown>;
  const cefr = typeof o.cefr === "string" && CEFR_LEVELS.includes(o.cefr as Cefr)
    ? (o.cefr as Cefr)
    : null;
  const n = typeof o.vocab === "number" && Number.isFinite(o.vocab) ? Math.round(o.vocab) : null;
  const vocab = n !== null && n >= 500 && n <= 30000 ? n : null;
  return { cefr, vocab };
}
