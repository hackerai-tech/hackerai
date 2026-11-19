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
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

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

it("restores the submitted answer when a delayed claim arrives and after reload", () => {
  const first = renderHook(
    ({ claimed }) => useQuestionAnswers("claimed", questions, claimed),
    {
      initialProps: { claimed: false },
    },
  );
  act(() => first.result.current.select("a"));
  act(() => first.result.current.go(1));
  act(() => first.result.current.setCustomAnswer("JSON"));
  act(() => first.result.current.markSubmitted());
  act(() => first.result.current.setCustomAnswer("XML"));
  first.rerender({ claimed: true });
  expect(first.result.current.locked).toBe(true);
  expect(first.result.current.answer.customAnswer).toBe("JSON");
  act(() => first.result.current.setCustomAnswer("Changed"));
  expect(first.result.current.answer.customAnswer).toBe("JSON");
  first.unmount();
  const restored = renderHook(() =>
    useQuestionAnswers("claimed", questions, true),
  );
  expect(restored.result.current.text).toBe(
    "Choose scope\nAlpha\n\nWhich format?\nJSON",
  );
  expect(restored.result.current.locked).toBe(true);
  act(() => restored.result.current.releaseSubmission());
  expect(restored.result.current.locked).toBe(false);
  act(() =>
    restored.result.current.setCustomAnswer("Original from another tab"),
  );
  expect(restored.result.current.answer.customAnswer).toBe(
    "Original from another tab",
  );
});

it("allows retyping an original reply when another browser owns the claim", () => {
  const { result } = renderHook(() =>
    useQuestionAnswers("other-browser", [questions[1]], true),
  );
  act(() => result.current.setCustomAnswer("Original reply"));
  act(() => result.current.markSubmitted());
  expect(result.current.locked).toBe(false);
  expect(result.current.text).toBe("Original reply");
});

it("keeps a valid draft editable if its retry snapshot is corrupt", () => {
  const first = renderHook(() =>
    useQuestionAnswers("corrupt-retry", [questions[1]]),
  );
  act(() => first.result.current.setCustomAnswer("Keep this answer"));
  first.unmount();
  sessionStorage.setItem("corrupt-retry:submitted", "invalid JSON");
  const restored = renderHook(() =>
    useQuestionAnswers("corrupt-retry", [questions[1]], true),
  );
  expect(restored.result.current.text).toBe("Keep this answer");
  expect(restored.result.current.locked).toBe(false);
});
