import { Sandbox } from "@e2b/code-interpreter";
import type {
  SandboxBootInfo,
  SandboxManager,
  SandboxType,
  SubscriptionTier,
} from "@/types";
import { CentrifugoSandbox, type CentrifugoConfig } from "./centrifugo-sandbox";
import { isCentrifugoSandbox, type ConnectionInfo } from "./sandbox-types";
import { ensureSandboxConnection } from "./sandbox";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { SANDBOX_ENVIRONMENT_TOOLS } from "./sandbox-tools";
import { getPlatformDisplayName } from "./platform-utils";

type SandboxInstance = Sandbox | CentrifugoSandbox;

// "e2b" for cloud sandbox, "desktop" for Tauri desktop app, or a connectionId UUID for a specific local connection.
// Uses `string & {}` to preserve autocomplete for well-known values while allowing arbitrary strings.
export type SandboxPreference = "e2b" | "desktop" | (string & {});

export interface SandboxFallbackInfo {
  occurred: boolean;
  reason?: "connection_unavailable" | "no_local_connections";
  requestedPreference: SandboxPreference;
  actualSandbox: "e2b" | string; // "e2b" or connectionId
  actualSandboxName?: string; // Human-readable name for local sandboxes
}

/**
 * Hybrid sandbox manager that automatically switches between
 * local Centrifugo sandbox and E2B cloud sandbox based on user preference
 * and connection availability.
 *
 * Supports:
 * - Multiple local connections per user
 * - Chat-level sandbox preference
 * - Automatic fallback to E2B when local unavailable
 * - Dangerous mode (no Docker) with OS context for AI
 */
const MAX_SANDBOX_HEALTH_FAILURES = 5;

export class HybridSandboxManager implements SandboxManager {
  private sandbox: SandboxInstance | null = null;
  private isLocal = false;
  private currentConnectionId: string | null = null;
  private currentConnectionName: string | null = null;
  private convex: ConvexHttpClient;
  private pendingFallbackInfo: SandboxFallbackInfo | null = null;
  private healthFailureCount = 0;
  private sandboxUnavailable = false;

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: SandboxInstance) => void,
    private sandboxPreference: SandboxPreference = "e2b",
    private serviceKey: string,
    initialSandbox?: Sandbox | null,
    private subscription?: SubscriptionTier,
    private onBoot?: (info: SandboxBootInfo) => void,
  ) {
    this.sandbox = initialSandbox || null;
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) {
      throw new Error("NEXT_PUBLIC_CONVEX_URL environment variable is not set");
    }
    this.convex = new ConvexHttpClient(convexUrl);
  }

  recordHealthFailure(): boolean {
    this.healthFailureCount++;
    if (this.healthFailureCount >= MAX_SANDBOX_HEALTH_FAILURES) {
      // Mark as unavailable regardless of sandbox type.
      // Don't auto-fallback from local to E2B — the user explicitly chose local
      // and switching environments mid-conversation loses files, network context,
      // and tools the agent was working with.
      if (this.isLocal) {
        console.warn(
          `[${this.userID}] Local sandbox health failures exceeded threshold, marking unavailable`,
        );
      }
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

  /**
   * Get the effective sandbox preference after any fallbacks.
   * Returns the actual sandbox in use: "e2b" or a connectionId.
   * Use this instead of the original sandboxPreference to persist accurate state.
   */
  getEffectivePreference(): SandboxPreference {
    if (this.isLocal && this.currentConnectionId) {
      return this.sandboxPreference === "desktop"
        ? "desktop"
        : this.currentConnectionId;
    }
    // If we've initialized a sandbox and it's not local, it's E2B
    if (this.sandbox && !this.isLocal) {
      return "e2b";
    }
    // Sandbox hasn't been initialized yet; return original preference
    return this.sandboxPreference;
  }

  /**
   * Get OS context for AI when using dangerous mode.
   * Returns null if using E2B.
   */
  getOsContext(): string | null {
    if (this.sandbox instanceof CentrifugoSandbox) {
      return this.sandbox.getOsContext();
    }
    return null;
  }

  /**
   * Close current sandbox if it's a CentrifugoSandbox (to prevent WebSocket leaks)
   */
  private async closeCurrentSandbox(): Promise<void> {
    if (this.sandbox instanceof CentrifugoSandbox) {
      await this.sandbox.close().catch((err) => {
        console.warn(`[${this.userID}] Failed to close sandbox:`, err);
      });
    }
  }

  /**
   * Set the sandbox preference for this chat
   * @param preference - "e2b" or a specific connectionId
   */
  async setSandboxPreference(preference: SandboxPreference): Promise<void> {
    this.sandboxPreference = preference;
    // Force re-evaluation on next getSandbox call
    if (preference !== "e2b" && this.currentConnectionId !== preference) {
      await this.closeCurrentSandbox();
      this.sandbox = null;
    }
  }

  /**
   * Get and clear any pending fallback info.
   * Returns null if no fallback occurred, otherwise returns the fallback details.
   * Clears the info after returning so it's only reported once.
   */
  consumeFallbackInfo(): SandboxFallbackInfo | null {
    const info = this.pendingFallbackInfo;
    this.pendingFallbackInfo = null;
    return info;
  }

  getSandboxInfo(): { type: SandboxType; name?: string } | null {
    if (!this.isLocal) {
      return { type: "e2b" };
    }
    const type: SandboxType =
      this.sandboxPreference === "desktop" ? "desktop" : "remote-connection";
    return { type, name: this.currentConnectionName ?? undefined };
  }

  getSandboxType(toolName: string): SandboxType | undefined {
    if (!(SANDBOX_ENVIRONMENT_TOOLS as readonly string[]).includes(toolName)) {
      return undefined;
    }
    if (!this.isLocal) {
      return "e2b";
    }
    return this.sandboxPreference === "desktop"
      ? "desktop"
      : "remote-connection";
  }

  /**
   * List available connections for this user
   */
  async listConnections(): Promise<ConnectionInfo[]> {
    try {
      const connections = await this.convex.query(
        api.localSandbox.listConnectionsForBackend,
        {
          serviceKey: this.serviceKey,
          userId: this.userID,
        },
      );
      return connections;
    } catch (error) {
      console.error(`[${this.userID}] Failed to list connections:`, error);
      return [];
    }
  }

  async getSandbox(): Promise<{ sandbox: SandboxInstance }> {
    // If preference is E2B, always use E2B (but block for free users)
    if (this.sandboxPreference === "e2b") {
      if (this.subscription === "free") {
        throw new Error("Cloud sandbox requires a paid plan.");
      }
      return this.getE2BSandbox();
    }

    // Check if the preferred connection is available
    const connections = await this.listConnections();

    // Find the preferred connection
    const preferredConnection =
      this.sandboxPreference === "desktop"
        ? connections.find((conn) => conn.isDesktop)
        : connections.find(
            (conn) => conn.connectionId === this.sandboxPreference,
          );

    if (preferredConnection) {
      // Use the preferred local connection
      if (
        this.currentConnectionId !== preferredConnection.connectionId ||
        !this.sandbox
      ) {
        await this.useCentrifugoConnection(preferredConnection);
      }

      return { sandbox: this.sandbox! };
    }

    // If preferred connection not available, check if any connection is available
    if (connections.length > 0) {
      const firstAvailable = connections[0];
      await this.useCentrifugoConnection(firstAvailable);

      // Record fallback info for notification
      this.pendingFallbackInfo = {
        occurred: true,
        reason: "connection_unavailable",
        requestedPreference: this.sandboxPreference,
        actualSandbox: firstAvailable.connectionId,
        actualSandboxName: firstAvailable.name,
      };

      return { sandbox: this.sandbox! };
    }

    // Free users cannot fall back to E2B — must use local sandbox
    if (this.subscription === "free") {
      throw new Error(
        "Local sandbox disconnected. Reconnect your desktop app or upgrade to Pro for cloud sandbox.",
      );
    }

    // Fall back to E2B if no local connections available (paid users only)
    // Record fallback info for notification
    this.pendingFallbackInfo = {
      occurred: true,
      reason: "no_local_connections",
      requestedPreference: this.sandboxPreference,
      actualSandbox: "e2b",
      actualSandboxName: "Cloud",
    };

    return this.getE2BSandbox();
  }

  /**
   * Create and wire up a CentrifugoSandbox for the given connection.
   */
  private async useCentrifugoConnection(
    connection: ConnectionInfo,
  ): Promise<void> {
    await this.closeCurrentSandbox();
    const centrifugoWsUrl = process.env.CENTRIFUGO_WS_URL;
    const centrifugoTokenSecret = process.env.CENTRIFUGO_TOKEN_SECRET;
    if (!centrifugoWsUrl || !centrifugoTokenSecret) {
      throw new Error("Missing Centrifugo environment variables");
    }
    const centrifugoConfig: CentrifugoConfig = {
      wsUrl: centrifugoWsUrl,
      tokenSecret: centrifugoTokenSecret,
    };
    this.sandbox = new CentrifugoSandbox(
      this.userID,
      connection,
      centrifugoConfig,
    );
    this.isLocal = true;
    this.currentConnectionId = connection.connectionId;
    this.currentConnectionName = connection.name;
    this.setSandboxCallback(this.sandbox);
  }

  private async getE2BSandbox(): Promise<{ sandbox: Sandbox }> {
    if (!this.isLocal && this.sandbox && this.sandbox instanceof Sandbox) {
      return { sandbox: this.sandbox };
    }

    await this.closeCurrentSandbox();
    const result = await ensureSandboxConnection(
      {
        userID: this.userID,
        setSandbox: (sandbox) => {
          this.sandbox = sandbox;
          this.setSandboxCallback(sandbox);
        },
        onBoot: this.onBoot,
      },
      {
        initialSandbox: this.isLocal ? null : (this.sandbox as Sandbox | null),
      },
    );

    this.sandbox = result.sandbox;
    this.isLocal = false;
    this.currentConnectionId = null;
    this.currentConnectionName = null;
    this.setSandboxCallback(result.sandbox);

    return { sandbox: result.sandbox };
  }

  setSandbox(sandbox: SandboxInstance): void {
    this.sandbox = sandbox;
    this.isLocal = isCentrifugoSandbox(sandbox);
    if (isCentrifugoSandbox(sandbox)) {
      this.currentConnectionId = sandbox.getConnectionId();
      this.currentConnectionName = sandbox.getConnectionName();
    } else {
      this.currentConnectionId = null;
      this.currentConnectionName = null;
    }
    this.setSandboxCallback(sandbox);
  }

  /**
   * Get expected sandbox context for the system prompt based on preference
   * without initializing the sandbox. Returns null for E2B (uses default prompt).
   */
  async getSandboxContextForPrompt(): Promise<string | null> {
    if (this.sandboxPreference === "e2b") {
      return null;
    }

    const connections = await this.listConnections();
    const preferredConnection =
      this.sandboxPreference === "desktop"
        ? connections.find((conn) => conn.isDesktop)
        : connections.find(
            (conn) => conn.connectionId === this.sandboxPreference,
          );

    const connection = preferredConnection || connections[0];
    if (!connection) {
      return null;
    }

    // Cache early so getSandboxType()/getSandboxInfo() work before getSandbox() is called
    this.currentConnectionName = connection.name;

    return this.buildSandboxContext(connection);
  }

  private buildSandboxContext(connection: ConnectionInfo): string | null {
    const { osInfo } = connection;

    if (osInfo) {
      const { platform, arch, release, hostname } = osInfo;
      const platformName = getPlatformDisplayName(platform);

      const uploadPath =
        platform === "win32"
          ? "C:\\temp\\hackerai-upload"
          : "/tmp/hackerai-upload";

      return `<sandbox_environment>
IMPORTANT: You are connected to a LOCAL machine in DANGEROUS MODE. Commands run directly on the host OS without Docker isolation.

System Environment:
- OS: ${platformName} ${release} (${arch})
- Hostname: ${hostname}
- Mode: DANGEROUS (no Docker isolation)
- User attachments: ${uploadPath}

Security Warning:
- File system operations affect the host directly
- Network operations use the host network
- Process management can affect the host system
- Be careful with destructive commands

Available tools depend on what's installed on the host system.
</sandbox_environment>`;
    }

    return null;
  }
}
