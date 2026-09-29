"use client";

import { useState } from "react";
import { useFormState } from "@/components/forms/action-form";
import { SegmentedControl } from "@/components/ui/choice";
import { Icon } from "@/components/ui/icon";
import { GRADE_TEXT, gradeFromChecklist, type ChecklistAnswers, type ChecklistItem, type GradeThresholds } from "@/lib/listing";

/** Step 3: the category checklist as Yes/No segments, with the resulting grade shown as the seller answers. */
export function ChecklistFields({ items, initial, thresholds }: { items: ChecklistItem[]; initial: ChecklistAnswers; thresholds: GradeThresholds }) {
  const [answers, setAnswers] = useState<ChecklistAnswers>(initial);
  const { state } = useFormState();
  const result = gradeFromChecklist(items, answers, thresholds);

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col border border-rule bg-surface">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 border-b border-rule p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
            <input type="hidden" name={`q_${item.id}`} value={answers[item.id] ?? ""} />
            <SegmentedControl
              legend={item.question}
              value={answers[item.id] ?? null}
              onChange={(v) => setAnswers((a) => ({ ...a, [item.id]: v }))}
              options={[
                { value: "YES", label: "Yes" },
                { value: "NO", label: "No" },
              ]}
            />
            {state?.fieldErrors?.[item.id] ? <p className="text-sm text-danger">{state.fieldErrors[item.id]}</p> : null}
          </li>
        ))}
      </ol>
      <section aria-live="polite" className="flex flex-col gap-1 border border-rule bg-surface p-4">
        {result.unanswered.length ? (
          <p className="text-steel">Answer every question to see the grade ({result.unanswered.length} left).</p>
        ) : (
          <>
            <p className="text-lg font-semibold">
              Grade: {GRADE_TEXT[result.grade].label} <span className="num text-steel">({result.score} out of 100)</span>
            </p>
            <p className="text-steel">{GRADE_TEXT[result.grade].meaning}</p>
          </>
        )}
        {result.blocking.map((q) => (
          <p key={q} className="flex items-start gap-2 text-danger">
            <Icon name="error" className="mt-0.5 shrink-0" />
            Parts where the answer to &ldquo;{q}&rdquo; is {items.find((i) => i.question === q)?.badAnswer === "YES" ? "yes" : "no"} can&apos;t be listed, for safety.
          </p>
        ))}
      </section>
    </div>
  );
}
