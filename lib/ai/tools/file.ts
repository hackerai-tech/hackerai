import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { truncateOutput } from "@/lib/token-utils";
import { supportsMultimodalToolResults } from "@/lib/ai/providers";
import { buildSandboxCommandOptions } from "./utils/sandbox-command-options";
import { isCentrifugoSandbox } from "./utils/sandbox-types";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";
import type { Id } from "@/convex/_generated/dataModel";
import { logger } from "@/lib/logger";
import { phLogger } from "@/lib/posthog/server";

const MAX_VIEW_FILE_BYTES = 10 * 1024 * 1024;
const FILE_ACTIONS_WITH_VIEW = [
  "view",
  "read",
  "write",
  "append",
  "edit",
] as const;
const FILE_ACTIONS_TEXT_ONLY = ["read", "write", "append", "edit"] as const;
type FileAction = (typeof FILE_ACTIONS_WITH_VIEW)[number];

const MULTIMODAL_UPGRADE_MESSAGE =
  "The current model does not support multimodal tool results for sandbox images. Please select HackerAI Pro or HackerAI Max and retry the view action.";

type ViewKind = "image";

type ViewPreviewFile = {
  fileId: Id<"files">;
  name: string;
  mediaType: string;
  s3Key?: string;
  storageId?: Id<"_storage">;
};

type ViewMetadata = {
  action: "view";
  content: string;
  path: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  kind: ViewKind;
  previewFiles?: ViewPreviewFile[];
  previewError?: string;
};

type SandboxViewPayload = {
  path: string;
  mediaType: string;
  sizeBytes: number;
  kind: ViewKind;
  data?: string;
};

type FileViewImageUsageOutcome =
  | "success"
  | "unsupported_model"
  | "inspection_failed";

const VIEW_FILE_SCRIPT = String.raw`
import base64
import json
import mimetypes
import os
import sys

path = os.environ["HACKERAI_FILE_VIEW_PATH"]
include_data = os.environ.get("HACKERAI_FILE_VIEW_INCLUDE_DATA") == "1"
max_bytes = int(os.environ.get("HACKERAI_FILE_VIEW_MAX_BYTES", "10485760"))

def emit(payload, code=0):
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(code)

if not os.path.isfile(path):
    emit({"error": f"File not found or is not a regular file: {path}"}, 2)

size = os.path.getsize(path)
if size > max_bytes:
    emit({
        "error": (
            f"Image is too large for view ({size} bytes). "
            f"Maximum supported size is {max_bytes} bytes."
        )
    }, 3)

with open(path, "rb") as f:
    head = f.read(32)

def detect_media_type(head_bytes, file_path):
    if head_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head_bytes.startswith(b"GIF87a") or head_bytes.startswith(b"GIF89a"):
        return "image/gif"
    if head_bytes.startswith(b"RIFF") and head_bytes[8:12] == b"WEBP":
        return "image/webp"
    guessed, _ = mimetypes.guess_type(file_path)
    return guessed or "application/octet-stream"

media_type = detect_media_type(head, path)
if media_type == "image/svg+xml":
    emit({"error": "SVG files are text/vector files. Use the read action instead of view."}, 4)
if not media_type.startswith("image/"):
    emit({
        "error": (
            f"Unsupported media type for view: {media_type}. "
            "The view action is only for raster image files. Use read or a purpose-built converter for PDFs and text-based files."
        )
    }, 5)

payload = {
    "path": path,
    "mediaType": media_type,
    "sizeBytes": size,
    "kind": "image",
}

if include_data:
    with open(path, "rb") as f:
        payload["data"] = base64.b64encode(f.read()).decode("ascii")

emit(payload)
`;

const getFilename = (path: string) => path.split("/").pop() || path;

const getFileExtension = (path: string): string | undefined => {
  const filename = getFilename(path);
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return undefined;
  return filename.slice(dotIndex + 1).toLowerCase();
};

function getViewSandboxType(sandbox: any): "centrifugo" | "e2b" {
  return isCentrifugoSandbox(sandbox) ? "centrifugo" : "e2b";
}

function getActiveModelName(context: ToolContext): string | undefined {
  return context.getCurrentModelName?.() ?? context.modelName;
}

function classifyFileViewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("Unsupported media type")) {
    return "unsupported_media_type";
  }
  if (message.includes("too large")) {
    return "file_too_large";
  }
  if (message.includes("File not found")) {
    return "file_not_found";
  }
  if (message.includes("Windows local sandboxes")) {
    return "unsupported_sandbox";
  }
  if (message.includes("SVG files")) {
    return "unsupported_svg";
  }

  return "inspection_error";
}

function captureFileViewImageUsage(args: {
  context: ToolContext;
  sandbox: any;
  path: string;
  outcome: FileViewImageUsageOutcome;
  durationMs: number;
  mediaType?: string;
  sizeBytes?: number;
  previewUploadSucceeded?: boolean;
  failureReason?: string;
}) {
  const {
    context,
    sandbox,
    path,
    outcome,
    durationMs,
    mediaType,
    sizeBytes,
    previewUploadSucceeded,
    failureReason,
  } = args;

  phLogger.event("file_view_image_used", {
    userId: context.userID,
    user_id: context.userID,
    chat_id: context.chatId,
    mode: context.mode,
    subscription: context.subscription,
    subscription_tier: context.subscription,
    model: getActiveModelName(context),
    configured_model: context.modelName,
    sandbox_type: getViewSandboxType(sandbox),
    file_extension: getFileExtension(path),
    outcome,
    success: outcome === "success",
    duration_ms: durationMs,
    ...(mediaType && { media_type: mediaType }),
    ...(typeof sizeBytes === "number" && { size_bytes: sizeBytes }),
    ...(typeof previewUploadSucceeded === "boolean" && {
      preview_upload_succeeded: previewUploadSucceeded,
    }),
    ...(failureReason && { failure_reason: failureReason }),
  });
}

function errorToLog(error: unknown) {
  if (error instanceof Error) {
    const commandError = error as Error & {
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      name: error.name,
      message: error.message,
      ...(typeof commandError.exitCode === "number"
        ? { exit_code: commandError.exitCode }
        : {}),
      ...(typeof commandError.stderr === "string" && commandError.stderr
        ? { stderr: commandError.stderr.slice(0, 500) }
        : {}),
      ...(typeof commandError.stdout === "string" && commandError.stdout
        ? { stdout: commandError.stdout.slice(0, 500) }
        : {}),
    };
  }

  return { message: String(error) };
}

const getSandboxViewPath = (sandbox: unknown, path: string): string => {
  const maybeSandbox = sandbox as any;
  if (
    isCentrifugoSandbox(maybeSandbox) &&
    maybeSandbox.isWindows() &&
    path.startsWith("/tmp/")
  ) {
    return `C:\\temp${path.slice(4).replace(/\//g, "\\")}`;
  }

  return path;
};

async function readSandboxFileForView(
  sandbox: any,
  path: string,
  includeData: boolean,
): Promise<SandboxViewPayload> {
  if (isCentrifugoSandbox(sandbox) && sandbox.isWindows()) {
    throw new Error(
      "The view action is not available for Windows local sandboxes yet. Use a Linux/E2B sandbox or inspect the image manually.",
    );
  }

  const sandboxPath = getSandboxViewPath(sandbox, path);
  const viewEnvVars = {
    HACKERAI_FILE_VIEW_PATH: sandboxPath,
    HACKERAI_FILE_VIEW_INCLUDE_DATA: includeData ? "1" : "0",
    HACKERAI_FILE_VIEW_MAX_BYTES: String(MAX_VIEW_FILE_BYTES),
  };
  const command = `PYTHON_BIN="$(command -v python3 || command -v python)" && "$PYTHON_BIN" - <<'PY'\n${VIEW_FILE_SCRIPT}\nPY`;
  let result: {
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
  };

  try {
    result = await sandbox.commands.run(command, {
      ...buildSandboxCommandOptions(sandbox, undefined, viewEnvVars),
      // E2B's command API calls this option `envs`; local sandboxes use
      // `envVars`. Provide both so the same binary-safe helper works in both.
      envs: viewEnvVars,
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      "stderr" in error
    ) {
      const commandError = error as Record<string, unknown>;
      result = {
        stdout: String(commandError.stdout ?? ""),
        stderr: String(commandError.stderr ?? ""),
        exitCode:
          typeof commandError.exitCode === "number" ? commandError.exitCode : 1,
        error:
          typeof commandError.error === "string"
            ? commandError.error
            : error instanceof Error
              ? error.message
              : String(error),
      };
    } else {
      throw error;
    }
  }

  const stdout = result.stdout.trim();
  let payload: { error?: string } & Partial<SandboxViewPayload>;

  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Failed to inspect file for view: ${
        result.stderr || stdout || "No output returned"
      }`,
    );
  }

  if (result.exitCode !== 0 || payload.error) {
    throw new Error(payload.error || result.stderr || "Failed to view file");
  }

  if (
    !payload.path ||
    !payload.mediaType ||
    typeof payload.sizeBytes !== "number" ||
    payload.kind !== "image"
  ) {
    throw new Error("View inspection returned an invalid payload.");
  }

  if (includeData && !payload.data) {
    throw new Error("View inspection did not return image data.");
  }

  return payload as SandboxViewPayload;
}

async function uploadViewPreviewFiles(args: {
  context: ToolContext;
  sandbox: any;
  sourcePath: string;
  payload: SandboxViewPayload;
}): Promise<ViewPreviewFile[]> {
  const { context, sandbox, sourcePath, payload } = args;

  const uploaded = await uploadSandboxFileToConvex({
    sandbox,
    userId: context.userID,
    fullPath: sourcePath,
    mediaType: payload.mediaType,
    name: getFilename(sourcePath),
  });

  return [
    {
      fileId: uploaded.fileId,
      name: uploaded.name,
      mediaType: uploaded.mediaType,
      s3Key: uploaded.s3Key,
      storageId: uploaded.storageId,
    },
  ];
}

const editSchema = z.object({
  find: z.string().describe("The exact text string to find in the file"),
  replace: z
    .string()
    .describe("The replacement text that will substitute the found text"),
  all: z
    .boolean()
    .optional()
    .describe(
      "Whether to replace all occurrences instead of just the first one. Defaults to false.",
    ),
});

export const createFile = (context: ToolContext) => {
  const { sandboxManager, modelName, getCurrentModelName } = context;
  const canViewMultimodalFiles = () =>
    supportsMultimodalToolResults(getCurrentModelName?.() ?? modelName);
  const supportsViewInSchema = canViewMultimodalFiles();
  const actionSchema = (
    supportsViewInSchema
      ? z.enum(FILE_ACTIONS_WITH_VIEW)
      : z.enum(FILE_ACTIONS_TEXT_ONLY)
  ) as z.ZodType<FileAction>;
  const supportedActionsDescription = [
    supportsViewInSchema
      ? "- view: View raster image files through multimodal understanding."
      : null,
    "- read: Read file content as text (Markdown, code, logs).",
    "- write: Overwrite the full content of a text file.",
    "- append: Append content to a text file.",
    "- edit: Make targeted edits to a text file.",
  ]
    .filter(Boolean)
    .join("\n");
  const instructions = [
    "Prioritize using this tool instead of the shell tool for file content operations to avoid escaping errors.",
    "For file copying, moving, and deletion, use the shell tool.",
    ...(supportsViewInSchema
      ? [
          "Use 'view' only for raster image files such as PNG, JPEG, GIF, and WebP.",
          "Do not use 'view' for PDFs. Use 'read' for extractable text, or use the shell tool to convert PDF pages to images first if visual inspection is required.",
          "Use 'read' for text-based or line-oriented formats.",
        ]
      : [
          "Use 'read' for text-based or line-oriented formats.",
          "This model cannot view sandbox images directly; ask the user to select HackerAI Pro or HackerAI Max for multimodal image viewing.",
        ]),
    "Code MUST be saved to a file using this tool before execution via the shell tool.",
    "DO NOT write partial or truncated content; always output the full content.",
    "'edit' can make multiple targeted replacements at once; all must succeed or none are applied.",
    "For extensive modifications to shorter files, use 'write' to rewrite the entire file instead of 'edit'.",
    "Under read action, the range parameter represents line number ranges (1-indexed, -1 for end of file).",
    "If the range parameter is not specified, the entire file will be read by default.",
    "DO NOT use the range parameter when reading a file for the first time; if the content is too long and gets truncated, the result will include range hints.",
    "write and append actions will automatically create files if they do not exist.",
    "When writing and appending text, ensure necessary trailing newlines are used to comply with POSIX standards.",
    "DO NOT read files that were just written, as their content remains in context.",
    "Choose appropriate file extensions based on file content and syntax, e.g. Markdown syntax MUST use .md extension.",
  ];
  const instructionsDescription = instructions
    .map((instruction, index) => `${index + 1}. ${instruction}`)
    .join("\n");

  return tool({
    description: `Perform operations on files in the sandbox file system.
This tool is the primary way to manage file content, allowing for reading, writing, appending, editing text-based files, and viewing raster image files.

### Supported Actions

${supportedActionsDescription}

### Instructions

${instructionsDescription}`,
    inputSchema: z.object({
      action: actionSchema.describe("The action to perform"),
      path: z.string().describe("The absolute path to the target file"),
      brief: z
        .string()
        .describe(
          "A one-sentence preamble describing the purpose of this operation",
        ),
      text: z
        .string()
        .optional()
        .describe(
          "The content to be written or appended. Required for `write` and `append` actions.",
        ),
      range: z
        .array(z.number().int())
        .length(2)
        .optional()
        .describe(
          "An array of two integers specifying the start and end of the range. For `read`, numbers are 1-indexed line numbers and -1 means read to the end of the file. Do not use range with `view`.",
        ),
      edits: z
        .array(editSchema)
        .optional()
        .describe(
          "A list of edits to be sequentially applied to the file. Required for `edit` action.",
        ),
    }),
    execute: async ({ action, path, text, range, edits }) => {
      try {
        const { sandbox } = await sandboxManager.getSandbox();

        switch (action) {
          case "view": {
            const viewStartedAt = Date.now();

            if (!canViewMultimodalFiles()) {
              captureFileViewImageUsage({
                context,
                sandbox,
                path,
                outcome: "unsupported_model",
                durationMs: Date.now() - viewStartedAt,
                failureReason: "unsupported_model",
              });
              return { error: MULTIMODAL_UPGRADE_MESSAGE };
            }

            let viewPayload: SandboxViewPayload;
            try {
              viewPayload = await readSandboxFileForView(sandbox, path, false);
            } catch (error) {
              captureFileViewImageUsage({
                context,
                sandbox,
                path,
                outcome: "inspection_failed",
                durationMs: Date.now() - viewStartedAt,
                failureReason: classifyFileViewError(error),
              });
              throw error;
            }

            const filename = getFilename(path);
            let previewFiles: ViewPreviewFile[] = [];
            let previewUploadError: string | undefined;
            try {
              previewFiles = await uploadViewPreviewFiles({
                context,
                sandbox,
                sourcePath: path,
                payload: viewPayload,
              });
            } catch (error) {
              previewUploadError =
                error instanceof Error ? error.message : String(error);
              logger.error(
                "file_view_preview_upload_failed",
                error instanceof Error ? error : undefined,
                {
                  event: "file_view_preview_upload_failed",
                  service: "chat-handler",
                  user_id: context.userID,
                  sandbox_type: getViewSandboxType(sandbox),
                  file_name: filename,
                  source_path: path,
                  kind: viewPayload.kind,
                  media_type: viewPayload.mediaType,
                  size_bytes: viewPayload.sizeBytes,
                  error: errorToLog(error),
                },
              );
            }

            captureFileViewImageUsage({
              context,
              sandbox,
              path,
              outcome: "success",
              durationMs: Date.now() - viewStartedAt,
              mediaType: viewPayload.mediaType,
              sizeBytes: viewPayload.sizeBytes,
              previewUploadSucceeded: !previewUploadError,
            });

            return {
              action: "view",
              content: `Viewing image file: ${filename} (${viewPayload.mediaType}, ${viewPayload.sizeBytes} bytes).`,
              path,
              filename,
              mediaType: viewPayload.mediaType,
              sizeBytes: viewPayload.sizeBytes,
              kind: viewPayload.kind,
              previewFiles,
              ...(previewUploadError
                ? { previewError: previewUploadError }
                : {}),
            } satisfies ViewMetadata;
          }

          case "read": {
            const fileContent = await sandbox.files.read(path, {
              user: "user" as const,
            });

            if (!fileContent || fileContent.trim() === "") {
              return { error: "File is empty." };
            }

            const lines = fileContent.split("\n");
            const filename = path.split("/").pop() || path;
            const totalLines = lines.length;

            // Validate range if provided
            if (range) {
              const [start, end] = range;

              if (start < 1) {
                return {
                  error: `Invalid start_line: ${start}. Line numbers are 1-indexed, must be >= 1.`,
                };
              }

              if (end !== -1 && end < start) {
                return {
                  error: `Invalid range: start_line (${start}) cannot be greater than end_line (${end}).`,
                };
              }

              if (start > totalLines) {
                return {
                  error: `Invalid start_line: ${start}. File ${filename} has ${totalLines} lines (1-indexed).`,
                };
              }

              if (end !== -1 && end > totalLines) {
                return {
                  error: `Invalid end_line: ${end}. File ${filename} has ${totalLines} lines (1-indexed).`,
                };
              }
            }

            // Apply range if provided
            let processedLines = lines;
            let startLineNumber = 1;

            if (range) {
              const [start, end] = range;
              startLineNumber = start;
              const startIndex = start - 1; // Convert to 0-based index
              const endIndex = end === -1 ? lines.length : end;
              processedLines = lines.slice(startIndex, endIndex);
            }

            // Add line numbers (padded format with pipe separator)
            const numberedLines = processedLines.map((line, index) => {
              const lineNumber = startLineNumber + index;
              return `${lineNumber.toString().padStart(6)}|${line}`;
            });

            const numberedContent = numberedLines.join("\n");
            const result = `Text file: ${filename}\nLatest content with line numbers:\n${numberedContent}`;
            const truncatedResult = truncateOutput({
              content: result,
              mode: "read-file",
            }) as string;

            // Return object with raw content for UI and formatted content for model
            return {
              content: truncatedResult,
              originalContent: truncateOutput({
                content: processedLines.join("\n"),
                mode: "read-file",
              }),
            };
          }

          case "write": {
            if (text === undefined) {
              return { error: "text is required for write action" };
            }

            await sandbox.files.write(path, text, {
              user: "user" as const,
            });

            return `File written: ${path}`;
          }

          case "append": {
            if (text === undefined) {
              return { error: "text is required for append action" };
            }

            // Read existing content first
            let existingContent = "";
            try {
              existingContent = await sandbox.files.read(path, {
                user: "user" as const,
              });
            } catch {
              // File doesn't exist, start with empty content
            }

            // Append directly without adding extra newline - agent controls exact content
            const newContent = existingContent + text;

            await sandbox.files.write(path, newContent, {
              user: "user" as const,
            });

            // Return both original and modified content for UI diff view in computer sidebar
            // toModelOutput controls what the model sees (summary only)
            return {
              content: `File appended: ${path}`,
              originalContent: truncateOutput({
                content: existingContent,
                mode: "read-file",
              }),
              modifiedContent: truncateOutput({
                content: newContent,
                mode: "read-file",
              }),
            };
          }

          case "edit": {
            if (!edits || edits.length === 0) {
              return { error: "edits array is required for edit action" };
            }

            // Read existing content
            const originalContent = await sandbox.files.read(path, {
              user: "user" as const,
            });

            if (!originalContent) {
              return {
                error: `Cannot edit file ${path} - file is empty or does not exist`,
              };
            }

            // Validate all find strings exist before applying any edits (atomic behavior)
            const missingFinds: { index: number; find: string }[] = [];
            for (let i = 0; i < edits.length; i++) {
              if (!originalContent.includes(edits[i].find)) {
                missingFinds.push({ index: i + 1, find: edits[i].find });
              }
            }

            if (missingFinds.length > 0) {
              const details = missingFinds
                .map(
                  (m) =>
                    `Edit #${m.index}: "${m.find.length > 50 ? m.find.slice(0, 50) + "..." : m.find}"`,
                )
                .join("\n");
              return {
                error: `Atomic edit failed - the following find string(s) were not found in the file:\n${details}\nNo edits were applied.`,
              };
            }

            // Apply edits sequentially (all find strings validated above)
            let content = originalContent;
            let totalReplacements = 0;

            for (const edit of edits) {
              const { find, replace, all = false } = edit;

              if (all) {
                const count = content.split(find).length - 1;
                content = content.split(find).join(replace);
                totalReplacements += count;
              } else {
                content = content.replace(find, replace);
                totalReplacements += 1;
              }
            }

            // Write the modified content back
            await sandbox.files.write(path, content, {
              user: "user" as const,
            });

            // Format content with line numbers for model output (padded format with pipe separator)
            const lines = content.split("\n");
            const numberedLines = lines
              .map(
                (line, index) =>
                  `${(index + 1).toString().padStart(6)}|${line}`,
              )
              .join("\n");

            // Return full diff data (persisted for UI)
            // toModelOutput will control what the model sees
            return {
              content: truncateOutput({
                content: `Multi-edit completed: ${edits.length} edits applied, ${totalReplacements} total replacements made\nLatest content with line numbers:\n${numberedLines}`,
                mode: "read-file",
              }),
              originalContent: truncateOutput({
                content: originalContent,
                mode: "read-file",
              }),
              modifiedContent: truncateOutput({
                content,
                mode: "read-file",
              }),
            };
          }

          default:
            return { error: `Unknown action ${action}` };
        }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    // Control what the model sees (exclude large diff content)
    async toModelOutput({ output }) {
      // If output is a string (write action), pass through
      if (typeof output === "string") {
        return { type: "text" as const, value: output };
      }

      if (typeof output === "object" && output !== null) {
        // Handle error responses
        if ("error" in output) {
          return {
            type: "text" as const,
            value: `Error: ${(output as { error: string }).error}`,
          };
        }

        if (
          "action" in output &&
          (output as { action?: string }).action === "view"
        ) {
          const viewOutput = output as ViewMetadata;

          if (!canViewMultimodalFiles()) {
            return {
              type: "text" as const,
              value: `Error: ${MULTIMODAL_UPGRADE_MESSAGE}`,
            };
          }

          try {
            const { sandbox } = await sandboxManager.getSandbox();
            const viewPayload = await readSandboxFileForView(
              sandbox,
              viewOutput.path,
              true,
            );

            return {
              type: "content" as const,
              value: [
                { type: "text" as const, text: viewOutput.content },
                {
                  type: "image-data" as const,
                  data: viewPayload.data!,
                  mediaType: viewPayload.mediaType,
                },
              ],
            };
          } catch (error) {
            return {
              type: "text" as const,
              value: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
        }

        // For read, edit, and append actions, return the content message
        if ("content" in output) {
          return {
            type: "text" as const,
            value: (output as { content: string }).content,
          };
        }
      }

      // Fallback: stringify the output
      return { type: "text" as const, value: JSON.stringify(output) };
    },
  });
};
