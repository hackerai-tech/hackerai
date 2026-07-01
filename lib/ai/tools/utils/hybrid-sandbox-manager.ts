import { Sandbox } from "@e2b/code-interpreter";
import { Centrifuge, type Subscription } from "centrifuge";
import type {
  SandboxBootInfo,
  SandboxManager,
  SandboxType,
  SubscriptionTier,
} from "@/types";
import { CentrifugoSandbox, type CentrifugoConfig } from "./centrifugo-sandbox";
import { isCentrifugoSandbox, type ConnectionInfo } from "./sandbox-types";
import { ensureSandboxConnection } from "./sandbox";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { SANDBOX_ENVIRONMENT_TOOLS } from "./sandbox-tools";
import { getPlatformDisplayName } from "./platform-utils";
import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import { sandboxConnectionChannel } from "@/lib/centrifugo/types";
import { presenceHasConnectionId } from "@/lib/centrifugo/presence";
import { isExpectedAlreadyGoneCleanupError } from "@/lib/utils/cleanup-errors";

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
export const LOCAL_SANDBOX_PRESENCE_GRACE_MS = 30_000;
const LOCAL_SANDBOX_PRESENCE_TIMEOUT_MS = 2_000;

interface PresenceProbeResult {
  reliable: boolean;
  onlineConnectionIds: Set<string>;
  durationMs: number;
  error?: unknown;
}

interface PresenceFilterResult {
  availableConnections: ConnectionInfo[];
  staleConnections: ConnectionInfo[];
}

const logStructured = (
  level: "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "chat-handler",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    request_id: process.env.VERCEL_REQUEST_ID ?? null,
    ...fields,
  };

  const message = JSON.stringify(payload);
  if (level === "error") {
    console.error(message);
  } else {
    console.warn(message);
  }
};

export function filterConnectionsByPresence(
  connections: ConnectionInfo[],
  onlineConnectionIds: Set<string>,
  now = Date.now(),
): PresenceFilterResult {
  const availableConnections: ConnectionInfo[] = [];
  const staleConnections: ConnectionInfo[] = [];

  for (const connection of connections) {
    const recentlySeen =
      connection.lastSeen != null &&
      now - connection.lastSeen <= LOCAL_SANDBOX_PRESENCE_GRACE_MS;
    if (onlineConnectionIds.has(connection.connectionId) || recentlySeen) {
      availableConnections.push(connection);
    } else {
      staleConnections.push(connection);
    }
  }

  return { availableConnections, staleConnections };
}

async function queryLiveSandboxConnectionIds(
  userId: string,
  connectionIds: string[],
): Promise<PresenceProbeResult> {
  if (connectionIds.length === 0) {
    return {
      reliable: true,
      onlineConnectionIds: new Set(),
      durationMs: 0,
    };
  }

  const wsUrl = process.env.CENTRIFUGO_WS_URL;
  if (!wsUrl) {
    return {
      reliable: false,
      onlineConnectionIds: new Set(),
      durationMs: 0,
      error: new Error("CENTRIFUGO_WS_URL is not configured"),
    };
  }

  const start = Date.now();
  let client: Centrifuge | null = null;
  const subscriptions: Subscription[] = [];

  try {
    const token = await generateCentrifugoToken(userId, 30);
    client = new Centrifuge(wsUrl, { token });
    const onlineConnectionIds = new Set<string>();

    const probes = connectionIds.map(
      (connectionId) =>
        new Promise<void>((resolve, reject) => {
          const sub = client!.newSubscription(
            sandboxConnectionChannel(userId, connectionId),
          );
          subscriptions.push(sub);

          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error(
                `Centrifugo presence timeout for connection ${connectionId}`,
              ),
            );
          }, LOCAL_SANDBOX_PRESENCE_TIMEOUT_MS);

          const cleanup = () => {
            clearTimeout(timeout);
            sub.removeAllListeners();
          };

          sub.on("subscribed", async () => {
            try {
              const result = await sub.presence();
              cleanup();
              if (presenceHasConnectionId(result, connectionId)) {
                onlineConnectionIds.add(connectionId);
              }
              resolve();
            } catch (error) {
              cleanup();
              reject(error);
            }
          });

          sub.on("error", (ctx) => {
            cleanup();
            reject(
              new Error(ctx.error?.message ?? "Centrifugo subscription error"),
            );
          });

          sub.subscribe();
        }),
    );

    client.connect();
    await Promise.all(probes);

    return {
      reliable: true,
      onlineConnectionIds,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      reliable: false,
      onlineConnectionIds: new Set(),
      durationMs: Date.now() - start,
      error,
    };
  } finally {
    try {
      for (const sub of subscriptions) {
        sub.removeAllListeners();
        sub.unsubscribe();
      }
      client?.disconnect();
    } catch {
      // Ignore cleanup failures.
    }
  }
}

export class HybridSandboxManager implements SandboxManager {
  private sandbox: SandboxInstance | null = null;
  private isLocal = false;
  private currentConnectionId: string | null = null;
  private currentConnectionName: string | null = null;
  private pendingFallbackInfo: SandboxFallbackInfo | null = null;
  private reportedFallbackKeys = new Set<string>();
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
        if (isExpectedAlreadyGoneCleanupError(err)) {
          console.debug(`[${this.userID}] Sandbox was already closed:`, err);
        } else {
          console.warn(`[${this.userID}] Failed to close sandbox:`, err);
        }
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
  peekFallbackInfo(): SandboxFallbackInfo | null {
    return this.pendingFallbackInfo;
  }

  clearFallbackInfo(): void {
    this.pendingFallbackInfo = null;
  }

  consumeFallbackInfo(): SandboxFallbackInfo | null {
    const info = this.pendingFallbackInfo;
    this.pendingFallbackInfo = null;
    if (info) {
      this.reportedFallbackKeys.add(this.getFallbackKey(info));
    }
    return info;
  }

  private getFallbackKey(info: SandboxFallbackInfo): string {
    return [
      info.reason ?? "unknown",
      info.requestedPreference,
      info.actualSandbox,
    ].join(":");
  }

  private recordFallbackInfo(info: SandboxFallbackInfo): void {
    if (this.reportedFallbackKeys.has(this.getFallbackKey(info))) {
      return;
    }
    this.pendingFallbackInfo = info;
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

  async supportsInteractivePty(): Promise<boolean> {
    if (this.sandboxPreference === "e2b") {
      return true;
    }

    const connection = await this.getPreferredOrFallbackConnection();
    if (!connection) {
      return this.subscription !== "free";
    }

    return connection.capabilities?.pty !== false;
  }

  /**
   * List available connections for this user
   */
  async listConnections(): Promise<ConnectionInfo[]> {
    try {
      const connections = await getConvexClient().query(
        api.localSandbox.listConnectionsForBackend,
        {
          serviceKey: this.serviceKey,
          userId: this.userID,
        },
      );
      if (connections.length === 0) {
        return connections;
      }

      const presence = await queryLiveSandboxConnectionIds(
        this.userID,
        connections.map((connection) => connection.connectionId),
      );
      if (!presence.reliable) {
        logStructured("warn", "local_sandbox_presence_unavailable", {
          user_id: this.userID,
          connection_count: connections.length,
          duration_ms: presence.durationMs,
          error:
            presence.error instanceof Error
              ? presence.error.message
              : String(presence.error ?? "unknown"),
        });
        return connections;
      }

      const { availableConnections, staleConnections } =
        filterConnectionsByPresence(connections, presence.onlineConnectionIds);

      if (staleConnections.length > 0) {
        logStructured("warn", "local_sandbox_stale_connections_filtered", {
          user_id: this.userID,
          stale_connection_count: staleConnections.length,
          available_connection_count: availableConnections.length,
          online_connection_count: presence.onlineConnectionIds.size,
          duration_ms: presence.durationMs,
          stale_connection_ids: staleConnections.map(
            (connection) => connection.connectionId,
          ),
        });

        const disconnectResults = await Promise.allSettled(
          staleConnections.map((connection) =>
            getConvexClient().mutation(api.localSandbox.disconnectByBackend, {
              serviceKey: this.serviceKey,
              connectionId: connection.connectionId,
            }),
          ),
        );

        const failedDisconnects = disconnectResults.filter(
          (result) => result.status === "rejected",
        );
        if (failedDisconnects.length > 0) {
          logStructured("error", "local_sandbox_stale_disconnect_failed", {
            user_id: this.userID,
            failed_count: failedDisconnects.length,
            stale_connection_count: staleConnections.length,
            errors: failedDisconnects.map((result) =>
              result.status === "rejected" && result.reason instanceof Error
                ? result.reason.message
                : String(
                    result.status === "rejected" ? result.reason : "unknown",
                  ),
            ),
          });
        }
      }

      return availableConnections;
    } catch (error) {
      logStructured("error", "local_sandbox_connections_list_failed", {
        user_id: this.userID,
        error: error instanceof Error ? error.message : String(error),
      });
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

      this.recordFallbackInfo({
        occurred: true,
        reason: "connection_unavailable",
        requestedPreference: this.sandboxPreference,
        actualSandbox: firstAvailable.connectionId,
        actualSandboxName: firstAvailable.name,
      });

      return { sandbox: this.sandbox! };
    }

    // Free users cannot fall back to E2B — must use local sandbox
    if (this.subscription === "free") {
      throw new Error(
        "Local sandbox disconnected. Reconnect your desktop app or upgrade to Pro for cloud sandbox.",
      );
    }

    // Fall back to E2B if no local connections available (paid users only)
    this.recordFallbackInfo({
      occurred: true,
      reason: "no_local_connections",
      requestedPreference: this.sandboxPreference,
      actualSandbox: "e2b",
      actualSandboxName: "Cloud",
    });

    return this.getE2BSandbox();
  }

  private async getPreferredOrFallbackConnection(): Promise<ConnectionInfo | null> {
    const connections = await this.listConnections();
    const preferredConnection =
      this.sandboxPreference === "desktop"
        ? connections.find((conn) => conn.isDesktop)
        : connections.find(
            (conn) => conn.connectionId === this.sandboxPreference,
          );

    return preferredConnection ?? connections[0] ?? null;
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

  async resetSandbox(reason?: string): Promise<void> {
    const sandbox = this.sandbox;
    this.sandbox = null;
    this.isLocal = false;
    this.currentConnectionId = null;
    this.currentConnectionName = null;

    if (!sandbox) return;

    if (sandbox instanceof CentrifugoSandbox) {
      await sandbox.close().catch((error) => {
        const message = `[${this.userID}] Failed to close local sandbox during reset${reason ? ` (${reason})` : ""}:`;
        if (isExpectedAlreadyGoneCleanupError(error)) {
          console.debug(message, error);
        } else {
          console.warn(message, error);
        }
      });
      return;
    }

    try {
      await sandbox.kill();
    } catch (error) {
      const message = `[${this.userID}] Failed to kill E2B sandbox during reset${reason ? ` (${reason})` : ""}:`;
      if (isExpectedAlreadyGoneCleanupError(error)) {
        console.debug(message, error);
      } else {
        console.warn(message, error);
      }
    }
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

    if (preferredConnection) {
      // Cache early so getSandboxType()/getSandboxInfo() work before getSandbox() is called
      this.currentConnectionName = preferredConnection.name;
      return this.buildSandboxContext(preferredConnection);
    }

    if (connections.length > 0) {
      const firstAvailable = connections[0];
      this.currentConnectionName = firstAvailable.name;
      this.recordFallbackInfo({
        occurred: true,
        reason: "connection_unavailable",
        requestedPreference: this.sandboxPreference,
        actualSandbox: firstAvailable.connectionId,
        actualSandboxName: firstAvailable.name,
      });
      return this.buildSandboxContext(firstAvailable);
    }

    if (this.subscription !== "free") {
      this.recordFallbackInfo({
        occurred: true,
        reason: "no_local_connections",
        requestedPreference: this.sandboxPreference,
        actualSandbox: "e2b",
        actualSandboxName: "Cloud",
      });
    }

    return null;
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
      const agentBrowserProbe =
        platform === "win32"
          ? "where agent-browser && agent-browser --version"
          : "command -v agent-browser && agent-browser --version";

      return `<sandbox_environment>
IMPORTANT: You are connected to a LOCAL machine in DANGEROUS MODE. Commands run directly on the host OS without Docker isolation.

System Environment:
- OS: ${platformName} ${release} (${arch})
- Hostname: ${hostname}
- Mode: DANGEROUS (no Docker isolation)
- User attachments: ${uploadPath}
- Interactive terminal: ${connection.capabilities?.pty === false ? "unavailable" : "available"}

Security Warning:
- File system operations affect the host directly
- Network operations use the host network
- Process management can affect the host system
- Be careful with destructive commands

Available tools depend on what's installed on the host system.

Browser Automation:
- Chromium and agent-browser are preinstalled only in the Cloud sandbox.
- On this host, browser automation is host-dependent. If browser automation is needed, first check with \`${agentBrowserProbe}\`.
- Use agent-browser only if it is already installed. Do not install browser automation packages on the host unless the user explicitly asks.
- If agent-browser is unavailable, continue with other installed tools when possible or tell the user they can switch to the Cloud sandbox for the preinstalled browser workflow.
</sandbox_environment>`;
    }

    return null;
  }
}
