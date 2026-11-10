import { z } from "zod";
import { MAX_AGENT_USER_REPLY_LENGTH } from "./agent-user-wait";

export const userInputQuestionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  header: z.string().trim().min(1).max(100),
  question: z.string().trim().min(1).max(2000),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        value: z.string().trim().min(1).max(200),
        description: z.string().trim().max(500).optional(),
      }),
    )
    .max(9),
  multiSelect: z.boolean().optional(),
  allowCustomAnswer: z.boolean().optional(),
});

export const userInputQuestionsSchema = z
  .array(userInputQuestionSchema)
  .min(1)
  .max(8)
  .superRefine((questions, ctx) => {
    const ids = new Set<string>();
    questions.forEach((question, index) => {
      if (ids.has(question.id))
        ctx.addIssue({
          code: "custom",
          message: "Question IDs must be unique",
          path: [index, "id"],
        });
      ids.add(question.id);
      if (
        new Set(question.options.map((option) => option.value)).size !==
        question.options.length
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Option values must be unique",
          path: [index, "options"],
        });
      }
      if (
        question.allowCustomAnswer === false &&
        question.options.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Choice-only questions require options",
          path: [index, "options"],
        });
      }
    });
  });

export type UserInputQuestion = z.infer<typeof userInputQuestionSchema>;
export type UserInputAnswer = {
  selectedValues: string[];
  customAnswer: string;
};

/** Custom text replaces selected choices, matching the composer's answer mode. */
export function resolveUserInputAnswer(
  question: UserInputQuestion,
  answer: UserInputAnswer,
): string | null {
  const custom = answer.customAnswer.trim();
  if (custom) return question.allowCustomAnswer === false ? null : custom;
  const selected = new Set(answer.selectedValues);
  if (!selected.size || (!question.multiSelect && selected.size !== 1))
    return null;
  if (
    [...selected].some(
      (value) => !question.options.some((option) => option.value === value),
    )
  )
    return null;
  return question.options
    .filter((option) => selected.has(option.value))
    .map((option) => option.label)
    .join(", ");
}

/** One bounded, human-readable reply is saved and delivered for the whole request. */
export function formatUserInputAnswers(
  questions: UserInputQuestion[],
  answers: Record<string, UserInputAnswer>,
): string | null {
  if (!questions.length) return null;
  const values = questions.map((question) => {
    const answer = Object.hasOwn(answers, question.id)
      ? answers[question.id]
      : undefined;
    return answer ? resolveUserInputAnswer(question, answer) : null;
  });
  if (values.some((value) => value === null)) return null;
  const text =
    questions.length === 1
      ? values[0]!
      : questions
          .map((question, index) => `${question.question}\n${values[index]}`)
          .join("\n\n");
  return text.length <= MAX_AGENT_USER_REPLY_LENGTH ? text : null;
}
