"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  formatUserInputAnswers,
  resolveUserInputAnswer,
  type UserInputAnswer,
  type UserInputQuestion,
} from "@/lib/chat/user-input-questions";

type Draft = {
  index: number;
  answers: Record<string, UserInputAnswer>;
  submittedAnswers?: Record<string, UserInputAnswer>;
};
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
  claimed = false,
) {
  const [openedAt] = useState(Date.now);
  const snapshot = useCallback(() => {
    if (!key) return null;
    let saved = null;
    let submitted = null;
    try {
      saved = localStorage.getItem(key);
    } catch {
      /* Storage may be unavailable. */
    }
    try {
      submitted = sessionStorage.getItem(`${key}:submitted`);
    } catch {
      /* Session storage may be unavailable independently. */
    }
    return JSON.stringify([
      fallback.get(key) ?? saved,
      fallback.get(`${key}:submitted`) ?? submitted,
    ]);
  }, [key]);
  const savedText = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const signature = JSON.stringify(questions);
  const draft = useMemo<Draft>(() => {
    const next: Draft = { index: 0, answers: Object.create(null) };
    try {
      const [savedDraft, submittedDraft] = JSON.parse(
        savedText ?? "[null,null]",
      );
      const saved = JSON.parse(savedDraft ?? "null");
      if (
        saved?.signature !== signature ||
        !Number.isFinite(saved.savedAt) ||
        openedAt - saved.savedAt >= 7 * 86400_000 ||
        !saved.answers ||
        typeof saved.answers !== "object"
      )
        return next;
      const readAnswers = (value: unknown) => {
        const answers: Record<string, UserInputAnswer> = Object.create(null);
        if (!value || typeof value !== "object") return answers;
        const source = value as Record<string, UserInputAnswer>;
        for (const question of questions) {
          const answer = Object.hasOwn(source, question.id)
            ? source[question.id]
            : undefined;
          if (
            answer &&
            Array.isArray(answer.selectedValues) &&
            answer.selectedValues.length <= 9 &&
            answer.selectedValues.every(
              (item: unknown) => typeof item === "string",
            ) &&
            typeof answer.customAnswer === "string" &&
            answer.customAnswer.length <= 20_000
          )
            answers[question.id] = answer;
        }
        return answers;
      };
      let submission;
      try {
        submission = JSON.parse(submittedDraft ?? "null");
      } catch {
        /* A corrupt retry snapshot must not discard the editable draft. */
      }
      if (
        submission?.signature === signature &&
        Number.isFinite(submission.savedAt) &&
        openedAt - submission.savedAt < 7 * 86400_000
      ) {
        const submitted = readAnswers(submission.answers);
        if (formatUserInputAnswers(questions, submitted) !== null)
          next.submittedAnswers = submitted;
      }
      next.answers =
        claimed && next.submittedAnswers
          ? next.submittedAnswers
          : readAnswers(saved.answers);
      next.index = Number.isInteger(saved.index)
        ? Math.max(0, Math.min(saved.index, questions.length - 1))
        : 0;
    } catch {
      /* Corrupt storage must not prevent answering. */
    }
    return next;
  }, [savedText, signature, questions, openedAt, claimed]);
  const locked = claimed && !!draft.submittedAnswers;
  const question = questions[draft.index];
  const answer =
    question && Object.hasOwn(draft.answers, question.id)
      ? draft.answers[question.id]
      : emptyAnswer;
  const save = (next: Draft) => {
    if (!key) return;
    const serialized = JSON.stringify({
      ...next,
      submittedAnswers: undefined,
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
    if (!key || !question || locked) return;
    save({ ...draft, answers: { ...draft.answers, [question.id]: value } });
  };
  const removeSubmission = () => {
    if (!key) return;
    fallback.delete(`${key}:submitted`);
    try {
      sessionStorage.removeItem(`${key}:submitted`);
    } catch {
      /* Best effort. */
    }
  };
  return {
    ready: !!key,
    locked,
    index: draft.index,
    question,
    answer,
    text: formatUserInputAnswers(questions, draft.answers),
    canAdvance: !!question && resolveUserInputAnswer(question, answer) !== null,
    markSubmitted: () => {
      if (!key || claimed) return;
      // Keep each tab's attempted reply independently: another tab may race a
      // different answer against the same server claim.
      const serialized = JSON.stringify({
        answers: draft.answers,
        signature,
        savedAt: Date.now(),
      });
      try {
        sessionStorage.setItem(`${key}:submitted`, serialized);
        fallback.delete(`${key}:submitted`);
      } catch {
        fallback.set(`${key}:submitted`, serialized);
      }
      window.dispatchEvent(new Event(changeEvent));
    },
    releaseSubmission: () => {
      removeSubmission();
      window.dispatchEvent(new Event(changeEvent));
    },
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
      removeSubmission();
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
