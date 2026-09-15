import type { SidebarToolError } from "@/types/chat";

export const SAFE_TOOL_INPUT_ERROR_TEXT =
  "Some tool parameters did not match the required format.";

const TOOL_INPUT_VALIDATION_PATTERNS = [
  /invalid input for tool/i,
  /type validation failed/i,
  /invalid tool arguments?/i,
  /tool (?:input|arguments?).*(?:invalid|validation)/i,
] as const;

export function isToolInputValidationError(errorText: unknown): boolean {
  return (
    typeof errorText === "string" &&
    TOOL_INPUT_VALIDATION_PATTERNS.some((pattern) => pattern.test(errorText))
  );
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  "tool-create_vulnerability_report": "Vulnerability report",
  "tool-shell": "Terminal",
  "tool-run_terminal_cmd": "Terminal",
  "tool-interact_terminal_session": "Terminal",
  "tool-file": "File",
  "tool-read_file": "File reader",
  "tool-write_file": "File writer",
  "tool-delete_file": "File deletion",
  "tool-search_replace": "File editor",
  "tool-multi_edit": "File editor",
  "tool-http_request": "HTTP request",
  "tool-web_search": "Web search",
  "tool-open_url": "URL opener",
  "tool-web": "Web",
  "tool-get_terminal_files": "File sharing",
  "tool-todo_write": "To-do list",
  "tool-create_note": "Notes",
  "tool-list_notes": "Notes",
  "tool-update_note": "Notes",
  "tool-delete_note": "Notes",
  "tool-list_requests": "Proxy",
  "tool-view_request": "Proxy",
  "tool-send_request": "Proxy",
  "tool-scope_rules": "Proxy",
  "tool-list_sitemap": "Proxy",
  "tool-view_sitemap_entry": "Proxy",
};

export function getToolDisplayName(toolType: string): string {
  const knownName = TOOL_DISPLAY_NAMES[toolType];
  if (knownName) return knownName;

  const normalized = toolType
    .replace(/^tool-/, "")
    .replace(/[_-]+/g, " ")
    .trim();

  if (!normalized) return "Tool";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

const VALIDATION_PROBLEMS: Record<string, string> = {
  invalid_type: "Unexpected value type",
  invalid_format: "Invalid format",
  invalid_value: "Unsupported value",
  too_small: "Missing or too short",
  too_big: "Exceeds the allowed size",
  custom: "Doesn’t meet the requirements",
};

const formatFieldSegment = (segment: string | number): string | null => {
  if (typeof segment === "number") return `#${segment + 1}`;
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(segment)) return null;

  const knownLabels: Record<string, string> = {
    cve: "CVE",
    cwe: "CWE",
    cvss: "CVSS",
    cvss_breakdown: "CVSS breakdown",
    poc_description: "PoC description",
    poc_script_code: "PoC script/code",
    code_locations: "Code locations",
  };
  return (
    knownLabels[segment] ||
    segment.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())
  );
};

const extractJsonArray = (value: string): string | null => {
  const start = value.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }

  return null;
};

export function extractSafeToolValidationIssues(
  errorText: unknown,
): SidebarToolError["issues"] {
  if (!isToolInputValidationError(errorText) || typeof errorText !== "string") {
    return undefined;
  }

  const marker = errorText.match(/error message\s*:/i);
  if (marker?.index === undefined) return undefined;

  const serializedIssues = extractJsonArray(
    errorText.slice(marker.index + marker[0].length),
  );
  if (!serializedIssues) return undefined;

  try {
    const parsed = JSON.parse(serializedIssues);
    if (!Array.isArray(parsed)) return undefined;

    const seen = new Set<string>();
    const issues: NonNullable<SidebarToolError["issues"]> = [];

    for (const issue of parsed) {
      if (!issue || typeof issue !== "object" || !Array.isArray(issue.path)) {
        continue;
      }

      const fieldSegments = issue.path
        .slice(0, 4)
        .map((segment: unknown) =>
          typeof segment === "string" || typeof segment === "number"
            ? formatFieldSegment(segment)
            : null,
        )
        .filter((segment: string | null): segment is string =>
          Boolean(segment),
        );
      const field = fieldSegments.join(" · ") || "Tool input";
      const problem =
        typeof issue.code === "string" && VALIDATION_PROBLEMS[issue.code]
          ? VALIDATION_PROBLEMS[issue.code]
          : "Invalid value";
      const key = `${field}:${problem}`;
      if (seen.has(key)) continue;

      seen.add(key);
      issues.push({ field, problem });
      if (issues.length === 5) break;
    }

    return issues.length > 0 ? issues : undefined;
  } catch {
    return undefined;
  }
}

export function createToolInputErrorContent({
  toolType,
  toolCallId,
  errorText,
}: {
  toolType: string;
  toolCallId: string;
  errorText?: unknown;
}): SidebarToolError {
  const toolName = getToolDisplayName(toolType);
  const isFinding = toolType === "tool-create_vulnerability_report";

  return {
    kind: "tool-error",
    errorKind: "validation",
    toolName,
    action: isFinding
      ? "Vulnerability report wasn’t saved"
      : "Tool input needs attention",
    title: isFinding
      ? "The vulnerability report wasn’t saved"
      : `${toolName} couldn’t start`,
    summary: isFinding
      ? "Some report fields didn’t match the required format. No finding was saved."
      : `${SAFE_TOOL_INPUT_ERROR_TEXT} The tool did not run.`,
    nextStep: isFinding
      ? "Ask HackerAI to correct the report fields and save the finding once more."
      : "Ask HackerAI to correct the tool parameters and try again.",
    issues: extractSafeToolValidationIssues(errorText),
    isExecuting: false,
    toolCallId,
  };
}

export function getSafeToolErrorText(
  errorText: unknown,
  fallback: string,
): string {
  if (isToolInputValidationError(errorText)) {
    return SAFE_TOOL_INPUT_ERROR_TEXT;
  }
  return typeof errorText === "string" && errorText.trim()
    ? errorText
    : fallback;
}

export function createFindingFailureContent({
  toolCallId,
  reason,
}: {
  toolCallId: string;
  reason: "validation" | "chat_not_found" | "general" | "invalid_result";
}): SidebarToolError {
  if (reason === "validation") {
    return createToolInputErrorContent({
      toolType: "tool-create_vulnerability_report",
      toolCallId,
    });
  }

  const details =
    reason === "chat_not_found"
      ? {
          title: "The vulnerability report wasn’t saved",
          summary:
            "The source chat is no longer available, so the finding couldn’t be linked and saved.",
          nextStep:
            "Continue in an active chat and ask HackerAI to validate the issue again before saving it.",
        }
      : reason === "invalid_result"
        ? {
            title: "The vulnerability report couldn’t be confirmed",
            summary:
              "The save response was incomplete, so HackerAI couldn’t verify that a finding was created.",
            nextStep:
              "Ask HackerAI to check the report and retry once. If it still fails, start a new Agent run.",
          }
        : {
            title: "The vulnerability report wasn’t saved",
            summary:
              "HackerAI couldn’t save the confirmed finding because of a temporary error.",
            nextStep:
              "Ask HackerAI to save the finding once more. If it still fails, continue in a new Agent run.",
          };

  return {
    kind: "tool-error",
    errorKind: reason === "chat_not_found" ? "not_found" : "execution",
    toolName: "Vulnerability report",
    action: "Vulnerability report wasn’t saved",
    ...details,
    isExecuting: false,
    toolCallId,
  };
}
