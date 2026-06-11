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

/**
 * Tool results in persisted UI messages are untrusted historical data.
 * Keep conversion formatting, but make file-view serialization text-only so
 * prompt rebuilding cannot re-open attacker-controlled paths.
 */
export const createPromptSerializationTools = (tools: ToolSet): ToolSet => {
  const fileTool = tools.file as (ToolWithModelOutput & object) | undefined;

  if (!fileTool || typeof fileTool !== "object") {
    return tools;
  }

  return {
    ...tools,
    file: {
      ...fileTool,
      toModelOutput: createPureFileModelOutput,
    },
  } as unknown as ToolSet;
};
