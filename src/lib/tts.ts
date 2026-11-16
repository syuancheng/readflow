/**
 * 卡片句子音频的合成与存取（P35 spec §5.2）。会碰数据库、文件和网络，不在单测编译范围；
 * 拼请求 / 解析响应 / Key 顺序这些纯逻辑在 src/lib/cards/tts-api.ts，单测覆盖。
 *
 * - 同一句话（audioKey 相同）只合成一次，所有用户共用：tts_audio 表 + 数据目录下的 tts/<key>.wav。
 * - 同一进程里同一个 key 同时只跑一个任务；全局最多同时 3 个合成请求。
 * - 百炼返回的音频地址 24 小时内有效，拿到就下载到本地，不保存地址。
 * - 失败返回 null 并记日志：日志里不打印 Key，句子只打印前 40 个字符。
 */
import fs from "node:fs";
import path from "node:path";
import { sqlite, dbPath } from "@/db/sqlite";
import { getSetting } from "@/lib/settings-store";
import { SETTINGS_KEYS } from "@/lib/config";
import { isRetryableError } from "@/lib/retry";
import { audioKey, normalizeAudioText, speakable } from "@/lib/cards/audio";
import { VOICE } from "@/lib/cards/voices";
import { audioMimeOf, buildTtsRequest, parseTtsResponse, resolveTtsKey, ttsBase } from "@/lib/cards/tts-api";

export const TTS_CONCURRENCY = 3;
export const TTS_TIMEOUT_MS = 20_000;

export type StoredAudio = { key: string; filePath: string; mime: string };

/** 音频目录：数据库所在目录下的 tts/（测试用隔离库时也落在临时目录里） */
export function audioDir(): string {
  return path.join(path.dirname(dbPath), "tts");
}

export function ttsKey(): string | null {
  return resolveTtsKey(process.env, getSetting(SETTINGS_KEYS.providerKey("qwen")));
}

export function ttsKeyAvailable(): boolean {
  return ttsKey() !== null;
}

type Row = { key: string; file_path: string; mime: string };

/** 已经合成好、文件也在的音频；没有返回 null */
export function storedAudio(key: string): StoredAudio | null {
  const row = sqlite.prepare("SELECT key, file_path, mime FROM tts_audio WHERE key = ?").get(key) as Row | undefined;
  if (!row) return null;
  const abs = path.join(path.dirname(dbPath), row.file_path);
  return fs.existsSync(abs) ? { key: row.key, filePath: abs, mime: row.mime } : null;
}

// ---------- 并发控制 ----------

const inflight = new Map<string, Promise<StoredAudio | null>>();
let running = 0;
const waiters: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= TTS_CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

class TtsHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TTS_TIMEOUT_MS) });
}

/** 合成一次：请求百炼 → 下载音频。出错抛异常，由调用方决定是否重试 */
async function synthesizeOnce(text: string, apiKey: string): Promise<{ bytes: Buffer; mime: string; ext: string }> {
  const req = buildTtsRequest(ttsBase(process.env), apiKey, text, VOICE);
  const res = await fetchWithTimeout(req.url, req.init);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new TtsHttpError(`语音合成失败：${msg}`, res.status);
  }
  const parsed = parseTtsResponse(json);
  if (parsed.characters !== null) {
    console.info("[tts] 合成", { characters: parsed.characters, expiresAt: parsed.expiresAt });
  }
  const audio = await fetchWithTimeout(parsed.url);
  if (!audio.ok) throw new TtsHttpError(`下载音频失败：HTTP ${audio.status}`, audio.status);
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (bytes.length === 0) throw new Error("下载的音频是空的");
  return { bytes, ...audioMimeOf(audio.headers.get("content-type"), parsed.url) };
}

async function synthesizeAndStore(text: string, key: string): Promise<StoredAudio | null> {
  const apiKey = ttsKey();
  if (!apiKey) return null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { bytes, mime, ext } = await slot(() => synthesizeOnce(text, apiKey));
      const dir = audioDir();
      fs.mkdirSync(dir, { recursive: true });
      const rel = path.join("tts", `${key}.${ext}`);
      const abs = path.join(path.dirname(dbPath), rel);
      const tmp = `${abs}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, abs);
      sqlite
        .prepare(
          `INSERT INTO tts_audio (key, text, model, voice, file_path, mime, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET file_path = excluded.file_path, mime = excluded.mime,
             bytes = excluded.bytes, created_at = excluded.created_at`,
        )
        .run(key, text, VOICE.model, VOICE.voice, rel, mime, bytes.length, Date.now());
      return { key, filePath: abs, mime };
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err)) break;
    }
  }
  console.error("[tts] 合成失败", {
    key,
    status: (lastErr as { status?: number } | null)?.status ?? null,
    reason: lastErr instanceof Error ? lastErr.message : String(lastErr),
    text: text.slice(0, 40),
  });
  return null;
}

/** 确保这句英文有音频：已有直接返回；没有就合成（同 key 的并发请求合并成一个） */
export function ensureAudio(rawText: string): Promise<StoredAudio | null> {
  const text = normalizeAudioText(rawText);
  if (!speakable(text)) return Promise.resolve(null);
  const key = audioKey(text, VOICE);
  const have = storedAudio(key);
  if (have) return Promise.resolve(have);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = synthesizeAndStore(text, key).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/**
 * 一组句子全部确保有音频，最多等 budgetMs；超时的部分在后台继续合成。
 * 返回在时限内拿到音频的句子数（日志用）。
 */
export async function ensureAudioAll(texts: string[], budgetMs: number): Promise<number> {
  if (texts.length === 0) return 0;
  let done = 0;
  const all = Promise.all(texts.map((t) => ensureAudio(t).then((r) => { if (r) done++; })));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([all, new Promise<void>((r) => { timer = setTimeout(r, budgetMs); })]);
  if (timer) clearTimeout(timer);
  return done;
}
