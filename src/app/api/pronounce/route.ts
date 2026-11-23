import fs from "node:fs";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { SETTINGS_KEYS } from "@/lib/config";
import { getSetting } from "@/lib/settings-store";
import { ensureDictAudio } from "@/lib/dictvoice";
import { normalizeDictText } from "@/lib/dictvoice-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pronounce?text=<原文>
 *
 * 阅读器发音：取有道真人音频（服务端缓存），失败 503 让前端回退浏览器朗读。
 * 口音从当前用户的个人设置读（美音默认），设置保存后下次发音即生效，前端无需同步状态。
 * 参数白名单：文本 ≤200 字。
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const url = new URL(req.url);
  const text = normalizeDictText(url.searchParams.get("text") ?? "");
  if (!text) return NextResponse.json({ error: "没有要朗读的内容" }, { status: 400 });
  const raw = getSetting(SETTINGS_KEYS.pronunciationAccent, user.id);
  const accent = raw === "gb" ? "gb" : "us";

  const audio = await ensureDictAudio(text, accent);
  if (!audio) return NextResponse.json({ error: "发音暂时不可用" }, { status: 503 });

  const bytes = fs.readFileSync(audio.filePath);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": audio.mime,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
