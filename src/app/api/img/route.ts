import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 图片代理（P17）：`/api/img?u=<编码后的图片地址>`
 *
 * 为什么需要：不少站点对 <img> 校验 Referer（必须来自本站），浏览器直连
 * 即使带 no-referrer 也会被 403。前端 FigureBlock 直连失败后会换这里重试。
 * 服务端请求没有 Referer、UA 是正常浏览器，绝大多数防盗链都能过。
 *
 * 安全边界（单机单用户，仍收紧）：
 *   - 只接受 http(s) 绝对地址；不代理任意页面（content-type 必须是 image/*）
 *   - 大小上限 15MB
 *   - 按 URL 哈希落盘缓存（data/img-cache/，data/ 已 gitignore），重复阅读零请求
 */
const MAX_BYTES = 15 * 1024 * 1024;
const CACHE_DIR = path.join(process.cwd(), "data", "img-cache");

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};

function cachePath(u: string, ext: string): string {
  const h = createHash("sha256").update(u).digest("hex").slice(0, 32);
  return path.join(CACHE_DIR, `${h}.${ext}`);
}

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get("u");
  if (!u) return new Response("missing u", { status: 400 });

  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return new Response("only http(s)", { status: 400 });
  }

  // 命中缓存直接回（ext 未知时按类型挨个试太啰嗦：缓存文件名存 hash 无 ext 的话
  // 需要单独记 content-type；简化为「缓存时把类型写进同名 .meta 文件」）
  const metaFile = cachePath(u, "meta");
  if (existsSync(metaFile)) {
    try {
      const cached = JSON.parse(await readFile(metaFile, "utf8")) as { type: string; file: string };
      const body = await readFile(cached.file);
      return new Response(body, {
        headers: {
          "Content-Type": cached.type,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      /* 缓存损坏就重新拉 */
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.href, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      },
      redirect: "follow",
    });
  } catch {
    return new Response("upstream unreachable", { status: 502 });
  }
  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, { status: 502 });
  }

  const type = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) {
    return new Response("not an image", { status: 415 });
  }
  const len = Number(upstream.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) {
    return new Response("too large", { status: 413 });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    return new Response("too large", { status: 413 });
  }

  // 写缓存（失败不影响本次响应）
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const ext = EXT_BY_TYPE[type] ?? "bin";
    const file = cachePath(u, ext);
    await writeFile(file, buf);
    await writeFile(metaFile, JSON.stringify({ type, file }));
  } catch {
    /* 磁盘问题：直接透传，下次再试 */
  }

  return new Response(buf, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
