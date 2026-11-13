import assert from "node:assert/strict";
import test from "node:test";
import { CARD_DAILY_LIMIT, cardQuotaDay, cardQuotaMessage } from "../../src/lib/cards/quota";

test("每天 30 个词（PRD Q1）", () => {
  assert.equal(CARD_DAILY_LIMIT, 30);
  assert.ok(cardQuotaMessage().includes("30"));
});

test("按上海时区的自然日：UTC 16:00 就是上海次日 0 点", () => {
  assert.equal(cardQuotaDay(Date.UTC(2026, 10, 12, 15, 59, 59)), "2026-11-12");
  assert.equal(cardQuotaDay(Date.UTC(2026, 10, 12, 16, 0, 0)), "2026-11-13");
  assert.equal(cardQuotaDay(Date.UTC(2026, 11, 31, 16, 0, 0)), "2027-01-01");
});

test("不传时间用当前时间，格式 YYYY-MM-DD", () => {
  assert.match(cardQuotaDay(), /^\d{4}-\d{2}-\d{2}$/);
});
