import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GONE = { error: "导出已改为在 我的词库 → 待推送 里完成" };

/** P33：旧的「直接导出」已下线，推送统一走 POST /api/cards/push。三种方法都返回 410。 */
export const GET = () => NextResponse.json(GONE, { status: 410 });
export const POST = () => NextResponse.json(GONE, { status: 410 });
export const PUT = () => NextResponse.json(GONE, { status: 410 });
