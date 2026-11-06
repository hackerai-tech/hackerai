"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  formatUserInputAnswers,
  resolveUserInputAnswer,
  type UserInputAnswer,
  type UserInputQuestion,
} from "@/lib/chat/user-input-questions";

type Draft = { index: number; answers: Record<string, UserInputAnswer> };
const emptyAnswer: UserInputAnswer = { selectedValues: [], customAnswer: "" };
const fallback = new Map<string, string>();
const changeEvent = "hackerai-question-draft";
const serverSnapshot = () => null;
function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(changeEvent, notify);
  };
}

export function useQuestionAnswers(
  key: string | undefined,
  questions: UserInputQuestion[],
) {
  const [openedAt] = useState(Date.now);
  const snapshot = useCallback(() => {
    if (!key) return null;
    if (fallback.has(key)) return fallback.get(key)!;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);
  const savedText = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const signature = JSON.stringify(questions);
  const draft = useMemo<Draft>(() => {
    const next: Draft = { index: 0, answers: Object.create(null) };
    try {
      const saved = JSON.parse(savedText ?? "null");
      if (
        saved?.signature !== signature ||
        !Number.isFinite(saved.savedAt) ||
        openedAt - saved.savedAt >= 7 * 86400_000 ||
        !saved.answers ||
        typeof saved.answers !== "object"
      )
        return next;
      for (const question of questions) {
        const answer = Object.hasOwn(saved.answers, question.id)
          ? saved.answers[question.id]
          : undefined;
        if (
          answer &&
          Array.isArray(answer.selectedValues) &&
          answer.selectedValues.length <= 9 &&
          answer.selectedValues.every(
            (value: unknown) => typeof value === "string",
          ) &&
          typeof answer.customAnswer === "string" &&
          answer.customAnswer.length <= 20_000
        )
          next.answers[question.id] = answer;
      }
      next.index = Number.isInteger(saved.index)
        ? Math.max(0, Math.min(saved.index, questions.length - 1))
        : 0;
    } catch {
      /* Corrupt storage must not prevent answering. */
    }
    return next;
  }, [savedText, signature, questions, openedAt]);
  const question = questions[draft.index];
  const answer =
    question && Object.hasOwn(draft.answers, question.id)
      ? draft.answers[question.id]
      : emptyAnswer;
  const save = (next: Draft) => {
    if (!key) return;
    const serialized = JSON.stringify({
      ...next,
      signature,
      savedAt: Date.now(),
    });
    try {
      localStorage.setItem(key, serialized);
      fallback.delete(key);
    } catch {
      fallback.set(key, serialized);
    }
    window.dispatchEvent(new Event(changeEvent));
  };
  const update = (value: UserInputAnswer) => {
    if (!key || !question) return;
    save({ ...draft, answers: { ...draft.answers, [question.id]: value } });
  };
  return {
    ready: !!key,
    index: draft.index,
    question,
    answer,
    text: formatUserInputAnswers(questions, draft.answers),
    canAdvance: !!question && resolveUserInputAnswer(question, answer) !== null,
    setCustomAnswer: (customAnswer: string) =>
      update({ ...answer, customAnswer }),
    select: (value: string) =>
      update({
        customAnswer: "",
        selectedValues: question?.multiSelect
          ? answer.selectedValues.includes(value)
            ? answer.selectedValues.filter((item) => item !== value)
            : [...answer.selectedValues, value]
          : [value],
      }),
    go: (index: number) =>
      save({
        ...draft,
        index: Math.max(0, Math.min(index, questions.length - 1)),
      }),
    clear: () => {
      if (!key) return;
      fallback.delete(key);
      try {
        localStorage.removeItem(key);
      } catch {
        /* Best effort. */
      }
      window.dispatchEvent(new Event(changeEvent));
    },
  };
}
