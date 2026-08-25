import type {
  AnySandbox,
  SandboxBootInfo,
  SandboxInfo,
  SandboxManager,
  SandboxType,
} from "@/types";
import { refreshE2BSandboxLeaseBestEffort } from "./sandbox";
import { SANDBOX_ENVIRONMENT_TOOLS } from "./sandbox-tools";
import {
  ensureCloudSandboxConnection,
  type CloudSandboxAcquisitionContext,
} from "./cloud-sandbox";
import { getCloudSandboxProvider } from "./cloud-sandbox-provider";
import { isE2BSandbox } from "./sandbox-types";
import { isExpectedAlreadyGoneCleanupError } from "@/lib/utils/cleanup-errors";

// One failed initial readiness check plus one failed reconnect is enough to
// stop terminal retries in this Agent run. The manager only forgets its local
// SDK client; it never kills the shared per-user sandbox or another run's work.
const MAX_SANDBOX_HEALTH_FAILURES = 2;

export class DefaultSandboxManager implements SandboxManager {
  private sandbox: AnySandbox | null = null;
  private healthFailureCount = 0;
  private sandboxUnavailable = false;

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: AnySandbox) => void,
    initialSandbox?: AnySandbox | null,
    private onBoot?: (info: SandboxBootInfo) => void,
    private cloudSandboxContext?: CloudSandboxAcquisitionContext,
  ) {
    this.sandbox = initialSandbox || null;
  }

  recordHealthFailure(): boolean {
    this.healthFailureCount++;
    if (this.healthFailureCount >= MAX_SANDBOX_HEALTH_FAILURES) {
      this.sandboxUnavailable = true;
    }
    return this.sandboxUnavailable;
  }

  resetHealthFailures(): void {
    this.healthFailureCount = 0;
    this.sandboxUnavailable = false;
  }

  isSandboxUnavailable(): boolean {
    return this.sandboxUnavailable;
  }

  getSandboxInfo(): SandboxInfo | null {
    return {
      type: "e2b",
      provider: this.cloudSandboxContext?.provider ?? getCloudSandboxProvider(),
    };
  }

  getEffectivePreference(): string {
    return "e2b";
  }

  getSandboxType(toolName: string): SandboxType | undefined {
    if (!SANDBOX_ENVIRONMENT_TOOLS.includes(toolName as any)) {
      return undefined;
    }
    return "e2b";
  }

  async getSandbox(): Promise<{
    sandbox: AnySandbox;
  }> {
    if (this.sandbox) {
      if (isE2BSandbox(this.sandbox)) {
        await refreshE2BSandboxLeaseBestEffort(this.sandbox, {
          source: "default_manager_cache",
        });
      }
      return { sandbox: this.sandbox };
    }

    const result = await ensureCloudSandboxConnection({
      userId: this.userID,
      setSandbox: this.setSandboxCallback,
      onBoot: this.onBoot,
      initialSandbox: this.sandbox,
      context: this.cloudSandboxContext,
    });
    this.sandbox = result.sandbox;

    if (!this.sandbox) {
      throw new Error("Failed to initialize sandbox");
    }

    return { sandbox: this.sandbox };
  }

  setSandbox(sandbox: AnySandbox): void {
    this.sandbox = sandbox;
    this.setSandboxCallback(sandbox);
  }

  async resetSandbox(_reason?: string): Promise<void> {
    // E2B is shared per user, so recovery only forgets its SDK connection.
    // Relay sandboxes own a websocket client, which is safe to close while the
    // underlying sandbox continues running.
    const sandbox = this.sandbox;
    this.sandbox = null;
    if (sandbox && !isE2BSandbox(sandbox)) {
      await sandbox.close().catch((error) => {
        if (isExpectedAlreadyGoneCleanupError(error)) {
          console.debug(`[${this.userID}] Sandbox relay was already closed`);
        } else {
          console.warn(
            `[${this.userID}] Failed to close sandbox relay during recovery:`,
            error,
          );
        }
      });
    }
  }
}
