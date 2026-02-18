import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxManager, SandboxType } from "@/types";
import { ConvexSandbox } from "./convex-sandbox";
import { ensureSandboxConnection } from "./sandbox";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { PREINSTALLED_PENTESTING_TOOLS } from "@/lib/system-prompt";
import { SANDBOX_ENVIRONMENT_TOOLS } from "./sandbox-tools";

type SandboxInstance = Sandbox | ConvexSandbox;

export type SandboxPreference = "e2b" | string; // "e2b" or connectionId

export interface SandboxFallbackInfo {
  occurred: boolean;
  reason?: "connection_unavailable" | "no_local_connections";
  requestedPreference: SandboxPreference;
  actualSandbox: "e2b" | string; // "e2b" or connectionId
  actualSandboxName?: string; // Human-readable name for local sandboxes
}

interface ConnectionInfo {
  connectionId: string;
  name: string;
  mode: "docker" | "dangerous";
  osInfo?: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
  };
  containerId?: string;
  lastSeen: number;
}

/**
 * Hybrid sandbox manager that automatically switches between
 * local Convex sandbox and E2B cloud sandbox based on user preference
 * and connection availability.
 *
 * Supports:
 * - Multiple local connections per user
 * - Chat-level sandbox preference
 * - Automatic fallback to E2B when local unavailable
 * - Dangerous mode (no Docker) with OS context for AI
 */
const MAX_SANDBOX_HEALTH_FAILURES = 3;

export class HybridSandboxManager implements SandboxManager {
  private sandbox: SandboxInstance | null = null;
  private isLocal = false;
  private currentConnectionId: string | null = null;
  private currentConnectionMode: "docker" | "dangerous" | null = null;
  private currentConnectionName: string | null = null;
  private convex: ConvexHttpClient;
  private convexUrl: string;
  private pendingFallbackInfo: SandboxFallbackInfo | null = null;
  private healthFailureCount = 0;
  private sandboxUnavailable = false;

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: SandboxInstance) => void,
    private sandboxPreference: SandboxPreference = "e2b",
    private serviceKey: string,
    initialSandbox?: Sandbox | null,
  ) {
    this.sandbox = initialSandbox || null;
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!convexUrl) {
      throw new Error("NEXT_PUBLIC_CONVEX_URL environment variable is not set");
    }
    this.convexUrl = convexUrl;
    this.convex = new ConvexHttpClient(convexUrl);
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

  /**
   * Get OS context for AI when using dangerous mode
   * Returns null if not in dangerous mode or using E2B
   */
  getOsContext(): string | null {
    if (this.sandbox instanceof ConvexSandbox) {
      return this.sandbox.getOsContext();
    }
    return null;
  }

  /**
   * Close current sandbox if it's a ConvexSandbox (to prevent WebSocket leaks)
   */
  private async closeCurrentSandbox(): Promise<void> {
    if (this.sandbox instanceof ConvexSandbox) {
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
    if (this.sandboxPreference === "e2b") {
      return { type: "e2b" };
    }
    const type: SandboxType =
      this.currentConnectionMode === "docker" ? "local-sandbox" : "local";
    return { type, name: this.currentConnectionName ?? undefined };
  }

  getSandboxType(toolName: string): SandboxType | undefined {
    if (!SANDBOX_ENVIRONMENT_TOOLS.includes(toolName as any)) {
      return undefined;
    }
    if (this.sandboxPreference === "e2b") {
      return "e2b";
    }
    // Local sandbox — use cached mode to distinguish docker vs dangerous
    if (this.currentConnectionMode === "docker") {
      return "local-sandbox";
    }
    return "local";
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
    // If preference is E2B, always use E2B
    if (this.sandboxPreference === "e2b") {
      return this.getE2BSandbox();
    }

    // Check if the preferred connection is available
    const connections = await this.listConnections();

    // Find the preferred connection
    const preferredConnection = connections.find(
      (conn) => conn.connectionId === this.sandboxPreference,
    );

    if (preferredConnection) {
      // Use the preferred local connection
      if (
        this.currentConnectionId !== preferredConnection.connectionId ||
        !this.sandbox
      ) {
        await this.closeCurrentSandbox();
        this.sandbox = new ConvexSandbox(
          this.userID,
          this.convexUrl,
          preferredConnection,
          this.serviceKey,
        );
        this.isLocal = true;
        this.currentConnectionId = preferredConnection.connectionId;
        this.currentConnectionMode = preferredConnection.mode;
        this.currentConnectionName = preferredConnection.name;
        this.setSandboxCallback(this.sandbox);
      }

      return { sandbox: this.sandbox };
    }

    // If preferred connection not available, check if any connection is available
    if (connections.length > 0) {
      const firstAvailable = connections[0];
      await this.closeCurrentSandbox();
      this.sandbox = new ConvexSandbox(
        this.userID,
        this.convexUrl,
        firstAvailable,
        this.serviceKey,
      );
      this.isLocal = true;
      this.currentConnectionId = firstAvailable.connectionId;
      this.currentConnectionMode = firstAvailable.mode;
      this.currentConnectionName = firstAvailable.name;
      this.setSandboxCallback(this.sandbox);

      // Record fallback info for notification
      this.pendingFallbackInfo = {
        occurred: true,
        reason: "connection_unavailable",
        requestedPreference: this.sandboxPreference,
        actualSandbox: firstAvailable.connectionId,
        actualSandboxName: firstAvailable.name,
      };

      return { sandbox: this.sandbox };
    }

    // Fall back to E2B if no local connections available
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
      },
      {
        initialSandbox: this.isLocal ? null : (this.sandbox as Sandbox | null),
      },
    );

    this.sandbox = result.sandbox;
    this.isLocal = false;
    this.currentConnectionId = null;
    this.currentConnectionMode = null;
    this.currentConnectionName = null;
    this.setSandboxCallback(result.sandbox);

    return { sandbox: result.sandbox };
  }

  setSandbox(sandbox: SandboxInstance): void {
    this.sandbox = sandbox;
    this.isLocal = sandbox instanceof ConvexSandbox;
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
    const preferredConnection = connections.find(
      (conn) => conn.connectionId === this.sandboxPreference,
    );

    const connection = preferredConnection || connections[0];
    if (!connection) {
      return null;
    }

    // Cache early so getSandboxType()/getSandboxInfo() work before getSandbox() is called
    this.currentConnectionMode = connection.mode;
    this.currentConnectionName = connection.name;

    return this.buildSandboxContext(connection);
  }

  private buildSandboxContext(connection: ConnectionInfo): string | null {
    const { mode, osInfo } = connection;

    if (mode === "dangerous" && osInfo) {
      const { platform, arch, release, hostname } = osInfo;
      const platformName =
        platform === "darwin"
          ? "macOS"
          : platform === "win32"
            ? "Windows"
            : platform === "linux"
              ? "Linux"
              : platform;

      return `<sandbox_environment>
IMPORTANT: You are connected to a LOCAL machine in DANGEROUS MODE. Commands run directly on the host OS without Docker isolation.

System Environment:
- OS: ${platformName} ${release} (${arch})
- Hostname: ${hostname}
- Mode: DANGEROUS (no Docker isolation)
- User attachments: /tmp/hackerai-upload

Security Warning:
- File system operations affect the host directly
- Network operations use the host network
- Process management can affect the host system
- Be careful with destructive commands

Available tools depend on what's installed on the host system.
</sandbox_environment>`;
    }

    if (mode === "docker") {
      return `<sandbox_environment>
IMPORTANT: You are connected to a LOCAL machine running the HackerAI Docker sandbox.

Container Environment:
- Image: hackerai/sandbox (pre-built pentesting tools)
- Mode: Docker container
- Network: Host network (--network host)
- User attachments: /tmp/hackerai-upload

${PREINSTALLED_PENTESTING_TOOLS}
</sandbox_environment>`;
    }

    return null;
  }
}
