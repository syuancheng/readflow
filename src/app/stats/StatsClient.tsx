"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import CefrBadge from "@/components/CefrBadge";
import HeatCalendar, {
  HeatLegend,
  LISTENING_HEAT_THRESHOLDS,
  READING_HEAT_THRESHOLDS,
} from "@/components/HeatCalendar";
import Icon from "@/components/Icon";
import {
  formatCompactCount,
  formatDurationHero,
  formatMinutes,
  LISTENING_MODE_LABEL,
  type ListeningMode,
} from "@/lib/listening";
import type { DayStat, ListeningStats, ReadingStats } from "@/lib/stats";
import { parseKey } from "@/lib/streak";

type Tab = "reading" | "listening";

type WordChip = {
  id: string;
  displayForm: string;
};

type Props = {
  initialTab: Tab;
  todayKey: string;
  reading: ReadingStats;
  initialListening: ListeningStats;
  recentWords: WordChip[];
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const QUICK_MINUTES = [5, 15, 30, 60] as const;

function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}-${day}`;
}

export default function StatsClient({
  initialTab,
  todayKey,
  reading,
  initialListening,
  recentWords,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [listening, setListening] = useState<ListeningStats>(initialListening);

  // 听力手动录入表单状态
  const [minutesInput, setMinutesInput] = useState("");
  const [mode, setMode] = useState<ListeningMode>("intensive");
  const [logDate, setLogDate] = useState(todayKey);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 删除二次确认状态（原地轻量确认，不弹窗）
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function switchTab(next: Tab) {
    setTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next === "listening") {
        url.searchParams.set("tab", "listening");
      } else {
        url.searchParams.delete("tab");
      }
      window.history.replaceState(null, "", url.toString());
    }
  }

  async function handleListeningSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const trimmed = minutesInput.trim();
    if (!trimmed) {
      setFormError("请输入听懂时长（分钟）");
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 600) {
      setFormError("时长需在 0.1 到 600 分钟之间（如 0.5 表示 30 秒）");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/listening-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minutes: parsed,
          logDate: logDate || todayKey,
          mode,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(data?.error ?? "保存失败，请稍后重试");
        return;
      }
      if (data?.stats) {
        setListening(data.stats);
      }
      setMinutesInput("");
      setNote("");
      setLogDate(todayKey);
    } catch {
      setFormError("网络异常，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteLog(id: string) {
    setDeletingId(id);
    setFormError(null);
    try {
      const res = await fetch(`/api/listening-logs/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFormError(data?.error ?? "删除失败，请稍后重试");
        return;
      }
      if (data?.stats) {
        setListening(data.stats);
      }
      setConfirmDeleteId(null);
    } catch {
      setFormError("网络异常，请稍后重试");
    } finally {
      setDeletingId(null);
    }
  }

  const listeningHero = formatDurationHero(listening.totalMinutes);

  return (
    <div className="rf-container rf-page">
      {/* 顶栏说明 + 阅读/听力分段切换 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <p className="text-sm text-ink-soft">
          看看你真正读懂了多少词、听懂了多少分钟。
        </p>

        <div className="rf-seg self-start sm:self-auto" role="tablist" aria-label="战绩维度">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "reading"}
            className={`duo-tab ${tab === "reading" ? "duo-tab-active" : ""}`}
            onClick={() => switchTab("reading")}
          >
            阅读
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "listening"}
            className={`duo-tab ${tab === "listening" ? "duo-tab-active" : ""}`}
            onClick={() => switchTab("listening")}
          >
            听力
          </button>
        </div>
      </div>

      {tab === "reading" ? (
        <>
          {/* 阅读核心四连卡 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <StatCard
              label="累计读懂词数"
              value={reading.totalWords.toLocaleString("en-US")}
              unit="词"
              subLabel={
                reading.weekWords > 0
                  ? `本周 ${reading.weekWords.toLocaleString("en-US")} 词`
                  : undefined
              }
            />
            <StatCard
              label="今日读懂词数"
              value={reading.todayWords.toLocaleString("en-US")}
              unit="词"
              subLabel={`本月 ${reading.monthWords.toLocaleString("en-US")} 词`}
            />
            <StatCard
              label="已读完篇数"
              value={reading.completedCount.toLocaleString("en-US")}
              unit="篇"
            />
            <StatCard
              label="连续阅读天数"
              value={String(reading.streakDays)}
              unit="天"
              subLabel={`最长 ${reading.bestStreak} 天`}
            />
          </div>

          {/* 学习日历 + 最近 14 天柱状图 */}
          <div className="grid gap-6 mb-6 lg:grid-cols-[auto_minmax(0,1fr)]">
            <div className="duo-card p-4 sm:p-6">
              <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
                <h2 className="duo-section-title">学习日历</h2>
                <HeatLegend />
              </div>

              <HeatCalendar
                cells={reading.calendar}
                thresholds={READING_HEAT_THRESHOLDS}
                unitLabel="词"
              />

              <p className="text-sm text-ink-soft mt-4 pt-4 border-t border-[var(--rf-border)]">
                {reading.activeDays === 0 ? (
                  <>读完一篇文章后，点击阅读页右上角的「标记已读完」，它的词数就会计入这里。</>
                ) : (
                  <>
                    共 <b className="text-ink">{reading.activeDays}</b> 天有完读记录
                    {reading.bestStreak > 1 && (
                      <>
                        ，最长连续 <b className="text-ink">{reading.bestStreak}</b> 天
                      </>
                    )}
                  </>
                )}
              </p>
            </div>

            <RecentBarChart
              title="最近 14 天（每日读懂词数）"
              recent={reading.recent}
              unitLabel="词"
              emptyHint={
                reading.totalWords === 0
                  ? "还没有已读完的文章 —— 读完一篇并点击「标记已读完」即可点亮。"
                  : undefined
              }
            />
          </div>

          {/* 最近读完的文章 */}
          <div className="duo-card p-4 sm:p-6">
            <div className="flex items-baseline justify-between gap-4 mb-2">
              <h2 className="duo-section-title">最近读完的文章</h2>
              {reading.completedCount > 0 && (
                <span className="text-xs text-ink-soft">
                  显示最近 {reading.recentCompleted.length} 篇
                </span>
              )}
            </div>

            {reading.recentCompleted.length === 0 ? (
              <p className="text-sm text-ink-soft py-6">
                读完一篇文章后，点击阅读页右上角的「标记已读完」，它的词数就会计入这里。
                <Link
                  href="/"
                  className="text-ink font-semibold underline underline-offset-2 ml-2"
                >
                  去书架挑一篇
                </Link>
              </p>
            ) : (
              <ul className="divide-y divide-[var(--rf-border)]">
                {reading.recentCompleted.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/texts/${t.id}`}
                      className="flex items-center justify-between gap-4 min-h-14 -mx-3 px-3 py-3 rounded-md hover:bg-[var(--rf-bg-hover)] transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-base font-semibold truncate">{t.title}</span>
                        <CefrBadge
                          level={t.cefrLevel}
                          score={t.cefrScore}
                          detail={t.cefrDetail}
                        />
                      </div>
                      <div className="flex items-center gap-4 shrink-0 text-sm">
                        <span className="text-ink-soft">
                          {formatMonthDay(t.completedAt)}
                        </span>
                        <span className="font-semibold text-ink">
                          {t.wordCount.toLocaleString("en-US")} 词
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 收集生词降级至页尾，默认折叠，避免干扰核心里程指标 */}
          {recentWords.length > 0 && (
            <details className="duo-card p-4 sm:p-6 mt-6">
              <summary className="text-sm font-semibold text-ink-soft cursor-pointer select-none">
                最近收下的词（{recentWords.length}）
              </summary>
              <div className="flex flex-wrap gap-2 mt-4">
                {recentWords.map((w) => (
                  <span
                    key={w.id}
                    className="inline-flex items-center h-8 px-3 rounded-full text-sm font-semibold"
                    style={{
                      background: "var(--rf-bg-subtle)",
                      color: "var(--rf-text-primary)",
                    }}
                  >
                    {w.displayForm}
                  </span>
                ))}
              </div>
            </details>
          )}
        </>
      ) : (
        <>
          {/* 听力核心四连卡（与阅读对称） */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <StatCard
              label="累计听懂时长"
              value={listeningHero.value}
              unit={listeningHero.unit}
              subLabel={
                listeningHero.subLabel ??
                (listening.weekMinutes > 0
                  ? `本周 ${formatMinutes(listening.weekMinutes)} 分钟`
                  : undefined)
              }
            />
            <StatCard
              label="今日听懂时长"
              value={formatMinutes(listening.todayMinutes)}
              unit="分钟"
              subLabel={`本月 ${formatMinutes(listening.monthMinutes)} 分钟`}
            />
            <StatCard
              label="累计记录次数"
              value={listening.logCount.toLocaleString("en-US")}
              unit="次"
            />
            <StatCard
              label="连续听力天数"
              value={String(listening.streakDays)}
              unit="天"
              subLabel={`最长 ${listening.bestStreak} 天`}
            />
          </div>

          {/* 极简手动录入卡（展开即用、无嵌套框、唯一墨绿主按钮） */}
          <div className="duo-card p-4 sm:p-6 mb-6">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
              <h2 className="duo-section-title">记录听力</h2>
              <span className="text-xs text-ink-soft">
                建议只记关掉字幕真正听懂的音频净时长；未来站内支持上传音频后将自动累计。
              </span>
            </div>

            <form onSubmit={handleListeningSubmit}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[144px_144px_156px_minmax(0,1fr)_auto] gap-3 items-end">
                <div>
                  <label
                    htmlFor="listening-minutes"
                    className="block text-xs font-semibold text-ink-soft mb-1"
                  >
                    听懂时长（分钟）
                  </label>
                  <input
                    id="listening-minutes"
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min="0.1"
                    max="600"
                    value={minutesInput}
                    onChange={(e) => setMinutesInput(e.target.value)}
                    placeholder="如 15 或 0.5"
                    className="rf-field-input"
                    required
                  />
                </div>

                <div>
                  <span className="block text-xs font-semibold text-ink-soft mb-1">
                    练习类型
                  </span>
                  <div className="rf-seg w-full h-11 items-center">
                    {(["intensive", "extensive"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={`duo-tab flex-1 ${mode === m ? "duo-tab-active" : ""}`}
                      >
                        {LISTENING_MODE_LABEL[m]}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="listening-date"
                    className="block text-xs font-semibold text-ink-soft mb-1"
                  >
                    日期
                  </label>
                  <input
                    id="listening-date"
                    type="date"
                    max={todayKey}
                    value={logDate}
                    onChange={(e) => setLogDate(e.target.value)}
                    className="rf-field-input"
                  />
                </div>

                <div>
                  <label
                    htmlFor="listening-note"
                    className="block text-xs font-semibold text-ink-soft mb-1"
                  >
                    备注（选填）
                  </label>
                  <input
                    id="listening-note"
                    type="text"
                    maxLength={200}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="材料名或主题，如新托福短对话 #12"
                    className="rf-field-input"
                  />
                </div>

                <button
                  type="submit"
                  className="duo-btn duo-btn-primary w-full lg:w-auto h-11"
                  disabled={submitting}
                >
                  {submitting ? "记录中…" : "记录"}
                </button>
              </div>

              {/* 快捷时长填充 chip */}
              <div className="flex items-center gap-2 flex-wrap mt-3">
                <span className="text-xs text-ink-soft">快捷填入：</span>
                {QUICK_MINUTES.map((m) => {
                  const active = minutesInput.trim() === String(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setMinutesInput(String(m));
                        setFormError(null);
                      }}
                      className={`rf-chip ${active ? "rf-chip-active" : ""}`}
                    >
                      {m} 分钟
                    </button>
                  );
                })}
              </div>

              {formError && (
                <p
                  className="text-sm mt-3"
                  style={{ color: "var(--rf-danger-text)" }}
                  role="alert"
                >
                  {formError}
                </p>
              )}
            </form>
          </div>

          {/* 听力日历 + 最近 14 天柱状图 */}
          <div className="grid gap-6 mb-6 lg:grid-cols-[auto_minmax(0,1fr)]">
            <div className="duo-card p-4 sm:p-6">
              <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
                <h2 className="duo-section-title">听力日历</h2>
                <HeatLegend />
              </div>

              <HeatCalendar
                cells={listening.calendar}
                thresholds={LISTENING_HEAT_THRESHOLDS}
                unitLabel="分钟"
              />

              <p className="text-sm text-ink-soft mt-4 pt-4 border-t border-[var(--rf-border)]">
                {listening.activeDays === 0 ? (
                  <>还没有听力记录 —— 在上方记下今天真正听懂的时长，日历就会点亮。</>
                ) : (
                  <>
                    共 <b className="text-ink">{listening.activeDays}</b> 天有听力记录
                    {listening.bestStreak > 1 && (
                      <>
                        ，最长连续 <b className="text-ink">{listening.bestStreak}</b> 天
                      </>
                    )}
                  </>
                )}
              </p>
            </div>

            <RecentBarChart
              title="最近 14 天（每日听懂分钟）"
              recent={listening.recent}
              unitLabel="分钟"
              emptyHint={
                listening.totalMinutes === 0
                  ? "还没有听力记录 —— 每次听懂一段音频（哪怕 0.5 分钟）都可以记下来。"
                  : undefined
              }
            />
          </div>

          {/* 最近听力记录列表 */}
          <div className="duo-card p-4 sm:p-6">
            <div className="flex items-baseline justify-between gap-4 mb-2">
              <h2 className="duo-section-title">最近听力记录</h2>
              {listening.logCount > 0 && (
                <span className="text-xs text-ink-soft">
                  显示最近 {listening.recentLogs.length} 条
                </span>
              )}
            </div>

            {listening.recentLogs.length === 0 ? (
              <p className="text-sm text-ink-soft py-6">
                还没有听力记录 —— 在上方记下你今天真正听懂的第一段音频吧。
              </p>
            ) : (
              <ul className="divide-y divide-[var(--rf-border)]">
                {listening.recentLogs.map((item) => {
                  const isConfirming = confirmDeleteId === item.id;
                  const isDeleting = deletingId === item.id;
                  return (
                    <li
                      key={item.id}
                      className="group flex items-center justify-between gap-4 min-h-14 py-3"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-wrap sm:flex-nowrap">
                        <span className="text-sm text-ink-soft shrink-0">
                          {item.logDate}
                        </span>
                        <span
                          className="inline-flex items-center h-6 px-2 rounded-sm text-xs font-semibold shrink-0"
                          style={{
                            background:
                              item.mode === "intensive"
                                ? "var(--rf-bg-selected)"
                                : "var(--rf-bg-subtle)",
                            color: "var(--rf-text-primary)",
                          }}
                        >
                          {LISTENING_MODE_LABEL[item.mode]}
                        </span>
                        {item.source === "audio" && (
                          <span
                            className="inline-flex items-center h-6 px-2 rounded-sm text-xs font-semibold shrink-0"
                            style={{
                              background: "var(--rf-success-soft)",
                              color: "var(--rf-success-text)",
                            }}
                          >
                            自动
                          </span>
                        )}
                        <span className="text-base text-ink truncate">
                          {item.note || "听力练习"}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-sm font-semibold text-ink">
                          +{formatMinutes(item.minutes)} 分钟
                        </span>

                        {isConfirming ? (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => handleDeleteLog(item.id)}
                              className="text-xs font-semibold px-2 h-7 rounded-sm cursor-pointer"
                              style={{
                                background: "var(--rf-danger-soft)",
                                color: "var(--rf-danger-text)",
                              }}
                            >
                              {isDeleting ? "删除中…" : "确认删除"}
                            </button>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteId(null)}
                              className="text-xs font-semibold px-2 h-7 rounded-sm text-ink-soft hover:text-ink cursor-pointer"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            aria-label="删除这条记录"
                            title="删除"
                            onClick={() => setConfirmDeleteId(item.id)}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-sm text-ink-soft hover:text-[var(--rf-danger-text)] hover:bg-[var(--rf-danger-soft)] transition-all sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 cursor-pointer"
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  unit,
  subLabel,
}: {
  label: string;
  value: string;
  unit: string;
  subLabel?: string;
}) {
  return (
    <div className="duo-card p-4 sm:p-6 flex flex-col justify-between">
      <div className="text-sm text-ink-soft">{label}</div>
      <div className="flex items-baseline gap-1 mt-2">
        <span className="text-3xl font-extrabold">{value}</span>
        <span className="text-sm font-semibold text-ink-soft">{unit}</span>
      </div>
      <div className="text-xs text-ink-soft mt-2 min-h-4">{subLabel ?? ""}</div>
    </div>
  );
}

function RecentBarChart({
  title,
  recent,
  unitLabel,
  emptyHint,
}: {
  title: string;
  recent: DayStat[];
  unitLabel: string;
  emptyHint?: string;
}) {
  const maxBar = Math.max(0.1, ...recent.map((r) => r.count));

  return (
    <div className="duo-card p-4 sm:p-6 flex flex-col">
      <h2 className="duo-section-title mb-4">{title}</h2>
      <div className="flex justify-between gap-2 flex-1 min-h-40">
        {recent.map((d, i) => {
          const h = d.count > 0 ? Math.round((d.count / maxBar) * 100) : 0;
          const isToday = i === recent.length - 1;
          const empty = d.count <= 0;
          const weekdayLabel = isToday
            ? "今"
            : i % 2 === 0
              ? WEEKDAYS[parseKey(d.date).getDay()]
              : "";
          return (
            <div
              key={d.date}
              title={`${d.date} · ${formatMinutes(d.count)} ${unitLabel}`}
              className="flex-1 h-full flex flex-col items-center gap-1"
            >
              <span className="text-xs font-semibold text-ink-soft min-h-4">
                {formatCompactCount(d.count)}
              </span>
              <div className="w-full flex-1 flex items-end">
                <div
                  className="w-full rounded-sm"
                  style={{
                    height: `${Math.max(h, 4)}%`,
                    background: empty
                      ? "var(--rf-bg-selected)"
                      : isToday
                        ? "var(--rf-data)"
                        : "var(--rf-heat-2)",
                  }}
                />
              </div>
              <span
                className="text-xs min-h-4"
                style={{
                  color: isToday
                    ? "var(--rf-text-primary)"
                    : "var(--rf-text-secondary)",
                  fontWeight: isToday ? 700 : 400,
                }}
              >
                {weekdayLabel}
              </span>
            </div>
          );
        })}
      </div>
      {emptyHint && (
        <p className="text-sm text-ink-soft mt-4 pt-4 border-t border-[var(--rf-border)]">
          {emptyHint}
        </p>
      )}
    </div>
  );
}
