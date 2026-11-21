import { beginAgentPartialSaveDiagnostic } from "@/lib/analytics/agent-start-diagnostics";

/**
 * `fetch(input, init)` for the Agent partial-save writer, observing one
 * attempt. The same arguments reach fetch and the same response or rejection
 * reaches the caller; the response body is never read, cloned or consumed.
 * Reports at most one HTTP 413 per call.
 */
export async function fetchAgentPartialSaveWithDiagnostic(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const diagnostic = beginAgentPartialSaveDiagnostic(init.body);
  try {
    const response = await fetch(input, init);
    diagnostic.onHttpErrorResponse?.(response);
    return response;
  } finally {
    diagnostic.dispose();
  }
}
