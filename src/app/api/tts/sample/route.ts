import fs from "node:fs";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isVoiceId, voiceOf } from "@/lib/cards/voices";
import { ensureAudio, ttsKeyAvailable } from "@/lib/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 试听用的固定句子：每个音色只合成一次，之后走缓存（和卡片句子共用 tts_audio） */
const SAMPLE_TEXT = "Reading a little every day makes the words feel like old friends.";

/**
 * GET /api/tts/sample?voice=Serena（P38）：设置里「语音合成模型」试听音色。
 * 只有主账号能用（合成要花站长的百炼额度）；音色只接受 cards/voices.ts 里的。
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!user.isOwner) return NextResponse.json({ error: "只有主账号能试听音色" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("voice");
  if (!isVoiceId(id)) return NextResponse.json({ error: "不认识这个音色" }, { status: 400 });
  if (!ttsKeyAvailable()) return NextResponse.json({ error: "还没有配置阿里云百炼的 Key" }, { status: 409 });

  const audio = await ensureAudio(SAMPLE_TEXT, voiceOf(id));
  if (!audio) return NextResponse.json({ error: "试听音频暂时没生成，稍后再试" }, { status: 503 });
  const bytes = fs.readFileSync(audio.filePath);
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": audio.mime, "Content-Length": String(bytes.length), "Cache-Control": "private, max-age=86400" },
  });
}
