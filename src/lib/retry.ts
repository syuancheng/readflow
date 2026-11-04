/**
 * 通用重试：网络抖动、网关错误、限流、模型繁忙都重试。
 * 纯模块（不依赖 DB / Next），可单测。
 *
 * 判定原则：
 *  - 明确是「请求方的问题」（400/401/403/404/422）不重试，重试只会重复失败
 *  - 429 / 408 / 5xx / 529(overloaded) / 超时 / 连接断开 / 繁忙字样 → 重试
 *  - 其它未知异常也重试（用户要求「失败就重试」），次数用尽后抛出最后一个错误
 */

export type RetryOptions = {
  /** 最大尝试次数，含首次。默认 3 */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 指数底数，默认 2 */
  factor?: number;
  /** 抖动比例 0~1，默认 0.2，避免多请求同时撞墙 */
  jitter?: number;
  /** 注入时钟/随机源，方便单测 */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  shouldRetry?: (error: unknown) => boolean;
};

export const DEFAULT_RETRY: Required<
  Pick<RetryOptions, "attempts" | "baseDelayMs" | "maxDelayMs" | "factor" | "jitter">
> = {
  attempts: 3,
  baseDelayMs: 600,
  maxDelayMs: 8000,
  factor: 2,
  jitter: 0.2,
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524, 529]);
const NON_RETRYABLE_STATUS = new Set([400, 401, 402, 403, 404, 405, 410, 413, 422]);
/** 没有 status 时，用于明确判定「重试也没用」的文案 */
const NON_RETRYABLE_MESSAGE = [
  "invalid_api_key",
  "incorrect api key",
  "invalid api key",
  "authentication_error",
  "permission_denied",
  "invalid_request_error",
  "unsupported",
];
type ErrorLike = {
  status?: number;
  statusCode?: number;
  code?: string | number;
  name?: string;
  message?: string;
  response?: { status?: number };
  error?: { type?: string; message?: string };
};

function asErrorLike(err: unknown): ErrorLike {
  if (typeof err === "object" && err !== null) return err as ErrorLike;
  return {};
}

export function errorStatus(err: unknown): number | undefined {
  const e = asErrorLike(err);
  const candidates = [e.status, e.statusCode, e.response?.status, e.code];
  for (const c of candidates) {
    if (typeof c === "number" && c >= 100 && c <= 599) return c;
    if (typeof c === "string" && /^\d{3}$/.test(c)) return Number(c);
  }
  return undefined;
}

/** 是否值得重试 */
export function isRetryableError(err: unknown): boolean {
  const status = errorStatus(err);
  if (status !== undefined) {
    if (NON_RETRYABLE_STATUS.has(status)) return false;
    if (RETRYABLE_STATUS.has(status)) return true;
    if (status >= 500) return true;
  }

  const e = asErrorLike(err);
  const text = [e.name, e.message, e.error?.type, e.error?.message, e.code]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (!text) return true; // 未知异常默认重试
  if (NON_RETRYABLE_MESSAGE.some((frag) => text.includes(frag))) return false;
  if (text.includes("overloaded_error") || text.includes("rate_limit_error")) return true;
  // 其余（含未知错误）一律重试：由 attempts 上限兜住，不会无限循环
  return true;
}

/** 指数退避 + 抖动；attempt 从 0 开始 */
export function backoffDelayMs(attempt: number, opts: RetryOptions = {}): number {
  const base = opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const max = opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const factor = opts.factor ?? DEFAULT_RETRY.factor;
  const jitter = opts.jitter ?? DEFAULT_RETRY.jitter;
  const raw = Math.min(max, base * factor ** Math.max(0, attempt));
  const rnd = opts.random ?? Math.random;
  return Math.round(raw * (1 + (rnd() * 2 - 1) * jitter));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 执行 fn，失败按策略重试。次数用尽后抛出最后一次错误。
 * 注意：fn 必须是幂等的（或由调用方保证），否则不要在写操作上直接用。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_RETRY.attempts);
  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? isRetryableError;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;
      if (i === attempts - 1 || !shouldRetry(err)) throw err;
      const delayMs = backoffDelayMs(i, opts);
      opts.onRetry?.({ attempt: i + 1, error: err, delayMs });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
