import { miosaErrorDiagnostics } from "./miosa-acquisition-diagnostics";

type FileStage =
  | "upload_stage"
  | "write_destination"
  | "read_source"
  | "download_stage"
  | "list"
  | "stat"
  | "exists"
  | "remove";
// Preserve the SDK error identity (including frozen errors) without adding paths,
// content, or provider response bodies to logs or serialized exceptions.
const stages = new WeakMap<object, FileStage>();

export async function trackMiosaFileOperation<T>(
  stage: FileStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === "object" && !stages.has(error))
      stages.set(error, stage);
    throw error;
  }
}

export function miosaFileErrorDiagnostics(error: unknown) {
  let exitCode: unknown;
  try {
    exitCode =
      error && typeof error === "object" && "exitCode" in error
        ? error.exitCode
        : undefined;
  } catch {
    /* Diagnostics must not replace the original failure. */
  }
  return {
    ...miosaErrorDiagnostics(error),
    file_operation_stage:
      error && typeof error === "object" ? stages.get(error) : undefined,
    file_operation_exit_code:
      typeof exitCode === "number" &&
      Number.isInteger(exitCode) &&
      exitCode >= 0 &&
      exitCode <= 255
        ? exitCode
        : undefined,
  };
}
