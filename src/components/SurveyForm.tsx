"use client";

/**
 * P32 F1 问卷题目（/welcome 与设置 →「学习档案」共用）。
 * 题目与选项只从 SURVEY_QUESTIONS / EXAM_SCORE_BANDS 读取，这里不抄文案。
 * 每题都可以跳过；单选再点一次取消，Q3 是唯一的多选题。
 */
import {
  SURVEY_QUESTIONS,
  EXAM_SCORE_BANDS,
  showScoreQuestion,
  type SurveyAnswers,
} from "@/lib/learner/survey";

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
          const bands = EXAM_SCORE_BANDS[value.exam!];
          return (
            <fieldset key={q.id} className="rf-survey-q">
              <legend className="rf-survey-q-title">{q.title}</legend>
              <div className="flex flex-wrap gap-2">
                {bands.map((o) => (
                  <Chip
                    key={o.key}
                    label={o.label}
                    selected={value.examScore === o.key}
                    onClick={() => set({ examScore: value.examScore === o.key ? undefined : o.key })}
                  />
                ))}
              </div>
            </fieldset>
          );
        }

        const multi = q.multi === true;
        const selected = (key: string): boolean => {
          if (q.id === "goals") return value.goals?.includes(key as NonNullable<SurveyAnswers["goals"]>[number]) ?? false;
          return (value as Record<string, string | undefined>)[q.id] === key;
        };
        const toggle = (key: string) => {
          if (q.id === "goals") {
            const cur = value.goals ?? [];
            const g = key as NonNullable<SurveyAnswers["goals"]>[number];
            set({ goals: cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g] });
          } else if (q.id === "exam") {
            // 换考试时清掉旧分数段，避免出现「六级 + 托福 100 以上」这种错档
            set({ exam: value.exam === key ? undefined : (key as SurveyAnswers["exam"]), examScore: undefined });
          } else {
            const cur = (value as Record<string, string | undefined>)[q.id];
            set({ [q.id]: cur === key ? undefined : key } as Partial<SurveyAnswers>);
          }
        };

        return (
          <fieldset key={q.id} className="rf-survey-q">
            <legend className="rf-survey-q-title">
              {q.title}
              {multi && <span className="text-xs">（可多选）</span>}
            </legend>
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => (
                <Chip key={o.key} label={o.label} selected={selected(o.key)} onClick={() => toggle(o.key)} />
              ))}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`duo-filter-chip ${selected ? "duo-filter-chip-on" : ""}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
