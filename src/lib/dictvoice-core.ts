/**
 * 有道词典发音接口的纯逻辑（可在单测里直接编译，不碰 DB / 网络 / 文件）。
 *
 * 接口：http://dict.youdao.com/dictvoice?type=0|1&audio=<文本>
 * 实测（2026-11-23）：type=1 英音，type=0 / type=2 是同一个文件（美音）。
 */

export type Accent = "us" | "gb";

/** 一次朗读最多多少字符：有道对超长文本支持有限，超出直接回退浏览器朗读 */
export const DICTVOICE_MAX_CHARS = 200;

/** 默认接口地址；服务端可用 READFLOW_DICTVOICE_BASE_URL 覆盖（E2E 用本地 mock） */
export const DICTVOICE_DEFAULT_BASE = "http://dict.youdao.com/dictvoice";

/** 英美音 → 有道 type 参数 */
export function accentToType(accent: Accent): 0 | 1 {
  return accent === "gb" ? 1 : 0;
}

/** 非法值一律按美音 */
export function narrowAccent(v: unknown): Accent {
  return v === "gb" ? "gb" : "us";
}

/** 文本规整：去首尾空白、折叠内部连续空白；超出上限返回 null（让调用方回退） */
export function normalizeDictText(raw: string): string | null {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text || text.length > DICTVOICE_MAX_CHARS) return null;
  return text;
}

/** 缓存用的 key：model+voice 参与哈希，英美音天然分开存；复用卡片音频的 key 算法 */
export function dictAudioKey(text: string, accent: Accent, hash: (s: string) => string): string {
  return `dv:${hash(`${text}\nyoudao-dictvoice\n${accent}`)}`;
}

/** 拼请求 URL；base 末尾的斜杠会被去掉 */
export function dictVoiceUrl(base: string, text: string, accent: Accent): string {
  const b = (base || DICTVOICE_DEFAULT_BASE).replace(/\/+$/, "");
  const q = new URLSearchParams({ type: String(accentToType(accent)), audio: text });
  return `${b}?${q.toString()}`;
}

/** 响应是否是可用音频：状态 2xx + content-type 含 audio/ + 有正文 */
export function isAudioResponse(ok: boolean, contentType: string | null, bytes: number): boolean {
  return ok && (contentType ?? "").toLowerCase().includes("audio/") && bytes > 0;
}
