import { and, eq, gte, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { exports, userWords } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getSetting } from "@/lib/settings-store";
import { markjiTokenFor } from "@/lib/user-secrets";
import { CARD_TYPES } from "@/lib/cardgen";
import ExportPanel from "@/components/ExportPanel";

export const dynamic = "force-dynamic";

const DAILY_CAP = 600;

/** 一次最多导出多少个词，和 /api/export 的 MAX_WORDS_PER_RUN 一致 */
const MAX_SELECTED = 200;

/**
 * 只导出词库里勾选的词（P27）：词库页把选中的词 id 放在 ?ids=a,b,c 里带过来。
 * 没带 ids 就不提供导出，引导回词库勾选 —— 不再默认导出整个词库。
 */
export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids = "" } = await searchParams;
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(ids ? `/export?ids=${ids}` : "/export")}`);
  const requested = [...new Set(ids.split(",").map((x) => x.trim()).filter(Boolean))];
  // 只认自己名下的词；顺序跟词库里勾选时一致
  const found = requested.length
    ? db
        .select({ id: userWords.id, displayForm: userWords.displayForm })
        .from(userWords)
        .where(and(eq(userWords.userId, user.id), inArray(userWords.id, requested)))
        .all()
    : [];
  const byId = new Map(found.map((w) => [w.id, w]));
  const selected = requested.map((id) => byId.get(id)).filter((w) => !!w).slice(0, MAX_SELECTED);
  const overLimit = requested.length > MAX_SELECTED;
  const doneIds = new Set(
    selected.length
      ? db
          .select({ id: exports.userWordId })
          .from(exports)
          .where(
            and(
              inArray(
                exports.userWordId,
                selected.map((w) => w.id),
              ),
              eq(exports.status, "done"),
              eq(exports.target, "markji"),
            ),
          )
          .all()
          .map((r) => r.id)
      : [],
  );
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const wordCount = db
    .select({ c: sql<number>`count(*)` })
    .from(userWords)
    .where(eq(userWords.userId, user.id))
    .get();

  // exports 没有 user_id 列，必须经 user_words 关联才能只统计自己的卡片
  const exportedByType = db
    .select({ t: exports.cardType, c: sql<number>`count(*)` })
    .from(exports)
    .innerJoin(userWords, eq(exports.userWordId, userWords.id))
    .where(and(eq(exports.status, "done"), eq(exports.target, "markji"), eq(userWords.userId, user.id)))
    .groupBy(exports.cardType)
    .all();

  const todayPushed = db
    .select({ c: sql<number>`count(*)` })
    .from(exports)
    .innerJoin(userWords, eq(exports.userWordId, userWords.id))
    .where(
      and(
        eq(exports.status, "done"),
        eq(exports.target, "markji"),
        eq(userWords.userId, user.id),
        gte(exports.pushedAt, todayStart.getTime()),
      ),
    )
    .get();

  // 站级默认 + 本人覆盖；直接从 settings 全表读会把别人的行混进来
  const deckId = getSetting("markji.deck", user.id) ?? "";
  const chapterId = getSetting("markji.chapter", user.id) ?? "";

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
          把词库里勾选的词做成卡片推进墨墨。同一个词在同一个牌组只会推一次。
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-7">
        <Stat value={total} label="词库词数" icon="⚡" />
        <Stat value={exported} label="已推送卡片" icon="📤" />
        <Stat value={Number(todayPushed?.c ?? 0)} label="今日已推" icon="📅" />
      </div>

      {selected.length === 0 ? (
        <div className="duo-card duo-empty">
          <div className="duo-empty-icon">☑️</div>
          <p className="text-[17px] font-bold mb-1.5">还没有选要导出的词</p>
          <p className="text-[14px] text-ink-faint">
            到词库里勾选要导出的词，再点工具栏上的「导出选中的词到墨墨」。
          </p>
          <Link href="/words" className="duo-btn duo-btn-primary mt-5">
            去词库勾选
          </Link>
        </div>
      ) : (
        <>
          <div className="duo-card p-6 mb-5" data-testid="export-selection">
            <div className="duo-section-title mb-3">
              <span style={{ color: "var(--duo-green)" }}>☑️</span>
              本次导出：选中的 {selected.length} 个词
            </div>
            <div className="flex flex-wrap gap-2">
              {selected.map((w) => (
                <span
                  key={w.id}
                  className={`duo-badge ${doneIds.has(w.id) ? "duo-badge-green" : "duo-badge-blue"}`}
                  title={doneIds.has(w.id) ? "已导出过，同牌组同类型的卡片会自动跳过" : undefined}
                >
                  {w.displayForm}
                  {doneIds.has(w.id) ? " ✓" : ""}
                </span>
              ))}
            </div>
            {overLimit && (
              <p className="text-[12.5px] font-bold mt-3" style={{ color: "var(--duo-orange-dark)" }}>
                一次最多导出 {MAX_SELECTED} 个词，这次只导前 {MAX_SELECTED} 个，剩下的导完再选一次。
              </p>
            )}
            {selected.some((w) => doneIds.has(w.id)) && (
              <p className="text-[12.5px] font-medium text-ink-faint mt-3">
                带 ✓ 的词已经导出过：同一牌组里已有的卡片类型会自动跳过，不会重复。
              </p>
            )}
          </div>

          <ExportPanel
            tokenReady={Boolean(markjiTokenFor(user))}
            initialDeckId={deckId}
            initialChapterId={chapterId}
            wordIds={selected.map((w) => w.id)}
            todayPushed={Number(todayPushed?.c ?? 0)}
            dailyCap={DAILY_CAP}
          />
        </>
      )}

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
