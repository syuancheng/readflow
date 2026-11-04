import { and, eq, gte, ne, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { exports, settings, userWords, LOCAL_USER } from "@/db/schema";
import { hasMarkjiToken } from "@/lib/markji";
import { CARD_TYPES } from "@/lib/cardgen";
import ExportPanel from "@/components/ExportPanel";

export const dynamic = "force-dynamic";

const DAILY_CAP = 600;

export default async function ExportPage() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 词库词数
  const wordCount = db
    .select({ c: sql<number>`count(*)` })
    .from(userWords)
    .where(eq(userWords.userId, LOCAL_USER))
    .get();

  const exportedByType = db
    .select({ t: exports.cardType, c: sql<number>`count(*)` })
    .from(exports)
    .where(eq(exports.status, "done"))
    .groupBy(exports.cardType)
    .all();

  const todayPushed = db
    .select({ c: sql<number>`count(*)` })
    .from(exports)
    .where(and(eq(exports.status, "done"), gte(exports.pushedAt, todayStart.getTime())))
    .get();

  const cfg = Object.fromEntries(
    db.select().from(settings).all().map((r) => [r.key, r.value]),
  );

  const total = Number(wordCount?.c ?? 0);
  const exported = exportedByType.reduce((s, r) => s + Number(r.c), 0);
  const types = CARD_TYPES.length;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-6">
        <Link href="/words" className="duo-nav-link inline-block">
          ← 返回词库
        </Link>
        <h1 className="text-[28px] font-extrabold tracking-tight mt-3 mb-2">
          导出到墨墨记忆卡
        </h1>
        <p className="text-[15px] font-medium text-ink-soft">
          把词库里的词做成卡片推进墨墨。同一个词在同一个牌组只会推一次。
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-7">
        <Stat value={total} label="词库词数" icon="⚡" />
        <Stat value={exported} label="已推送卡片" icon="📤" />
        <Stat value={Number(todayPushed?.c ?? 0)} label="今日已推" icon="📅" />
      </div>

      <ExportPanel
        tokenReady={hasMarkjiToken()}
        initialDeckId={cfg["markji.deck"] ?? ""}
        initialChapterId={cfg["markji.chapter"] ?? ""}
        wordCount={total}
        todayPushed={Number(todayPushed?.c ?? 0)}
        dailyCap={DAILY_CAP}
      />

      <p className="text-[12.5px] font-medium text-ink-faint mt-6 leading-relaxed">
        卡片内容完全由数据库拼装，不经过 AI：词、音标、释义、原句都来自你收词时存下的数据。
        最多可选 {types} 种卡片类型，每种类型每个词一张。
      </p>
    </div>
  );
}

function Stat({ value, label, icon }: { value: number; label: string; icon: string }) {
  return (
    <div className="duo-card px-4 py-4 text-center">
      <div className="text-[18px] leading-none mb-1.5">{icon}</div>
      <div className="text-[24px] font-extrabold leading-tight">{value.toLocaleString()}</div>
      <div className="text-[12px] font-bold text-ink-faint mt-0.5">{label}</div>
    </div>
  );
}
