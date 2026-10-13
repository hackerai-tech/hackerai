"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvex, useConvexAuth, useMutation, useQuery } from "convex/react";
import { BookOpen, Download, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { api } from "@/convex/_generated/api";
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
function useSkillsAccess() {
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
          .then((r) => (r.ok ? r.json() : null))
          .then((r) => r?.enabled === true)
          .catch(() => false),
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
  chatId,
  disabled = false,
  conversationText,
}: {
  chatId?: string;
  disabled?: boolean;
  conversationText?: string;
}) {
  const enabled = useSkillsAccess();
  return enabled ? (
    <SkillsControl
      chatId={chatId}
      disabled={disabled}
      conversationText={conversationText}
    />
  ) : null;
}
function SkillsControl({
  chatId,
  disabled,
  conversationText,
}: {
  chatId?: string;
  disabled: boolean;
  conversationText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<Editor>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const client = useConvex();
  const library = useQuery(api.userSkills.list, {});
  const selection = useQuery(
    api.userSkills.selection,
    chatId ? { chatId } : "skip",
  );
  const save = useMutation(api.userSkills.save);
  const remove = useMutation(api.userSkills.remove);
  const setDefault = useMutation(api.userSkills.setDefault);
  const select = useMutation(api.userSkills.select);
  const selected = chatId
    ? (selection ?? [])
    : (library?.filter((s) => s.isDefault) ?? []);
  const ids = selected.map((s) => s.id);
  useEffect(() => {
    if (conversationText === undefined)
      capture("user_skills_exposed", { surface: "composer" });
  }, [conversationText]);
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
    capture("user_skills_exposed", {
      surface: conversationText === undefined ? "library" : "conversation",
    });
  }
  const ready =
    !busy &&
    !disabled &&
    library !== undefined &&
    (!chatId || selection !== undefined);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={begin}
        disabled={disabled}
        aria-label={
          conversationText === undefined ? "My Skills" : "Save as skill"
        }
        title={
          selected.length
            ? `Available in this chat: ${selected.map((s) => s.name).join(", ")}. Loaded only when needed.`
            : "My Skills"
        }
      >
        <BookOpen className="size-4" />
        {conversationText === undefined ? (
          <span>Skills{selected.length ? ` (${selected.length})` : ""}</span>
        ) : (
          <span className="sr-only">Save as skill</span>
        )}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            if (!value) setEditor(undefined);
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor ? "Review and save skill" : "My Skills"}
            </DialogTitle>
            <DialogDescription>
              {editor
                ? "Keep reusable methodology and context. Remove private targets, credentials, and details that belong only to this conversation."
                : "Private Markdown you can reuse across chats. Select up to 3 skills; content loads only when needed."}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
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
                  required
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
                  className="min-h-64 font-mono text-sm"
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
                {utf8Bytes(editor.draft.content).toLocaleString()} /{" "}
                {MAX_SKILL_BYTES.toLocaleString()} bytes. Skills provide
                reference context. They cannot grant permissions or run scripts
                automatically.
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
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    setEditor({ source: "manual", draft: { ...emptyDraft } })
                  }
                >
                  <Plus className="size-4" />
                  New skill
                </Button>
                <Button
                  variant="outline"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload className="size-4" />
                  Upload SKILL.md
                </Button>
              </div>
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
              {chatId && (
                <div className="rounded-md border p-3 text-sm">
                  <strong>Available in this chat</strong>
                  <p>
                    {selection === undefined
                      ? "Loading selection…"
                      : selected.length
                        ? selected.map((s) => s.name).join(", ")
                        : "No skills selected"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Changes apply to the next response. Previously loaded text
                    can remain in chat history. Start a new chat to fully remove
                    that context.
                  </p>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Defaults are selected for new chats only. Selecting a skill
                makes it available; the “Loading skills” message shows when its
                content is used.
              </p>
              {library === undefined ? (
                <p>Loading skills…</p>
              ) : library.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                  Save your first methodology, upload Markdown, or use “Save as
                  skill” beneath an assistant message.
                </p>
              ) : (
                <ul className="space-y-3">
                  {library.map((skill) => (
                    <li
                      key={skill.id}
                      className="rounded-md border p-3 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium break-words">
                            {skill.name}
                          </p>
                          <p className="text-sm text-muted-foreground break-words">
                            {skill.description}
                          </p>
                        </div>
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
                                const url = URL.createObjectURL(
                                  new Blob([exportSkill(draft)], {
                                    type: "text/markdown;charset=utf-8",
                                  }),
                                );
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = "SKILL.md";
                                a.click();
                                setTimeout(
                                  () => URL.revokeObjectURL(url),
                                  1000,
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
                      <div className="flex flex-wrap gap-4 text-sm">
                        {chatId && (
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={ids.includes(skill.id)}
                              disabled={!ready}
                              onChange={(e) =>
                                void perform(async () => {
                                  const next = e.target.checked
                                    ? [...ids, skill.id]
                                    : ids.filter((id) => id !== skill.id);
                                  await select({ chatId, ids: next });
                                  capture("user_skills_selected", {
                                    chat_id: chatId,
                                    selected_count: next.length,
                                  });
                                })
                              }
                            />
                            Use in this chat
                          </label>
                        )}
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
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
