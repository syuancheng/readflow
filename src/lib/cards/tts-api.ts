/**
 * 百炼语音合成接口的纯函数部分（P35 spec §5.1），单测覆盖：
 * 拼请求、解析响应、Key 的读取顺序。真正发请求、存文件在 src/lib/tts.ts。
 *
 * 接口（2026-11-16 查阅 https://help.aliyun.com/en/model-studio/qwen-tts-api）：
 *   POST {base}/api/v1/services/aigc/multimodal-generation/generation
 *   Authorization: Bearer <key>；非流式请求不带 X-DashScope-SSE
 *   { model, input: { text, voice, language_type: "English" } }
 *   → { output: { audio: { url, expires_at } }, usage: { characters } }，url 24 小时内有效
 */
import type { Voice } from "./audio";

/** 北京地域；新加坡地域的 Key 不通用 */
export const TTS_DEFAULT_BASE = "https://dashscope.aliyuncs.com";
export const TTS_PATH = "/api/v1/services/aigc/multimodal-generation/generation";

export function ttsBase(env: Record<string, string | undefined>): string {
  return (env.READFLOW_TTS_BASE_URL || TTS_DEFAULT_BASE).replace(/\/+$/, "");
}

export function buildTtsRequest(
  base: string,
  key: string,
  text: string,
  voice: Voice,
): { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } {
  return {
    url: `${base}${TTS_PATH}`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: voice.model,
        input: { text, voice: voice.voice, language_type: "English" },
      }),
    },
  };
}

export type TtsResult = { url: string; expiresAt: number | null; characters: number | null };

/** 从响应里取音频下载地址；没有 url 时抛出带原因的错误 */
export function parseTtsResponse(json: unknown): TtsResult {
  const o = (json ?? {}) as {
    output?: { audio?: { url?: unknown; expires_at?: unknown } };
    usage?: { characters?: unknown };
    code?: unknown;
    message?: unknown;
  };
  const url = o.output?.audio?.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    const why = [o.code, o.message].filter((x) => typeof x === "string" && x).join(" ");
    throw new Error(`语音合成没有返回音频地址${why ? `：${why}` : ""}`);
  }
  const exp = o.output?.audio?.expires_at;
  const chars = o.usage?.characters;
  return {
    url,
    expiresAt: typeof exp === "number" ? exp : null,
    characters: typeof chars === "number" ? chars : null,
  };
}

/** Key：先读环境变量 DASHSCOPE_API_KEY，再读站级设置里「通义千问」那一栏；都没有返回 null */
export function resolveTtsKey(env: Record<string, string | undefined>, siteQwenKey: string | null): string | null {
  const fromEnv = env.DASHSCOPE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromSite = siteQwenKey?.trim();
  return fromSite ? fromSite : null;
}

/** 下载回来的音频是什么格式：优先看响应头，其次看地址的扩展名，默认 wav */
export function audioMimeOf(contentType: string | null, url: string): { mime: string; ext: string } {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3") || /\.mp3(\?|$)/i.test(url)) return { mime: "audio/mpeg", ext: "mp3" };
  return { mime: "audio/wav", ext: "wav" };
}
