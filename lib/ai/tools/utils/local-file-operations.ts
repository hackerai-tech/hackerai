import { readFile, writeFile, access, unlink } from "fs/promises";
import { constants } from "fs";
import { resolve } from "path";

export interface LocalFileReadOptions {
  offset?: number;
  limit?: number;
}

export const readLocalFile = async (
  filePath: string,
  options: LocalFileReadOptions = {},
): Promise<string> => {
  try {
    // Resolve the file path to handle both relative and absolute paths
    const resolvedPath = resolve(filePath);

    // Check if file exists and is readable
    await access(resolvedPath, constants.R_OK);

    // Read the file content
    const fileContent = await readFile(resolvedPath, "utf-8");

    if (!fileContent || fileContent.trim() === "") {
      return "File is empty.";
    }

    const lines = fileContent.split("\n");
    const { offset, limit } = options;

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

    return numberedLines.join("\n");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    } else if (error.code === "EACCES") {
      throw new Error(`Permission denied: ${filePath}`);
    } else {
      throw new Error(`Error reading file: ${error.message}`);
    }
  }
};

export const writeLocalFile = async (
  filePath: string,
  contents: string,
): Promise<string> => {
  try {
    // Resolve the file path to handle both relative and absolute paths
    const resolvedPath = resolve(filePath);

    // Write the file content
    await writeFile(resolvedPath, contents, "utf-8");

    const lineCount = contents.split("\n").length;
    return `Successfully wrote ${lineCount} lines to ${filePath}`;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      throw new Error(`Directory not found for file: ${filePath}`);
    } else if (error.code === "EACCES") {
      throw new Error(`Permission denied: ${filePath}`);
    } else {
      throw new Error(`Error writing file: ${error.message}`);
    }
  }
};

export const checkLocalFileExists = async (
  filePath: string,
): Promise<boolean> => {
  try {
    const resolvedPath = resolve(filePath);
    await access(resolvedPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const deleteLocalFile = async (filePath: string): Promise<string> => {
  try {
    // Resolve the file path to handle both relative and absolute paths
    const resolvedPath = resolve(filePath);

    // Check if file exists first
    const fileExists = await checkLocalFileExists(filePath);
    if (!fileExists) {
      return `File not found: ${filePath}`;
    }

    // Delete the file
    await unlink(resolvedPath);

    return `Successfully deleted file: ${filePath}`;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return `File not found: ${filePath}`;
    } else if (error.code === "EACCES") {
      throw new Error(`Permission denied: ${filePath}`);
    } else if (error.code === "EISDIR") {
      throw new Error(`Cannot delete directory with delete_file: ${filePath}`);
    } else {
      throw new Error(`Error deleting file: ${error.message}`);
    }
  }
};
