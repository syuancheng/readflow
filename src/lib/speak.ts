"use client";

/**
 * 浏览器自带 TTS（零成本、离线可用）。
 *
 * 坑 1：不指定 voice 时系统用默认音色（macOS 上常命中低沉老男声 Albert/Aaron）。
 *       按优先级挑自然音色：Google 英语 → Enhanced/Premium → 常见自然女声。
 *
 * 坑 2：Chrome 的 speechSynthesis 有几个经典 bug，都会导致「点了没声音」：
 *   a) cancel() 之后同步 speak() 有概率被吞掉 —— 延迟一拍再 speak；
 *   b) voices 列表是异步加载的，模块加载时拿到的音色对象可能已失效，
 *      用失效对象赋值 u.voice 会静默失败 —— 每次发音前按名字重新解析；
 *   c) synth 意外进入 paused 状态后 speak() 无声 —— resume 兜底。
 */

const PREFERRED = [
  (v: SpeechSynthesisVoice) => /google (us|uk) english/i.test(v.name),
  (v: SpeechSynthesisVoice) => /enhanced|premium/i.test(v.name),
  (v: SpeechSynthesisVoice) => /samantha|ava|allison|serena|karen|moira|tessa/i.test(v.name),
];

/** 经验上听感差的老男声/怪声（macOS 默认常命中 Albert/Aaron/Fred 一类） */
const AVOID = /albert|aaron|fred|ralph|jr\b|good news|bad news|organ|whisper|bells|bubbles|cello|zarvox|trinoids|boing|deranged|hysterical|pipe/i;

/** 只记名字不存对象：音色对象可能随 voices 列表刷新而失效 */
let cachedName: string | null = null;

function pickFrom(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
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

/** 每次发音前解析：缓存的音色还在列表里就直接用，不在了重新挑 */
function resolveVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  if (cachedName) {
    const still = voices.find((v) => v.name === cachedName);
    if (still) return still;
  }
  const picked = pickFrom(voices);
  cachedName = picked?.name ?? null;
  return picked;
}

/** 预热：触发 voices 异步加载；加载完成后更新缓存的名字 */
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    const picked = pickFrom(window.speechSynthesis.getVoices());
    cachedName = picked?.name ?? null;
  });
}

export function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  if (!text.trim()) return;
  const synth = window.speechSynthesis;

  const u = new SpeechSynthesisUtterance(text);
  const v = resolveVoice();
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  } else {
    u.lang = "en-US";
  }
  u.rate = 0.95;

  synth.cancel();
  if (synth.paused) synth.resume();
  // cancel() 后同步 speak() 会被 Chrome 吞掉，延迟一拍（仍在用户手势激活窗口内）
  setTimeout(
    () => {
      if (synth.paused) synth.resume();
      synth.speak(u);
    },
    30,
  );
}

export const canSpeak =
  typeof window !== "undefined" && "speechSynthesis" in window;
