"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import { BookOpen, Download, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { downloadFile } from "@/lib/utils/file-download";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
        <DialogContent className="flex max-h-[min(85dvh,48rem)] flex-col gap-0 overflow-hidden rounded-2xl border-border/70 bg-background p-0 sm:max-w-lg">
          <DialogHeader className="shrink-0 gap-1.5 border-b border-border/60 px-6 py-5 pr-12 text-left">
            <DialogTitle className="text-base">
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
                : "Your workflows, ready to reuse in any chat."}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            {error && (
              <p
                role="alert"
                className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
              <div className="space-y-4">
                {!!library?.length && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-muted-foreground">
                      {library.length}{" "}
                      {library.length === 1 ? "skill" : "skills"}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-foreground text-background hover:bg-foreground/90"
                        onClick={() =>
                          setEditor({
                            source: "manual",
                            draft: { ...emptyDraft },
                          })
                        }
                      >
                        <Plus className="size-4" />
                        New skill
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => fileInput.current?.click()}
                      >
                        <Upload className="size-4" />
                        Import
                      </Button>
                    </div>
                  </div>
                )}
                <input
                  ref={fileInput}
                  type="file"
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
                {library === undefined ? (
                  <p
                    role="status"
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    Loading skills…
                  </p>
                ) : library.length === 0 ? (
                  <div className="flex flex-col items-center px-2 py-7 text-center">
                    <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
                      <BookOpen
                        aria-hidden="true"
                        className="size-5 text-muted-foreground"
                      />
                    </div>
                    <h3 className="text-sm font-medium">
                      Save your first skill
                    </h3>
                    <p className="mt-2 max-w-64 text-sm leading-relaxed text-muted-foreground">
                      Turn a repeatable workflow into instructions you can add
                      to any chat.
                    </p>
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      <Button
                        size="sm"
                        className="bg-foreground text-background hover:bg-foreground/90"
                        onClick={() =>
                          setEditor({
                            source: "manual",
                            draft: { ...emptyDraft },
                          })
                        }
                      >
                        <Plus className="size-4" />
                        New skill
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => fileInput.current?.click()}
                      >
                        <Upload className="size-4" />
                        Import Markdown
                      </Button>
                    </div>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {library.map((skill) => (
                      <li
                        key={skill.id}
                        className="space-y-2 rounded-xl border border-border/60 bg-muted/40 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium break-words">
                              {skill.name}
                            </p>
                            <p className="text-sm text-muted-foreground break-words">
                              {skill.description}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={skill.isDefault}
                              disabled={!ready}
                              onChange={(e) =>
                                void perform(() =>
                                  setDefault({
                                    id: skill.id,
                                    enabled: e.target.checked,
                                  }),
                                )
                              }
                            />
                            Default for new chats
                          </label>
                          <div className="flex shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${skill.name}`}
                              disabled={busy}
                              onClick={() =>
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
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Export ${skill.name}`}
                              disabled={busy}
                              onClick={() =>
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
                              <Download className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${skill.name}`}
                              disabled={busy}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Delete “${skill.name}”? This removes it from your library and future loads.`,
                                  )
                                )
                                  void perform(() => remove({ id: skill.id }));
                              }}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          {!editor && (
            <div className="shrink-0 border-t border-border/60 bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
              <p>
                Type{" "}
                <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-foreground">
                  $
                </kbd>{" "}
                in a chat to choose a skill.
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
