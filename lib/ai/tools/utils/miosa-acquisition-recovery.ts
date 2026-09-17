import type { Sandbox } from "@miosa/sdk";
import { miosaErrorDiagnostics } from "./miosa-acquisition-diagnostics";

const RECOVERY_BUDGET_MS = 10_000;
const RECOVERY_POLL_MS = 500;

class MiosaRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MiosaRecoveryError";
  }
}

/** Read-only reconciliation: never replay create/resume, pause, or destroy a
 * shared persistent workspace. A different chat may already be using it. */
export async function recoverMiosaAcquisition(options: {
  lookup: () => Promise<Sandbox>;
  expectedId?: string;
  workspaceName: string;
  externalUserId: string;
  onObserved: (sandbox: Sandbox) => void;
}): Promise<Sandbox> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new MiosaRecoveryError("ACQUISITION_RECONCILIATION_TIMEOUT"));
    }, RECOVERY_BUDGET_MS);
  });
  const poll = async () => {
    while (!expired) {
      let sandbox: Sandbox;
      try {
        sandbox = await options.lookup();
      } catch (error) {
        if (expired) throw error;
        // A timed-out fresh create may not be visible yet. This does not grant
        // permission to create a replacement or resume another instance.
        const diagnostic = miosaErrorDiagnostics(error);
        const transient =
          diagnostic.error_retryable === true &&
          (diagnostic.error_code === "TIMEOUT" ||
            diagnostic.error_code === "NETWORK_ERROR" ||
            (diagnostic.error_http_status !== undefined &&
              diagnostic.error_http_status >= 500));
        const missing =
          error instanceof Error && error.name === "NotFoundError";
        if ((missing && !options.expectedId) || (!missing && transient)) {
          await new Promise((resolve) => setTimeout(resolve, RECOVERY_POLL_MS));
          continue;
        }
        throw error;
      }
      if (expired)
        throw new MiosaRecoveryError("ACQUISITION_RECONCILIATION_TIMEOUT");
      options.onObserved(sandbox);
      if (
        (options.expectedId && sandbox.id !== options.expectedId) ||
        (sandbox.data.external_user_id != null &&
          sandbox.data.external_user_id !== options.externalUserId) ||
        (!options.expectedId &&
          (sandbox.data.name !== options.workspaceName ||
            sandbox.data.external_user_id !== options.externalUserId))
      )
        throw new MiosaRecoveryError("ACQUISITION_IDENTITY_MISMATCH");
      if (
        sandbox.state === "running" ||
        sandbox.state === "resuming" ||
        sandbox.state === "provisioning"
      )
        return sandbox; // Caller still requires readiness and initialization.
      throw new MiosaRecoveryError("ACQUISITION_NOT_EXECUTABLE");
    }
    throw new MiosaRecoveryError("ACQUISITION_RECONCILIATION_TIMEOUT");
  };
  try {
    return await Promise.race([poll(), deadline]);
  } finally {
    expired = true;
    if (timer) clearTimeout(timer);
  }
}
