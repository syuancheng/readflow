import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildSystemPrompt, buildUserMessage } from "../../src/lib/ai";

// 单测编译到 .unit/ 后 __dirname 会变，统一从仓库根（npm test 的工作目录）读快照
const snapshot = (name: string) =>
  fs.readFileSync(path.join(process.cwd(), "tests/unit/fixtures", name), "utf8");

const ZH_BEFORE = snapshot("ai-system-zh-before-p32.txt");
const EN_BEFORE = snapshot("ai-system-en-before-p32.txt");

const BASE = {
  word: "is",
  context: "The opposite problem is the classifier repeatedly stopping something.",
  prefix: "The opposite problem ",
  suffix: " the classifier repeatedly stopping something that's routine in your setup.",
};

test("开关关闭时：中英文两套系统提示词与 P32 改动前逐字一致（快照）", () => {
  assert.equal(buildSystemPrompt("en", false, "steer"), ZH_BEFORE);
  assert.equal(buildSystemPrompt("en", true, "steer"), EN_BEFORE);
  assert.equal(buildSystemPrompt("en", false, "steer", { personalized: false }), ZH_BEFORE);
  assert.equal(buildSystemPrompt("en", true, "steer", { personalized: false }), EN_BEFORE);
});

test("开关打开时：中文人设换成 L1–L4 深度指引，旧的「同句第 2/3 次」硬规则不再出现", () => {
  const p = buildSystemPrompt("en", false, "steer", { personalized: true });
  assert.ok(p.includes("L1 只给这句里的意思") && p.includes("L4 再加句子地图"));
  assert.ok(p.includes("偏好简洁的学生即使同句连续请教"));
  assert.ok(p.includes("阅读目的会影响义项选择"));
  assert.ok(p.includes("第一行永远是「释义：」"), "个性化不能打乱释义第一行");
  assert.ok(p.includes("【答案深度由你判断，不要问我】"));
  const depth = p.slice(p.indexOf("【答案深度"), p.indexOf("【硬性禁止】"));
  assert.ok(!depth.includes("第 2 次请教") && !depth.includes("第 3 次及以上"), "深度段里的旧硬规则换成画像判断");
  // 其余部分一个字都没动（核心规则段里提到「第 2 次」的例外句照旧保留）
  assert.equal(p.slice(0, p.indexOf("【答案深度")), ZH_BEFORE.slice(0, ZH_BEFORE.indexOf("【答案深度")));
  assert.equal(p.slice(p.indexOf("【硬性禁止】")), ZH_BEFORE.slice(ZH_BEFORE.indexOf("【硬性禁止】")));
});

test("开关打开时：monolingual 人设同样换成个性化深度指引，且不破坏后面的硬性禁止", () => {
  const p = buildSystemPrompt("en", true, "steer", { personalized: true });
  assert.ok(p.includes("student profile") && p.includes("L1 gives only the meaning"));
  assert.ok(p.includes("Do not output your reasoning."), "英文人设不能丢掉「不输出推理过程」的约束");
  assert.ok(!p.includes("Second ask on the same sentence"));
  assert.equal(p.slice(0, p.indexOf("Depth is yours")), EN_BEFORE.slice(0, EN_BEFORE.indexOf("Depth is yours")));
  assert.equal(
    p.slice(p.indexOf("Never: phonetic symbols")),
    EN_BEFORE.slice(EN_BEFORE.indexOf("Never: phonetic symbols")),
  );
});

test("学生档案放在 user 消息最前面；为空时 user 消息和改动前逐字相同", () => {
  const before = buildUserMessage(BASE);
  assert.equal(buildUserMessage({ ...BASE, learnerBlock: "" }), before);
  assert.equal(buildUserMessage({ ...BASE, learnerBlock: "   " }), before);
  const withBlock = buildUserMessage({ ...BASE, learnerBlock: "学生档案（…）：\n- 估计水平：B2" });
  assert.ok(withBlock.startsWith("学生档案（…）："));
  assert.equal(withBlock.slice("学生档案（…）：\n- 估计水平：B2".length + 2), before);
  assert.ok(withBlock.indexOf("学生档案") < withBlock.indexOf("用户选中"));
});
