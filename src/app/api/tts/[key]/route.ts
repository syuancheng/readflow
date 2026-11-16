import fs from "node:fs";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { sqlite } from "@/db/sqlite";
import { audioTextsOf, isAudioKey } from "@/lib/cards/audio";
import { matchAudioKey } from "@/lib/cards/voices";
import type { CardSpec } from "@/lib/cards/spec";
import { ensureAudio, storedAudio } from "@/lib/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tts/:key（P35 spec §6）：卡片预览里的播放按钮取音频。
 * - 只返回**本人卡片里用到的**音频：草稿内容里有这个 key 的占位符才算（pusher 不改写 cards.content）。
 * - 文件还没有就现场合成；合成失败返回 503「音频暂时没生成」。
 * - key 先过十六进制校验，所以拼进 LIKE 不会被注入。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { key } = await ctx.params;
  if (!isAudioKey(key)) return NextResponse.json({ error: "音频不存在" }, { status: 404 });

  const rows = sqlite
    .prepare("SELECT spec FROM cards WHERE user_id = ? AND content LIKE ? LIMIT 20")
    .all(user.id, `%@AUDIO:${key}@%`) as { spec: string }[];
  if (rows.length === 0) return NextResponse.json({ error: "音频不存在" }, { status: 404 });

  let audio = storedAudio(key);
  if (!audio) {
    // 按写进占位符时的音色找回句子（换过音色的旧草稿仍用旧音色）
    const hit = matchAudioKey(rows.flatMap((r) => audioTextsOf(JSON.parse(r.spec) as CardSpec)), key);
    audio = hit ? await ensureAudio(hit.text, hit.voice) : null;
  }
  if (!audio) return NextResponse.json({ error: "音频暂时没生成" }, { status: 503 });

  const bytes = fs.readFileSync(audio.filePath);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": audio.mime,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
