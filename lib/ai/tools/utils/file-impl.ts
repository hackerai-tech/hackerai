/**
 * Pure file action helpers shared by the AI-SDK `file` factory and the
 * workflow `file*Step` step functions. The impl is duck-typed over
 * `FileSandbox` so callers can pass either an E2B `Sandbox` or a
 * `CentrifugoSandbox` (both expose `files.read/write` with this shape).
 */
import { truncateOutput } from "@/lib/token-utils";

export interface FileSandbox {
  files: {
    read(path: string, opts?: { user?: "user" }): Promise<string>;
    write(
      path: string,
      content: string,
      opts?: { user?: "user" },
    ): Promise<unknown>;
  };
}

export interface EditOp {
  find: string;
  replace: string;
  all?: boolean;
}

export type FileReadResult =
  | { content: string; originalContent: string }
  | { error: string };

export type FileEditResult =
  | { content: string; originalContent: string; modifiedContent: string }
  | { error: string };

export async function readFileImpl(
  sbx: FileSandbox,
  args: { path: string; range?: [number, number] },
): Promise<FileReadResult> {
  try {
    const fileContent = await sbx.files.read(args.path, { user: "user" });

    if (!fileContent || fileContent.trim() === "") {
      return { error: "File is empty." };
    }

    const lines = fileContent.split("\n");
    const filename = args.path.split("/").pop() || args.path;
    const totalLines = lines.length;

    if (args.range) {
      const [start, end] = args.range;
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

    let processedLines = lines;
    let startLineNumber = 1;
    if (args.range) {
      const [start, end] = args.range;
      startLineNumber = start;
      const startIndex = start - 1;
      const endIndex = end === -1 ? lines.length : end;
      processedLines = lines.slice(startIndex, endIndex);
    }

    const numberedLines = processedLines.map(
      (line, index) =>
        `${(startLineNumber + index).toString().padStart(6)}|${line}`,
    );

    const result = `Text file: ${filename}\nLatest content with line numbers:\n${numberedLines.join("\n")}`;

    return {
      content: truncateOutput({ content: result, mode: "read-file" }) as string,
      originalContent: truncateOutput({
        content: processedLines.join("\n"),
        mode: "read-file",
      }) as string,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeFileImpl(
  sbx: FileSandbox,
  args: { path: string; text: string },
): Promise<string | { error: string }> {
  try {
    await sbx.files.write(args.path, args.text, { user: "user" });
    return `File written: ${args.path}`;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function appendFileImpl(
  sbx: FileSandbox,
  args: { path: string; text: string },
): Promise<FileEditResult> {
  try {
    let existingContent = "";
    try {
      existingContent = await sbx.files.read(args.path, { user: "user" });
    } catch {
      // File doesn't exist; start empty.
    }

    const newContent = existingContent + args.text;
    await sbx.files.write(args.path, newContent, { user: "user" });

    return {
      content: `File appended: ${args.path}`,
      originalContent: truncateOutput({
        content: existingContent,
        mode: "read-file",
      }) as string,
      modifiedContent: truncateOutput({
        content: newContent,
        mode: "read-file",
      }) as string,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function editFileImpl(
  sbx: FileSandbox,
  args: { path: string; edits: EditOp[] },
): Promise<FileEditResult> {
  try {
    if (!args.edits || args.edits.length === 0) {
      return { error: "edits array is required for edit action" };
    }

    const originalContent = await sbx.files.read(args.path, { user: "user" });
    if (!originalContent) {
      return {
        error: `Cannot edit file ${args.path} - file is empty or does not exist`,
      };
    }

    // Atomic: validate every find string before applying any edits.
    const missingFinds: { index: number; find: string }[] = [];
    for (let i = 0; i < args.edits.length; i++) {
      if (!originalContent.includes(args.edits[i].find)) {
        missingFinds.push({ index: i + 1, find: args.edits[i].find });
      }
    }
    if (missingFinds.length > 0) {
      const details = missingFinds
        .map(
          (m) =>
            `Edit #${m.index}: "${
              m.find.length > 50 ? m.find.slice(0, 50) + "..." : m.find
            }"`,
        )
        .join("\n");
      return {
        error: `Atomic edit failed - the following find string(s) were not found in the file:\n${details}\nNo edits were applied.`,
      };
    }

    let content = originalContent;
    let totalReplacements = 0;
    for (const edit of args.edits) {
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

    await sbx.files.write(args.path, content, { user: "user" });

    const numberedLines = content
      .split("\n")
      .map((line, index) => `${(index + 1).toString().padStart(6)}|${line}`)
      .join("\n");

    return {
      content: truncateOutput({
        content: `Multi-edit completed: ${args.edits.length} edits applied, ${totalReplacements} total replacements made\nLatest content with line numbers:\n${numberedLines}`,
        mode: "read-file",
      }) as string,
      originalContent: truncateOutput({
        content: originalContent,
        mode: "read-file",
      }) as string,
      modifiedContent: truncateOutput({
        content,
        mode: "read-file",
      }) as string,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Shared `toModelOutput` for the `file` tool — strips the large
 * `originalContent`/`modifiedContent` diff payload from what the model sees,
 * keeping only the human-readable `content` message (or error).
 *
 * Used by both the AI-SDK factory and the durable workflow tool so the
 * model-facing surface stays identical between the two agent modes.
 */
export function fileToModelOutput({ output }: { output: unknown }): {
  type: "text";
  value: string;
} {
  if (typeof output === "string") {
    return { type: "text", value: output };
  }
  if (typeof output === "object" && output !== null) {
    if ("error" in output) {
      return {
        type: "text",
        value: `Error: ${(output as { error: string }).error}`,
      };
    }
    if ("content" in output) {
      return {
        type: "text",
        value: (output as { content: string }).content,
      };
    }
  }
  return { type: "text", value: JSON.stringify(output) };
}
