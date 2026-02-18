import type { AnySandbox } from "@/types";
import type { createTerminalHandler } from "@/lib/utils/terminal-executor";
import { FULL_OUTPUT_SAVED_MESSAGE } from "@/lib/token-utils";
import { isE2BSandbox } from "./sandbox-types";

/**
 * Save full terminal output to a file in the sandbox when it exceeds token limits.
 * E2B (cloud) saves to ~/terminal_full_output/, local Docker saves to /tmp/terminal_full_output/.
 * Returns the file path if saved, or null if saving failed.
 */
export async function saveFullOutputToFile(
  sandbox: AnySandbox,
  fullOutput: string,
): Promise<string | null> {
  try {
    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/[T]/g, "_")
      .replace(/[:]/g, "-")
      .replace(/\./, "_");
    // e.g. 2026-02-17_16-54-34_442Z

    const dir = isE2BSandbox(sandbox)
      ? "/home/user/terminal_full_output"
      : "/tmp/terminal_full_output";
    const filePath = `${dir}/${timestamp}.txt`;

    await sandbox.commands.run(`mkdir -p ${dir}`, {
      timeoutMs: 5000,
    });
    await sandbox.files.write(filePath, fullOutput);

    return filePath;
  } catch (err) {
    console.warn("[Terminal Command] Failed to save full output to file:", err);
    return null;
  }
}

/**
 * If the terminal handler's output was truncated, saves the full output to a file
 * in the sandbox and returns the notification message. Also streams the message
 * to the terminal writer for real-time UI feedback.
 *
 * Returns the save message string to append to the tool result, or empty string if
 * no save was needed/possible.
 */
export async function saveTruncatedOutput(opts: {
  handler: ReturnType<typeof createTerminalHandler>;
  sandbox: AnySandbox;
  terminalWriter: (output: string) => Promise<void>;
}): Promise<string> {
  const { handler, sandbox, terminalWriter } = opts;

  if (!handler.wasTruncated()) {
    return "";
  }

  const fullOutput = handler.getFullOutput();
  const savedPath = await saveFullOutputToFile(sandbox, fullOutput);

  if (!savedPath) {
    return "";
  }

  const saveMsg = FULL_OUTPUT_SAVED_MESSAGE(
    savedPath,
    fullOutput.length,
    handler.wasFullOutputCapped(),
  );
  await terminalWriter(saveMsg);
  return saveMsg;
}
