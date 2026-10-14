"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { BookOpen, Check, Search, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useComposerActions } from "@/app/contexts/ComposerState";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import { MAX_SELECTED_SKILLS } from "@/lib/user-skills/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { MySkills, useSkillsAccess } from "../MySkills";

type Skill = { id: Id<"user_skills">; name: string; description: string };
type SkillInput = {
  selected: Skill[];
  disabled: boolean;
  open: boolean;
  listId: string;
  activeId?: string;
  toggle: () => void;
  remove: (id: Skill["id"]) => void;
  inspect: (element: HTMLTextAreaElement) => void;
  keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
};
const SkillInputContext = createContext<SkillInput | null>(null);
export const useComposerSkills = () => useContext(SkillInputContext);

type Props = {
  chatId?: string;
  disabled: boolean;
  onSavingChange: (saving: boolean) => void;
  children: ReactNode;
};
export function ComposerSkillsProvider({
  chatId,
  disabled,
  onSavingChange,
  children,
}: Props) {
  const enabled = useSkillsAccess();
  const available = enabled && !!chatId;
  const library = useQuery(api.userSkills.list, available ? {} : "skip");
  const selection = useQuery(
    api.userSkills.selection,
    available ? { chatId } : "skip",
  );
  const select = useMutation(api.userSkills.select);
  const { getInput, setInput } = useComposerActions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const token = useRef<{ start: number; end: number; text: string } | null>(
    null,
  );
  const dismissed = useRef<number | null>(null);
  const pending = useRef(false);
  const currentChat = useRef(chatId);
  currentChat.current = chatId;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    token.current = null;
    dismissed.current = null;
    setOpen(false);
    setError("");
  }, [chatId, available]);
  useEffect(() => {
    if (available)
      captureQueuedAuthenticatedEvent({
        event: "user_skills_exposed",
        properties: { surface: "composer" },
        dedupeKey: crypto.randomUUID(),
      });
  }, [available]);
  const listId = useId();
  const selected = selection ?? [];
  const ids = selected.map((skill) => skill.id);
  const unavailable =
    !available ||
    disabled ||
    saving ||
    library === undefined ||
    selection === undefined;
  const needle = query.toLocaleLowerCase().trim();
  const matches = (library ?? []).filter((skill) =>
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle),
  );
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;

  function close() {
    dismissed.current = token.current?.start ?? null;
    setOpen(false);
  }
  async function change(next: Skill["id"][], consumeToken = false) {
    if (unavailable || pending.current || !chatId) return;
    const selectedToken = consumeToken ? token.current : null;
    pending.current = true;
    setSaving(true);
    onSavingChange(true);
    setError("");
    try {
      await select({ chatId, ids: next });
      captureQueuedAuthenticatedEvent({
        event: "user_skills_selected",
        properties: { chat_id: chatId, selected_count: next.length },
        dedupeKey: crypto.randomUUID(),
      });
      if (!mounted.current || currentChat.current !== chatId) return;
      if (selectedToken) {
        const { start, end, text } = selectedToken;
        const current = getInput();
        // Preserve edits made while the selection was being saved.
        if (current.slice(start, end) === text) {
          setInput(current.slice(0, start) + current.slice(end));
          requestAnimationFrame(() => {
            textarea.current?.focus();
            textarea.current?.setSelectionRange(start, start);
          });
        }
      }
      token.current = null;
      setOpen(false);
    } catch (cause) {
      if (!mounted.current || currentChat.current !== chatId) return;
      setOpen(true);
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to select skill. Please retry.",
      );
    } finally {
      pending.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  }
  function pick(skill: Skill) {
    if (ids.includes(skill.id)) {
      void change(ids, true);
      return;
    }
    if (ids.length >= MAX_SELECTED_SKILLS) {
      setError(
        "Remove a selected skill before adding another. You can select up to 3.",
      );
      return;
    }
    void change([...ids, skill.id], true);
  }
  function inspect(element: HTMLTextAreaElement) {
    textarea.current = element;
    if (
      !available ||
      disabled ||
      element.selectionStart !== element.selectionEnd
    ) {
      token.current = null;
      setOpen(false);
      return;
    }
    const before = element.value.slice(0, element.selectionStart);
    const match = /(?:^|\s)\$([^\s$]*)$/.exec(before);
    if (!match) {
      token.current = null;
      dismissed.current = null;
      setOpen(false);
      return;
    }
    const start = before.length - match[1].length - 1;
    token.current = { start, end: before.length, text: before.slice(start) };
    if (dismissed.current === start) return;
    dismissed.current = null;
    setQuery(match[1]);
    setActive(0);
    setOpen(true);
  }
  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (!open || disabled || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) =>
        matches.length
          ? (value + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
            matches.length
          : 0,
      );
      return true;
    }
    if (
      (event.key === "Enter" && !event.shiftKey) ||
      (event.key === "Tab" && matches.length > 0)
    ) {
      event.preventDefault();
      if (matches[activeIndex]) pick(matches[activeIndex]);
      return true;
    }
    return false;
  }
  useEffect(() => {
    if (open)
      document
        .getElementById(`${listId}-${activeIndex}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, listId]);
  const context: SkillInput = {
    selected,
    disabled: unavailable,
    open,
    listId,
    activeId: open && matches.length ? optionId(activeIndex) : undefined,
    inspect,
    keyDown: navigate,
    remove: (id) => {
      void change(ids.filter((value) => value !== id));
    },
    toggle: () => {
      token.current = null;
      setQuery("");
      setActive(0);
      setError("");
      setOpen(!open);
    },
  };
  return (
    <SkillInputContext.Provider value={available ? context : null}>
      <Popover
        open={available && open && !disabled}
        onOpenChange={(value) => {
          if (!value) close();
          else setOpen(true);
        }}
      >
        <PopoverAnchor asChild>{children}</PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          className="w-[min(32rem,calc(100vw-2rem))] p-0 overflow-hidden rounded-xl"
          onOpenAutoFocus={(event) => {
            if (token.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (event.target === textarea.current) event.preventDefault();
          }}
        >
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="size-4 text-muted-foreground" />
            {token.current ? (
              <span className="py-1 text-sm">
                {query ? `Skills matching “${query}”` : "Select a skill"}
              </span>
            ) : (
              <Input
                aria-label="Search skills"
                role="combobox"
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={
                  matches.length ? optionId(activeIndex) : undefined
                }
                aria-autocomplete="list"
                placeholder="Search skills…"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={navigate}
                className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
              />
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {selected.length}/3
            </span>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Skills"
            className="max-h-64 overflow-y-auto p-1.5"
          >
            {matches.map((skill, index) => (
              <button
                type="button"
                key={skill.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                disabled={unavailable}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(skill)}
                className={`flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm disabled:opacity-50 ${index === activeIndex ? "bg-accent" : "hover:bg-accent/60"}`}
              >
                <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {skill.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {skill.description || "Reusable methodology"}
                  </span>
                </span>
                {ids.includes(skill.id) && (
                  <Check className="size-4 shrink-0" aria-label="Selected" />
                )}
                <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  Private
                </span>
              </button>
            ))}
            {!matches.length && (
              <p className="p-3 text-sm text-muted-foreground">
                {library === undefined
                  ? "Loading skills…"
                  : library.length
                    ? "No matching skills."
                    : "No skills yet. Create or import one in Manage skills."}
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="px-3 pb-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between border-t px-2 py-1.5">
            <MySkills />
            <span className="pr-1 text-xs text-muted-foreground">
              ↑↓ navigate · Enter select
            </span>
          </div>
        </PopoverContent>
      </Popover>
    </SkillInputContext.Provider>
  );
}
export function ComposerSkillsButton() {
  const skills = useComposerSkills();
  if (!skills) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      aria-label="Add skill"
      title="Add a skill ($)"
      disabled={skills.disabled}
      onClick={skills.toggle}
    >
      <BookOpen className="size-4" />
    </Button>
  );
}
export function ComposerSkillSelections() {
  const skills = useComposerSkills();
  if (!skills?.selected.length) return null;
  return (
    <div
      aria-label="Skills selected for this chat"
      className="flex flex-wrap gap-1.5 px-4"
    >
      {skills.selected.map((skill) => (
        <span
          key={skill.id}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2 pr-1 text-xs"
          title={`${skill.description || skill.name}. Available for this chat; content loads when relevant.`}
        >
          <BookOpen className="size-3 shrink-0 text-muted-foreground" />
          <span className="max-w-48 truncate">{skill.name}</span>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Remove ${skill.name} from this chat`}
            disabled={skills.disabled}
            onClick={() => skills.remove(skill.id)}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
