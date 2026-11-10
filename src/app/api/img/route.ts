import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 图片代理（P17）：`/api/img?u=<编码后的图片地址>`
 *
 * 为什么需要：不少站点对 <img> 校验 Referer（必须来自本站），浏览器直连
 * 即使带 no-referrer 也会被 403。前端 FigureBlock 直连失败后会换这里重试。
 * 服务端请求没有 Referer、UA 是正常浏览器，绝大多数防盗链都能过。
 *
 * 安全边界：
 *   - 必须登录（<img> 同源请求自带 cookie）
 *   - 只接受解析到公网地址的 http(s) URL，重定向逐跳复检（防 SSRF 探内网）
 *   - 不代理任意页面（content-type 必须是 image/*）；响应带 CSP sandbox + nosniff（防 SVG XSS）
 *   - 大小上限 15MB；按 URL 哈希落盘缓存（data/img-cache/），总量超 300MB 按旧到新清理
 */
const MAX_BYTES = 15 * 1024 * 1024;
const CACHE_DIR = path.join(process.cwd(), "data", "img-cache");
/** 磁盘缓存总量上限，超出按最久未写入的先删 */
const CACHE_MAX_BYTES = 300 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * 代理返回的内容与本站同源：SVG 能带脚本，直接打开 /api/img?u=恶意.svg 就会在
 * ReadFlow 的源里执行。用 CSP sandbox 把响应关进沙箱，并禁止 MIME 嗅探。
 */
const SAFE_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
};

/** 内网 / 本机 / 保留地址：代理不能被用来探测服务所在的局域网（SSRF） */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE.addSubnet(net, prefix, "ipv6");

function isPrivateAddress(addr: string): boolean {
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return PRIVATE.check(mapped[1], "ipv4");
  const fam = isIP(addr);
  if (fam === 4) return PRIVATE.check(addr, "ipv4");
  if (fam === 6) return PRIVATE.check(addr, "ipv6");
  return true;
}

/** 只允许解析到公网地址的 http(s) URL */
async function isPublicUrl(u: URL): Promise<boolean> {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** 手动跟随重定向：每一跳都重新校验，防止公网地址 302 到内网 */
async function fetchPublic(start: URL, init: RequestInit): Promise<Response | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublicUrl(url))) return null;
    const res = await fetch(url.href, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    return res;
  }
  return null;
}

async function pruneCache(): Promise<void> {
  const names = await readdir(CACHE_DIR);
  const files = await Promise.all(
    names.map(async (n) => {
      const full = path.join(CACHE_DIR, n);
      const st = await stat(full).catch(() => null);
      return st ? { full, size: st.size, mtime: st.mtimeMs } : null;
    }),
  );
  const list = files.filter((f): f is NonNullable<typeof f> => f !== null);
  let total = list.reduce((sum, f) => sum + f.size, 0);
  if (total <= CACHE_MAX_BYTES) return;
  list.sort((a, b) => a.mtime - b.mtime);
  for (const f of list) {
    if (total <= CACHE_MAX_BYTES) break;
    await unlink(f.full).catch(() => undefined);
    total -= f.size;
  }
}

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
  // <img> 同源请求会带 cookie；不登录就不给用，避免变成谁都能用的开放代理
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
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
          "Cache-Control": "private, max-age=31536000, immutable",
          ...SAFE_HEADERS,
        },
      });
    } catch {
      /* 缓存损坏就重新拉 */
    }
  }

  let upstream: Response | null;
  try {
    upstream = await fetchPublic(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return new Response("upstream unreachable", { status: 502 });
  }
  if (!upstream) return new Response("forbidden target", { status: 403 });
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
    await pruneCache();
  } catch {
    /* 磁盘问题：直接透传，下次再试 */
  }

  return new Response(buf, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "private, max-age=31536000, immutable",
      ...SAFE_HEADERS,
    },
  });
}
