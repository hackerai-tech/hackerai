import { tool } from "ai";
import type { ToolContext } from "@/types";
import { FILE_DESCRIPTION, FILE_INPUT_SCHEMA } from "./schemas";
import {
  readFileImpl,
  writeFileImpl,
  appendFileImpl,
  editFileImpl,
  fileToModelOutput,
} from "./utils/file-impl";

export const createFile = (context: ToolContext) => {
  const { sandboxManager } = context;

  return tool({
    description: FILE_DESCRIPTION,
    inputSchema: FILE_INPUT_SCHEMA,
    execute: async ({ action, path, text, range, edits }) => {
      try {
        const { sandbox } = await sandboxManager.getSandbox();
        switch (action) {
          case "read":
            return readFileImpl(sandbox, {
              path,
              range: range as [number, number] | undefined,
            });
          case "write":
            if (text === undefined) {
              return { error: "text is required for write action" };
            }
            return writeFileImpl(sandbox, { path, text });
          case "append":
            if (text === undefined) {
              return { error: "text is required for append action" };
            }
            return appendFileImpl(sandbox, { path, text });
          case "edit":
            return editFileImpl(sandbox, { path, edits: edits ?? [] });
          default:
            return { error: `Unknown action ${action as string}` };
        }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    toModelOutput: fileToModelOutput,
  });
};
