/**
 * 配置中心 + 本地个人资料 API 冒烟。
 *
 * 用法：BASE=http://127.0.0.1:3000 node scripts/smoke-settings.mjs
 *
 * 会写入假 Key / 假资料，但结尾全部清掉，只保留插件同步 Token，
 * 跑完数据库回到「全未配置 + 默认资料」状态。
 */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const FAKE = "sk-0000000000000000000000000000";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}

const get = async () => (await (await fetch(`${BASE}/api/settings`)).json());
const put = async (body) => {
  const res = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const d = (cfg, id) => cfg.providers.find((p) => p.id === id);

const before = await get();

// ---------- 模型配置 ----------
let cfg = (
  await put({
    providers: { deepseek: { apiKey: FAKE, model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" } },
    activeProvider: "deepseek",
  })
).json;
check("1 保存模型配置后立即生效", d(cfg, "deepseek").configured);
check(
  "2 接口只返回掩码，不下发明文",
  !JSON.stringify(cfg).includes(FAKE) && d(cfg, "deepseek").maskedKey === "••••0000",
);
check("3 勾选的 provider 即为当前使用", cfg.activeProvider === "deepseek");

cfg = (await put({ providers: { deepseek: { apiKey: d(cfg, "deepseek").maskedKey } } })).json;
check("4 掩码原样回传不会被写进数据库", d(cfg, "deepseek").maskedKey === "••••0000");

cfg = (await put({ activeProvider: "qwen" })).json;
check("5 可切换到另一家（勾选优先）", cfg.activeProvider === "qwen");

cfg = (
  await put({ providers: { custom: { apiKey: FAKE, model: "qwen3:8b", baseUrl: "http://127.0.0.1:11434/v1" } } })
).json;
check("6 自定义端点填全才算配置完成", d(cfg, "custom").configured && d(cfg, "custom").baseUrl.includes("11434"));

cfg = (await put({ markjiToken: "MJ-0000000000000000" })).json;
check("7 墨墨 Token 保存且脱敏", cfg.markji.configured && !JSON.stringify(cfg).includes("MJ-0000"));
cfg = (await put({ markjiClear: true })).json;
check("8 墨墨 Token 可清除", !cfg.markji.configured);

// ---------- 本地个人资料 ----------
cfg = (
  await put({
    profile: {
      displayName: "冒烟用户",
      fullName: "Smoke User",
      bio: "在读原文",
      avatar: PNG,
    },
  })
).json;
check(
  "9 个人资料四字段保存后可原样读回",
  cfg.profile?.displayName === "冒烟用户" &&
    cfg.profile?.fullName === "Smoke User" &&
    cfg.profile?.bio === "在读原文" &&
    cfg.profile?.avatar === PNG,
  JSON.stringify(cfg.profile?.displayName),
);

const bad = await put({ profile: { displayName: "X", fullName: "", bio: "", avatar: "https://evil.example/a.png" } });
check("10 外链/非内联图片头像被拒绝", bad.status === 400, `HTTP ${bad.status}`);
check("11 非法头像不会污染已保存资料", (await get()).profile.displayName === "冒烟用户");

cfg = (await put({ profileReset: true })).json;
check(
  "12 资料可清空恢复默认",
  cfg.profile?.displayName === "Siyuan Cheng" && cfg.profile?.avatar === "",
);

// ---------- 收尾：清空冒烟写入的一切，插件 Token 保留 ----------
cfg = (
  await put({
    providers: Object.fromEntries(cfg.providers.map((p) => [p.id, { clear: true }])),
    activeProvider: null,
    markjiClear: true,
    profileReset: true,
  })
).json;
const clean =
  cfg.providers.every((p) => !p.configured) &&
  cfg.activeProvider === null &&
  !cfg.markji.configured &&
  !JSON.stringify(cfg).includes(FAKE) &&
  cfg.profile.displayName === "Siyuan Cheng" &&
  cfg.extension.hasToken === before.extension.hasToken &&
  cfg.extension.hint === before.extension.hint;
check(
  "13 冒烟配置与资料全部清空，插件 Token 保留",
  clean,
  `active=${cfg.activeProvider} markji=${cfg.markji.configured} ext=${cfg.extension.hint === before.extension.hint ? "kept" : "changed"}`,
);

console.log(`===== 配置 + 资料流程 ${pass}/${pass + fail} 通过 =====`);
process.exit(fail ? 1 : 0);
