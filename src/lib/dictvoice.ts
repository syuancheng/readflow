/**
 * 有道词典发音：请求真人音频，缓存复用，失败返回 null（由前端回退浏览器朗读）。
 *
 * 缓存复用 tts_audio 表和 tts/ 目录（与卡片配音共用存储，model=youdao-dictvoice，
 * voice=us|gb 区分英美音），不新增表、不新增依赖。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sqlite, dbPath } from "@/db/sqlite";
import {
  DICTVOICE_DEFAULT_BASE,
  accentToType,
  dictAudioKey,
  dictVoiceUrl,
  isAudioResponse,
  normalizeDictText,
  type Accent,
} from "./dictvoice-core";

/** 单次请求的硬超时 */
const DICTVOICE_TIMEOUT_MS = 8_000;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** 供单测注入 base；生产走环境变量，没配就用有道默认地址 */
function baseUrl(): string {
  return process.env.READFLOW_DICTVOICE_BASE_URL || DICTVOICE_DEFAULT_BASE;
}

type Cached = { filePath: string; mime: string };

/** 命中本地缓存且文件还在才返回 */
function cached(key: string): Cached | null {
  const row = sqlite
    .prepare("SELECT file_path, mime FROM tts_audio WHERE key = ?")
    .get(key) as { file_path: string; mime: string } | undefined;
  if (!row) return null;
  const abs = path.join(path.dirname(dbPath), row.file_path);
  return fs.existsSync(abs) ? { filePath: abs, mime: row.mime } : null;
}

function store(key: string, text: string, accent: Accent, bytes: Buffer): Cached {
  const dir = path.join(path.dirname(dbPath), "tts");
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join("tts", `${key}.mp3`);
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
    .run(key, text, "youdao-dictvoice", accent, rel, "audio/mpeg", bytes.length, Date.now());
  return { filePath: abs, mime: "audio/mpeg" };
}

const inflight = new Map<string, Promise<Cached | null>>();

/**
 * 取一段文本的真人发音（缓存优先）。
 * - text 过长/为空、网络失败、响应不是音频 → 返回 null，调用方回退浏览器朗读。
 * - 不做重试：免费内部接口，失败一次就降级，避免被封。
 */
export async function ensureDictAudio(rawText: string, accent: Accent): Promise<Cached | null> {
  const text = normalizeDictText(rawText);
  if (!text) return null;

  const key = dictAudioKey(text, accent, hash);
  const have = cached(key);
  if (have) return have;
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    try {
      const url = dictVoiceUrl(baseUrl(), text, accent);
      const res = await fetch(url, { signal: AbortSignal.timeout(DICTVOICE_TIMEOUT_MS) });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!isAudioResponse(res.ok, res.headers.get("content-type"), bytes.length)) {
        throw new Error(`有道返回非音频：status=${res.status} type=${res.headers.get("content-type")} bytes=${bytes.length}`);
      }
      return store(key, text, accent, bytes);
    } catch (err) {
      // 日志不打印完整文本，避免把用户划选内容写进日志
      console.warn("[dictvoice] 取音失败，回退浏览器朗读", {
        accent,
        type: accentToType(accent),
        reason: err instanceof Error ? err.message : String(err),
        text: text.slice(0, 40),
      });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}
