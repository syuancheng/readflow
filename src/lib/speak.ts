"use client";

/**
 * 浏览器自带 TTS（零成本、离线可用）。
 *
 * 坑：直接 new SpeechSynthesisUtterance 不指定 voice 时，
 * 系统会用默认音色（macOS 上常命中一个低沉的老男声），很难听。
 * 这里按优先级挑一个自然的女声/高质量音色：
 *   1. Google 英语（Chrome 内置，最自然）
 *   2. 系统标记 Enhanced / Premium 的音色
 *   3. Samantha（macOS 自带，自然女声）
 *   4. 其他 en-US 音色里排除明显的老男声
 */

const PREFERRED = [
  (v: SpeechSynthesisVoice) => /google (us|uk) english/i.test(v.name),
  (v: SpeechSynthesisVoice) => /enhanced|premium/i.test(v.name),
  (v: SpeechSynthesisVoice) => /samantha|ava|allison|serena|karen|moira|tessa/i.test(v.name),
];

/** 经验上听感差的老男声（macOS 默认常命中 Albert/Aaron/Fred 一类） */
const AVOID = /albert|aaron|fred|ralph|jr\b|good news|bad news|organ|whisper|bells|bubbles|cello|zarvox|trinoids|boing|deranged|hysterical|pipe/i;

let cached: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  if (en.length === 0) return null;

  for (const match of PREFERRED) {
    const hit = en.find(match);
    if (hit) return hit;
  }
  const us = en.filter((v) => v.lang.replace("_", "-").toLowerCase() === "en-us" && !AVOID.test(v.name));
  if (us.length > 0) return us[0];
  const plain = en.filter((v) => !AVOID.test(v.name));
  return plain[0] ?? en[0];
}

/** voices 列表是异步加载的，首次可能为空；监听变化后重挑并缓存 */
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  cached = pickVoice();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    cached = pickVoice();
  });
}

export function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  if (!cached) cached = pickVoice();

  const u = new SpeechSynthesisUtterance(text);
  if (cached) {
    u.voice = cached;
    u.lang = cached.lang;
  } else {
    u.lang = "en-US";
  }
  u.rate = 0.95;
  synth.cancel();
  synth.speak(u);
}

export const canSpeak =
  typeof window !== "undefined" && "speechSynthesis" in window;
