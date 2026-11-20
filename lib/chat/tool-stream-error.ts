import { InvalidToolInputError, NoSuchToolError } from "ai";
import { serializeChatSDKErrorForStream } from "@/lib/errors";
import { isQaSpendPoolError } from "@/lib/rate-limit/qa-spending-policy";

/** Explain model tool-call mistakes without exposing inputs or provider errors. */
export function formatToolStreamError(error: unknown): string {
  if (isQaSpendPoolError(error)) return serializeChatSDKErrorForStream(error);
  if (NoSuchToolError.isInstance(error)) {
    return "The model requested an unavailable tool. Retry using a tool offered for this step and provide its required arguments. The tool was not executed.";
  }
  if (InvalidToolInputError.isInstance(error)) {
    return "The model provided invalid tool arguments. Correct the arguments to match the tool schema and retry. The tool was not executed.";
  }
  return "An error occurred.";
}
