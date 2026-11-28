"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Check,
  MessageCircleQuestionMark,
  Square,
  X,
} from "lucide-react";
import type {
  UserInputQuestion,
  UserInputAnswer,
} from "@/lib/chat/user-input-questions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { isShortcutTargetBlocked } from "@/lib/keyboard-shortcuts";
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
  const [questionOverflows, setQuestionOverflows] = useState(false);
  const questionPreviewRef = useRef<HTMLDivElement>(null);
  const questionContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const preview = questionPreviewRef.current;
    const content = questionContentRef.current;
    if (!preview || !content) return;
    const measure = () =>
      setQuestionOverflows(content.scrollHeight > preview.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    observer.observe(content);
    return () => observer.disconnect();
  }, [collapsed, question.question]);
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
      // Text fields, selects, menus, and dialogs own their number keys
      // (e.g. typeahead), so only claim keys typed elsewhere.
      if (
        isShortcutTargetBlocked(event) ||
        (event.target instanceof Element &&
          event.target.closest(
            'input, textarea, select, [contenteditable=true], [role="combobox"], [role="listbox"], [role="menu"], [role="menubar"], [role^="menuitem"], [role="dialog"], [role="alertdialog"], dialog',
          ))
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
      className="relative flex min-h-0 min-w-0 flex-col rounded-t-[22px] border border-b-0 border-black/8 bg-input-chat dark:border-border"
    >
      <div className="flex shrink-0 items-start gap-2 pl-4 pr-2 pt-2">
        <div className="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <MessageCircleQuestionMark
              className="size-3.5 shrink-0"
              aria-hidden="true"
            />
            Input needed
            {total > 1 && (
              <span className="font-medium normal-case tracking-normal">
                · {index + 1} of {total}
              </span>
            )}
          </span>
          <span
            className={`mt-1 min-w-0 font-semibold text-foreground ${collapsed ? "truncate text-sm" : "text-base leading-6 sm:text-[17px]"}`}
          >
            {question.header}
            {collapsed && (
              <span className="ml-2 font-normal text-muted-foreground">
                {question.question}
              </span>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand question" : "Collapse question"}
            aria-expanded={!collapsed}
            className="flex size-11 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:size-9"
          >
            {collapsed ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="size-4" aria-hidden="true" />
            )}
          </button>
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              aria-label="Stop agent"
              title="Stop agent"
              className="flex size-11 items-center justify-center rounded-full bg-destructive/15 text-destructive outline-none hover:bg-destructive/25 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:size-9"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="flex min-h-0 flex-col">
          <div className="min-w-0 shrink-0 break-words px-4 pb-1 pt-1 text-[15px] leading-6 text-foreground/90">
            <div
              ref={questionPreviewRef}
              inert={questionOverflows || undefined}
              className="max-h-24 overflow-hidden [@media(max-height:600px)]:max-h-15"
            >
              <div ref={questionContentRef}>
                <MemoizedMarkdown content={question.question} />
              </div>
            </div>
            {questionOverflows && (
              <Dialog>
                <DialogTrigger asChild>
                  <button
                    type="button"
                    className="min-h-11 rounded-md text-xs font-medium text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Read full question
                  </button>
                </DialogTrigger>
                <DialogContent
                  aria-describedby={undefined}
                  showCloseButton={false}
                  className="flex max-h-[80dvh] flex-col"
                >
                  <DialogTitle className="shrink-0 pr-8">
                    {question.header}
                  </DialogTitle>
                  <div
                    role="region"
                    aria-label="Full question"
                    tabIndex={0}
                    className="min-h-0 overflow-y-auto overscroll-contain rounded-sm p-1 break-words text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <MemoizedMarkdown content={question.question} />
                  </div>
                  <DialogClose asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-2 top-2 size-11"
                      aria-label="Close"
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </DialogClose>
                </DialogContent>
              </Dialog>
            )}
          </div>
          <div className="max-h-[min(20rem,38dvh)] min-h-0 space-y-2 overflow-y-auto overscroll-contain px-3 pb-3 pt-2 [mask-image:linear-gradient(to_bottom,transparent,#000_8px,#000_calc(100%_-_8px),transparent)]">
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
                  className={`flex min-h-11 w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-foreground/40 bg-muted text-foreground" : "border-transparent bg-black/[0.035] text-foreground/90 hover:bg-black/[0.06] dark:bg-white/[0.05] dark:hover:bg-white/[0.08]"}`}
                >
                  <span className="min-w-0 flex-1 break-words">
                    <span className="block text-[15px] font-semibold leading-5">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="block pt-1 text-sm leading-5 text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  <kbd className="mt-0.5 hidden shrink-0 rounded border px-1 text-[10px] text-muted-foreground sm:block">
                    {optionIndex + 1}
                  </kbd>
                  {(question.multiSelect || selected) && (
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center border ${question.multiSelect ? "rounded-md" : "rounded-full"} ${selected ? "border-foreground bg-foreground text-background" : "border-muted-foreground/60"}`}
                    >
                      {selected && <Check className="size-3.5" />}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
