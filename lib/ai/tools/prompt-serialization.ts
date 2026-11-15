import type { ToolSet } from "ai";

type ToolModelOutputArgs = {
  toolCallId?: string;
  input?: unknown;
  output: unknown;
};

type ToolWithModelOutput = {
  toModelOutput?: (args: ToolModelOutputArgs) => unknown | Promise<unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const createTextOutput = (value: string) => ({
  type: "text" as const,
  value,
});

const createPureFileModelOutput = ({ output }: ToolModelOutputArgs) => {
  if (typeof output === "string") {
    return createTextOutput(output);
  }

  if (isRecord(output)) {
    if ("error" in output) {
      return createTextOutput(`Error: ${String(output.error)}`);
    }

    if (output.action === "view") {
      return createTextOutput(
        typeof output.content === "string"
          ? output.content
          : JSON.stringify(output),
      );
    }

    if (typeof output.content === "string") {
      return createTextOutput(output.content);
    }
  }

  return createTextOutput(JSON.stringify(output));
};

const OBSERVED_TOOLS = new Set([
  "get_note",
  "list_notes",
  "create_note",
  "update_note",
  "delete_note",
  "file",
]);

type ValueKind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "other"
  | "unreadable";

type PropertyKind = ValueKind | "missing" | "accessor";

/**
 * Closed-vocabulary shape of a historical tool output whose formatter
 * rejected. It never contains output values, tool-call IDs or error text.
 */
export type PromptFormatterFailure = {
  tool:
    | "get_note"
    | "list_notes"
    | "create_note"
    | "update_note"
    | "delete_note"
    | "file"
    | "other";
  rejection: "sync" | "async";
  output_kind: ValueKind;
  note_kind: PropertyKind;
  notes_kind: PropertyKind;
  success: "true" | "false" | "missing" | "other";
  storage_compacted: boolean;
};

export type PromptSerializationOptions = {
  /** Called on formatter rejection; its own failures are ignored. */
  onFormatterFailure?: (failure: PromptFormatterFailure) => void;
};

const valueKind = (value: unknown): ValueKind => {
  if (value === null) return "null";
  const type = typeof value;
  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "undefined"
  ) {
    return type;
  }
  if (type !== "object") return "other";
  try {
    // Array.isArray throws for revoked proxies.
    return Array.isArray(value) ? "array" : "object";
  } catch {
    return "unreadable";
  }
};

/** Own data-property lookup that never runs getters. */
const ownProperty = (
  value: unknown,
  key: string,
):
  | { kind: "missing" | "accessor" | "unreadable" }
  | { kind: "data"; value: unknown } => {
  if (typeof value !== "object" || value === null) return { kind: "missing" };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return { kind: "missing" };
    return "value" in descriptor
      ? { kind: "data", value: descriptor.value }
      : { kind: "accessor" };
  } catch {
    return { kind: "unreadable" };
  }
};

const propertyKind = (value: unknown, key: string): PropertyKind => {
  const property = ownProperty(value, key);
  return property.kind === "data" ? valueKind(property.value) : property.kind;
};

const describeFailure = (
  toolName: string,
  rejection: PromptFormatterFailure["rejection"],
  args: unknown,
): PromptFormatterFailure => {
  const output = ownProperty(args, "output");
  const outputValue = output.kind === "data" ? output.value : undefined;
  const success = ownProperty(outputValue, "success");
  const marker = ownProperty(outputValue, "__hackeraiStorageCompacted");
  return {
    tool: OBSERVED_TOOLS.has(toolName)
      ? (toolName as PromptFormatterFailure["tool"])
      : "other",
    rejection,
    output_kind: output.kind === "data" ? valueKind(outputValue) : "unreadable",
    note_kind: propertyKind(outputValue, "note"),
    notes_kind: propertyKind(outputValue, "notes"),
    success:
      success.kind === "missing"
        ? "missing"
        : success.kind === "data" && typeof success.value === "boolean"
          ? success.value
            ? "true"
            : "false"
          : "other",
    storage_compacted: marker.kind === "data" && marker.value === true,
  };
};

/**
 * Report a formatter rejection without changing its result: the exact error
 * object is rethrown, and synchronous formatters stay synchronous.
 */
const observeFormatter = (
  toolName: string,
  format: (...args: unknown[]) => unknown,
  onFailure: NonNullable<PromptSerializationOptions["onFormatterFailure"]>,
) => {
  const report = (
    rejection: PromptFormatterFailure["rejection"],
    args: unknown[],
  ) => {
    try {
      onFailure(describeFailure(toolName, rejection, args[0]));
    } catch {
      // Diagnostics must never replace the formatter's own error.
    }
  };
  return function observedToModelOutput(this: unknown, ...args: unknown[]) {
    let result: unknown;
    try {
      result = format.apply(this, args);
    } catch (error) {
      report("sync", args);
      throw error;
    }
    // Even a prototype check can throw for a returned revoked proxy. Keep
    // successful synchronous results untouched by optional observation.
    try {
      if (!(result instanceof Promise)) return result;
    } catch {
      return result;
    }
    return result.catch((error: unknown) => {
      report("async", args);
      throw error;
    });
  };
};

/**
 * Tool results in persisted UI messages are untrusted historical data.
 * Keep conversion formatting, but make file-view serialization text-only so
 * prompt rebuilding cannot re-open attacker-controlled paths.
 */
export const createPromptSerializationTools = (
  tools: ToolSet,
  { onFormatterFailure }: PromptSerializationOptions = {},
): ToolSet => {
  const fileTool = tools.file as (ToolWithModelOutput & object) | undefined;
  const hasFileTool = !!fileTool && typeof fileTool === "object";

  if (!onFormatterFailure) {
    if (!hasFileTool) return tools;
    return {
      ...tools,
      file: { ...fileTool, toModelOutput: createPureFileModelOutput },
    } as unknown as ToolSet;
  }

  const serializationTools: Record<string, unknown> = { ...tools };
  for (const [name, tool] of Object.entries(tools)) {
    const format =
      name === "file" && hasFileTool
        ? createPureFileModelOutput
        : (tool as ToolWithModelOutput | undefined)?.toModelOutput;
    if (typeof format !== "function") continue;
    serializationTools[name] = {
      ...tool,
      toModelOutput: observeFormatter(
        name,
        format as (...args: unknown[]) => unknown,
        onFormatterFailure,
      ),
    };
  }
  return serializationTools as ToolSet;
};
