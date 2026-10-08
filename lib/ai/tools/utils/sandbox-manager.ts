import type {
  AnySandbox,
  SandboxBootInfo,
  SandboxInfo,
  SandboxManager,
  SandboxType,
} from "@/types";
import type { CloudSandboxProvider } from "./cloud-sandbox-provider";
import {
  assertCloudWorkspaceAvailable,
  registerE2BMigrationLease,
  CloudMigrationUnavailableError,
} from "./cloud-migration-state";
import { isMiosaCloudSandboxPaused } from "./miosa-rollout";
import { refreshE2BSandboxLeaseBestEffort } from "./sandbox";
import { SANDBOX_ENVIRONMENT_TOOLS } from "./sandbox-tools";
import {
  ensureCloudSandboxConnection,
  type CloudSandboxAcquisitionContext,
} from "./cloud-sandbox";
import { getCloudSandboxProvider } from "./cloud-sandbox-provider";
import {
  getCloudSandboxProviderForInstance,
  isCentrifugoSandbox,
  isE2BSandbox,
  isMiosaSandbox,
} from "./sandbox-types";
import { isExpectedAlreadyGoneCleanupError } from "@/lib/utils/cleanup-errors";
import { CloudAcquisitionBudget } from "./cloud-acquisition-budget";

// One failed initial readiness check plus one failed reconnect is enough to
// stop terminal retries in this Agent run. The manager only forgets its local
// SDK client; it never kills the shared per-user sandbox or another run's work.
const MAX_SANDBOX_HEALTH_FAILURES = 2;

export class DefaultSandboxManager implements SandboxManager {
  private sandbox: AnySandbox | null = null;
  private healthFailureCount = 0;
  private sandboxUnavailable = false;
  private activeCloudProvider: CloudSandboxProvider;
  private acquisition: Promise<{ sandbox: AnySandbox }> | null = null;
  private readonly acquisitionBudget = new CloudAcquisitionBudget();

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: AnySandbox) => void,
    initialSandbox?: AnySandbox | null,
    private onBoot?: (info: SandboxBootInfo) => void,
    private cloudSandboxContext?: CloudSandboxAcquisitionContext,
  ) {
    this.sandbox = initialSandbox || null;
    if (this.sandbox && isE2BSandbox(this.sandbox))
      registerE2BMigrationLease(this.sandbox, userID);
    this.activeCloudProvider =
      getCloudSandboxProviderForInstance(this.sandbox) ??
      cloudSandboxContext?.provider ??
      getCloudSandboxProvider();
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
      type: "cloud",
      provider: this.activeCloudProvider,
    };
  }

  getEffectivePreference(): string {
    return "e2b";
  }

  getSandboxType(toolName: string): SandboxType | undefined {
    if (!SANDBOX_ENVIRONMENT_TOOLS.includes(toolName as any)) {
      return undefined;
    }
    return "cloud";
  }

  async getSandbox(): Promise<{
    sandbox: AnySandbox;
  }> {
    if (this.acquisition) return this.acquisition;
    if (this.sandbox) {
      let reacquire =
        isMiosaSandbox(this.sandbox) && isMiosaCloudSandboxPaused();
      if (isE2BSandbox(this.sandbox)) {
        try {
          await assertCloudWorkspaceAvailable(
            this.userID,
            "e2b",
            this.sandbox.sandboxId,
          );
          await refreshE2BSandboxLeaseBestEffort(this.sandbox, {
            source: "default_manager_cache",
          });
        } catch (error) {
          if (!(error instanceof CloudMigrationUnavailableError)) throw error;
          reacquire = true;
        }
      }
      if (!reacquire) return { sandbox: this.sandbox };
      this.sandbox = null;
    }

    if (this.acquisition) return this.acquisition;
    this.acquisition = this.acquisitionBudget
      .run((signal) => this.acquireSandbox(signal), {
        userId: this.userID,
        ...this.cloudSandboxContext,
      })
      .finally(() => {
        this.acquisition = null;
      });
    return this.acquisition;
  }

  private async acquireSandbox(
    signal: AbortSignal,
  ): Promise<{ sandbox: AnySandbox }> {
    signal.throwIfAborted();
    const result = await ensureCloudSandboxConnection({
      signal,
      userId: this.userID,
      setSandbox: (sandbox) => {
        signal.throwIfAborted();
        this.setSandboxCallback(sandbox);
      },
      onBoot: (info) => {
        signal.throwIfAborted();
        this.onBoot?.(info);
      },
      initialSandbox: this.sandbox,
      // Reconnect to the provider that actually supplied this run's files.
      context: {
        ...this.cloudSandboxContext,
        provider: this.activeCloudProvider,
      },
    });
    signal.throwIfAborted();
    this.sandbox = result.sandbox;
    this.activeCloudProvider = result.provider;

    if (!this.sandbox) {
      throw new Error("Failed to initialize sandbox");
    }

    return { sandbox: this.sandbox };
  }

  setSandbox(sandbox: AnySandbox): void {
    if (isE2BSandbox(sandbox)) registerE2BMigrationLease(sandbox, this.userID);
    this.sandbox = sandbox;
    this.activeCloudProvider =
      getCloudSandboxProviderForInstance(sandbox) ?? this.activeCloudProvider;
    this.setSandboxCallback(sandbox);
  }

  async resetSandbox(_reason?: string): Promise<void> {
    // Do not let an in-flight acquisition repopulate the cache after reset.
    await this.acquisition?.catch(() => undefined);
    // E2B is shared per user, so recovery only forgets its SDK connection.
    // Relay sandboxes own a websocket client, which is safe to close while the
    // underlying sandbox continues running.
    const sandbox = this.sandbox;
    this.sandbox = null;
    if (sandbox && isCentrifugoSandbox(sandbox)) {
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

  async supportsInteractivePty(): Promise<boolean> {
    return true;
  }
}
