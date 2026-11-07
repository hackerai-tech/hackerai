"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Check,
  MessageCircleQuestionMark,
} from "lucide-react";
import type {
  UserInputQuestion,
  UserInputAnswer,
} from "@/lib/chat/user-input-questions";
import { Button } from "@/components/ui/button";
import { MemoizedMarkdown } from "../MemoizedMarkdown";

export function UserInputQuestionPanel({
  question,
  answer,
  index,
  total,
  disabled,
  answersLocked = false,
  onSelect,
  onStop,
  stopping = false,
}: {
  question: UserInputQuestion;
  answer: UserInputAnswer;
  index: number;
  total: number;
  disabled: boolean;
  answersLocked?: boolean;
  onSelect: (value: string) => void;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const select = (value: string) => {
    if (disabled || answersLocked) return;
    onSelect(value);
  };
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });
  useEffect(() => {
    if (disabled || answersLocked || collapsed) return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        event.repeat
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, [contenteditable=true], [role="dialog"], [role="alertdialog"], dialog',
        )
      )
        return;
      if (!/^[1-9]$/.test(event.key)) return;
      const option = question.options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        selectRef.current(option.value);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [question, disabled, answersLocked, collapsed]);
  return (
    <section
      aria-label="Agent question"
      className="relative mx-3 -mb-3 min-w-0 rounded-t-xl border border-b-0 border-black/8 bg-input-chat pb-4 dark:border-border"
    >
      <div className="flex min-h-9 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 py-2 text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex shrink-0 items-center gap-1.5 font-medium text-foreground">
            <MessageCircleQuestionMark
              className="size-3.5"
              aria-hidden="true"
            />
            Input
          </span>
          <span className="truncate">{question.header}</span>
          {collapsed && (
            <span className="min-w-0 flex-1 truncate">{question.question}</span>
          )}
          <span className="ml-auto shrink-0">
            {total > 1 ? `${index + 1}/${total}` : ""}
          </span>
          {collapsed ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronUp className="size-3.5 shrink-0" />
          )}
        </button>
        {onStop && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-10 px-2 text-xs text-muted-foreground sm:h-8"
            onClick={onStop}
            disabled={stopping}
          >
            Stop
          </Button>
        )}
      </div>
      {!collapsed && (
        <div className="max-h-[30dvh] overflow-y-auto overscroll-contain px-3 pb-1">
          <div className="min-w-0 break-words px-1 pb-1 text-sm">
            <MemoizedMarkdown content={question.question} />
          </div>
          <div className="space-y-0.5">
            {question.options.map((option, optionIndex) => {
              const selected =
                !answer.customAnswer.trim() &&
                answer.selectedValues.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  disabled={disabled || answersLocked}
                  onClick={() => select(option.value)}
                  className={`flex min-h-11 w-full items-start gap-2.5 rounded-lg px-2 py-2.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "bg-muted text-foreground" : "text-foreground/80"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${question.multiSelect ? "rounded" : "rounded-full"} ${selected ? "border-foreground bg-foreground text-background" : "border-muted-foreground/60"}`}
                  >
                    {selected &&
                      (question.multiSelect ? (
                        <Check className="size-3" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-white dark:bg-background" />
                      ))}
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    <span className="block text-sm font-medium">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="block pt-0.5 text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <kbd className="mt-0.5 hidden shrink-0 rounded border px-1 text-[10px] text-muted-foreground sm:block">
                    {optionIndex + 1}
                  </kbd>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
