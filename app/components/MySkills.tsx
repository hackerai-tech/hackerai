"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import {
  BookOpen,
  ChevronDown,
  Download,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { downloadFile } from "@/lib/utils/file-download";
import { searchUserSkills } from "@/lib/user-skills/search";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import {
  exportSkill,
  importSkill,
  MAX_SKILL_BYTES,
  utf8Bytes,
  validateSkill,
  type SkillDraft,
} from "@/lib/user-skills/contracts";

const accessRequests = new Map<
  string,
  { expires: number; promise: Promise<boolean> }
>();
export function useSkillsAccess() {
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const [allowedUser, setAllowedUser] = useState<string>();
  useEffect(() => {
    let canceled = false;
    if (!user?.id || !isAuthenticated) return;
    const id = user.id;
    let request = accessRequests.get(id);
    if (!request || request.expires < Date.now()) {
      request = {
        expires: Date.now() + 30_000,
        promise: Promise.resolve()
          .then(() => fetch("/api/user-skills/access"))
          .then((r) => {
            if (!r.ok) throw new Error("Skills access check failed");
            return r.json();
          })
          .then((r) => r?.enabled === true)
          .catch(() => {
            if (accessRequests.get(id) === request) accessRequests.delete(id);
            return false;
          }),
      };
      accessRequests.set(id, request);
    }
    void request.promise.then((enabled) => {
      if (!canceled) setAllowedUser(enabled ? id : undefined);
    });
    return () => {
      canceled = true;
    };
  }, [user?.id, isAuthenticated]);
  return isAuthenticated && !!user?.id && allowedUser === user.id;
}
const capture = (
  event: string,
  properties: Record<string, string | number | boolean> = {},
) =>
  captureQueuedAuthenticatedEvent({
    event,
    properties,
    dedupeKey: crypto.randomUUID(),
  });
const SkillsManagerContext = createContext<(() => void) | undefined>(undefined);
export const useSkillsManager = () => useContext(SkillsManagerContext);

// Keep the editor mounted when the chat switches between its centered and mobile composers.
export function SkillsManagerProvider({
  children,
  scopeKey,
}: {
  children: ReactNode;
  scopeKey: string;
}) {
  const [manager, setManager] = useState({ scopeKey, open: false });
  if (manager.scopeKey !== scopeKey) {
    setManager({ scopeKey, open: false });
  }
  const open = manager.scopeKey === scopeKey && manager.open;
  const setOpen = useCallback(
    (value: boolean) => setManager({ scopeKey, open: value }),
    [scopeKey],
  );
  const openManager = useCallback(() => setOpen(true), [setOpen]);
  return (
    <SkillsManagerContext.Provider value={openManager}>
      {children}
      {open && (
        <MySkills
          open
          onOpenChange={(value) => {
            setOpen(value);
            if (!value)
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLTextAreaElement>(
                    'textarea[data-testid="chat-input"]',
                  )
                  ?.focus(),
              );
          }}
        />
      )}
    </SkillsManagerContext.Provider>
  );
}

const emptyDraft: SkillDraft = { name: "", description: "", content: "" };
type Editor = {
  id?: Id<"user_skills">;
  draft: SkillDraft;
  source: "manual" | "upload" | "conversation" | "edit";
};

export function MySkills({
  disabled = false,
  open,
  onOpenChange,
  conversationText,
}: {
  chatId?: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  conversationText?: string;
}) {
  const enabled = useSkillsAccess();
  return enabled ? (
    <SkillsControl
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      conversationText={conversationText}
    />
  ) : null;
}
function SkillsControl({
  disabled,
  open: controlledOpen,
  onOpenChange,
  conversationText,
}: {
  chatId?: string;
  disabled: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  conversationText?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const [editor, setEditor] = useState<Editor>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "defaults">("all");
  const fileInput = useRef<HTMLInputElement>(null);
  const client = useConvex();
  const library = useQuery(api.userSkills.list, {});
  const save = useMutation(api.userSkills.save);
  const remove = useMutation(api.userSkills.remove);
  const setDefault = useMutation(api.userSkills.setDefault);

  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to save changes. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  function begin() {
    setError("");
    setOpen(true);
    if (conversationText !== undefined)
      setEditor({
        source: "conversation",
        draft: { ...emptyDraft, content: conversationText },
      });
  }
  useEffect(() => {
    if (open)
      capture("user_skills_exposed", {
        surface: conversationText === undefined ? "library" : "conversation",
      });
  }, [open, conversationText]);
  const visibleSkills =
    library === undefined
      ? undefined
      : searchUserSkills(
          library.filter((skill) => filter === "all" || skill.isDefault),
          search,
        );
  function newSkill() {
    setError("");
    setEditor({ source: "manual", draft: { ...emptyDraft } });
  }
  const ready = !busy && !disabled && library !== undefined;
  return (
    <>
      {controlledOpen === undefined && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={begin}
          disabled={disabled}
          aria-label={
            conversationText === undefined ? "Manage skills" : "Save as skill"
          }
          title="Manage private skills"
        >
          <BookOpen className="size-4" />
          {conversationText === undefined ? (
            <span>Manage skills</span>
          ) : (
            <span className="sr-only">Save as skill</span>
          )}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            if (!value) setEditor(undefined);
          }
        }}
      >
        <DialogContent
          className={cn(
            "flex max-h-[min(88dvh,48rem)] flex-col gap-0 overflow-hidden rounded-2xl border-border/70 bg-background p-0",
            editor ? "sm:max-w-xl" : "h-[min(80dvh,42rem)] sm:max-w-3xl",
          )}
        >
          <DialogHeader className="shrink-0 gap-1.5 border-b border-border/60 px-5 py-5 pr-12 text-left sm:px-8 sm:py-6">
            <DialogTitle className="text-lg font-semibold tracking-tight">
              {editor
                ? editor.source === "manual"
                  ? "New skill"
                  : editor.source === "edit"
                    ? "Edit skill"
                    : "Review skill"
                : "Skills"}
            </DialogTitle>
            <DialogDescription>
              {editor
                ? "Save instructions you want to reuse. Leave out credentials and details specific to one chat."
                : "Your private workflows, ready to use in HackerAI."}
            </DialogDescription>
          </DialogHeader>
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              editor && "overflow-y-auto px-5 py-5 sm:px-8",
            )}
          >
            {error && (
              <p
                role="alert"
                className="m-4 shrink-0 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            {editor ? (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void perform(async () => {
                    const draft = validateSkill(editor.draft);
                    await save({
                      ...draft,
                      ...(editor.id ? { id: editor.id } : {}),
                    });
                    capture("user_skill_saved", {
                      source: editor.source,
                      content_bytes: utf8Bytes(draft.content),
                    });
                    setEditor(undefined);
                  });
                }}
              >
                <label className="block space-y-1 text-sm">
                  Name
                  <Input
                    autoFocus
                    required
                    placeholder="e.g. API authorization review"
                    maxLength={80}
                    value={editor.draft.name}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, name: e.target.value },
                      })
                    }
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  When to use it
                  <Input
                    maxLength={240}
                    value={editor.draft.description}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, description: e.target.value },
                      })
                    }
                    placeholder="For example: when reviewing an API's authorization"
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  Methodology (Markdown)
                  <Textarea
                    required
                    className="min-h-48 max-h-80 font-mono text-sm"
                    value={editor.draft.content}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        draft: { ...editor.draft, content: e.target.value },
                      })
                    }
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  {(utf8Bytes(editor.draft.content) / 1024).toFixed(1)} / 16 KB
                  · Instructions only, no automatic script execution.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setEditor(undefined)}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      busy || utf8Bytes(editor.draft.content) > MAX_SKILL_BYTES
                    }
                  >
                    Save skill
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="shrink-0 space-y-4 px-5 pt-5 pb-3 sm:px-8">
                  <div className="flex items-center justify-between gap-3">
                    <div className="relative min-w-0 flex-1 sm:max-w-64">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
                      />
                      <Input
                        aria-label="Search skills"
                        placeholder="Search skills"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        className="h-9 bg-transparent pl-9 shadow-none"
                      />
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!ready}
                          className="h-9 shrink-0 gap-1.5 bg-transparent shadow-none"
                        >
                          <Plus className="size-4" /> Add{" "}
                          <ChevronDown className="size-3.5 text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-52 rounded-xl p-1.5"
                      >
                        <DropdownMenuItem onSelect={newSkill}>
                          <Pencil /> New skill
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => fileInput.current?.click()}
                        >
                          <Upload /> Import Markdown
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div
                    className="flex items-center gap-1"
                    role="group"
                    aria-label="Filter skills"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={filter === "all"}
                      onClick={() => setFilter("all")}
                      className={cn(
                        "h-8 px-3 font-normal text-muted-foreground",
                        filter === "all" && "bg-muted text-foreground",
                      )}
                    >
                      All skills
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={filter === "defaults"}
                      onClick={() => setFilter("defaults")}
                      className={cn(
                        "h-8 px-3 font-normal text-muted-foreground",
                        filter === "defaults" && "bg-muted text-foreground",
                      )}
                    >
                      Defaults
                    </Button>
                    {library && (
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {search.trim() || filter !== "all"
                          ? `${visibleSkills?.length} of ${library.length}`
                          : `${library.length} ${library.length === 1 ? "skill" : "skills"}`}
                      </span>
                    )}
                  </div>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  tabIndex={-1}
                  accept=".md,text/markdown"
                  className="sr-only"
                  aria-label="Upload skill Markdown"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    void perform(async () => {
                      if (file.size > MAX_SKILL_BYTES + 1024)
                        throw new Error("Upload a Markdown file up to 17 KiB.");
                      const bytes = await file.arrayBuffer();
                      const text = new TextDecoder("utf-8", {
                        fatal: true,
                      }).decode(bytes);
                      setEditor({
                        source: "upload",
                        draft: importSkill(text, file.name),
                      });
                    });
                  }}
                />
                <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-8">
                  {library === undefined ? (
                    <p
                      role="status"
                      className="py-20 text-center text-sm text-muted-foreground"
                    >
                      Loading skills…
                    </p>
                  ) : library.length === 0 ? (
                    <div className="flex h-full min-h-56 flex-col items-center justify-center py-10 text-center">
                      <BookOpen
                        aria-hidden="true"
                        className="mb-4 size-8 shrink-0 text-muted-foreground/70"
                      />
                      <h3 className="text-sm font-medium">No skills yet</h3>
                      <p className="mt-2 max-w-72 text-sm leading-relaxed text-muted-foreground">
                        Save a workflow you want HackerAI to follow, then choose
                        it in any chat.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-5 bg-transparent shadow-none"
                        onClick={newSkill}
                        disabled={!ready}
                      >
                        <Plus className="size-4" /> New skill
                      </Button>
                    </div>
                  ) : visibleSkills?.length === 0 ? (
                    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center">
                      <Search
                        aria-hidden="true"
                        className="mb-2 size-6 text-muted-foreground/70"
                      />
                      <p className="text-sm font-medium">
                        {search.trim()
                          ? "No matching skills"
                          : "No default skills"}
                      </p>
                      <p className="max-w-64 text-sm text-muted-foreground">
                        {search.trim()
                          ? "Try a different name or description."
                          : "Mark a skill as a default to include it in new chats."}
                      </p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/50">
                      {visibleSkills?.map((skill) => (
                        <li key={skill.id} className="group relative py-4">
                          <div className="flex items-start gap-3 pr-9">
                            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/50">
                              <BookOpen
                                aria-hidden="true"
                                className="size-4 text-muted-foreground"
                              />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p
                                title={skill.name}
                                className="line-clamp-2 text-sm font-medium break-words"
                              >
                                {skill.name}
                              </p>
                              <p
                                title={skill.description}
                                className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground break-words"
                              >
                                {skill.description}
                              </p>
                            </div>
                          </div>
                          <div className="mt-2.5 flex items-center justify-between gap-2 pl-[3.25rem] text-xs text-muted-foreground">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                aria-label="Default for new chats"
                                className="size-3.5 accent-foreground dark:[color-scheme:dark]"
                                checked={skill.isDefault}
                                disabled={!ready}
                                onChange={(event) =>
                                  void perform(() =>
                                    setDefault({
                                      id: skill.id,
                                      enabled: event.target.checked,
                                    }),
                                  )
                                }
                              />
                              Default for new chats
                            </label>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="absolute top-3 right-0 size-8 text-muted-foreground"
                                  aria-label={`Actions for ${skill.name}`}
                                  disabled={busy}
                                >
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="w-40 rounded-xl p-1.5"
                              >
                                <DropdownMenuItem
                                  aria-label={`Edit ${skill.name}`}
                                  disabled={busy}
                                  onSelect={() =>
                                    void perform(async () => {
                                      const draft = await client.query(
                                        api.userSkills.get,
                                        { id: skill.id },
                                      );
                                      setEditor({
                                        id: skill.id,
                                        draft,
                                        source: "edit",
                                      });
                                    })
                                  }
                                >
                                  <Pencil className="size-4" /> Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  aria-label={`Export ${skill.name}`}
                                  disabled={busy}
                                  onSelect={() =>
                                    void perform(async () => {
                                      const draft = await client.query(
                                        api.userSkills.get,
                                        { id: skill.id },
                                      );
                                      const result = await downloadFile({
                                        filename: "SKILL.md",
                                        content: exportSkill(draft),
                                        mimeType: "text/markdown;charset=utf-8",
                                      });
                                      if (result.outcome === "failed")
                                        throw new Error(
                                          "Unable to export skill. Please retry.",
                                        );
                                    })
                                  }
                                >
                                  <Download className="size-4" /> Export
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  aria-label={`Delete ${skill.name}`}
                                  disabled={busy}
                                  onSelect={() => {
                                    if (
                                      window.confirm(
                                        `Delete “${skill.name}”? This removes it from your library and future loads.`,
                                      )
                                    )
                                      void perform(() =>
                                        remove({ id: skill.id }),
                                      );
                                  }}
                                >
                                  <Trash2 className="size-4" /> Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
          {!editor && (
            <div className="shrink-0 border-t border-border/50 px-5 py-3 sm:px-8 text-xs text-muted-foreground">
              <p>
                Type{" "}
                <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-foreground">
                  $
                </kbd>{" "}
                or <kbd className="font-sans">/skill:</kbd> in a chat to choose
                a skill.
              </p>
              {!!library?.length && (
                <details className="mt-2">
                  <summary className="cursor-pointer hover:text-foreground">
                    Defaults and chat history
                  </summary>
                  <p className="mt-2 leading-relaxed">
                    Defaults apply to new chats. Removing a skill stops future
                    loads; previously loaded content stays in that chat’s
                    history.
                  </p>
                </details>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
