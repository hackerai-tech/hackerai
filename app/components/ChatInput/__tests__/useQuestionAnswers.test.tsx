import { act, renderHook } from "@testing-library/react";
import { useQuestionAnswers } from "../useQuestionAnswers";
import type { UserInputQuestion } from "@/lib/chat/user-input-questions";

const questions: UserInputQuestion[] = [
  {
    id: "scope",
    header: "Scope",
    question: "Choose scope",
    options: [{ label: "Alpha", value: "a" }],
  },
  { id: "format", header: "Format", question: "Which format?", options: [] },
];
beforeEach(() => localStorage.clear());

it("restores selections, custom text and question position after remount", () => {
  const first = renderHook(() => useQuestionAnswers("request-1", questions));
  act(() => first.result.current.select("a"));
  act(() => first.result.current.go(1));
  act(() => first.result.current.setCustomAnswer("JSON"));
  first.unmount();
  const restored = renderHook(() => useQuestionAnswers("request-1", questions));
  expect(restored.result.current.index).toBe(1);
  expect(restored.result.current.text).toBe(
    "Choose scope\nAlpha\n\nWhich format?\nJSON",
  );
  act(() => restored.result.current.clear());
  expect(localStorage.getItem("request-1")).toBeNull();
});

it("isolates drafts by request and rejects drafts for changed questions", () => {
  const { result, rerender } = renderHook(
    ({ request, items }) => useQuestionAnswers(request, items),
    { initialProps: { request: "request-1", items: questions } },
  );
  act(() => result.current.select("a"));
  rerender({ request: "request-2", items: questions });
  expect(result.current.answer.selectedValues).toEqual([]);
  rerender({ request: "request-1", items: questions });
  expect(result.current.answer.selectedValues).toEqual(["a"]);
  rerender({
    request: "request-1",
    items: [{ ...questions[0], options: [{ label: "Beta", value: "b" }] }],
  });
  expect(result.current.answer.selectedValues).toEqual([]);
  expect(result.current.text).toBeNull();
});
