"use client";

/**
 * P32 F1 问卷题目（/welcome 与设置 →「学习档案」共用）。
 * 题目与选项只从 SURVEY_QUESTIONS / EXAM_SCORE_BANDS 读取，这里不抄文案。
 *
 * 表单控件（不是药丸）：单选题用下拉框，Q3 是唯一的多选题，用复选框。
 * 每题都可以跳过：下拉选回「请选择」就是清空；复选框全不勾也行。
 */
import {
  SURVEY_QUESTIONS,
  EXAM_SCORE_BANDS,
  showScoreQuestion,
  type SurveyAnswers,
  type SurveyOption,
} from "@/lib/learner/survey";

const PLACEHOLDER = "请选择（可以跳过）";

export default function SurveyForm({
  value,
  onChange,
}: {
  value: SurveyAnswers;
  onChange: (next: SurveyAnswers) => void;
}) {
  const set = (patch: Partial<SurveyAnswers>) => onChange({ ...value, ...patch });

  return (
    <div className="rf-survey">
      {SURVEY_QUESTIONS.map((q) => {
        if (q.id === "examScore") {
          if (!showScoreQuestion(value.exam)) return null;
          return (
            <SelectQuestion
              key={q.id}
              id={`survey-${q.id}`}
              title={q.title}
              options={EXAM_SCORE_BANDS[value.exam!]}
              value={value.examScore}
              onChange={(v) => set({ examScore: v })}
            />
          );
        }

        if (q.id === "goals") {
          const cur = value.goals ?? [];
          return (
            <fieldset key={q.id} className="rf-survey-q">
              <legend className="rf-survey-q-title">
                {q.title}
                <span className="rf-survey-hint">（可多选）</span>
              </legend>
              <div className="rf-survey-checks">
                {q.options.map((o) => {
                  const g = o.key as NonNullable<SurveyAnswers["goals"]>[number];
                  const on = cur.includes(g);
                  return (
                    <label key={o.key} className={`rf-survey-check${on ? " rf-survey-check-on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => set({ goals: on ? cur.filter((x) => x !== g) : [...cur, g] })}
                      />
                      {o.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        }

        return (
          <SelectQuestion
            key={q.id}
            id={`survey-${q.id}`}
            title={q.title}
            options={q.options}
            value={(value as Record<string, string | undefined>)[q.id]}
            onChange={(v) =>
              q.id === "exam"
                ? // 换考试时清掉旧分数段，避免出现「六级 + 托福 100 以上」这种错档
                  set({ exam: v as SurveyAnswers["exam"], examScore: undefined })
                : set({ [q.id]: v } as Partial<SurveyAnswers>)
            }
          />
        );
      })}
    </div>
  );
}

function SelectQuestion({
  id,
  title,
  options,
  value,
  onChange,
}: {
  id: string;
  title: string;
  options: SurveyOption[];
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <div className="rf-survey-q">
      <label className="rf-survey-q-title" htmlFor={id}>
        {title}
      </label>
      <select
        id={id}
        className="duo-input rf-survey-select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">{PLACEHOLDER}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
