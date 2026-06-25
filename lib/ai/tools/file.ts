import { tool } from "ai";
import { z } from "zod";
import { createHash } from "crypto";
import type { AnySandbox, ToolContext } from "@/types";
import { truncateOutput } from "@/lib/token-utils";
import { supportsMultimodalToolResults } from "@/lib/ai/providers";
import { buildSandboxCommandOptions } from "./utils/sandbox-command-options";
import { isCentrifugoSandbox } from "./utils/sandbox-types";
import { uploadSandboxFileToConvex } from "./utils/sandbox-file-uploader";
import type { Id } from "@/convex/_generated/dataModel";
import { logger } from "@/lib/logger";
import { phLogger } from "@/lib/posthog/server";
import { validateImageBytes } from "@/lib/utils/image-validation";

const MAX_VIEW_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_FILE_READ_BYTES = 1024 * 1024;
const MAX_TEXT_READ_RESULT_BYTES = 1024 * 1024;
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
  "The current model does not support multimodal tool results for sandbox images. Please select a model with image viewing support and retry the view action.";

type ViewKind = "image";

type ViewPreviewFile = {
  fileId: Id<"files">;
  name: string;
  mediaType: string;
  s3Key?: string;
};

type ViewMetadata = {
  action: "view";
  content: string;
  path: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  kind: ViewKind;
  previewUploadSucceeded?: boolean;
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

type FileViewStage = "initial_inspection" | "model_output";

type FileViewErrorClassification = {
  failureReason: string;
  failureDetail: string;
  errorName?: string;
  errorMessageHash: string;
};

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

const READ_TEXT_FILE_SCRIPT = String.raw`
import json
import os
import sys

path = os.environ["HACKERAI_FILE_READ_PATH"]
range_start = int(os.environ.get("HACKERAI_FILE_READ_RANGE_START", "0"))
range_end = int(os.environ.get("HACKERAI_FILE_READ_RANGE_END", "-1"))
max_full_bytes = int(os.environ.get("HACKERAI_FILE_READ_MAX_FULL_BYTES", "1048576"))
max_result_bytes = int(os.environ.get("HACKERAI_FILE_READ_MAX_RESULT_BYTES", "1048576"))

def emit(payload, code=0):
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(code)

if range_start < 0:
    emit({"error": f"Invalid start_line: {range_start}. Line numbers are 1-indexed, must be >= 1."}, 2)
if range_start > 0 and range_end != -1 and range_end < range_start:
    emit({"error": f"Invalid range: start_line ({range_start}) cannot be greater than end_line ({range_end})."}, 2)

if not os.path.isfile(path):
    emit({"error": f"File not found or is not a regular file: {path}"}, 3)

size = os.path.getsize(path)

def count_lines(file_path, file_size):
    if file_size == 0:
        return 0
    lines = 0
    last_byte = b""
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            lines += chunk.count(b"\n")
            last_byte = chunk[-1:]
    if last_byte != b"\n":
        lines += 1
    return lines

total_lines = count_lines(path, size)
if range_start == 0 and size > max_full_bytes:
    emit({
        "path": path,
        "sizeBytes": size,
        "totalLines": total_lines,
        "tooLarge": True,
    })

if range_start > 0:
    if range_start > total_lines:
        emit({"error": f"Invalid start_line: {range_start}. File has {total_lines} lines (1-indexed)."}, 2)
    if range_end != -1 and range_end > total_lines:
        emit({"error": f"Invalid end_line: {range_end}. File has {total_lines} lines (1-indexed)."}, 2)

selected = []
selected_bytes = 0
truncated = False
start_line = range_start if range_start > 0 else 1

def add_text(text):
    global selected_bytes, truncated
    encoded = text.encode("utf-8", errors="replace")
    remaining = max_result_bytes - selected_bytes
    if remaining <= 0:
        truncated = True
        return False
    if len(encoded) > remaining:
        selected.append(encoded[:remaining].decode("utf-8", errors="replace"))
        selected_bytes = max_result_bytes
        truncated = True
        return False
    selected.append(text)
    selected_bytes += len(encoded)
    return True

with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
    for line_no, line in enumerate(f, 1):
        if range_start > 0 and line_no < range_start:
            continue
        if range_start > 0 and range_end != -1 and line_no > range_end:
            break
        if not add_text(line):
            break

emit({
    "path": path,
    "sizeBytes": size,
    "totalLines": total_lines,
    "content": "".join(selected),
    "startLine": start_line,
    "truncated": truncated,
})
`;

const FILE_STATE_SCRIPT = String.raw`
import json
import os
import sys

path = os.environ["HACKERAI_FILE_STATE_PATH"]

def emit(payload, code=0):
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(code)

if not os.path.exists(path):
    emit({"kind": "missing", "path": path})

if not os.path.isfile(path):
    emit({"kind": "not_file", "path": path})

emit({
    "kind": "file",
    "path": path,
    "sizeBytes": os.path.getsize(path),
})
`;

const APPEND_TEXT_FILE_SCRIPT = String.raw`
import os

target_path = os.environ["HACKERAI_FILE_APPEND_TARGET_PATH"]
source_path = os.environ["HACKERAI_FILE_APPEND_SOURCE_PATH"]

with open(source_path, "rb") as source, open(target_path, "ab") as target:
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        target.write(chunk)

try:
    os.remove(source_path)
except OSError:
    pass
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

function hashTelemetryValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function getPathPrefixClass(path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const lowerPath = normalizedPath.toLowerCase();

  if (path.trim() === "") return "empty";
  if (lowerPath.startsWith("/tmp/") || lowerPath.startsWith("c:/temp/")) {
    return "tmp";
  }
  if (lowerPath.startsWith("/home/") || lowerPath.startsWith("c:/users/")) {
    return "home";
  }
  if (lowerPath.startsWith("/workspace/") || lowerPath.includes("/workdir/")) {
    return "workspace";
  }
  if (normalizedPath.startsWith("/") || /^[a-z]:\//i.test(normalizedPath)) {
    return "absolute_other";
  }
  return "relative";
}

function getPathDepth(path: string): number {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0).length;
}

function getPathTelemetry(path: string, userId: string) {
  return {
    path_fingerprint: hashTelemetryValue(`${userId}:${path}`),
    path_prefix_class: getPathPrefixClass(path),
    path_is_absolute: path.startsWith("/") || /^[a-z]:[\\/]/i.test(path),
    path_has_extension: Boolean(getFileExtension(path)),
    path_depth: getPathDepth(path),
    path_length: path.length,
  };
}

function classifyFileViewError(error: unknown): FileViewErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const base = {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessageHash: hashTelemetryValue(message),
  };

  if (message.includes("Unsupported media type")) {
    return {
      ...base,
      failureReason: "unsupported_media_type",
      failureDetail: "unsupported_media_type",
    };
  }
  if (message.includes("too large")) {
    return {
      ...base,
      failureReason: "file_too_large",
      failureDetail: "file_too_large",
    };
  }
  if (message.includes("File not found")) {
    return {
      ...base,
      failureReason: "file_not_found",
      failureDetail: "file_not_found",
    };
  }
  if (message.includes("Windows local sandboxes")) {
    return {
      ...base,
      failureReason: "unsupported_sandbox",
      failureDetail: "windows_local_sandbox",
    };
  }
  if (message.includes("SVG files")) {
    return {
      ...base,
      failureReason: "unsupported_svg",
      failureDetail: "unsupported_svg",
    };
  }
  if (message.includes("Failed to inspect file for view")) {
    return {
      ...base,
      failureReason: "inspection_error",
      failureDetail: "invalid_inspection_output",
    };
  }
  if (message.includes("View inspection returned an invalid payload")) {
    return {
      ...base,
      failureReason: "inspection_error",
      failureDetail: "invalid_payload",
    };
  }
  if (message.includes("View inspection did not return image data")) {
    return {
      ...base,
      failureReason: "inspection_error",
      failureDetail: "missing_image_data",
    };
  }
  if (message.includes("View inspection found invalid image data")) {
    return {
      ...base,
      failureReason: "inspection_error",
      failureDetail: "invalid_image_data",
    };
  }

  return {
    ...base,
    failureReason: "inspection_error",
    failureDetail: "inspection_error",
  };
}

function captureFileViewImageUsage(args: {
  context: ToolContext;
  sandbox: any;
  path: string;
  stage: FileViewStage;
  outcome: FileViewImageUsageOutcome;
  durationMs: number;
  mediaType?: string;
  sizeBytes?: number;
  previewUploadSucceeded?: boolean;
  failureReason?: string;
  failureDetail?: string;
  errorName?: string;
  errorMessageHash?: string;
}) {
  const {
    context,
    sandbox,
    path,
    stage,
    outcome,
    durationMs,
    mediaType,
    sizeBytes,
    previewUploadSucceeded,
    failureReason,
    failureDetail,
    errorName,
    errorMessageHash,
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
    stage,
    outcome,
    success: outcome === "success",
    duration_ms: durationMs,
    ...getPathTelemetry(path, context.userID),
    ...(mediaType && { media_type: mediaType }),
    ...(typeof sizeBytes === "number" && { size_bytes: sizeBytes }),
    ...(typeof previewUploadSucceeded === "boolean" && {
      preview_upload_succeeded: previewUploadSucceeded,
    }),
    ...(failureReason && { failure_reason: failureReason }),
    ...(failureDetail && { failure_detail: failureDetail }),
    ...(errorName && { error_name: errorName }),
    ...(errorMessageHash && { error_message_hash: errorMessageHash }),
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

type SandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
};

type SandboxTextReadPayload = {
  path: string;
  sizeBytes: number;
  totalLines: number;
  content?: string;
  startLine?: number;
  tooLarge?: boolean;
  truncated?: boolean;
  error?: string;
};

type SandboxFileState =
  | { kind: "file"; path: string; sizeBytes: number }
  | { kind: "missing"; path: string }
  | { kind: "not_file"; path: string }
  | { kind: "unknown"; path: string; error: string };

function commandErrorToResult(error: unknown): SandboxCommandResult | null {
  if (!(error instanceof Error)) return null;

  const commandError = error as Error & {
    exitCode?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };

  if (typeof commandError.exitCode !== "number") return null;

  return {
    stdout:
      typeof commandError.stdout === "string"
        ? commandError.stdout
        : error.message,
    stderr: typeof commandError.stderr === "string" ? commandError.stderr : "",
    exitCode: commandError.exitCode,
    error: error.message,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

async function runSandboxCommand(
  sandbox: AnySandbox,
  command: string,
  envVars?: Record<string, string>,
  timeoutMs = 60_000,
): Promise<SandboxCommandResult> {
  try {
    const result = await sandbox.commands.run(command, {
      ...buildSandboxCommandOptions(sandbox, undefined, envVars),
      envs: envVars,
      timeoutMs,
    } as ReturnType<typeof buildSandboxCommandOptions> & {
      envs?: Record<string, string>;
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
    };
  } catch (error) {
    const commandResult = commandErrorToResult(error);
    if (commandResult) return commandResult;
    throw error;
  }
}

function isWindowsSandbox(sandbox: AnySandbox): boolean {
  return isCentrifugoSandbox(sandbox) && sandbox.isWindows();
}

function getWindowsNativePath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) return path;
  if (path.startsWith("/tmp/")) {
    return `C:\\temp${path.slice(4).replace(/\//g, "\\")}`;
  }
  return path.replace(/\//g, "\\");
}

function getPythonPathForSandbox(sandbox: AnySandbox, path: string): string {
  return isWindowsSandbox(sandbox) ? getWindowsNativePath(path) : path;
}

function toWindowsBashPath(path: string): string {
  const drive = path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) {
    return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  }
  return path.replace(/\\/g, "/");
}

async function detectSandboxShell(
  sandbox: AnySandbox,
): Promise<"bash" | "cmd"> {
  if (!isWindowsSandbox(sandbox)) return "bash";

  const probe = await runSandboxCommand(
    sandbox,
    "echo $BASH_VERSION",
    undefined,
    10_000,
  ).catch(() => null);
  if (probe?.exitCode === 0 && /^\d/.test(probe.stdout.trim())) {
    return "bash";
  }

  return "cmd";
}

async function runPythonScript(
  sandbox: AnySandbox,
  script: string,
  envVars: Record<string, string>,
  timeoutMs: number,
): Promise<SandboxCommandResult> {
  if (!isWindowsSandbox(sandbox)) {
    const command = `PYTHON_BIN="$(command -v python3 || command -v python)" && "$PYTHON_BIN" - <<'PY'\n${script}\nPY`;
    return runSandboxCommand(sandbox, command, envVars, timeoutMs);
  }

  const shell = await detectSandboxShell(sandbox);
  const tempScriptPath = `/tmp/hackerai_script_${Date.now()}_${Math.random().toString(36).slice(2)}.py`;
  await sandbox.files.write(tempScriptPath, script, {
    user: "user" as const,
  });

  const nativePath = getWindowsNativePath(tempScriptPath);
  const commandPath =
    shell === "bash" ? toWindowsBashPath(nativePath) : nativePath;
  const quotedPath =
    shell === "bash" ? shellQuote(commandPath) : cmdQuote(commandPath);
  const command =
    shell === "bash"
      ? `PYTHON_BIN="$(command -v python3 || command -v python)" && "$PYTHON_BIN" ${quotedPath}; status=$?; rm -f ${quotedPath}; exit $status`
      : `python ${quotedPath}`;

  try {
    return await runSandboxCommand(sandbox, command, envVars, timeoutMs);
  } finally {
    if (shell === "cmd") {
      await sandbox.files.remove(tempScriptPath).catch(() => undefined);
    }
  }
}

async function getSandboxFileState(
  sandbox: AnySandbox,
  path: string,
): Promise<SandboxFileState> {
  const pythonPath = getPythonPathForSandbox(sandbox, path);
  const result = await runPythonScript(
    sandbox,
    FILE_STATE_SCRIPT,
    { HACKERAI_FILE_STATE_PATH: pythonPath },
    30_000,
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: message,
      exitCode: 1,
    } satisfies SandboxCommandResult;
  });

  if (result.exitCode !== 0) {
    return {
      kind: "unknown",
      path,
      error: result.stderr || result.stdout || "file state command failed",
    };
  }

  try {
    const payload = JSON.parse(result.stdout.trim()) as SandboxFileState;
    if (
      payload.kind === "file" &&
      typeof payload.sizeBytes === "number" &&
      Number.isFinite(payload.sizeBytes)
    ) {
      return { ...payload, path };
    }
    if (payload.kind === "missing" || payload.kind === "not_file") {
      return { ...payload, path };
    }
  } catch {
    // Fall through to unknown below.
  }

  return {
    kind: "unknown",
    path,
    error: result.stderr || result.stdout || "invalid file state response",
  };
}

function buildNumberedFileContent(args: {
  filename: string;
  content: string;
  startLineNumber?: number;
  truncated?: boolean;
}): {
  content: string;
  originalContent: string;
} {
  const { filename, content, startLineNumber = 1, truncated } = args;
  const lines = content.split("\n");
  const numberedLines = lines.map((line, index) => {
    const lineNumber = startLineNumber + index;
    return `${lineNumber.toString().padStart(6)}|${line}`;
  });

  const truncatedNotice = truncated
    ? `\n\n[Range output truncated at ${formatBytes(MAX_TEXT_READ_RESULT_BYTES)}. Request a narrower line range to continue.]`
    : "";
  const numberedContent = numberedLines.join("\n");
  const result = `Text file: ${filename}\nLatest content with line numbers:\n${numberedContent}${truncatedNotice}`;

  return {
    content: truncateOutput({
      content: result,
      mode: "read-file",
    }) as string,
    originalContent: truncateOutput({
      content,
      mode: "read-file",
    }),
  };
}

async function readSandboxTextFile(
  sandbox: AnySandbox,
  path: string,
  range?: number[],
): Promise<SandboxTextReadPayload> {
  const pythonPath = getPythonPathForSandbox(sandbox, path);
  const envVars = {
    HACKERAI_FILE_READ_PATH: pythonPath,
    HACKERAI_FILE_READ_RANGE_START: String(range?.[0] ?? 0),
    HACKERAI_FILE_READ_RANGE_END: String(range?.[1] ?? -1),
    HACKERAI_FILE_READ_MAX_FULL_BYTES: String(MAX_TEXT_FILE_READ_BYTES),
    HACKERAI_FILE_READ_MAX_RESULT_BYTES: String(MAX_TEXT_READ_RESULT_BYTES),
  };
  const result = await runPythonScript(
    sandbox,
    READ_TEXT_FILE_SCRIPT,
    envVars,
    120_000,
  );
  const stdout = result.stdout.trim();
  let payload: SandboxTextReadPayload;

  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Failed to inspect text file: ${
        result.stderr || stdout || "No output returned"
      }`,
    );
  }

  if (result.exitCode !== 0 || payload.error) {
    throw new Error(payload.error || result.stderr || "Failed to read file");
  }

  return payload;
}

async function readSandboxTextFileWithFallback(
  sandbox: AnySandbox,
  path: string,
  range?: number[],
): Promise<SandboxTextReadPayload> {
  try {
    return await readSandboxTextFile(sandbox, path, range);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.startsWith("Invalid ") ||
      errorMessage.includes("File not found")
    ) {
      throw error;
    }

    const state = await getSandboxFileState(sandbox, path);
    if (state.kind === "unknown") {
      throw new Error(
        `Unable to determine file size for ${path}; refusing to load the file into memory. ${state.error}`,
      );
    }
    if (state.kind === "missing") {
      throw new Error(`File not found or is not a regular file: ${path}`);
    }
    if (state.kind === "not_file") {
      throw new Error(`File is not a regular file: ${path}`);
    }
    if (state.sizeBytes > MAX_TEXT_FILE_READ_BYTES) {
      if (range) {
        throw new Error(
          `Unable to perform a bounded range read for ${path}, and the file is too large to load safely (${formatBytes(state.sizeBytes)}). Use a targeted terminal command that writes a small result to a separate file.`,
        );
      }

      return {
        path,
        sizeBytes: state.sizeBytes,
        totalLines: 0,
        tooLarge: true,
      };
    }

    const fileContent = await sandbox.files.read(path, {
      user: "user" as const,
    });
    const lines = fileContent.split("\n");

    if (range) {
      const [start, end] = range;
      if (start < 1) {
        throw new Error(
          `Invalid start_line: ${start}. Line numbers are 1-indexed, must be >= 1.`,
        );
      }
      if (end !== -1 && end < start) {
        throw new Error(
          `Invalid range: start_line (${start}) cannot be greater than end_line (${end}).`,
        );
      }
      if (start > lines.length) {
        throw new Error(
          `Invalid start_line: ${start}. File has ${lines.length} lines (1-indexed).`,
        );
      }
      if (end !== -1 && end > lines.length) {
        throw new Error(
          `Invalid end_line: ${end}. File has ${lines.length} lines (1-indexed).`,
        );
      }
      const startIndex = start - 1;
      const endIndex = end === -1 ? lines.length : end;
      return {
        path,
        sizeBytes: Buffer.byteLength(fileContent),
        totalLines: lines.length,
        content: lines.slice(startIndex, endIndex).join("\n"),
        startLine: start,
      };
    }

    return {
      path,
      sizeBytes: Buffer.byteLength(fileContent),
      totalLines: lines.length,
      content: fileContent,
      startLine: 1,
    };
  }
}

async function appendSandboxTextFile(
  sandbox: AnySandbox,
  path: string,
  text: string,
): Promise<void> {
  const tempPath = `/tmp/hackerai_append_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`;
  await sandbox.files.write(tempPath, text, {
    user: "user" as const,
  });

  const result = await runPythonScript(
    sandbox,
    APPEND_TEXT_FILE_SCRIPT,
    {
      HACKERAI_FILE_APPEND_TARGET_PATH: getPythonPathForSandbox(sandbox, path),
      HACKERAI_FILE_APPEND_SOURCE_PATH: getPythonPathForSandbox(
        sandbox,
        tempPath,
      ),
    },
    60_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to append file");
  }
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

  if (includeData && payload.data) {
    const validation = validateImageBytes(
      Buffer.from(payload.data, "base64"),
      payload.mediaType,
    );
    if (!validation.valid) {
      throw new Error(
        `View inspection found invalid image data (${validation.reason}).`,
      );
    }
    payload.mediaType = validation.mediaType;
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
          "This model cannot view sandbox images directly; ask the user to select a model with image viewing support.",
        ]),
    "Code MUST be saved to a file using this tool before execution via the shell tool.",
    "DO NOT write partial or truncated content; always output the full content.",
    "'edit' can make multiple targeted replacements at once; all must succeed or none are applied.",
    "For extensive modifications to shorter files, use 'write' to rewrite the entire file instead of 'edit'.",
    "Under read action, the range parameter represents line number ranges (1-indexed, -1 for end of file).",
    "If the range parameter is not specified, the entire file will be read by default.",
    "Oversized files are not loaded in full; read will return file metadata and range guidance instead.",
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
                stage: "initial_inspection",
                outcome: "unsupported_model",
                durationMs: Date.now() - viewStartedAt,
                failureReason: "unsupported_model",
                failureDetail: "unsupported_model",
              });
              return { error: MULTIMODAL_UPGRADE_MESSAGE };
            }

            let viewPayload: SandboxViewPayload;
            try {
              viewPayload = await readSandboxFileForView(sandbox, path, false);
            } catch (error) {
              const classification = classifyFileViewError(error);
              captureFileViewImageUsage({
                context,
                sandbox,
                path,
                stage: "initial_inspection",
                outcome: "inspection_failed",
                durationMs: Date.now() - viewStartedAt,
                failureReason: classification.failureReason,
                failureDetail: classification.failureDetail,
                errorName: classification.errorName,
                errorMessageHash: classification.errorMessageHash,
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

            return {
              action: "view",
              content: `Viewing image file: ${filename} (${viewPayload.mediaType}, ${viewPayload.sizeBytes} bytes).`,
              path,
              filename,
              mediaType: viewPayload.mediaType,
              sizeBytes: viewPayload.sizeBytes,
              kind: viewPayload.kind,
              previewUploadSucceeded: !previewUploadError,
              previewFiles,
              ...(previewUploadError
                ? { previewError: previewUploadError }
                : {}),
            } satisfies ViewMetadata;
          }

          case "read": {
            const filename = path.split("/").pop() || path;
            const readPayload = await readSandboxTextFileWithFallback(
              sandbox,
              path,
              range,
            );

            if (readPayload.tooLarge) {
              const totalLines =
                readPayload.totalLines > 0
                  ? `${readPayload.totalLines} lines`
                  : "line count unavailable";
              return {
                content: `Text file: ${filename}\nFile is too large to read in full (${formatBytes(readPayload.sizeBytes)}, ${totalLines}). Use the range parameter to read a smaller slice, e.g. range [1, 200].`,
                originalContent: "",
              };
            }

            if (!readPayload.content || readPayload.content.trim() === "") {
              return { error: "File is empty." };
            }

            // Return object with raw content for UI and formatted content for model
            return buildNumberedFileContent({
              filename,
              content: readPayload.content,
              startLineNumber: readPayload.startLine,
              truncated: readPayload.truncated,
            });
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

            const existingState = await getSandboxFileState(sandbox, path);
            if (existingState.kind === "unknown") {
              return {
                error: `Cannot append safely because the existing file size could not be determined for ${path}. ${existingState.error}`,
              };
            }
            if (existingState.kind === "not_file") {
              return {
                error: `Cannot append to ${path} because it is not a file.`,
              };
            }
            if (
              existingState.kind === "file" &&
              existingState.sizeBytes > MAX_TEXT_FILE_READ_BYTES
            ) {
              await appendSandboxTextFile(sandbox, path, text);
              return {
                content: `File appended: ${path}\nExisting file is ${formatBytes(existingState.sizeBytes)}, so the full diff preview was skipped to avoid loading the entire file into memory.`,
              };
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

            const existingState = await getSandboxFileState(sandbox, path);
            if (existingState.kind === "unknown") {
              return {
                error: `Cannot edit ${path} safely because the file size could not be determined. ${existingState.error}`,
              };
            }
            if (existingState.kind === "missing") {
              return {
                error: `Cannot edit file ${path} - file is empty or does not exist`,
              };
            }
            if (existingState.kind === "not_file") {
              return { error: `Cannot edit ${path} because it is not a file.` };
            }
            if (existingState.sizeBytes > MAX_TEXT_FILE_READ_BYTES) {
              return {
                error: `File ${path} is too large for the edit action (${formatBytes(existingState.sizeBytes)}). Use a targeted shell command, restore the file from a clean source, or replace it with the write action instead of loading the whole file into memory.`,
              };
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

          const viewStartedAt = Date.now();
          let outputSandbox: any | undefined;
          try {
            const { sandbox } = await sandboxManager.getSandbox();
            outputSandbox = sandbox;
            const viewPayload = await readSandboxFileForView(
              sandbox,
              viewOutput.path,
              true,
            );

            try {
              captureFileViewImageUsage({
                context,
                sandbox,
                path: viewOutput.path,
                stage: "model_output",
                outcome: "success",
                durationMs: Date.now() - viewStartedAt,
                mediaType: viewPayload.mediaType,
                sizeBytes: viewPayload.sizeBytes,
                previewUploadSucceeded: viewOutput.previewUploadSucceeded,
              });
            } catch {
              // Telemetry must never break a successful image handoff.
            }

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
            try {
              const sandbox =
                outputSandbox ?? (await sandboxManager.getSandbox()).sandbox;
              const classification = classifyFileViewError(error);
              captureFileViewImageUsage({
                context,
                sandbox,
                path: viewOutput.path,
                stage: "model_output",
                outcome: "inspection_failed",
                durationMs: Date.now() - viewStartedAt,
                mediaType: viewOutput.mediaType,
                sizeBytes: viewOutput.sizeBytes,
                previewUploadSucceeded: viewOutput.previewUploadSucceeded,
                failureReason: classification.failureReason,
                failureDetail: classification.failureDetail,
                errorName: classification.errorName,
                errorMessageHash: classification.errorMessageHash,
              });
            } catch {
              // Preserve the model-visible error if telemetry capture itself fails.
            }
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
