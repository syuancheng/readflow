/**
 * 听力战绩与统计展示的纯计算函数（无 DB 依赖，客户端、服务端与单元测试共用）。
 */
import { dayKey } from "./streak";

export const MIN_LISTENING_MINUTES = 0.1;
export const MAX_LISTENING_MINUTES = 600;
export const MAX_LISTENING_NOTE_LENGTH = 200;

export const LISTENING_MODES = ["intensive", "extensive"] as const;
export type ListeningMode = (typeof LISTENING_MODES)[number];

export const LISTENING_MODE_LABEL: Record<ListeningMode, string> = {
  intensive: "精听",
  extensive: "泛听",
};

/** 四舍五入到两位小数，消除 IEEE-754 浮点累加尾巴（如 0.1 + 0.2） */
export function roundMinutes(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 校验 YYYY-MM-DD 是否为真实存在的日历日期 */
export function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return (
    dt.getFullYear() === y &&
    dt.getMonth() === m - 1 &&
    dt.getDate() === d
  );
}

export type ValidatedListeningInput = {
  minutes: number;
  logDate: string;
  mode: ListeningMode;
  note: string | null;
};

export type ValidationResult =
  | { ok: true; data: ValidatedListeningInput }
  | { ok: false; error: string };

/**
 * 校验 POST /api/listening-logs 请求体。
 * 支持浮点数分钟（如 0.5 表示 30 秒、0.25 表示 15 秒），上限 600 分钟。
 */
export function validateListeningInput(
  raw: {
    minutes?: unknown;
    logDate?: unknown;
    mode?: unknown;
    note?: unknown;
  },
  todayKey: string,
): ValidationResult {
  const num =
    typeof raw.minutes === "string" && raw.minutes.trim() !== ""
      ? Number(raw.minutes)
      : raw.minutes;

  if (typeof num !== "number" || !Number.isFinite(num)) {
    return { ok: false, error: "请输入有效的听懂时长（分钟）" };
  }
  const minutes = roundMinutes(num);
  if (minutes < MIN_LISTENING_MINUTES || minutes > MAX_LISTENING_MINUTES) {
    return {
      ok: false,
      error: `时长需在 ${MIN_LISTENING_MINUTES} 到 ${MAX_LISTENING_MINUTES} 分钟之间`,
    };
  }

  let logDate = todayKey;
  if (raw.logDate !== undefined && raw.logDate !== null && raw.logDate !== "") {
    if (typeof raw.logDate !== "string" || !isValidDateKey(raw.logDate.trim())) {
      return { ok: false, error: "日期格式需为 YYYY-MM-DD" };
    }
    logDate = raw.logDate.trim();
    if (logDate > todayKey) {
      return { ok: false, error: "记录日期不能晚于今天" };
    }
  }

  let mode: ListeningMode = "intensive";
  if (raw.mode !== undefined && raw.mode !== null && raw.mode !== "") {
    if (raw.mode !== "intensive" && raw.mode !== "extensive") {
      return { ok: false, error: "练习类型仅支持精听或泛听" };
    }
    mode = raw.mode;
  }

  let note: string | null = null;
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string") {
      return { ok: false, error: "备注格式不正确" };
    }
    const trimmed = raw.note.trim().slice(0, MAX_LISTENING_NOTE_LENGTH);
    note = trimmed.length > 0 ? trimmed : null;
  }

  return { ok: true, data: { minutes, logDate, mode, note } };
}

/** 格式化数字（去多余尾零，保留最多两位小数） */
export function formatMinutes(value: number): string {
  const clean = roundMinutes(value);
  if (Number.isInteger(clean)) return clean.toLocaleString("en-US");
  return clean.toString();
}

/** 累计时长卡片大数字：小于 60 分钟显示分钟，≥ 60 分钟显示小时并附精确分钟副标 */
export function formatDurationHero(totalMinutes: number): {
  value: string;
  unit: string;
  subLabel: string | null;
} {
  const clean = roundMinutes(totalMinutes);
  if (clean >= 60) {
    const hours = Math.round((clean / 60) * 10) / 10;
    return {
      value: formatMinutes(hours),
      unit: "小时",
      subLabel: `共 ${formatMinutes(clean)} 分钟`,
    };
  }
  return {
    value: formatMinutes(clean),
    unit: "分钟",
    subLabel: null,
  };
}

/** 柱状图顶部紧凑数字：≥ 1000 时显示如 1.2k */
export function formatCompactCount(n: number): string {
  if (n <= 0) return "";
  if (n >= 1000) {
    const k = Math.round((n / 1000) * 10) / 10;
    return `${k}k`;
  }
  return formatMinutes(n);
}

/** 返回本周一的本地日期 YYYY-MM-DD */
export function weekStartKey(today: Date): string {
  const monday = new Date(today);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((today.getDay() + 6) % 7));
  return dayKey(monday);
}

/** 按今天 / 本周（周一至今）/ 本月（1 日至今）/ 累计汇总每日数值 */
export function aggregateByPeriod(
  byDay: Map<string, number>,
  today: Date,
): {
  todayTotal: number;
  weekTotal: number;
  monthTotal: number;
  total: number;
} {
  const todayStr = dayKey(today);
  const mondayStr = weekStartKey(today);
  const monthPrefix = todayStr.slice(0, 7);

  let weekTotal = 0;
  let monthTotal = 0;
  let total = 0;

  for (const [k, v] of byDay.entries()) {
    if (v <= 0) continue;
    total += v;
    if (k >= mondayStr && k <= todayStr) weekTotal += v;
    if (k.startsWith(monthPrefix) && k <= todayStr) monthTotal += v;
  }

  return {
    todayTotal: roundMinutes(byDay.get(todayStr) ?? 0),
    weekTotal: roundMinutes(weekTotal),
    monthTotal: roundMinutes(monthTotal),
    total: roundMinutes(total),
  };
}
