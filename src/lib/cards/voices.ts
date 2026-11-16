/**
 * 卡片句子音频用的模型和音色（P35 spec §5.1；P38 起站长可在「模型 → 语音合成模型」里选音色）。
 * 音色来自百炼 Qwen3-TTS 音色列表（2026-11-16 查阅 https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list），
 * 这里只收能读英文的女声：Jennifer（原默认）加上列表里标明温柔 / 温和的几位。
 * 换音色只影响之后合成的句子（audioKey 含音色）；已有草稿按写进占位符时的音色找回，已推送的卡不变。
 * 单测编译走 CommonJS，只用相对路径 import。
 */
import { audioKey, type Voice } from "./audio";

export const TTS_MODEL = "qwen3-tts-flash";
export type VoiceOption = { id: string; name: string; desc: string };

export const VOICE_OPTIONS: readonly VoiceOption[] = [
  { id: "Jennifer", name: "詹妮弗", desc: "美式英语女声，清晰标准" },
  { id: "Serena", name: "苏瑶", desc: "温柔的女声" },
  { id: "Maia", name: "四月", desc: "知性又温柔" },
  { id: "Sohee", name: "素熙", desc: "温柔开朗的姐姐音" },
  { id: "Seren", name: "小婉", desc: "温和舒缓，语速偏慢" },
];

export const DEFAULT_VOICE_ID = "Jennifer";

export function isVoiceId(id: unknown): id is string {
  return typeof id === "string" && VOICE_OPTIONS.some((o) => o.id === id);
}

/** 设置里存的音色 id → Voice；不认识的值一律回到默认音色 */
export function voiceOf(id: string | null | undefined): Voice {
  return { model: TTS_MODEL, voice: isVoiceId(id) ? id : DEFAULT_VOICE_ID };
}

/** 默认音色（单测和没有设置时用） */
export const VOICE: Voice = voiceOf(DEFAULT_VOICE_ID);

/** 按 key 找回句子和它当时用的音色：每个候选句子 × 每个可选音色都试一遍 */
export function matchAudioKey(texts: readonly string[], key: string): { text: string; voice: Voice } | null {
  for (const o of VOICE_OPTIONS) {
    const voice = voiceOf(o.id);
    const text = texts.find((t) => audioKey(t, voice) === key);
    if (text !== undefined) return { text, voice };
  }
  return null;
}

/** 草稿内容里的占位符是用哪个音色写的（预览按它算 key）；一个都对不上返回 null */
export function voiceInContent(content: string, texts: readonly string[]): Voice | null {
  const keys = [...content.matchAll(/@AUDIO:([0-9a-f]{32})@/g)].map((m) => m[1]);
  for (const k of keys) {
    const hit = matchAudioKey(texts, k);
    if (hit) return hit.voice;
  }
  return null;
}
