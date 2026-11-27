import assert from "node:assert/strict";
import test from "node:test";
import { ensureListeningLogs } from "../../src/db/ensure-listening-logs";
import {
  aggregateByPeriod,
  formatCompactCount,
  formatDurationHero,
  formatMinutes,
  isValidDateKey,
  roundMinutes,
  validateListeningInput,
} from "../../src/lib/listening";
import { computeStreaks } from "../../src/lib/streak";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");
type Db = import("better-sqlite3").Database;

test("validateListeningInput：支持浮点数时长（如 0.5 表示 30 秒、0.25 表示 15 秒）", () => {
  const r1 = validateListeningInput({ minutes: 0.5, note: "  30秒新闻精听  " }, "2026-11-27");
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.data.minutes, 0.5);
    assert.equal(r1.data.logDate, "2026-11-27");
    assert.equal(r1.data.mode, "intensive");
    assert.equal(r1.data.note, "30秒新闻精听");
  }

  const r2 = validateListeningInput(
    { minutes: "0.25", logDate: "2026-11-25", mode: "extensive", note: "   " },
    "2026-11-27",
  );
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.data.minutes, 0.25);
    assert.equal(r2.data.logDate, "2026-11-25");
    assert.equal(r2.data.mode, "extensive");
    assert.equal(r2.data.note, null);
  }
});

test("validateListeningInput：拒绝越界时长、未来日期、非法日期与非法类型", () => {
  assert.equal(validateListeningInput({ minutes: 0 }, "2026-11-27").ok, false);
  assert.equal(validateListeningInput({ minutes: 0.05 }, "2026-11-27").ok, false);
  assert.equal(validateListeningInput({ minutes: 601 }, "2026-11-27").ok, false);
  assert.equal(validateListeningInput({ minutes: Number.NaN }, "2026-11-27").ok, false);
  assert.equal(
    validateListeningInput({ minutes: 10, logDate: "2026-11-28" }, "2026-11-27").ok,
    false,
  );
  assert.equal(
    validateListeningInput({ minutes: 10, logDate: "2026-02-30" }, "2026-11-27").ok,
    false,
  );
  assert.equal(
    validateListeningInput({ minutes: 10, mode: "unknown" }, "2026-11-27").ok,
    false,
  );
});

test("validateListeningInput：备注超过 200 字自动裁剪", () => {
  const longNote = "a".repeat(250);
  const r = validateListeningInput({ minutes: 5, note: longNote }, "2026-11-27");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.note?.length, 200);
});

test("格式化与浮点精度工具", () => {
  assert.equal(roundMinutes(0.1 + 0.2), 0.3);
  assert.equal(formatMinutes(0.5), "0.5");
  assert.equal(formatMinutes(15.0), "15");
  assert.equal(formatMinutes(1250), "1,250");
  assert.equal(formatCompactCount(0), "");
  assert.equal(formatCompactCount(500), "500");
  assert.equal(formatCompactCount(1250), "1.3k");
  assert.equal(isValidDateKey("2026-02-28"), true);
  assert.equal(isValidDateKey("2026-02-29"), false);

  assert.deepEqual(formatDurationHero(45.5), {
    value: "45.5",
    unit: "分钟",
    subLabel: null,
  });
  assert.deepEqual(formatDurationHero(510), {
    value: "8.5",
    unit: "小时",
    subLabel: "共 510 分钟",
  });
});

test("aggregateByPeriod 与连续天数兼容浮点分钟", () => {
  const today = new Date(2026, 10, 27); // 2026-11-27 周五（本周一为 11-23）
  const byDay = new Map<string, number>([
    ["2026-10-30", 30], // 上月
    ["2026-11-10", 20], // 本月但非本周
    ["2026-11-25", 0.5], // 本周
    ["2026-11-26", 10], // 本周昨天
    ["2026-11-27", 5.5], // 今天
  ]);
  const p = aggregateByPeriod(byDay, today);
  assert.deepEqual(p, {
    todayTotal: 5.5,
    weekTotal: 16,
    monthTotal: 36,
    total: 66,
  });

  const streak = computeStreaks(byDay, today);
  assert.deepEqual(streak, { streakDays: 3, bestStreak: 3, activeDays: 5 });
});

test("SQLite 建表、阅读完读口径（未读完=0/取消扣减/排除web）与听力浮点聚合", () => {
  const db = new Database(":memory:") as Db;
  db.exec(`
    CREATE TABLE texts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER
    );
  `);
  ensureListeningLogs(db);
  // 幂等二次执行不报错
  ensureListeningLogs(db);

  const nowMs = new Date(2026, 10, 27, 10, 0, 0).getTime();
  // u1: 两篇已读完 (100 + 200 = 300)，一篇看一半未完读 (500 → 不计)，一篇 web 摘录 (80 → 不计)
  // u2: 一篇已读完 (999 → 隔离，不计入 u1)
  db.prepare(
    `INSERT INTO texts (id, user_id, title, source_type, word_count, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("t1", "u1", "Article 1", "paste", 100, nowMs);
  db.prepare(
    `INSERT INTO texts (id, user_id, title, source_type, word_count, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("t2", "u1", "Article 2", "url", 200, nowMs);
  db.prepare(
    `INSERT INTO texts (id, user_id, title, source_type, word_count, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("t3", "u1", "Half Read", "paste", 500, null);
  db.prepare(
    `INSERT INTO texts (id, user_id, title, source_type, word_count, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("t4", "u1", "Web Clip", "web", 80, nowMs);
  db.prepare(
    `INSERT INTO texts (id, user_id, title, source_type, word_count, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("t5", "u2", "Other User", "paste", 999, nowMs);

  const sumCompleted = (uid: string) =>
    (
      db
        .prepare(
          `SELECT coalesce(sum(word_count), 0) AS w, count(*) AS c
           FROM texts
           WHERE user_id = ? AND source_type != 'web' AND completed_at IS NOT NULL`,
        )
        .get(uid) as { w: number; c: number }
    );

  assert.deepEqual(sumCompleted("u1"), { w: 300, c: 2 });
  assert.deepEqual(sumCompleted("u2"), { w: 999, c: 1 });

  // 取消 t2 的「已读完」标记后，词数实时回退到 100
  db.prepare(`UPDATE texts SET completed_at = NULL WHERE id = 't2'`).run();
  assert.deepEqual(sumCompleted("u1"), { w: 100, c: 1 });

  // 听力日志：0.5 分钟 + 5 分钟 + 10 分钟 = 15.5 分钟，且账号隔离
  const insertLog = db.prepare(
    `INSERT INTO listening_logs (id, user_id, log_date, minutes, mode, note, source, text_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', NULL, ?)`,
  );
  insertLog.run("l1", "u1", "2026-11-27", 0.5, "intensive", "30s clip", nowMs);
  insertLog.run("l2", "u1", "2026-11-27", 5, "intensive", "short talk", nowMs + 1);
  insertLog.run("l3", "u1", "2026-11-27", 10, "extensive", null, nowMs + 2);
  insertLog.run("l4", "u2", "2026-11-27", 60, "intensive", "other user", nowMs);

  const sumListening = (uid: string) =>
    (
      db
        .prepare(`SELECT coalesce(sum(minutes), 0) AS m, count(*) AS c FROM listening_logs WHERE user_id = ?`)
        .get(uid) as { m: number; c: number }
    );

  assert.deepEqual(sumListening("u1"), { m: 15.5, c: 3 });
  assert.deepEqual(sumListening("u2"), { m: 60, c: 1 });

  // 删除 l2 后同步扣减
  db.prepare(`DELETE FROM listening_logs WHERE id = 'l2' AND user_id = 'u1'`).run();
  assert.deepEqual(sumListening("u1"), { m: 10.5, c: 2 });

  db.close();
});
