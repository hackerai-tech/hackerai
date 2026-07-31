import type { Sandbox } from "@e2b/code-interpreter";
import type {
  SandboxBootInfo,
  SandboxInfo,
  SandboxManager,
  SandboxType,
} from "@/types";
import {
  ensureSandboxConnection,
  refreshE2BSandboxLeaseBestEffort,
} from "./sandbox";
import { SANDBOX_ENVIRONMENT_TOOLS } from "./sandbox-tools";

// One failed initial readiness check plus one failed reconnect is enough to
// stop terminal retries in this Agent run. The manager only forgets its local
// SDK client; it never kills the shared per-user sandbox or another run's work.
const MAX_SANDBOX_HEALTH_FAILURES = 2;

export class DefaultSandboxManager implements SandboxManager {
  private sandbox: Sandbox | null = null;
  private healthFailureCount = 0;
  private sandboxUnavailable = false;

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: Sandbox) => void,
    initialSandbox?: Sandbox | null,
    private onBoot?: (info: SandboxBootInfo) => void,
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
    return { type: "e2b" };
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
    sandbox: Sandbox;
  }> {
    if (this.sandbox) {
      await refreshE2BSandboxLeaseBestEffort(this.sandbox, {
        source: "default_manager_cache",
      });
      return { sandbox: this.sandbox };
    }

    const result = await ensureSandboxConnection(
      {
        userID: this.userID,
        setSandbox: this.setSandboxCallback,
        onBoot: this.onBoot,
      },
      {
        initialSandbox: this.sandbox,
      },
    );
    this.sandbox = result.sandbox;

    if (!this.sandbox) {
      throw new Error("Failed to initialize sandbox");
    }

    return { sandbox: this.sandbox };
  }

  setSandbox(sandbox: Sandbox): void {
    this.sandbox = sandbox;
    this.setSandboxCallback(sandbox);
  }

  async resetSandbox(_reason?: string): Promise<void> {
    // This manager holds only a local SDK connection. The E2B sandbox itself
    // is shared per user and may contain commands from another Agent run, so
    // recovery must reconnect instead of globally killing it.
    this.sandbox = null;
  }
}
