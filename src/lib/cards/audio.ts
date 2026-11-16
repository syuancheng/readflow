/**
 * 卡片句子音频的纯函数（P35 spec §3）。
 * - 音频只配给**背面**的英文句子：正面放音频会把答案读出来（PRD 原则 6）。
 * - 同一句话（规范化后）+ 同一模型音色 → 同一个 key，所有用户共用一份合成结果。
 * - 草稿里写占位符 `[Audio#M,ID/@AUDIO:<key>@#]`，推送时换成墨墨的 file.id。
 * 单测编译走 CommonJS，只用相对路径 import。
 */
import { createHash } from "node:crypto";
import type { Block, CardSpec } from "./spec";

export type Voice = { model: string; voice: string };

/** 单句最多多少个字符才合成（百炼单次上限 600，留出余量；P33 spec §10 也是 400） */
export const AUDIO_TEXT_MAX = 400;

const KEY_RE = /^[0-9a-f]{32}$/;
const PLACEHOLDER_RE = /@AUDIO:([0-9a-f]{32})@/g;

export function normalizeAudioText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function audioKey(text: string, voice: Voice): string {
  return createHash("sha256")
    .update(`${normalizeAudioText(text)}\n${voice.model}\n${voice.voice}`)
    .digest("hex")
    .slice(0, 32);
}

export function isAudioKey(v: string): boolean {
  return KEY_RE.test(v);
}

/** 这句英文值不值得配音：非空、不超长、至少有一个英文字母 */
export function speakable(text: string): boolean {
  const t = normalizeAudioText(text);
  return t.length > 0 && t.length <= AUDIO_TEXT_MAX && /[A-Za-z]/.test(t);
}

function sentencesOf(blocks: Block[] | undefined): string[] {
  return (blocks ?? []).flatMap((b) => (b.t === "sentence" ? [b.text] : []));
}

/** 背面所有要配音的英文句子：answer / explanation 里的句子块 + 补充例句；去重、保持顺序 */
export function audioTextsOf(spec: CardSpec): string[] {
  const all = [
    ...sentencesOf(spec.back.answer),
    ...sentencesOf(spec.back.explanation),
    ...(spec.back.example ? [spec.back.example.en] : []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of all) {
    const n = normalizeAudioText(t);
    if (!speakable(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 草稿里的音频标签：手动播放、显示文字为空（第二个 # 必须保留） */
export function audioPlaceholder(key: string): string {
  return `[Audio#M,ID/@AUDIO:${key}@#]`;
}

/** 渲染结果里出现的所有 key（去重、保持顺序） */
export function audioPlaceholderKeys(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 把占位符换成墨墨的 file.id；值为 null 的整段音频标签（连同它前面的一个空格）删掉。
 * 用 split / join 替换：id 里可能有 `$` 等字符，不能拼进正则或替换模板。
 */
export function fillAudioIds(content: string, ids: Record<string, string | null>): string {
  let out = content;
  for (const [key, fileId] of Object.entries(ids)) {
    if (fileId === null) {
      const tag = audioPlaceholder(key);
      out = out.split(` ${tag}`).join("").split(tag).join("");
    } else {
      out = out.split(`@AUDIO:${key}@`).join(fileId);
    }
  }
  return out;
}
