import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRulesSystemPrompt,
  hasRules,
  normalizeOverride,
  normalizeRules,
  RULE_MAX_COUNT,
  RULE_MAX_CHARS,
  rulesFromJson,
  rulesToJson,
} from "../../src/lib/learner/teaching-rules";
import {
  FEEDBACK_REASON_LABEL,
  FEEDBACK_REASONS,
  formatReasonLine,
  normalizeFeedbackReason,
} from "../../src/lib/learner/feedback-reason";
import { recencyWeight, DECAY_HALF_LIFE_DAYS } from "../../src/lib/learner/model";
import { claimIsFresh, CLAIM_LEASE_MS } from "../../src/lib/learner/nightly";

test("教学规则：白名单清洗，每题限长限数，空规则不算", () => {
  const rules = normalizeRules({
    can: ["  只答选中的词  ", "", 42, "x".repeat(RULE_MAX_CHARS + 10)],
    cannot: "不是数组",
  });
  assert.deepEqual(rules.cannot, []);
  assert.equal(rules.can.length, 2);
  assert.equal(rules.can[0], "只答选中的词");
  assert.equal(rules.can[1].length, RULE_MAX_CHARS);
  assert.deepEqual(normalizeRules(null), { can: [], cannot: [] });
  const many = normalizeRules({ can: Array.from({ length: 30 }, (_, i) => `第${i}条`) });
  assert.equal(many.can.length, RULE_MAX_COUNT);
  assert.equal(hasRules(many), true);
  assert.equal(hasRules(normalizeRules({})), false);
});

test("教学规则：JSON 往返不丢；坏 JSON 当空规则", () => {
  const rules = { can: ["先答释义"], cannot: ["不要整句翻译"] };
  assert.deepEqual(rulesFromJson(rulesToJson(rules)), rules);
  assert.deepEqual(rulesFromJson("not json"), { can: [], cannot: [] });
});

test("教学规则：空规则不产生额外 system message 文本；有规则时写明优先级且不含原 prompt", () => {
  assert.equal(buildRulesSystemPrompt({ can: [], cannot: [] }), "");
  const text = buildRulesSystemPrompt({ can: ["只答选中的词"], cannot: ["不要整句翻译"] });
  assert.match(text, /学生本人明确写下/);
  assert.match(text, /希望老师做的/);
  assert.match(text, /只答选中的词/);
  assert.match(text, /不要整句翻译/);
  assert.ok(!/答案深度由你判断/.test(text));
});

test("水平覆盖：CEFR 白名单、词汇量范围，非法值忽略", () => {
  assert.deepEqual(normalizeOverride({ cefr: "A2", vocab: 1000 }), { cefr: "A2", vocab: 1000 });
  assert.deepEqual(normalizeOverride({ cefr: "Z9", vocab: 10 }), { cefr: null, vocab: null });
  assert.deepEqual(normalizeOverride(null), { cefr: null, vocab: null });
});

test("反馈原因：白名单与中文标签，未知原因不写进档案", () => {
  assert.deepEqual([...FEEDBACK_REASONS], ["gave_answer", "too_much", "missed_point", "unnecessary"]);
  assert.equal(normalizeFeedbackReason("deep"), null);
  assert.equal(normalizeFeedbackReason("gave_answer"), "gave_answer");
  assert.equal(FEEDBACK_REASON_LABEL.gave_answer, "直接给了答案或整句翻译");
  assert.equal(formatReasonLine("gave_answer"), "原因：直接给了答案或整句翻译");
  assert.equal(formatReasonLine("bogus"), "");
});

test("时间衰减：今天 1，45 天前 0.5，未来与过去同样远不对称", () => {
  const now = Date.UTC(2026, 10, 18);
  const day = 24 * 3600 * 1000;
  assert.equal(recencyWeight(now, now), 1);
  assert.equal(recencyWeight(now - DECAY_HALF_LIFE_DAYS * day, now), 0.5);
  assert.ok(recencyWeight(now - 2 * DECAY_HALF_LIFE_DAYS * day, now) < 0.3);
  assert.equal(recencyWeight(now + day, now), 1, "未来事件按今天算");
});

test("夜间租约：同一天未过期算占用；过期或跨日可接管", () => {
  const now = Date.UTC(2026, 10, 18, 2, 0, 0);
  const claim = `2026-11-18@${now}`;
  assert.equal(claimIsFresh(claim, now + 1000), true);
  assert.equal(claimIsFresh(claim, now + CLAIM_LEASE_MS - 1), true);
  assert.equal(claimIsFresh(claim, now + CLAIM_LEASE_MS + 1), false);
  assert.equal(claimIsFresh("2026-11-17@" + now, now), false);
  assert.equal(claimIsFresh(null, now), false);
  assert.equal(claimIsFresh("garbage", now), false);
});
