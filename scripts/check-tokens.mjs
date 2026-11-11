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
 * 确实需要例外时，在行尾写注释 `token-ok: 原因`（CSS 用 /* *\/，TSX 用 {/* *\/} 或 //）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const SPACE = new Set([0, 1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
const WEIGHTS = new Set(["400", "600", "700", "800", "normal", "bold", "inherit"]);

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

for (const f of walk(SRC)) {
  if (f.endsWith(path.join("styles", "tokens.css"))) continue;
  if (f.endsWith(".css")) checkCss(f);
  else checkTsx(f);
}

if (problems.length) {
  console.log(problems.join("\n"));
  console.log(`\n✗ ${problems.length} 处不符合设计规范（docs/design-system.md）`);
  process.exit(1);
}
console.log("✓ 设计规范检查通过");
