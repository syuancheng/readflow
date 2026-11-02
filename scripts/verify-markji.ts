/**
 * 临时验证脚本：用我们自己的 markji.ts 客户端做**只读**调用，
 * 证明 base URL、Bearer 鉴权、响应信封解析、路径编码都是对的。
 *
 * 不做任何写入（写卡是主流程，由 /api/export 在用户确认后执行）。
 *
 * 用法：node .verify/scripts/verify-markji.js [deckId]
 */

import { hasMarkjiToken, listDecks, listChapters, MarkjiError } from "../src/lib/markji";

async function main() {
  if (!hasMarkjiToken()) {
    console.error("✗ 没有读到 MARKJI_TOKEN（.env 是否在项目根目录？）");
    process.exit(1);
  }
  console.log("✓ 已读到令牌（不打印内容）");

  try {
    const decks = await listDecks();
    console.log(`✓ 牌组列表：${decks.length} 个`);
    for (const d of decks.slice(0, 5)) {
      console.log(`   - ${d.name}  (§${d.id.slice(0, 12)}…  卡片 ${d.card_count ?? "?"})`);
    }

    const target = process.argv[2] ?? decks.find((d) => (d.card_count ?? 0) > 0)?.id;
    if (!target) {
      console.log("（没有可用于测章节的牌组）");
      return;
    }

    const chapters = await listChapters(target);
    console.log(`✓ 章节列表：${chapters.length} 个（牌组 ${target.slice(0, 12)}…）`);
    for (const c of chapters.slice(0, 5)) {
      console.log(`   - ${c.name}  (${(c.card_ids ?? []).length} 张卡)`);
    }
  } catch (err) {
    if (err instanceof MarkjiError) {
      console.error(`✗ 墨墨报错 HTTP ${err.status} ${err.code ?? ""}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main();
