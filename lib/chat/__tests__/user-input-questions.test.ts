import {
  formatUserInputAnswers,
  resolveUserInputAnswer,
  userInputQuestionsSchema,
  type UserInputQuestion,
} from "../user-input-questions";

const question: UserInputQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which scope?",
  options: [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ],
};

describe("structured user answers", () => {
  it("uses custom text instead of an earlier selected choice", () => {
    expect(
      resolveUserInputAnswer(question, {
        selectedValues: ["a"],
        customAnswer: "  Gamma  ",
      }),
    ).toBe("Gamma");
  });
  it("rejects custom text on choice-only questions and unknown options", () => {
    expect(
      resolveUserInputAnswer(
        { ...question, allowCustomAnswer: false },
        { selectedValues: ["a"], customAnswer: "Gamma" },
      ),
    ).toBeNull();
    expect(
      resolveUserInputAnswer(question, {
        selectedValues: ["stale"],
        customAnswer: "",
      }),
    ).toBeNull();
  });
  it("allows several selections only for a multi-select question, in display order", () => {
    const answer = { selectedValues: ["b", "a"], customAnswer: "" };
    expect(resolveUserInputAnswer(question, answer)).toBeNull();
    expect(
      resolveUserInputAnswer({ ...question, multiSelect: true }, answer),
    ).toBe("Alpha, Beta");
  });
  it("requires every question to be answered and labels answers with their questions", () => {
    const questions = [
      question,
      { ...question, id: "format", question: "Which format?" },
    ];
    const answers = { scope: { selectedValues: ["a"], customAnswer: "" } };
    expect(formatUserInputAnswers(questions, answers)).toBeNull();
    expect(
      formatUserInputAnswers(questions, {
        ...answers,
        format: { selectedValues: [], customAnswer: "JSON" },
      }),
    ).toBe("Which scope?\nAlpha\n\nWhich format?\nJSON");
    expect(
      formatUserInputAnswers([question], {
        scope: { selectedValues: [], customAnswer: "x".repeat(20_001) },
      }),
    ).toBeNull();
  });
  it("rejects ambiguous IDs, option values, and unanswerable choice-only requests", () => {
    expect(
      userInputQuestionsSchema.safeParse([question, question]).success,
    ).toBe(false);
    expect(
      userInputQuestionsSchema.safeParse([
        { ...question, options: [question.options[0], question.options[0]] },
      ]).success,
    ).toBe(false);
    expect(
      userInputQuestionsSchema.safeParse([
        { ...question, options: [], allowCustomAnswer: false },
      ]).success,
    ).toBe(false);
    expect(
      userInputQuestionsSchema.safeParse([{ ...question, options: [] }])
        .success,
    ).toBe(true);
  });
});
