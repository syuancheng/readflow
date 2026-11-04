"use client";

/**
 * 浏览器自带 TTS（零成本、离线可用）。
 *
 * 坑 1：不指定 voice 时系统用默认音色（macOS 上常命中低沉老男声 Albert/Aaron）。
 *
 * 坑 2（导致完全无声的真凶）：Chrome 的 "Google US English" 等是**网络音色**
 *      （localService=false），发音要走 Google 服务器——网络不通时静默失败，
 *      一个字都不出。所以只从本地音色里挑。
 *
 * 坑 3：Chrome speechSynthesis 的其他经典 bug：
 *   a) cancel() 之后同步 speak() 有概率被吞掉 —— 延迟一拍再 speak；
 *   b) voices 列表异步加载，缓存的音色对象可能失效 —— 每次按名字重新解析；
 *   c) synth 意外进入 paused 状态后 speak() 无声 —— resume 兜底。
 */

/** macOS 上听感自然的本地女声/中性音色（Samantha 为 macOS 默认优质女声） */
const PREFERRED_NAMES = /samantha|ava|kathy|nicky|sandy|shelley|catherine|karen|tessa|moira|serena|allison/i;

/** 怪声/老男声/搞笑音色（macOS 特效音一大堆，全部排除） */
const AVOID =
  /albert|aaron|fred|ralph|jr\b|grandma|grandpa|junior|jester|rocko|reed|eddy|flo|gordon|martha|rishi|superstar|wobble|bahh|good news|bad news|organ|whisper|bells|bubbles|cello|zarvox|trinoids|boing|deranged|hysterical|pipe/i;

/** 只记名字不存对象：音色对象可能随 voices 列表刷新而失效 */
let cachedName: string | null = null;

function pickFrom(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const en = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
  if (en.length === 0) return null;

  // 关键：只用本地音色。网络音色（Google English 等）在国内连不上服务端，
  // 赋值后 speak() 会静默失败——就是「点了没声音」的根因。
  const local = en.filter((v) => v.localService);
  const pool = local.length > 0 ? local : en;

  const nice = pool.filter((v) => PREFERRED_NAMES.test(v.name));
  if (nice.length > 0) {
    // 同名多地区（Sandy (US) / Sandy (UK)）优先 en-US
    return nice.find((v) => v.lang.replace("_", "-").toLowerCase() === "en-us") ?? nice[0];
  }
  const us = pool.filter(
    (v) => v.lang.replace("_", "-").toLowerCase() === "en-us" && !AVOID.test(v.name),
  );
  if (us.length > 0) return us[0];
  const plain = pool.filter((v) => !AVOID.test(v.name));
  return plain[0] ?? pool[0];
}

/** 每次发音前解析：用户手动选过的音色 > 缓存 > 重新挑（都必须是本地音色） */
function resolveVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;

  const wanted = typeof localStorage !== "undefined" ? localStorage.getItem("readflow.voice") : null;
  if (wanted) {
    const chosen = voices.find((v) => v.name === wanted && v.localService);
    if (chosen) return chosen;
  }
  if (cachedName) {
    const still = voices.find((v) => v.name === cachedName && v.localService);
    if (still) return still;
  }
  const picked = pickFrom(voices);
  cachedName = picked?.name ?? null;
  return picked;
}

/** 音色选择器用：列出可用的本地英文音色（排除怪声） */
export function listEnglishVoices(): { name: string; lang: string }[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis
    .getVoices()
    .filter(
      (v) =>
        v.localService &&
        (v.lang || "").toLowerCase().startsWith("en") &&
        !AVOID.test(v.name),
    )
    .map((v) => ({ name: v.name, lang: v.lang }));
}

/** 记录用户手动选择的音色（null = 恢复自动挑选） */
export function setPreferredVoice(name: string | null) {
  if (typeof localStorage === "undefined") return;
  if (name) localStorage.setItem("readflow.voice", name);
  else localStorage.removeItem("readflow.voice");
  cachedName = name;
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

  // 兜底 1：音色不可用触发 onerror → 去掉 voice 用引擎默认重试
  let started = false;
  u.onstart = () => {
    started = true;
  };
  const speakWithDefault = () => {
    const fallback = new SpeechSynthesisUtterance(text);
    fallback.lang = "en-US";
    fallback.rate = 0.95;
    synth.speak(fallback);
  };
  u.onerror = () => {
    if (u.voice) speakWithDefault();
  };

  synth.cancel();
  if (synth.paused) synth.resume();
  // cancel() 后同步 speak() 会被 Chrome 吞掉，延迟一拍（仍在用户手势激活窗口内）
  setTimeout(
    () => {
      if (synth.paused) synth.resume();
      synth.speak(u);
      // 兜底 2（watchdog）：1.2 秒后既没开始播、也没有排队/正在播的内容，
      // 说明这路音色在这台机器上根本发不出声——去掉 voice 用默认引擎再试一次。
      setTimeout(() => {
        if (!started && !synth.speaking && !synth.pending) speakWithDefault();
      }, 1200);
    },
    30,
  );
}

export const canSpeak =
  typeof window !== "undefined" && "speechSynthesis" in window;
