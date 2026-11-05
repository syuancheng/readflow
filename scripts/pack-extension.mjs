/**
 * 把 extension/ 打成一个可直接「加载已解压的扩展程序」的包。
 *
 * 输出：dist/readflow-extension/（目录，可直接选）+ dist/readflow-extension-v<版本>.zip
 * 用法：npm run pack:extension
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "dist");
const NAME = "readflow-extension";
const DIR = path.join(OUT, NAME);

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

const INSTALL = `# ${manifest.name} · 安装说明

## 1. 加载插件（一次性）
1. 打开 Chrome，地址栏输入 \`chrome://extensions\`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹（含 \`manifest.json\` 的这一层）
4. 建议固定到工具栏：点拼图图标 → 把「${manifest.name}」钉住

## 2. 填服务地址与 Token
1. 确认本机 ReadFlow 服务在跑：\`http://127.0.0.1:3000\`
2. 打开 ReadFlow → 右上角头像 → **设置** → **浏览器插件** → 点「复制」拿到同步 Token
3. 点插件图标，粘贴 Token，服务地址保持 \`http://127.0.0.1:3000\`
4. 点「保存并同步」，看到「✓ 已同步 N 个词」即成功

## 3. 怎么用
- 任意英文网页：你词库里存过的单词 / 短语会**浅绿高亮**，上方带一行中文释义
- 选中网页上的词或句子：右上角浮条可查词、点一下即收进 ReadFlow 词库
- popup 里可关掉「启用网页高亮」，或切换页面语言

## 4. 常见问题
- **同步失败 401**：Token 不对或已被重新生成，回设置页复制新的
- **同步失败 / 连不上**：确认 3000 端口服务在跑；换端口的话服务地址也要改
- **某些网站没有高亮**：Chrome 内置页（chrome://）、扩展商店、PDF 阅读器不允许注入脚本，属正常
- **改了词库没更新**：插件每 5 分钟自动同步，也可在 popup 里点「仅重新同步词表」

卸载：\`chrome://extensions\` → 移除。
`;

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(EXT, DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, "INSTALL.md"), INSTALL, "utf8");

const zipName = `${NAME}-v${manifest.version}.zip`;
const zipPath = path.join(OUT, zipName);
fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-qr", zipName, NAME], { cwd: OUT });

const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`已生成：`);
console.log(`  目录  ${DIR}`);
console.log(`  压缩包 ${zipPath}（${size} KB）`);
