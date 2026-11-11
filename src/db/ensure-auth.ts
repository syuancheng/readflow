import type Database from "better-sqlite3";

/**
 * 账户体系的表结构与老库迁移（P20）。
 *
 * 在连接层（sqlite.ts）就执行，因为登录 API / 设置中心可能先于主 schema
 * 初始化被读取。全部幂等，重复执行安全。
 *
 * settings 从「全局 KV」改成「站级默认 + 用户覆盖」：
 *   user_id = GLOBAL_USER 的行是站级默认（AI 密钥 / 墨墨 Token / 插件 token，
 *   服务端代持，前端永远只拿脱敏值）；每个真实账号用自己的 id 存同名 key 覆盖它。
 *
 * 注意 GLOBAL_USER("local") 只是一个哨兵，**不是任何账号的 id**：
 * 老库里 user_id='local' 的文章/词会在 /api/auth/setup 建号时改成 owner 的 UUID。
 * 两者必须分开，否则 A 用户回退读站级默认时会看到 owner 的个人资料。
 * 老库的密钥类配置全部留在站级，一条不丢。
 */
export const GLOBAL_USER = "local";

export function ensureAuthSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      is_owner INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  // 手机号（P21）：可作登录名。老账号补列后为 NULL，可用 npm run set-phone 补上；
  // SQLite 的 UNIQUE 允许多个 NULL，所以老账号不会互相冲突。
  const userCols = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!userCols.some((c) => c.name === "phone")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone)");

  // 邀请码注册（P28）：只有 owner 能发码；每个码可用 max_uses 次，可随时作废。
  // users.invite_code 记下这个人是用哪个码注册的，方便 owner 在设置里看「谁用了」。
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      note TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
  `);
  if (!userCols.some((c) => c.name === "invite_code")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN invite_code TEXT");
  }

  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
    .get() as { name: string } | undefined;

  if (!table) {
    sqlite.exec(`
      CREATE TABLE settings (
        user_id TEXT NOT NULL DEFAULT '${GLOBAL_USER}',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `);
    return;
  }

  const cols = sqlite.prepare("PRAGMA table_info(settings)").all() as { name: string }[];
  if (cols.some((c) => c.name === "user_id")) return; // 已迁移

  // SQLite 不能 ALTER 主键，只能重建。老表是 (key PRIMARY KEY)，
  // 把全部配置归到站级，用户的个人覆盖从空开始、按需写入。
  sqlite.exec("BEGIN");
  try {
    sqlite.exec(`
      CREATE TABLE settings_auth_new (
        user_id TEXT NOT NULL DEFAULT '${GLOBAL_USER}',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      INSERT INTO settings_auth_new (user_id, key, value, updated_at)
        SELECT '${GLOBAL_USER}', key, value, updated_at FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_auth_new RENAME TO settings;
      COMMIT;
    `);
  } catch (e) {
    sqlite.exec("ROLLBACK");
    throw e;
  }
}
