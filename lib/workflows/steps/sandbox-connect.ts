import { Sandbox } from "@e2b/code-interpreter";
import { RetryableError } from "workflow";

const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;

export async function connectToSandbox(sandboxId: string): Promise<Sandbox> {
  try {
    const sbx = await Sandbox.connect(sandboxId);
    await sbx.setTimeout(SANDBOX_TIMEOUT_MS);
    return sbx;
  } catch (error) {
    throw new RetryableError(
      `Failed to connect to sandbox ${sandboxId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { retryAfter: "10s" },
    );
  }
}
