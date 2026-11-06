"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Check } from "lucide-react";
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
  canAdvance,
  onSelect,
  onAdvance,
  onBack,
  onStop,
  stopping = false,
}: {
  question: UserInputQuestion;
  answer: UserInputAnswer;
  index: number;
  total: number;
  disabled: boolean;
  canAdvance: boolean;
  onSelect: (value: string) => void;
  onAdvance: () => void;
  onBack: () => void;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const advance = useRef(onAdvance);
  useEffect(() => {
    advance.current = onAdvance;
  });
  useEffect(() => () => clearTimeout(timer.current), [question.id]);
  useEffect(() => {
    if (disabled || answer.customAnswer) clearTimeout(timer.current);
  }, [disabled, answer.customAnswer]);
  const select = (value: string) => {
    if (disabled) return;
    onSelect(value);
    clearTimeout(timer.current);
    if (!question.multiSelect)
      timer.current = setTimeout(() => advance.current(), 200);
  };
  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });
  useEffect(() => {
    if (disabled || collapsed) return;
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
        event.target.closest("input, textarea, [contenteditable=true]")
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
  }, [question, disabled, collapsed]);
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
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-xs text-muted-foreground"
        >
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
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onStop}
            disabled={stopping}
          >
            Stop
          </Button>
        )}
      </div>
      {!collapsed && (
        <div className="max-h-[35dvh] overflow-y-auto px-3 pb-1">
          <div className="min-w-0 break-words px-1 pb-2 text-sm">
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
                  disabled={disabled}
                  onClick={() => select(option.value)}
                  className="flex w-full items-start gap-2.5 rounded-md px-1 py-2 text-left text-foreground/80 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${question.multiSelect ? "rounded" : "rounded-full"} ${selected ? "border-foreground bg-foreground text-background" : "border-muted-foreground/60"}`}
                  >
                    {selected &&
                      (question.multiSelect ? (
                        <Check className="size-3" />
                      ) : (
                        <span className="size-1.5 rounded-full bg-background" />
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
                  <kbd className="mt-0.5 shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                    {optionIndex + 1}
                  </kbd>
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex items-center justify-end gap-1">
            {index > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onBack}
                disabled={disabled}
              >
                Back
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onAdvance}
              disabled={disabled || !canAdvance}
            >
              {index + 1 < total ? "Next" : "Submit answer"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
