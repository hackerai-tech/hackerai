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
  } catch (error: unknown) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    } else if (fileError.code === "EACCES") {
      throw new Error(`Permission denied: ${filePath}`);
    } else {
      throw new Error(
        `Error reading file: ${fileError.message || "Unknown error"}`,
      );
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
  } catch (error: unknown) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      throw new Error(`Directory not found for file: ${filePath}`);
    } else if (fileError.code === "EACCES") {
      throw new Error(`Permission denied: ${filePath}`);
    } else {
      throw new Error(
        `Error writing file: ${fileError.message || "Unknown error"}`,
      );
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
      throw new Error(`File not found: ${filePath}`);
    }

    // Delete the file
    await unlink(resolvedPath);

    return `Successfully deleted file: ${filePath}`;
  } catch (error: unknown) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    } else if (fileError.code === "EACCES") {
      throw new Error(`Permission denied: ${filePath}`);
    } else if (fileError.code === "EISDIR") {
      throw new Error(`Cannot delete directory with delete_file: ${filePath}`);
    } else {
      throw new Error(
        `Error deleting file: ${fileError.message || "Unknown error"}`,
      );
    }
  }
};

// Helper function to validate file access
const validateFileAccess = async (filePath: string): Promise<string> => {
  const resolvedPath = resolve(filePath);
  const fileExists = await checkLocalFileExists(filePath);
  if (!fileExists) {
    throw new Error(`File not found: ${filePath}`);
  }
  return resolvedPath;
};

// Helper function to validate edit parameters
const validateEdit = (
  oldString: string,
  newString: string,
  editIndex?: number,
): void => {
  if (oldString === newString) {
    const prefix = editIndex !== undefined ? `Edit ${editIndex + 1}: ` : "";
    throw new Error(`${prefix}old_string and new_string must be different`);
  }
};

// Helper function to perform a single string replacement
const performStringReplacement = (
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
  editIndex?: number,
): { updatedContent: string; replacementCount: number } => {
  // Check if old_string exists in the content
  if (!content.includes(oldString)) {
    const prefix = editIndex !== undefined ? `Edit ${editIndex + 1}: ` : "";
    throw new Error(`${prefix}String not found in file: "${oldString}"`);
  }

  let updatedContent: string;
  let replacementCount: number;

  if (replaceAll) {
    // Replace all occurrences
    const regex = new RegExp(
      oldString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "g",
    );
    updatedContent = content.replace(regex, newString);
    replacementCount = (content.match(regex) || []).length;
  } else {
    // Replace only the first occurrence
    const occurrences = content.split(oldString).length - 1;
    if (occurrences > 1) {
      const prefix = editIndex !== undefined ? `Edit ${editIndex + 1}: ` : "";
      throw new Error(
        `${prefix}String "${oldString}" appears ${occurrences} times in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance.`,
      );
    }
    updatedContent = content.replace(oldString, newString);
    replacementCount = 1;
  }

  return { updatedContent, replacementCount };
};

// Helper function to handle file operation errors
const handleFileError = (error: unknown, filePath: string): never => {
  const fileError = error as NodeJS.ErrnoException;
  if (fileError.code === "ENOENT") {
    throw new Error(`File not found: ${filePath}`);
  } else if (fileError.code === "EACCES") {
    throw new Error(`Permission denied: ${filePath}`);
  } else {
    throw error;
  }
};

export const searchReplaceLocalFile = async (
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): Promise<string> => {
  try {
    // Validate file access and get resolved path
    const resolvedPath = await validateFileAccess(filePath);

    // Validate edit parameters
    validateEdit(oldString, newString);

    // Read the file content
    const fileContent = await readFile(resolvedPath, "utf-8");

    // Perform the string replacement
    const { updatedContent, replacementCount } = performStringReplacement(
      fileContent,
      oldString,
      newString,
      replaceAll,
    );

    // Write the updated content back to the file
    await writeFile(resolvedPath, updatedContent, "utf-8");

    const action = replaceAll ? "replacements" : "replacement";
    return `Successfully made ${replacementCount} ${action} in ${filePath}`;
  } catch (error: unknown) {
    return handleFileError(error, filePath);
  }
};

export interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const multiEditLocalFile = async (
  filePath: string,
  edits: EditOperation[],
): Promise<string> => {
  try {
    // Validate file access and get resolved path
    const resolvedPath = await validateFileAccess(filePath);

    // Validate edits array
    if (!edits || edits.length === 0) {
      throw new Error("No edits provided");
    }

    // Read the file content
    let currentContent = await readFile(resolvedPath, "utf-8");
    let totalReplacements = 0;
    const editResults: string[] = [];

    // Apply each edit sequentially
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const { old_string, new_string, replace_all = false } = edit;

      // Validate edit parameters
      validateEdit(old_string, new_string, i);

      // Perform the string replacement
      const { updatedContent, replacementCount } = performStringReplacement(
        currentContent,
        old_string,
        new_string,
        replace_all,
        i,
      );

      currentContent = updatedContent;
      totalReplacements += replacementCount;
      const action = replace_all ? "replacements" : "replacement";
      editResults.push(`Edit ${i + 1}: ${replacementCount} ${action}`);
    }

    // Write the updated content back to the file
    await writeFile(resolvedPath, currentContent, "utf-8");

    return `Successfully applied ${edits.length} edits with ${totalReplacements} total replacements in ${filePath}:\n${editResults.join("\n")}`;
  } catch (error: unknown) {
    return handleFileError(error, filePath);
  }
};
