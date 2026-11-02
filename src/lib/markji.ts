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
 * 频控：10 秒 20 次 / 60 秒 40 次。这里用串行 + 最小间隔 600ms 兜住。
 */

const BASE = process.env.MARKJI_BASE_URL ?? "https://open.maimemo.com/open/api/v1/markji";

export function markjiToken(): string | null {
  return process.env.MARKJI_TOKEN || process.env.MAIMEMO_TOKEN || null;
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = markjiToken();
  if (!token) throw new MarkjiError("未配置 MARKJI_TOKEN 环境变量", 401);

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
export async function listDecks(): Promise<MarkjiDeck[]> {
  const data = await call<{ decks?: MarkjiDeck[] }>("/decks?limit=100");
  return (data.decks ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    card_count: d.card_count,
    chapter_count: d.chapter_count,
  }));
}

/** 列某个牌组下的章节 */
export async function listChapters(deckId: string): Promise<MarkjiChapter[]> {
  const data = await call<{ chapters?: MarkjiChapter[] }>(
    `/decks/${encodeURIComponent(deckId)}/chapters`,
  );
  return (data.chapters ?? []).map((c) => ({
    id: c.id,
    deck_id: c.deck_id,
    name: c.name,
    card_ids: c.card_ids,
  }));
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
export async function getCard(deckId: string, cardId: string): Promise<MarkjiCard> {
  const data = await call<{ card: MarkjiCard }>(
    `/decks/${encodeURIComponent(deckId)}/cards/${encodeURIComponent(cardId)}`,
  );
  if (!data?.card) throw new MarkjiError("墨墨没有返回卡片内容", 502);
  return data.card;
}
