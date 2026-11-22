/**
 * 设计规范检查（docs/design-system.md §9）。
 *
 *   node scripts/check-tokens.mjs
 *
 * 扫 src/**\/*.css（tokens.css 除外）和 src/**\/*.tsx，违反任何一条就以非 0 退出：
 *   CSS  · 裸 hex 颜色（:root 别名块除外）
 *        · font-size 不是 var(--rf-text-*) / em / inherit
 *        · font-weight 不在 400 / 600 / 700 / 800
 *        · padding / margin / gap 的 px 不在 4 的倍数阶梯里（0、1、2px 微调除外）
 *        · border-radius 不是 token / 0 / 50% / inherit
 *        · box-shadow 不是 token / none / inset 指示条 / 白色描边环
 *   TSX  · Tailwind 任意值字号 text-[..]、半步间距 x-1.5、阶梯外的 [Npx] 间距
 *        · font-medium / font-black / font-thin
 *        · style 里的 fontSize 数字、hex 颜色
 *
 * 组件层（COMPONENTS 处方表，见下）：token 单独合法还不够，组合形态也要合规。
 *   目前覆盖：小按钮尺寸/圆角、「标记已读完」三态的颜色语义。
 *   新组件照 COMPONENTS 的格式加一条即可；需要例外时在对应 CSS 规则块内写
 *   `token-ok: 原因`，组件层检查会跳过该规则块（token 层仍按行跳过）。
 *
 * 确实需要例外时，在行尾写注释 `token-ok: 原因`（CSS 用 /* *\/，TSX 用 {/* *\/} 或 //）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const SPACE = new Set([0, 1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
const WEIGHTS = new Set(["400", "600", "700", "800", "normal", "bold", "inherit"]);

/**
 * 组件处方表：token 层只管「单个值合法」，这里管「组合起来是否符合组件规范」。
 * 格式：targets 为精确选择器；extends 声明继承链（如 .duo-btn-sm 继承 .duo-btn）；
 * require 列出必须写出的声明及允许值；forbid 列出禁止的取值模式。
 * 新组件直接在数组里追加一条，不需要改检查逻辑。
 */
const BTN_COLOR_FORBID = [
  { prop: "background", re: /var\(--(?:duo-green-soft|rf-brand-soft|rf-highlight-bg|rf-brand)\)/, why: "按钮底色不得用亮绿/浅绿（§1.1）" },
  { prop: "color", re: /var\(--(?:duo-green|duo-green-dark|rf-brand)\)/, why: "按钮文字不得用亮绿（§1.2）" },
];

const COMPONENTS = [
  {
    id: "BTN-SM",
    targets: [".duo-btn-sm"],
    extends: { ".duo-btn-sm": [".duo-btn"] },
    require: {
      "min-height": { allow: ["36px"], why: "小按钮高 36px（§8）" },
      "font-size": { allow: ["var(--rf-text-sm)"], why: "小按钮字号 sm/14px（§8）" },
      "border-radius": { allow: ["var(--rf-radius-md)"], why: "按钮圆角 md/12px（§4）" },
    },
    forbid: BTN_COLOR_FORBID,
  },
  {
    id: "BTN-DONE-BASE",
    targets: [".rf-done-btn"],
    require: {
      "min-height": { allow: ["28px"], why: "顶栏完成开关高 28px，与同行徽章体量对齐" },
      "font-size": { allow: ["var(--rf-text-xs)"], why: "顶栏完成开关字号 xs/12px" },
      "border-radius": { allow: ["var(--rf-radius-sm)"], why: "顶栏完成开关圆角 sm/8px（§4）" },
    },
    forbid: BTN_COLOR_FORBID,
  },
  {
    id: "BTN-AT-BOTTOM",
    targets: [".rf-done-btn.at-bottom"],
    require: {
      background: { allow: ["var(--rf-bg-surface)", "var(--rf-bg-selected)"], why: "100% 提示态仍用中性底（§1.1）" },
      color: { allow: ["var(--rf-text-primary)", "var(--rf-accent-text)"], why: "100% 提示态文字用 primary / accent-text（§1.2）" },
    },
    forbid: BTN_COLOR_FORBID,
  },
  {
    id: "BTN-DONE",
    targets: [".rf-done-btn.done"],
    require: {
      background: { allow: ["var(--rf-success-soft)"], why: "已读完是成功状态标签，不是主按钮（§1.1 / P54）" },
      color: { allow: ["var(--rf-success-text)"], why: "成功状态用 success-text（§1.2 / P54）" },
    },
    forbid: BTN_COLOR_FORBID,
  },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const problems = [];
const report = (file, line, msg, text) =>
  problems.push(`${path.relative(ROOT, file)}:${line}  ${msg}\n      ${text.trim().slice(0, 140)}`);

function checkCss(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let inAliasRoot = false;
  let depth = 0;
  lines.forEach((raw, i) => {
    const n = i + 1;
    // 第一个 :root 块是旧变量名 → token 的别名表，允许
    if (/^:root\s*\{/.test(raw) && n < 20) inAliasRoot = true;
    depth += (raw.match(/\{/g) || []).length - (raw.match(/\}/g) || []).length;
    if (inAliasRoot) { if (depth === 0) inAliasRoot = false; return; }
    if (raw.includes("token-ok")) return;
    const line = raw.replace(/\/\*.*?\*\//g, "");

    if (/(^|[^&\w-])#[0-9a-fA-F]{3,8}\b/.test(line)) report(file, n, "裸 hex 颜色，改用 var(--rf-*)", raw);

    for (const m of line.matchAll(/font-size:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (!/^var\(--rf-text-[a-z0-9]+\)$/.test(v) && !/^[0-9.]+em$/.test(v) && v !== "inherit" && !/^calc\(/.test(v))
        report(file, n, `字号 ${v} 不在阶梯里`, raw);
    }
    for (const m of line.matchAll(/font-weight:\s*([^;}\s!]+)/g)) {
      if (!WEIGHTS.has(m[1])) report(file, n, `字重 ${m[1]} 不在 400/600/700/800 里`, raw);
    }
    for (const m of line.matchAll(/(?:^|[\s;{])(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?:\s*([^;}]+)/g)) {
      for (const px of m[1].matchAll(/(-?)([0-9.]+)px/g)) {
        if (!SPACE.has(+px[2])) report(file, n, `间距 ${px[2]}px 不在 4 的倍数阶梯里`, raw);
      }
    }
    for (const m of line.matchAll(/border(?:-[a-z]+)*-radius:\s*([^;}]+)/g)) {
      const bad = m[1].trim().split(/\s+/).filter((t) => !/^(var\(--rf-radius-[a-z]+\)|0|50%|inherit)$/.test(t));
      if (bad.length) report(file, n, `圆角 ${bad.join(" ")} 没用 token`, raw);
    }
    for (const m of line.matchAll(/box-shadow:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (!/^(none|inherit|var\(--rf-(shadow-[a-z]+|focus-ring)\)|inset\b.*|0 0 0 \dpx var\(--rf-gray-0\))/.test(v))
        report(file, n, `阴影没用 token`, raw);
    }
  });
}

function checkTsx(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (raw.includes("token-ok")) return;
    if (/\btext-\[[0-9.]+(px|rem)\]/.test(raw)) report(file, n, "任意值字号，用 text-xs … text-3xl", raw);
    if (/\b-?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\d+\.5\b/.test(raw))
      report(file, n, "半步间距（2/6/10px），改成整数档", raw);
    for (const m of raw.matchAll(/\b-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y)-\[(\d+)px\]/g))
      if (!SPACE.has(+m[1])) report(file, n, `间距 ${m[1]}px 不在阶梯里`, raw);
    if (/\bfont-(medium|black|thin|light)\b/.test(raw)) report(file, n, "字重只用 normal/semibold/bold/extrabold", raw);
    if (/fontSize:\s*[0-9]/.test(raw)) report(file, n, "style 里写死字号，用 var(--rf-text-*)", raw);
    if (/(color|background|border[A-Za-z]*)\s*:\s*["'`][^"'`]*#[0-9a-fA-F]{3,8}\b/.test(raw))
      report(file, n, "style 里写死 hex 颜色", raw);
  });
}

/** 按 CSS 规则块解析：拿到 { 选择器 → {文件, 行号, 声明集合} }，供组件处方表检查。 */
function parseCssBlocks(files) {
  const map = new Map();
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    // 注释原地替换为空格，保留行数；否则行号会漂移
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, " "));
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) {
      const selText = m[1].split("\n").filter((s) => s.trim()).pop()?.trim() ?? "";
      if (!selText || selText.startsWith("@") || selText.includes("@media")) continue;
      const line = src.slice(0, m.index + m[1].length).split("\n").length;
      const decls = new Map();
      for (const part of m[2].split(";")) {
        const i = part.indexOf(":");
        if (i < 0) continue;
        const prop = part.slice(0, i).trim().toLowerCase();
        const value = part.slice(i + 1).replace(/!important/g, "").trim();
        if (prop) decls.set(prop, value);
      }
      for (const sel of selText.split(",").map((s) => s.trim())) {
        if (!sel || sel.startsWith("@") || m[0].includes("token-ok")) continue;
        if (!map.has(sel)) map.set(sel, []);
        map.get(sel).push({ file, line, decls });
      }
    }
  }
  return map;
}

/** 把 extends 链上的声明先铺底，再用目标选择器自身覆盖，得到实际生效的集合。 */
function effectiveDecls(map, selector, extendsMap) {
  const decls = new Map();
  for (const base of extendsMap[selector] ?? []) {
    for (const block of map.get(base) ?? []) for (const [k, v] of block.decls) decls.set(k, v);
  }
  for (const block of map.get(selector) ?? []) for (const [k, v] of block.decls) decls.set(k, v);
  return decls;
}

function checkComponents(files) {
  const map = parseCssBlocks(files);
  for (const profile of COMPONENTS) {
    for (const target of profile.targets) {
      const decls = effectiveDecls(map, target, profile.extends ?? {});
      if (!decls.size) continue; // 组件未使用，不报
      const source = (map.get(target) ?? [])[0];
      for (const [prop, spec] of Object.entries(profile.require ?? {})) {
        const value = decls.get(prop);
        if (value === undefined) {
          report(source.file, source.line, `[${profile.id}] ${target} 缺少 ${prop}：${spec.why}`, target);
        } else if (!spec.allow.includes(value)) {
          report(source.file, source.line, `[${profile.id}] ${target} 的 ${prop}=${value} 不合规（${spec.why}；允许：${spec.allow.join(" / ")}）`, `${prop}: ${value};`);
        }
      }
      for (const bad of profile.forbid ?? []) {
        const value = decls.get(bad.prop);
        if (value && bad.re.test(value)) {
          report(source.file, source.line, `[${profile.id}] ${target} 的 ${bad.prop}=${value}：${bad.why}`, `${bad.prop}: ${value};`);
        }
      }
    }
  }
}

const cssFiles = [];
for (const f of walk(SRC)) {
  if (f.endsWith(path.join("styles", "tokens.css"))) continue;
  if (f.endsWith(".css")) { checkCss(f); cssFiles.push(f); }
  else checkTsx(f);
}
checkComponents(cssFiles);

if (problems.length) {
  console.log(problems.join("\n"));
  console.log(`\n✗ ${problems.length} 处不符合设计规范（docs/design-system.md）`);
  process.exit(1);
}
console.log("✓ 设计规范检查通过");
