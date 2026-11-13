/**
 * 墨墨记忆卡（Markji）开放 API 客户端。
 *
 * 三条硬边界（实测，别按 OpenAPI 文档写）：
 *   1. 只能写卡片和媒体 —— 不能建/删牌组，不能建/删章节，也不能删卡片。
 *      所以牌组和章节必须由用户在 App 或网页端先建好，我们只往里写卡。
 *   2. 创建卡片的请求体**必须省略** deck / chapter：服务端会按 24 位 ObjectId 校验，
 *      而开放 API 从不暴露 ObjectId，传了必报 `not a valid ObjectId`。
 *   3. 内容是不可逆的写入 —— 调用方必须先给用户看预览。
 *
 * Token 由「设置」页每个用户自己填，落本地 settings 表；
 * 环境变量 MARKJI_TOKEN / MAIMEMO_TOKEN 仅作为没配置时的兜底。
 *
 * 频控：10 秒 20 次 / 60 秒 40 次。写操作串行 + 最小间隔 600ms 兜住。
 */
import { resolveMarkjiToken } from "./config";
import { allSettings } from "./settings-store";
import { withRetry } from "./retry";

const BASE = process.env.MARKJI_BASE_URL ?? "https://open.maimemo.com/open/api/v1/markji";

export function markjiToken(): string | null {
  return resolveMarkjiToken(allSettings(), process.env);
}

export function hasMarkjiToken(): boolean {
  return markjiToken() !== null;
}

export type MarkjiDeck = {
  id: string;
  name: string;
  card_count?: number;
  chapter_count?: number;
};

export type MarkjiChapter = {
  id: string;
  deck_id: string;
  name: string;
  card_ids?: string[];
};

export type MarkjiCard = {
  id: string;
  root_id?: string;
  content: string;
};

type Envelope<T> = {
  success: boolean;
  errors: { code?: string; message?: string; info?: string }[];
  data: T;
};

export class MarkjiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MarkjiError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 写操作的串行闸门：保证相邻两次请求间隔 ≥600ms */
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>, minGap = 600): Promise<T> {
  const run = writeChain.then(async () => {
    await sleep(minGap);
    return fn();
  });
  // 链条不能因为单次失败断掉
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * token：调用方按账号传（lib/user-secrets.ts 的 markjiTokenFor）；
 * 不传（undefined）= 站级 Token，仅供命令行脚本使用；传 null = 这个账号没配。
 */
async function call<T>(path: string, init?: RequestInit, tokenArg?: string | null): Promise<T> {
  const token = tokenArg === undefined ? markjiToken() : tokenArg;
  if (!token) throw new MarkjiError("未配置墨墨 Token。请在右上角头像 → 设置里填入", 401);

  // 读操作遇到限流/网络抖动/服务端繁忙自动重试；写操作不重试，
  // 因为「写卡成功但响应丢失」重放会生成重复卡片。
  const isRead = !init?.method || init.method.toUpperCase() === "GET";
  const run = () => request<T>(path, token, init);
  return isRead ? withRetry(run, { attempts: 3, baseDelayMs: 700 }) : run();
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new MarkjiError(`墨墨返回了非 JSON 响应（HTTP ${res.status}）`, res.status);
  }

  if (!res.ok || !body?.success) {
    const first = body?.errors?.[0];
    throw new MarkjiError(
      first?.message || `墨墨接口错误（HTTP ${res.status}）`,
      res.status,
      first?.code,
    );
  }

  return body.data;
}

/** 列牌组。用户可能有很多牌组，取前 100 个够用（单用户场景）。 */
export async function listDecks(token?: string | null): Promise<MarkjiDeck[]> {
  const data = await call<{ decks?: MarkjiDeck[] }>("/decks?limit=100", undefined, token);
  return (data.decks ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    card_count: d.card_count,
    chapter_count: d.chapter_count,
  }));
}

/** 列某个牌组下的章节；withCards = true 时带上每章的 card_ids */
export async function listChapters(
  deckId: string,
  token?: string | null,
  opts: { withCards?: boolean } = {},
): Promise<MarkjiChapter[]> {
  const data = await call<{ chapters?: MarkjiChapter[] }>(
    `/decks/${encodeURIComponent(deckId)}/chapters${opts.withCards ? "?with_cards=true" : ""}`,
    undefined,
    token,
  );
  return (data.chapters ?? []).map((c) => ({
    id: c.id,
    deck_id: c.deck_id,
    name: c.name,
    card_ids: c.card_ids,
  }));
}

/**
 * 新建章节（2026-10 起开放 API 支持，但**不能删**，所以调用方必须先 listChapters 查重名）。
 * 请求体里的 deck 字段可能和建卡一样被服务端按 ObjectId 校验：先带上，命中
 * `not a valid ObjectId` 就去掉重试一次。
 */
export async function createChapter(
  deckId: string,
  name: string,
  token?: string | null,
): Promise<MarkjiChapter> {
  const path = `/decks/${encodeURIComponent(deckId)}/chapters`;
  const post = (body: Record<string, unknown>) =>
    serialize(() => call<{ chapter?: MarkjiChapter }>(path, { method: "POST", body: JSON.stringify(body) }, token));
  let data: { chapter?: MarkjiChapter };
  try {
    data = await post({ deck: deckId, name });
  } catch (err) {
    if (err instanceof MarkjiError && /ObjectId/i.test(err.message)) data = await post({ name });
    else throw err;
  }
  if (!data?.chapter?.id) throw new MarkjiError("墨墨没有返回章节 id", 502);
  const c = data.chapter;
  return { id: c.id, deck_id: c.deck_id ?? deckId, name: c.name ?? name, card_ids: c.card_ids };
}

/**
 * 创建一张卡片。
 * 注意：请求体里只放 card —— deck / chapter 由 URL 路径决定。
 * 不传 order：往非空章节追加时按提交顺序落到末尾（传 0 会插到最前面）。
 */
export async function createCard(
  deckId: string,
  chapterId: string,
  content: string,
  token?: string | null,
): Promise<MarkjiCard> {
  const data = await serialize(() =>
    call<{ card: MarkjiCard }>(
      `/decks/${encodeURIComponent(deckId)}/chapters/${encodeURIComponent(chapterId)}/cards`,
      {
        method: "POST",
        body: JSON.stringify({
          card: { content, grammar_version: 3 },
        }),
      },
      token,
    ),
  );

  if (!data?.card?.id) throw new MarkjiError("墨墨没有返回卡片 id", 502);
  return data.card;
}

/**
 * 更新一张卡片的内容。
 *
 * 与 create 不同，这个接口**按文档工作**：请求体里的 deck_id / card_id 要一起传，
 * 且 content 是**全量替换**而不是补丁 —— 所以改卡前必须先取回原内容，
 * 在原有语法骨架上改，否则会把整张卡冲掉。
 */
export async function updateCard(
  deckId: string,
  cardId: string,
  content: string,
): Promise<MarkjiCard> {
  const data = await serialize(() =>
    call<{ card: MarkjiCard }>(
      `/decks/${encodeURIComponent(deckId)}/cards/${encodeURIComponent(cardId)}`,
      {
        method: "POST",
        body: JSON.stringify({
          deck_id: deckId,
          card_id: cardId,
          card: { content, grammar_version: 3 },
        }),
      },
    ),
  );

  if (!data?.card?.id) throw new MarkjiError("墨墨没有返回卡片 id", 502);
  return data.card;
}

/** 读回一张卡片（改卡前先取原内容，避免全量替换时丢掉别的部分） */
export async function getCard(deckId: string, cardId: string, token?: string | null): Promise<MarkjiCard> {
  const data = await call<{ card: MarkjiCard }>(
    `/decks/${encodeURIComponent(deckId)}/cards/${encodeURIComponent(cardId)}`,
    undefined,
    token,
  );
  if (!data?.card) throw new MarkjiError("墨墨没有返回卡片内容", 502);
  return data.card;
}
