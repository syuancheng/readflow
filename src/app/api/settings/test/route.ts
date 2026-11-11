import { NextResponse } from "next/server";
import { resolveProvider } from "@/lib/config";
import { allSettings, ownSettings } from "@/lib/settings-store";
import { markjiTokenFor } from "@/lib/user-secrets";
import { testProvider } from "@/lib/providers";
import { withRetry } from "@/lib/retry";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/settings/test  { target: "ai", providerId?: string } */
export async function POST(req: Request) {
  // 测试连接会真实调用模型（花钱）。主账号测站级配置；普通账号只能测自己填的 Key
  // 和自己的墨墨 Token（P28），不能借测试接口白用站点的模型。
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
  let body: { target?: string; providerId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }

  if (body.target === "ai") {
    const p = user.isOwner
      ? resolveProvider(allSettings(), process.env, body.providerId)
      : resolveProvider(ownSettings(user.id), {}, body.providerId);
    if (!p) {
      return NextResponse.json({
        ok: false,
        error: "这个模型还没配好：请填入 API Key（自定义端点还需填 Base URL 和模型名）",
      });
    }
    try {
      const reply = await withRetry(() => testProvider(p), {
        attempts: 3,
        onRetry: ({ attempt, delayMs }) =>
          console.warn(`[settings/test] ${p.label} 第 ${attempt} 次失败，${delayMs}ms 后重试`),
      });
      return NextResponse.json({
        ok: true,
        detail: `${p.label} · ${p.model} 连接成功（返回：${reply.slice(0, 24)}）`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({
        ok: false,
        error: `${p.label} 连接失败（已自动重试）：${msg.slice(0, 300)}`,
      });
    }
  }

  if (body.target === "markji") {
    const { listDecks } = await import("@/lib/markji");
    try {
      const token = markjiTokenFor(user);
      if (!token) return NextResponse.json({ ok: false, error: "还没有填墨墨 Token" });
      const decks = await withRetry(() => listDecks(token), { attempts: 3 });
      return NextResponse.json({ ok: true, detail: `墨墨连接成功，读到 ${decks.length} 个牌组` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ ok: false, error: `墨墨验证失败（已自动重试）：${msg.slice(0, 300)}` });
    }
  }

  return NextResponse.json({ ok: false, error: "未知的测试目标" }, { status: 400 });
}
