"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import CefrBadge from "./CefrBadge";
import TextManageDialog, { CATEGORIES, type TextMeta } from "./TextManageDialog";
import { asCefrLevel, parseCefrDetail } from "@/lib/cefr";

export type TextCardRow = {
  id: string;
  title: string;
  sourceType: string;
  category: string | null;
  wordCount: number;
  createdAt: number;
  cefrLevel: string | null;
  cefrScore: number | null;
  cefrDetail: string | null;
  readRatio: number | null;
  /** P18：用户显式标记「已读完」的时间戳，null = 未标记。与进度百分比完全独立 */
  completedAt: number | null;
};

const SOURCE_STYLE: Record<string, { label: string; cls: string; color: string }> = {
  // 来源只是元信息，不上色（规范 §1.1：颜色只表达含义）
  paste: { label: "粘贴", cls: "duo-badge", color: "" },
  file: { label: "文件", cls: "duo-badge", color: "" },
  url: { label: "网页", cls: "duo-badge", color: "" },
};

const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;

/**
 * 阅读进度徽章（P18）：只表示「上次离开时滚到哪」，往回翻会下降。
 * 100% 也只显示「已读 100%」，绝不自动变成「已读完」—— 那由用户点按钮决定。
 */
function ReadBadge({ ratio }: { ratio: number | null }) {
  if (ratio === null || ratio < 0.02) return null;
  const pct = Math.round(Math.min(ratio, 1) * 100);
  return (
    <span
      className="duo-badge"
      title="上次离开时的滚动位置；往回翻会下降。100% 不等于已读完"
    >
      已读 {pct}%
    </span>
  );
}

/** 已读完：唯一判据是用户显式标记（completedAt），与进度无关 */
function CompletedBadge({ completedAt }: { completedAt: number | null }) {
  if (completedAt === null) return null;
  return (
    <span className="duo-badge duo-badge-success" title="你手动标记过已读完（阅读页可再点一次取消）">
      ✓ 已读完
    </span>
  );
}

/**
 * 「我的文本」列表（客户端组件，P16）。
 *
 * 服务端查好全量数据传入；分类 / 难度两排筛选 chip 在前端组合过滤，
 * 几条到几十条数据量不需要 URL 参数与路由参与。
 * 编辑（重命名 / 分类 / 删除）收敛在 TextManageDialog。
 */
export default function TextList({ rows }: { rows: TextCardRow[] }) {
  const [list, setList] = useState(rows);
  const [category, setCategory] = useState<string | "all">("all");
  const [level, setLevel] = useState<string | "all">("all");
  const [editing, setEditing] = useState<TextMeta | null>(null);

  // 文库里出现过的自定义分类也进筛选行（按数量排序，最多展示前 10 个）
  const customCats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of list) {
      if (r.category && !CATEGORIES.includes(r.category as (typeof CATEGORIES)[number])) {
        counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c]) => c);
  }, [list]);

  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of list) {
      const key = r.category ?? "";
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [list]);

  const levelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of list) {
      if (r.cefrLevel) m.set(r.cefrLevel, (m.get(r.cefrLevel) ?? 0) + 1);
    }
    return m;
  }, [list]);

  const shown = useMemo(() => {
    return list.filter((t) => {
      if (category !== "all") {
        const actual = t.category ?? "";
        if (actual !== category) return false;
      }
      if (level !== "all" && t.cefrLevel !== level) return false;
      return true;
    });
  }, [list, category, level]);

  const hasFilter = category !== "all" || level !== "all";
  const unclassified = catCounts.get("") ?? 0;

  function openEdit(t: TextCardRow) {
    setEditing({
      id: t.id,
      title: t.title,
      category: t.category,
      createdAt: t.createdAt,
      wordCount: t.wordCount,
      cefrLevel: t.cefrLevel,
    });
  }

  function applySaved(id: string, next: { title: string; category: string | null }) {
    setList((prev) => prev.map((t) => (t.id === id ? { ...t, ...next } : t)));
  }

  function applyDeleted(id: string) {
    setList((prev) => prev.filter((t) => t.id !== id));
  }

  function renderChip(key: string | "all", label: string, count: number | undefined, active: boolean, onClick: () => void) {
    return (
      <button
        key={key}
        type="button"
        className={`duo-filter-chip${active ? " duo-filter-chip-on" : ""}`}
        onClick={onClick}
        title={count !== undefined ? `${label} · ${count} 篇` : undefined}
      >
        {label}
      </button>
    );
  }

  return (
    <div>
      <div className="duo-section-title mb-4">
        我的文本
        <span className="text-sm font-semibold text-ink-soft">
          ({shown.length}
          {hasFilter ? `/${list.length}` : ""})
        </span>
      </div>

      {/* 筛选行：有分类数据才显示，避免空环境里两排无意义的 chip */}
      {(list.length > 0 && (catCounts.size > 1 || customCats.length > 0)) && (
        <div className="tm-filter-row">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tm-filter-label">分类</span>
            {renderChip("all", "全部", undefined, category === "all", () => setCategory("all"))}
            {unclassified > 0 &&
              renderChip("", "未分类", unclassified, category === "", () => setCategory(""))}
            {CATEGORIES.filter((c) => (catCounts.get(c) ?? 0) > 0).map((c) =>
              renderChip(c, c, catCounts.get(c), category === c, () => setCategory(c)),
            )}
            {customCats.map((c) =>
              renderChip(c, c, catCounts.get(c), category === c, () => setCategory(c)),
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="tm-filter-label">难度</span>
            {renderChip("all", "全部", undefined, level === "all", () => setLevel("all"))}
            {LEVELS.filter((l) => (levelCounts.get(l) ?? 0) > 0).map((l) =>
              renderChip(l, l, levelCounts.get(l), level === l, () => setLevel(l)),
            )}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        hasFilter ? (
          <div className="duo-card duo-empty">
            <div className="duo-empty-icon">🔍</div>
            <p className="text-lg font-bold mb-2">这个筛选条件下没有文本</p>
            <p className="text-sm text-ink-faint">
              <button
                type="button"
                className="underline underline-offset-2 font-bold"
                onClick={() => {
                  setCategory("all");
                  setLevel("all");
                }}
              >
                清除筛选
              </button>
            </p>
          </div>
        ) : (
          <div className="duo-card duo-empty">
            <div className="duo-empty-icon">🎯</div>
            <p className="text-lg font-bold mb-2">开始你的第一关</p>
            <p className="text-sm text-ink-faint">在右边粘贴一段文字，或上传一个 txt 文件</p>
          </div>
        )
      ) : (
        <ul className="space-y-3">
          {shown.map((t, i) => {
            const style = SOURCE_STYLE[t.sourceType] ?? SOURCE_STYLE.paste;
            const cefrDetail = parseCefrDetail(t.cefrDetail);
            return (
              <li key={t.id} className="relative group text-list-item">
                <Link href={`/texts/${t.id}`} className="duo-text-item block">
                  <div className="flex items-start gap-4">
                    <span className="duo-level-dot">{i + 1}</span>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-4 mb-2 pr-9">
                        <h2 className="text-base font-bold truncate">{t.title}</h2>
                        <span className="text-sm text-ink-soft shrink-0">
                          {t.wordCount.toLocaleString()} 词
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={style.cls}>{style.label}</span>
                        {t.category && (
                          <span className="duo-badge">{t.category}</span>
                        )}
                        <CefrBadge
                          level={asCefrLevel(t.cefrLevel)}
                          score={t.cefrScore ?? null}
                          detail={cefrDetail}
                        />
                        <ReadBadge ratio={t.readRatio} />
                        <CompletedBadge completedAt={t.completedAt} />
                        <span className="text-xs text-ink-soft">
                          {new Date(t.createdAt).toLocaleDateString("zh-CN")}
                        </span>
                        <span className="text-sm font-semibold text-ink-soft ml-auto group-hover:text-ink">
                          {t.completedAt !== null ? "继续回味 →" : "开始阅读 →"}
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
                <button
                  type="button"
                  className="duo-text-edit"
                  onClick={() => openEdit(t)}
                  title="编辑：重命名 / 分类 / 删除"
                  aria-label={`编辑文本 ${t.title}`}
                >
                  ✏️
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <TextManageDialog
          meta={editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => applySaved(editing.id, next)}
          onDeleted={applyDeleted}
        />
      )}
    </div>
  );
}
