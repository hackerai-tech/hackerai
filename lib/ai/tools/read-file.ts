import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "@/types";
import { readLocalFile } from "./utils/local-file-operations";
import { truncateOutput } from "@/lib/token-utils";

export const createReadFile = (context: ToolContext) => {
  const { sandboxManager, executionMode } = context;

  return tool({
    description: `Reads a file from the filesystem. You can access any file directly by using this tool.
If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.
- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT.
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- If you read a file that exists but has empty contents you will receive 'File is empty.'.`,
    inputSchema: z.object({
      target_file: z
        .string()
        .describe(
          "The path of the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.",
        ),
      offset: z
        .number()
        .optional()
        .describe(
          "The line number to start reading from. Only provide if the file is too large to read at once.",
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "The number of lines to read. Only provide if the file is too large to read at once.",
        ),
    }),
    execute: async ({
      target_file,
      offset,
      limit,
    }: {
      target_file: string;
      offset?: number;
      limit?: number;
    }) => {
      try {
        if (executionMode === "local") {
          // Read file locally using Node.js fs
          const result = await readLocalFile(target_file, { offset, limit });
          const truncatedResult = truncateOutput({
            content: result,
            mode: "read-file",
          }) as string;
          return { result: truncatedResult };
        } else {
          // Read file from sandbox (existing behavior)
          const { sandbox } = await sandboxManager.getSandbox();

          const fileContent = await sandbox.files.read(target_file);

          if (!fileContent || fileContent.trim() === "") {
            return { result: "File is empty." };
          }

          const lines = fileContent.split("\n");

          // Apply offset and limit if provided
          let processedLines = lines;
          if (offset !== undefined) {
            processedLines = lines.slice(offset - 1); // Convert to 0-based index
          }
          if (limit !== undefined) {
            processedLines = processedLines.slice(0, limit);
          }

          // Add line numbers (starting from the offset if provided, otherwise from 1)
          const startLineNumber = offset || 1;
          const numberedLines = processedLines.map((line, index) => {
            const lineNumber = startLineNumber + index;
            return `${lineNumber.toString().padStart(6)}|${line}`;
          });

          const result = numberedLines.join("\n");
          const truncatedResult = truncateOutput({
            content: result,
            mode: "read-file",
          }) as string;
          return { result: truncatedResult };
        }
      } catch (error) {
        return {
          result: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
};
