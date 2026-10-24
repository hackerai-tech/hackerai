import type { FilePart } from "@/types/file";

export type CapturedFile = {
  id: string;
  messageId: string;
  toolCallId?: string;
  path: string;
  name: string;
  source: string;
  sourceId: string;
  action: string;
  capturedAt?: number;
  text?: string;
  originalText?: string;
  partial: boolean;
  detail: string;
  saved?: FilePart;
};

type Part = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: Record<string, any>;
  output?: any;
};
export type FileMessage = {
  id?: string;
  role: string;
  parts?: Part[];
  fileDetails?: Array<Record<string, any>>;
};
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const truncated = (value?: string) =>
  /\[(?:[^\]\n]*truncat|[^\]\n]*omitted)|\.\.\.\s*\[|output truncated/i.test(
    value ?? "",
  );
const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;
const sourceLabel = (value: unknown) =>
  value === "cloud"
    ? "Cloud"
    : value === "desktop"
      ? "Desktop"
      : value === "remote-connection"
        ? "Local"
        : "Source not recorded";

/** Index only persisted results. Never read a current filesystem to fill a gap. */
export function collectChatFiles(
  messages: readonly FileMessage[],
): CapturedFile[] {
  const files: CapturedFile[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.id) continue;
    for (const part of message.parts ?? []) {
      if (
        part.state !== "output-available" ||
        !part.toolCallId ||
        !part.input ||
        part.output?.error
      )
        continue;
      if (
        ![
          "tool-file",
          "tool-read_file",
          "tool-write_file",
          "tool-search_replace",
          "tool-multi_edit",
        ].includes(part.type)
      )
        continue;
      const input = part.input;
      const output = part.output;
      const path = text(input.path ?? input.file_path ?? input.target_file);
      if (!path) continue;
      const action =
        part.type === "tool-file"
          ? input.action
          : (
              {
                "tool-read_file": "read",
                "tool-write_file": "write",
                "tool-search_replace": "edit",
                "tool-multi_edit": "edit",
              } as Record<string, string>
            )[part.type];
      let content: string | undefined;
      let originalText: string | undefined;
      let partial = false;
      if (action === "write")
        content = text(input.text ?? input.contents ?? input.content);
      else if (action === "read") {
        content = text(output?.originalContent);
        // Older tool output can include formatting and truncation; keep it as captured.
        if (content === undefined) {
          content = text(output?.result?.content ?? output?.result);
          partial = true;
        }
        partial ||= !!input.range || !!input.offset || !!input.limit;
      } else if (action === "edit" || action === "append") {
        originalText = text(output?.originalContent);
        content = text(output?.modifiedContent);
        if (content === undefined && action === "append") {
          const added = text(input.text);
          content =
            originalText !== undefined && added !== undefined
              ? originalText + added
              : added;
          partial = originalText === undefined;
        }
      }
      partial ||= truncated(content) || truncated(originalText);
      const snapshot = output?.fileSnapshot;
      const source = sourceLabel(snapshot?.environment);
      const previews =
        action === "view" && Array.isArray(output?.previewFiles)
          ? output.previewFiles
          : [];
      if (content === undefined && previews.length === 0) continue;
      const base = {
        messageId: message.id,
        toolCallId: part.toolCallId,
        path,
        name: nameOf(path),
        source,
        sourceId: text(snapshot?.identity) ?? "unknown",
        action,
        capturedAt:
          typeof snapshot?.capturedAt === "number"
            ? snapshot.capturedAt
            : undefined,
        partial,
        detail: input.range
          ? `Captured lines ${input.range[0]}–${input.range[1] === -1 ? "end" : input.range[1]}`
          : partial
            ? "Partial capture"
            : "Captured tool result",
      };
      if (content !== undefined)
        files.push({
          ...base,
          id: `${message.id}:${part.toolCallId}`,
          text: content,
          originalText,
        });
      previews.forEach((saved: FilePart, index: number) =>
        files.push({
          ...base,
          id: `${message.id}:${part.toolCallId}:${index}`,
          name:
            previews.length > 1
              ? `${nameOf(path)} · page ${index + 1}`
              : nameOf(path),
          saved,
          detail: "Saved preview",
          partial: true,
        }),
      );
    }
    for (const [index, saved] of (message.fileDetails ?? []).entries()) {
      if (!saved.fileId && !saved.s3Key && !saved.url) continue;
      const name = text(saved.name ?? saved.filename) ?? "Saved file";
      files.push({
        id: `${message.id}:saved:${saved.fileId ?? index}`,
        messageId: message.id,
        name,
        path: name,
        source: "Saved files",
        sourceId: "saved",
        action: "delivered",
        partial: false,
        detail: "Saved with this chat",
        saved: { ...saved, filename: name },
      });
    }
  }
  return files;
}
