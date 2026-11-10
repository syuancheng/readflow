/**
 * 账号运维脚本（P20）：关闭开放注册后，加人 / 改密的唯一入口。
 *
 *   npm run list-users
 *   npm run add-user -- alice                       # 自动生成随机密码并打印一次
 *   npm run add-user -- alice --password='...'      # 指定密码
 *   npm run reset-password -- alice                 # 重置 + 吊销该用户全部会话
 *   npm run reset-password -- alice --password='...'
 *
 * 密码也可以放环境变量 READFLOW_PASSWORD，避免留在 shell history 里。
 * 首个账号必须在网页 /setup 建（那里会顺带把老库数据迁到 owner 名下），
 * 命令行只负责后续加人和忘记密码时的重置。
 *
 * 所有密码逻辑复用 src/lib/auth-crypto.ts，不在脚本里另写一份 scrypt 参数。
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { ensureAuthSchema } from "../src/db/ensure-auth";
import {
  checkPassword,
  checkUsername,
  hashPassword,
  newUserId,
} from "../src/lib/auth-crypto";

const DB = process.env.DB_PATH ?? "data/readflow.db";
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "";
const username = argv[1] ?? "";
const flag = argv.find((a) => a.startsWith("--password="));
const supplied = flag ? flag.slice("--password=".length) : process.env.READFLOW_PASSWORD ?? "";

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function randomPassword(): string {
  return randomBytes(12).toString("base64url");
}

const db = new Database(DB);
db.pragma("busy_timeout = 10000");
db.pragma("foreign_keys = ON");
// 服务还没重启过时，users/sessions 可能尚不存在，这里补上（幂等）
ensureAuthSchema(db);

type UserRow = {
  id: string;
  username: string;
  is_owner: number;
  created_at: number;
};

const allUsers = () =>
  db.prepare("SELECT id, username, is_owner, created_at FROM users ORDER BY created_at").all() as UserRow[];

if (cmd === "list") {
  const users = allUsers();
  if (users.length === 0) {
    console.log("还没有账号，请打开 ReadFlow → /setup 创建第一个。");
  } else {
    for (const u of users) {
      console.log(
        `${u.is_owner === 1 ? "[owner] " : "[user]  "}${u.username}  id=${u.id}  created=${new Date(u.created_at).toLocaleString()}`,
      );
    }
  }
  db.close();
  process.exit(0);
}

if (cmd !== "add" && cmd !== "reset") {
  console.log(`用法：
  npm run list-users
  npm run add-user -- <用户名> [--password=...]
  npm run reset-password -- <用户名> [--password=...]`);
  db.close();
  process.exit(0);
}

if (!checkUsername(username).ok) die(checkUsername(username).reason ?? "用户名不合法");

const existing = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;

if (cmd === "add") {
  if (existing) die(`用户名 ${username} 已存在`);
  if (allUsers().length === 0) {
    die("还没有 owner 账号。请先在浏览器打开 /setup 创建第一个账号（会顺带迁移你的老文章和词库）。");
  }
  const auto = !supplied;
  const password = supplied || randomPassword();
  const rule = checkPassword(password);
  if (!rule.ok) die(rule.reason ?? "密码不合法");
  db.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, is_owner, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(newUserId(), username, hashPassword(password), username, Date.now());
  console.log(`✓ 已创建账号 ${username}${auto ? "" : "（密码为你指定的值）"}`);
  if (auto) console.log(`  初始密码：${password}  ← 只显示这一次，请保存`);
  console.log("  密钥类配置（AI / 墨墨 / 插件 Token）是站级共享，个人资料各自独立。");
} else {
  if (!existing) die(`找不到账号 ${username}`);
  const auto = !supplied;
  const password = supplied || randomPassword();
  const rule = checkPassword(password);
  if (!rule.ok) die(rule.reason ?? "密码不合法");
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), existing.id);
    // 改密码即踢掉该账号所有设备的登录态
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
  })();
  console.log(`✓ 已重置 ${username} 的密码，并吊销该账号的全部会话`);
  if (auto) console.log(`  新密码：${password}  ← 只显示这一次，请保存`);
}

db.close();
