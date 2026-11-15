const TERMINAL_TOOLS = new Set([
  "shell",
  "run_terminal_cmd",
  "interact_terminal_session",
  "interact_with_terminal",
]);

const PRIVATE_TERMINAL_PATH_FIELDS = [
  "workingDirectory",
  "recordPath",
  "outputPath",
  "artifactPaths",
  "sandboxInstance",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The app adds this line when it stores a truncated command result. Preserve
// ordinary command output, including paths the user explicitly printed.
const stripSavedOutputPath = (text: string): string =>
  text.replace(
    /^\[(Full output \(\d+ chars\)|Output too large - first \d+ chars) saved to: [^\r\n]*\]$/gm,
    "[$1 saved privately]",
  );

// Compaction references are unescaped. Only the no-reference form is safe to
// retain verbatim; any ambiguous placeholder may contain generated host paths.
const SAFE_TERMINAL_PLACEHOLDER =
  /^\[Terminal: ran '[^';\r\n]{1,80}', exit code (?:\d+|\?)\]$/;

const sanitizeTerminalText = (text: string): string =>
  SAFE_TERMINAL_PLACEHOLDER.test(text)
    ? text
    : text.startsWith("[Terminal: ran '") &&
        text.endsWith("]") &&
        text.includes("', exit code ")
      ? "[Terminal: prior output compacted for storage]"
      : stripSavedOutputPath(text);

const sanitizeTerminalResult = (value: unknown): unknown => {
  if (typeof value === "string") return sanitizeSerializedTerminalText(value);
  if (!isRecord(value)) return value;
  const sanitized = { ...value };
  let changed = false;
  for (const key of PRIVATE_TERMINAL_PATH_FIELDS) {
    if (Object.hasOwn(sanitized, key)) {
      delete sanitized[key];
      changed = true;
    }
  }
  for (const key of ["output", "stdout"] as const) {
    if (typeof sanitized[key] === "string") {
      const output = sanitizeTerminalText(sanitized[key]);
      if (output !== sanitized[key]) {
        sanitized[key] = output;
        changed = true;
      }
    }
  }
  return changed ? sanitized : value;
};

function sanitizeSerializedTerminalText(text: string): string {
  const sanitized = sanitizeTerminalText(text);
  const newline = sanitized.startsWith("Process ")
    ? sanitized.indexOf("\n")
    : -1;
  const prefix = newline < 0 ? "" : sanitized.slice(0, newline + 1);
  const serialized = sanitized.slice(prefix.length);
  if (!serialized.startsWith('{"result":')) return sanitized;

  try {
    const envelope: unknown = JSON.parse(serialized);
    if (
      !isRecord(envelope) ||
      Object.keys(envelope).length !== 1 ||
      !isRecord(envelope.result)
    )
      return sanitized;
    const result = sanitizeTerminalResult(envelope.result);
    return result === envelope.result
      ? sanitized
      : `${prefix}${JSON.stringify({ result })}`;
  } catch {
    return sanitized;
  }
}

/** Remove unshown local path metadata from public shares and chat forks. */
export const sanitizeTerminalPartForShare = (part: any): any => {
  if (!isRecord(part)) return part;
  if (part.type === "data-terminal" && isRecord(part.data)) {
    if (typeof part.data.terminal !== "string") return part;
    const terminal = stripSavedOutputPath(part.data.terminal);
    return terminal === part.data.terminal
      ? part
      : { ...part, data: { ...part.data, terminal } };
  }

  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : typeof part.type === "string" && part.type.startsWith("tool-")
        ? part.type.slice(5)
        : undefined;
  if (typeof toolName !== "string" || !TERMINAL_TOOLS.has(toolName))
    return part;

  const output = sanitizeTerminalResult(part.output);
  if (!isRecord(output))
    return output === part.output ? part : { ...part, output };
  const result = sanitizeTerminalResult(output.result);
  if (output === part.output && result === output.result) return part;
  return {
    ...part,
    output: { ...output, ...(result !== output.result && { result }) },
  };
};
