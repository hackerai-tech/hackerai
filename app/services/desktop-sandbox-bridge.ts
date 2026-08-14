import { Centrifuge, errorCodes, type Subscription } from "centrifuge";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  sandboxConnectionChannel,
  type SandboxMessage,
  type CommandCancelMessage,
  type CommandMessage,
  type PtyCreateMessage,
  type PtyInputMessage,
  type PtyResizeMessage,
  type PtyKillMessage,
  type FileRequestMessage,
  type FileStatMessage,
  type FileReadMessage,
  type FileWriteMessage,
  type FileAppendMessage,
  type FileRemoveMessage,
  type FileListMessage,
} from "@/lib/centrifugo/types";
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
} from "@/lib/ai/tools/utils/pty-session-manager";
import { CentrifugoPublishQueue } from "@/packages/local/src/centrifugo-transport";

type RefreshTokenResult =
  | { ok: true; centrifugoToken: string }
  | {
      ok: false;
      terminated: true;
      reason:
        "connection_not_found" | "ownership_mismatch" | "connection_inactive";
      connectionId: string;
      clientVersion: string | null;
      status: string | null;
      disconnectReason:
        | "client_disconnect"
        | "desktop_disconnect"
        | "desktop_kicked_by_new_session"
        | "token_regenerated"
        | "presence_sweep"
        | "command_unresponsive"
        | null;
      msSinceDisconnected: number | null;
      msSinceLastHeartbeat: number | null;
      msSinceCreated: number | null;
    };

type DesktopBridgeTerminationReason =
  | "unauthenticated"
  | "connection_not_found"
  | "ownership_mismatch"
  | "connection_inactive";

type DesktopStreamPublishFailureReason = "connection_closed" | "timeout";

const DESKTOP_STREAM_PUBLISH_MAX_ATTEMPTS = 3;
const DESKTOP_STREAM_PUBLISH_RETRY_BASE_DELAY_MS = 250;
const DESKTOP_STREAM_RECONNECT_WAIT_MS = 5_000;
const DESKTOP_STREAM_RECOVERY_DEADLINE_BUFFER_MS = 3_000;

interface StreamChunk {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number;
  message?: string;
}

interface DesktopStreamPublishRecoveryState {
  failureReported: boolean;
  recoveryReported: boolean;
  exhaustionReported: boolean;
  observedChunks: number;
  publishedChunks: number;
  exhaustedChunks: number;
  terminalChunkObserved: "exit" | "error" | null;
  terminalChunkPublished: boolean;
}

function shouldForwardStreamChunk(chunk: StreamChunk): boolean {
  if (chunk.type === "stdout" || chunk.type === "stderr") {
    return Boolean(chunk.data);
  }
  return true;
}

function classifyDesktopStreamPublishFailure(
  error: unknown,
): DesktopStreamPublishFailureReason | null {
  let code: unknown;
  let message: unknown;

  if (error instanceof Error) {
    message = error.message;
    try {
      const parsed = JSON.parse(error.message) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        code = (parsed as { code?: unknown }).code;
        message = (parsed as { message?: unknown }).message;
      }
    } catch {
      // Centrifuge can also reject with a normal Error message.
    }
  } else if (typeof error === "object" && error !== null) {
    code = (error as { code?: unknown }).code;
    message = (error as { message?: unknown }).message;
  } else {
    message = error;
  }

  if (code === errorCodes.connectionClosed || message === "connection closed") {
    return "connection_closed";
  }
  if (code === errorCodes.timeout || message === "timeout") {
    return "timeout";
  }
  return null;
}

type TargetedIncomingMessage =
  | CommandMessage
  | CommandCancelMessage
  | FileRequestMessage
  | PtyCreateMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyKillMessage;

function isTargetedIncomingMessage(
  message: unknown,
): message is TargetedIncomingMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const { type, targetConnectionId } = message as {
    type?: unknown;
    targetConnectionId?: unknown;
  };
  return (
    typeof targetConnectionId === "string" &&
    (type === "command" ||
      type === "command_cancel" ||
      type === "file_stat" ||
      type === "file_read" ||
      type === "file_write" ||
      type === "file_append" ||
      type === "file_remove" ||
      type === "file_list" ||
      type === "pty_create" ||
      type === "pty_input" ||
      type === "pty_resize" ||
      type === "pty_kill")
  );
}

// "Unauthenticated" UNAUTHORIZED still throws server-side (the user's auth
// identity is missing/expired, not a connection lifecycle event), so the
// catch path needs to recognize it as a terminate-the-loop signal too.
function isUnauthenticatedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  return (data as { code?: string }).code === "UNAUTHORIZED";
}

interface DesktopBridgeConfig {
  connectDesktop: (args: {
    connectionName: string;
    osInfo?: {
      platform: string;
      arch: string;
      release: string;
      hostname: string;
    };
    capabilities?: {
      commands: boolean;
      pty: boolean;
      files?: boolean;
    };
  }) => Promise<{
    connectionId: string;
    centrifugoToken: string;
    centrifugoWsUrl: string;
  }>;
  refreshCentrifugoTokenDesktop: (args: {
    connectionId: string;
  }) => Promise<RefreshTokenResult>;
  disconnectDesktop: (args: {
    connectionId: string;
  }) => Promise<{ success: boolean }>;
  onTerminated?: (reason: DesktopBridgeTerminationReason) => void;
}

export class DesktopSandboxBridge {
  private client: Centrifuge | null = null;
  private subscription: Subscription | null = null;
  private connectionId: string | null = null;
  private activeCommands = new Set<string>();
  private isStoppingOrStopped = true;
  private config: DesktopBridgeConfig;
  private publishQueue: CentrifugoPublishQueue | null = null;

  constructor(config: DesktopBridgeConfig) {
    this.config = config;
  }

  getConnectionId(): string | null {
    return this.connectionId;
  }

  private terminateClient(reason: DesktopBridgeTerminationReason): void {
    if (this.isStoppingOrStopped) return;
    this.isStoppingOrStopped = true;
    const client = this.client;
    const subscription = this.subscription;
    this.client = null;
    this.subscription = null;
    this.publishQueue = null;
    this.connectionId = null;
    try {
      subscription?.unsubscribe();
    } catch {
      // already in a terminal state
    }
    try {
      subscription?.removeAllListeners();
    } catch {
      // already in a terminal state
    }
    try {
      client?.disconnect();
    } catch {
      // already in a terminal state
    }
    this.config.onTerminated?.(reason);
  }

  async start(): Promise<string> {
    this.isStoppingOrStopped = false;
    const osInfo = await this.getOsInfo();

    const { connectionId, centrifugoToken, centrifugoWsUrl } =
      await this.config.connectDesktop({
        connectionName: osInfo?.hostname || "Desktop",
        osInfo,
        capabilities: { commands: true, pty: true, files: true },
      });

    this.connectionId = connectionId;

    this.client = new Centrifuge(centrifugoWsUrl, {
      token: centrifugoToken,
      getToken: async () => {
        if (!this.connectionId) {
          throw new Error(
            "[DesktopSandboxBridge] Cannot refresh token: connectionId is null",
          );
        }
        let result: RefreshTokenResult;
        try {
          result = await this.config.refreshCentrifugoTokenDesktop({
            connectionId: this.connectionId,
          });
        } catch (error) {
          if (isUnauthenticatedError(error)) {
            const eventProps = {
              connectionId: this.connectionId,
              clientSurface: "desktop_bridge",
              reason: "unauthenticated" as const,
            };
            console.warn(
              "[DesktopSandboxBridge] Centrifugo refresh aborted — user not authenticated; stopping client to break retry loop",
              eventProps,
            );
            captureAuthenticatedEvent(
              "sandbox_connection_terminated",
              eventProps,
            );
            this.terminateClient("unauthenticated");
          } else {
            console.error(
              "[DesktopSandboxBridge] Failed to refresh Centrifugo token:",
              error,
            );
          }
          throw error;
        }
        if (result.ok) return result.centrifugoToken;

        const eventProps = {
          connectionId: this.connectionId,
          clientSurface: "desktop_bridge",
          reason: result.reason,
          serverConnectionId: result.connectionId,
          serverClientVersion: result.clientVersion,
          serverStatus: result.status,
          disconnectReason: result.disconnectReason,
          msSinceDisconnected: result.msSinceDisconnected,
          msSinceLastHeartbeat: result.msSinceLastHeartbeat,
          msSinceCreated: result.msSinceCreated,
        };
        console.warn(
          "[DesktopSandboxBridge] Centrifugo refresh aborted — server reports connection terminated; stopping client to break retry loop",
          eventProps,
        );
        captureAuthenticatedEvent("sandbox_connection_terminated", eventProps);
        this.terminateClient(result.reason);
        throw new Error(`Centrifugo refresh aborted: ${result.reason}`);
      },
    });

    const userId = this.extractUserIdFromToken(centrifugoToken);
    const channel = sandboxConnectionChannel(userId, connectionId);
    const subscription = this.client.newSubscription(channel);
    this.subscription = subscription;
    this.publishQueue = new CentrifugoPublishQueue(async (message) => {
      // Queued work can outlive stop() or a reconnect; never publish it on a
      // replacement subscription.
      if (this.isStoppingOrStopped || this.subscription !== subscription)
        return;
      await subscription.publish(message);
    });

    this.subscription.on("publication", (ctx) => {
      const message = ctx.data;

      if (!isTargetedIncomingMessage(message)) {
        return;
      }

      if (message.targetConnectionId !== this.connectionId) {
        return;
      }

      switch (message.type) {
        case "command":
          this.handleCommand(message as CommandMessage).catch((err) => {
            console.error(
              "[DesktopSandboxBridge] Command handling failed:",
              err,
            );
          });
          break;

        case "command_cancel":
          this.handleCommandCancel(message as CommandCancelMessage).catch(
            (err) => {
              console.error(
                "[DesktopSandboxBridge] Command cancel failed:",
                err,
              );
            },
          );
          break;

        case "file_stat":
          this.handleFileStat(message as FileStatMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] File stat failed:", err);
          });
          break;

        case "file_read":
          this.handleFileRead(message as FileReadMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] File read failed:", err);
          });
          break;

        case "file_write":
          this.handleFileWrite(message as FileWriteMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] File write failed:", err);
          });
          break;

        case "file_append":
          this.handleFileAppend(message as FileAppendMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] File append failed:", err);
          });
          break;

        case "file_remove":
          this.handleFileRemove(message as FileRemoveMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] File remove failed:", err);
          });
          break;

        case "file_list":
          this.handleFileList(message as FileListMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] File list failed:", err);
          });
          break;

        case "pty_create":
          this.handlePtyCreate(message as PtyCreateMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] PTY create failed:", err);
          });
          break;

        case "pty_input":
          this.handlePtyInput(message as PtyInputMessage).catch((err) => {
            console.error("[DesktopSandboxBridge] PTY input failed:", err);
          });
          break;

        case "pty_resize":
          this.handlePtyResize(message as PtyResizeMessage).catch(() => {});
          break;

        case "pty_kill":
          this.handlePtyKill(message as PtyKillMessage).catch(() => {});
          break;

        default:
          break;
      }
    });

    this.subscription.subscribe();
    this.client.connect();

    return connectionId;
  }

  private extractUserIdFromToken(token: string): string {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(atob(b64));
    if (!payload.sub || typeof payload.sub !== "string") {
      throw new Error("JWT missing 'sub' claim");
    }
    return payload.sub;
  }

  private async getOsInfo(): Promise<
    | { platform: string; arch: string; release: string; hostname: string }
    | undefined
  > {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        stdout: string;
        stderr: string;
        exit_code: number;
      }>("execute_command", {
        command: "uname -srm && hostname",
        timeoutMs: 5000,
      });
      if (result.exit_code === 0) {
        const lines = result.stdout.trim().split("\n");
        const [uname, hostname] = [lines[0] || "", lines[1] || "Desktop"];
        const parts = uname.split(" ");
        return {
          platform:
            parts[0]?.toLowerCase() === "darwin"
              ? "darwin"
              : parts[0]?.toLowerCase() || "unknown",
          release: parts[1] || "unknown",
          arch: parts[2] || "unknown",
          hostname: hostname.trim(),
        };
      }

      // uname failed — try Windows-specific detection
      const winResult = await invoke<{
        stdout: string;
        stderr: string;
        exit_code: number;
      }>("execute_command", {
        command: "ver && hostname",
        timeoutMs: 5000,
      });
      if (winResult.exit_code === 0) {
        const lines = winResult.stdout.trim().split("\n").filter(Boolean);
        // `ver` outputs e.g. "Microsoft Windows [Version 10.0.22631.4890]"
        const verLine = lines[0] || "";
        const hostname = lines[1]?.trim() || "Desktop";
        const versionMatch = verLine.match(/\[Version\s+([\d.]+)\]/i);
        const archResult = await invoke<{
          stdout: string;
          stderr: string;
          exit_code: number;
        }>("execute_command", {
          command: "echo %PROCESSOR_ARCHITECTURE%",
          timeoutMs: 5000,
        });
        const arch =
          archResult.exit_code === 0
            ? archResult.stdout.trim().toLowerCase()
            : "unknown";
        return {
          platform: "win32",
          release: versionMatch?.[1] || "unknown",
          arch: arch === "amd64" ? "x64" : arch,
          hostname,
        };
      }
    } catch (error) {
      console.warn("[DesktopSandboxBridge] Failed to get OS info:", error);
    }
    return undefined;
  }

  private async handleCommand(command: CommandMessage): Promise<void> {
    const { commandId } = command;
    this.activeCommands.add(commandId);
    const commandStartedAt = Date.now();
    const recoveryState: DesktopStreamPublishRecoveryState = {
      failureReported: false,
      recoveryReported: false,
      exhaustionReported: false,
      observedChunks: 0,
      publishedChunks: 0,
      exhaustedChunks: 0,
      terminalChunkObserved: null,
      terminalChunkPublished: false,
    };

    try {
      const { invoke, Channel } = await import("@tauri-apps/api/core");

      const channel = new Channel<StreamChunk>();
      const recoveryDeadlineAt =
        Date.now() +
        (command.timeout ?? 30_000) +
        DESKTOP_STREAM_RECOVERY_DEADLINE_BUFFER_MS;
      let nextSequence = 0;
      let streamPublishTail: Promise<void> = Promise.resolve();

      channel.onmessage = (chunk) => {
        if (!shouldForwardStreamChunk(chunk)) return;

        const sequence = nextSequence++;
        recoveryState.observedChunks += 1;
        if (chunk.type === "exit" || chunk.type === "error") {
          recoveryState.terminalChunkObserved = chunk.type;
        }
        const operation = streamPublishTail.then(async () => {
          try {
            await this.forwardChunkWithRetry(
              commandId,
              chunk,
              sequence,
              recoveryState,
              recoveryDeadlineAt,
            );
          } catch (error) {
            // Tauri does not await Channel callbacks. Exhausted known
            // transients are already reported above, so keep them from
            // becoming one unhandled rejection per subsequent stream chunk.
            // Unknown failures are logged before reaching this catch and
            // remain rejected for callers that directly await this operation.
            if (!classifyDesktopStreamPublishFailure(error)) throw error;
          }
        });
        streamPublishTail = operation.catch(() => undefined);
        return operation;
      };

      await invoke("execute_stream_command", {
        commandId,
        command: command.command,
        cwd: command.cwd,
        env: command.env,
        timeoutMs: command.timeout ?? 30000,
        onEvent: channel,
      });
      await streamPublishTail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        "[desktop-bridge]",
        JSON.stringify({
          event: "desktop_stream_command_failed",
          service: "desktop_bridge",
          command_id: commandId,
          message,
        }),
      );
      await this.publishResult({
        type: "error",
        commandId,
        message,
      });
    } finally {
      this.reportDesktopStreamCommandSettlement(
        commandId,
        recoveryState,
        Date.now() - commandStartedAt,
      );
      this.activeCommands.delete(commandId);
    }
  }

  private reportDesktopStreamCommandSettlement(
    commandId: string,
    recoveryState: DesktopStreamPublishRecoveryState,
    durationMs: number,
  ): void {
    if (!recoveryState.failureReported) return;

    const outcome =
      recoveryState.exhaustedChunks > 0
        ? "incomplete"
        : recoveryState.publishedChunks === recoveryState.observedChunks
          ? "recovered"
          : "interrupted";
    const properties = {
      connectionId: this.connectionId,
      commandId,
      outcome,
      observedChunks: recoveryState.observedChunks,
      publishedChunks: recoveryState.publishedChunks,
      exhaustedChunks: recoveryState.exhaustedChunks,
      terminalChunkObserved: recoveryState.terminalChunkObserved,
      terminalChunkPublished: recoveryState.terminalChunkPublished,
      sequenceComplete:
        recoveryState.observedChunks === recoveryState.publishedChunks,
      durationMs,
    };
    const log = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: outcome === "recovered" ? "info" : "error",
      event: "desktop_stream_command_settled",
      service: "desktop_bridge",
      environment: process.env.NODE_ENV ?? "unknown",
      request_id: commandId,
      connection_id: this.connectionId,
      command_id: commandId,
      outcome,
      observed_chunks: recoveryState.observedChunks,
      published_chunks: recoveryState.publishedChunks,
      exhausted_chunks: recoveryState.exhaustedChunks,
      terminal_chunk_observed: recoveryState.terminalChunkObserved,
      terminal_chunk_published: recoveryState.terminalChunkPublished,
      sequence_complete:
        recoveryState.observedChunks === recoveryState.publishedChunks,
      duration_ms: durationMs,
    });

    if (outcome === "recovered") {
      console.info(log);
    } else {
      console.error(log);
    }
    captureAuthenticatedEvent("desktop_stream_command_settled", properties);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async publishFileError(
    requestId: string,
    error: unknown,
  ): Promise<void> {
    await this.publishResult({
      type: "file_error",
      requestId,
      message: this.getErrorMessage(error),
    });
  }

  private async callLocalFileServer<T>(
    route: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ port: number; token: string }>(
      "get_cmd_server_info",
    );
    if (!info.port || !info.token) {
      throw new Error("Desktop file server is not ready");
    }

    const response = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${info.token}`,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        typeof payload?.error === "string"
          ? payload.error
          : `Desktop file server request failed: ${response.status}`,
      );
    }
    return payload as T;
  }

  private countLines(content: string): number {
    if (content.length === 0) return 0;
    return content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;
  }

  private normalizeReadPayload(
    path: string,
    payload: unknown,
    range?: [number, number],
  ): {
    path: string;
    sizeBytes: number;
    totalLines: number;
    content?: string;
    startLine?: number;
    tooLarge?: boolean;
    truncated?: boolean;
  } {
    const data =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    const content = typeof data.content === "string" ? data.content : undefined;

    if (typeof data.sizeBytes === "number") {
      return {
        path: typeof data.path === "string" ? data.path : path,
        sizeBytes: data.sizeBytes,
        totalLines:
          typeof data.totalLines === "number"
            ? data.totalLines
            : content !== undefined
              ? this.countLines(content)
              : 0,
        ...(content !== undefined ? { content } : {}),
        ...(typeof data.startLine === "number"
          ? { startLine: data.startLine }
          : range
            ? { startLine: range[0] }
            : {}),
        ...(data.tooLarge === true ? { tooLarge: true } : {}),
        ...(data.truncated === true ? { truncated: true } : {}),
      };
    }

    if (content === undefined) {
      throw new Error("Desktop file server returned an invalid read payload");
    }

    const lines = content.split("\n");
    const selectedContent = range
      ? lines
          .slice(range[0] - 1, range[1] === -1 ? undefined : range[1])
          .join("\n")
      : content;

    return {
      path,
      sizeBytes: new TextEncoder().encode(content).byteLength,
      totalLines: this.countLines(content),
      content: selectedContent,
      startLine: range?.[0] ?? 1,
    };
  }

  private async handleFileStat(message: FileStatMessage): Promise<void> {
    const { requestId, path } = message;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const metadata = await invoke<{ path: string; size: number }>(
        "get_local_file_metadata",
        { path },
      );
      await this.publishResult({
        type: "file_stat_result",
        requestId,
        kind: "file",
        path: metadata.path,
        sizeBytes: metadata.size,
      });
    } catch (error) {
      const msg = this.getErrorMessage(error);
      if (msg.includes("Selected path is not a file")) {
        await this.publishResult({
          type: "file_stat_result",
          requestId,
          kind: "not_file",
          path,
        });
        return;
      }
      if (msg.includes("Metadata error")) {
        await this.publishResult({
          type: "file_stat_result",
          requestId,
          kind: "missing",
          path,
        });
        return;
      }
      await this.publishFileError(requestId, error);
    }
  }

  private async handleFileRead(message: FileReadMessage): Promise<void> {
    const { requestId, path, range, maxFullBytes, maxResultBytes } = message;
    try {
      const payload = await this.callLocalFileServer<unknown>("/files/read", {
        path,
        range_start: range?.[0],
        range_end: range?.[1],
        max_full_bytes: maxFullBytes,
        max_result_bytes: maxResultBytes,
      });
      await this.publishResult({
        type: "file_read_result",
        requestId,
        ...this.normalizeReadPayload(path, payload, range),
      });
    } catch (error) {
      await this.publishFileError(requestId, error);
    }
  }

  private async handleFileWrite(message: FileWriteMessage): Promise<void> {
    const { requestId, path, content, isBase64, allowedRoot } = message;
    try {
      await this.callLocalFileServer("/files/write", {
        path,
        content,
        is_base64: Boolean(isBase64),
        allowed_root: allowedRoot,
      });
      await this.publishResult({ type: "file_ok", requestId });
    } catch (error) {
      await this.publishFileError(requestId, error);
    }
  }

  private async handleFileAppend(message: FileAppendMessage): Promise<void> {
    const { requestId, path, content, isBase64, allowedRoot } = message;
    try {
      await this.callLocalFileServer("/files/append", {
        path,
        content,
        is_base64: Boolean(isBase64),
        allowed_root: allowedRoot,
      });
      await this.publishResult({ type: "file_ok", requestId });
    } catch (error) {
      await this.publishFileError(requestId, error);
    }
  }

  private async handleFileRemove(message: FileRemoveMessage): Promise<void> {
    const { requestId, path } = message;
    try {
      await this.callLocalFileServer("/files/remove", { path });
      await this.publishResult({ type: "file_ok", requestId });
    } catch (error) {
      await this.publishFileError(requestId, error);
    }
  }

  private async handleFileList(message: FileListMessage): Promise<void> {
    const { requestId, path } = message;
    try {
      const entries = await this.callLocalFileServer<Array<{ name: string }>>(
        "/files/list",
        { path },
      );
      await this.publishResult({
        type: "file_list_result",
        requestId,
        entries,
      });
    } catch (error) {
      await this.publishFileError(requestId, error);
    }
  }

  private async handleCommandCancel(
    command: CommandCancelMessage,
  ): Promise<void> {
    let canceled = false;
    if (this.activeCommands.has(command.commandId)) {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        canceled = await invoke<boolean>("cancel_stream_command", {
          commandId: command.commandId,
        });
      } catch (error) {
        console.error(
          "[desktop-bridge]",
          JSON.stringify({
            event: "desktop_stream_command_cancel_failed",
            service: "desktop_bridge",
            command_id: command.commandId,
            error_name: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
    }

    await this.publishResult({
      type: "command_cancel_result",
      commandId: command.commandId,
      canceled,
    });
  }

  private async forwardChunk(
    commandId: string,
    chunk: StreamChunk,
    sequence?: number,
  ): Promise<void> {
    const sequenceField = sequence === undefined ? {} : { sequence };
    switch (chunk.type) {
      case "stdout":
        if (chunk.data) {
          await this.publishResult({
            type: "stdout",
            commandId,
            data: chunk.data,
            ...sequenceField,
          });
        }
        break;
      case "stderr":
        if (chunk.data) {
          await this.publishResult({
            type: "stderr",
            commandId,
            data: chunk.data,
            ...sequenceField,
          });
        }
        break;
      case "exit":
        if (chunk.exitCode === undefined) {
          console.warn(
            "[desktop-bridge]",
            JSON.stringify({
              event: "desktop_stream_exit_code_missing",
              service: "desktop_bridge",
              command_id: commandId,
            }),
          );
        }
        await this.publishResult({
          type: "exit",
          commandId,
          exitCode: chunk.exitCode ?? -1,
          ...sequenceField,
        });
        break;
      case "error":
        console.error(
          "[desktop-bridge]",
          JSON.stringify({
            event: "desktop_stream_error_chunk_received",
            service: "desktop_bridge",
            command_id: commandId,
            message: chunk.message || "Unknown error",
          }),
        );
        await this.publishResult({
          type: "error",
          commandId,
          message: chunk.message || "Unknown error",
          ...sequenceField,
        });
        break;
    }
  }

  private async forwardChunkWithRetry(
    commandId: string,
    chunk: StreamChunk,
    sequence: number,
    recoveryState: DesktopStreamPublishRecoveryState,
    recoveryDeadlineAt: number,
  ): Promise<void> {
    let firstFailureAt: number | null = null;
    let firstFailureReason: DesktopStreamPublishFailureReason | null = null;

    for (
      let attempt = 1;
      attempt <= DESKTOP_STREAM_PUBLISH_MAX_ATTEMPTS;
      attempt++
    ) {
      if (this.isStoppingOrStopped) return;

      try {
        await this.forwardChunk(commandId, chunk, sequence);
        recoveryState.publishedChunks += 1;
        if (chunk.type === "exit" || chunk.type === "error") {
          recoveryState.terminalChunkPublished = true;
        }
        if (
          firstFailureAt !== null &&
          firstFailureReason !== null &&
          !recoveryState.recoveryReported
        ) {
          recoveryState.recoveryReported = true;
          const recoveryLatencyMs = Date.now() - firstFailureAt;
          console.info(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "info",
              event: "desktop_stream_publish_recovered",
              service: "desktop_bridge",
              environment: process.env.NODE_ENV ?? "unknown",
              request_id: commandId,
              connection_id: this.connectionId,
              command_id: commandId,
              chunk_type: chunk.type,
              reason: firstFailureReason,
              attempts: attempt,
              recovery_latency_ms: recoveryLatencyMs,
            }),
          );
          captureAuthenticatedEvent("desktop_stream_publish_recovered", {
            connectionId: this.connectionId,
            commandId,
            chunkType: chunk.type,
            reason: firstFailureReason,
            attempts: attempt,
            recoveryLatencyMs,
          });
        }
        return;
      } catch (error) {
        const reason = classifyDesktopStreamPublishFailure(error);
        if (!reason) throw error;

        firstFailureAt ??= Date.now();
        firstFailureReason ??= reason;

        if (!recoveryState.failureReported) {
          recoveryState.failureReported = true;
          console.warn(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "warn",
              event: "desktop_stream_publish_failed",
              service: "desktop_bridge",
              environment: process.env.NODE_ENV ?? "unknown",
              request_id: commandId,
              connection_id: this.connectionId,
              command_id: commandId,
              chunk_type: chunk.type,
              reason,
              attempt,
              max_attempts: DESKTOP_STREAM_PUBLISH_MAX_ATTEMPTS,
            }),
          );
          captureAuthenticatedEvent("desktop_stream_publish_failed", {
            connectionId: this.connectionId,
            commandId,
            chunkType: chunk.type,
            reason,
            attempt,
            maxAttempts: DESKTOP_STREAM_PUBLISH_MAX_ATTEMPTS,
          });
        }

        if (
          attempt < DESKTOP_STREAM_PUBLISH_MAX_ATTEMPTS &&
          Date.now() < recoveryDeadlineAt
        ) {
          await this.waitForRelayReady(attempt, recoveryDeadlineAt);
          if (this.isStoppingOrStopped) return;
          if (Date.now() < recoveryDeadlineAt) continue;
        }

        recoveryState.exhaustedChunks += 1;
        if (!recoveryState.exhaustionReported) {
          recoveryState.exhaustionReported = true;
          const recoveryLatencyMs = Date.now() - firstFailureAt;
          const exhaustionReason =
            Date.now() >= recoveryDeadlineAt ? "deadline" : "attempts";
          console.error(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: "error",
              event: "desktop_stream_publish_recovery_exhausted",
              service: "desktop_bridge",
              environment: process.env.NODE_ENV ?? "unknown",
              request_id: commandId,
              connection_id: this.connectionId,
              command_id: commandId,
              chunk_type: chunk.type,
              reason: firstFailureReason,
              attempts: attempt,
              exhaustion_reason: exhaustionReason,
              recovery_latency_ms: recoveryLatencyMs,
            }),
          );
          captureAuthenticatedEvent(
            "desktop_stream_publish_recovery_exhausted",
            {
              connectionId: this.connectionId,
              commandId,
              chunkType: chunk.type,
              reason: firstFailureReason,
              attempts: attempt,
              exhaustionReason,
              recoveryLatencyMs,
            },
          );
        }
        throw error;
      }
    }
  }

  private async waitForRelayReady(
    attempt: number,
    recoveryDeadlineAt: number,
  ): Promise<void> {
    const remainingBeforeBackoffMs = Math.max(
      0,
      recoveryDeadlineAt - Date.now(),
    );
    const backoffMs = Math.min(
      DESKTOP_STREAM_PUBLISH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      remainingBeforeBackoffMs,
    );
    if (backoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    if (this.isStoppingOrStopped) return;

    const readyTimeoutMs = Math.min(
      DESKTOP_STREAM_RECONNECT_WAIT_MS,
      Math.max(0, recoveryDeadlineAt - Date.now()),
    );
    if (readyTimeoutMs <= 0) return;

    const readyChecks = [
      this.client?.ready(readyTimeoutMs),
      this.subscription?.ready(readyTimeoutMs),
    ].filter((promise): promise is Promise<void> => Boolean(promise));
    await Promise.allSettled(readyChecks);
  }

  private async publishResult(message: SandboxMessage): Promise<void> {
    if (this.isStoppingOrStopped) return;
    if (!this.publishQueue) {
      throw new Error(
        "[DesktopSandboxBridge] Cannot publish result: subscription is null",
      );
    }
    try {
      await this.publishQueue.publish(
        message as unknown as Record<string, unknown>,
      );
    } catch (error) {
      if (!classifyDesktopStreamPublishFailure(error)) {
        console.error(
          "[DesktopSandboxBridge] Failed to publish result:",
          error,
        );
      }
      throw error;
    }
  }

  private async handlePtyCreate(msg: PtyCreateMessage): Promise<void> {
    const { sessionId, command, cols, rows, cwd, env } = msg;

    try {
      const { invoke, Channel } = await import("@tauri-apps/api/core");

      const channel = new Channel<string>();
      // Serialize publishes: Rust now flushes per-read (could be per-char on
      // interactive echo). Firing 12 unawaited publishes at the Centrifuge
      // client caused reordered arrival at the server, producing garbled
      // terminal rendering. Chain through this promise to preserve order.
      let publishQueue: Promise<void> = Promise.resolve();
      const enqueuePublish = (msg: SandboxMessage) => {
        publishQueue = publishQueue.then(() =>
          this.publishResult(msg).catch((err) => {
            console.error(
              "[DesktopSandboxBridge] Failed to publish",
              msg.type,
              err,
            );
          }),
        );
      };

      // Debounce buffer for PTY output - accumulate chunks before publishing
      // to reduce RPC overhead from node-pty's per-character callbacks.
      const PTY_DEBOUNCE_MS = 8;
      let ptyBuffer = "";
      let ptyDebounceTimer: ReturnType<typeof setTimeout> | null = null;

      const flushPtyBuffer = () => {
        if (ptyBuffer) {
          enqueuePublish({
            type: "pty_data",
            sessionId,
            data: ptyBuffer,
          });
          ptyBuffer = "";
        }
        ptyDebounceTimer = null;
      };

      channel.onmessage = (chunk: string) => {
        // The Tauri PTY backend sends raw output strings and a final JSON
        // exit sentinel: {"type":"exit","exitCode":N,"sessionId":"..."}.
        // We require ALL three sentinel fields before treating a chunk as an
        // exit — otherwise a program that legitimately prints
        // `{"type":"exit",...}` would be swallowed and never reach pty_data.
        try {
          const parsed = JSON.parse(chunk) as {
            type?: unknown;
            exitCode?: unknown;
            sessionId?: unknown;
          };
          if (
            parsed.type === "exit" &&
            parsed.sessionId === sessionId &&
            typeof parsed.exitCode === "number"
          ) {
            // Flush any buffered data before exit
            if (ptyDebounceTimer) {
              clearTimeout(ptyDebounceTimer);
              flushPtyBuffer();
            }
            enqueuePublish({
              type: "pty_exit",
              sessionId,
              exitCode: parsed.exitCode,
            });
            return;
          }
        } catch {
          // Not JSON — regular PTY output
        }

        // Accumulate chunks and debounce publish
        ptyBuffer += chunk;
        if (!ptyDebounceTimer) {
          ptyDebounceTimer = setTimeout(flushPtyBuffer, PTY_DEBOUNCE_MS);
        }
      };

      const result = (await invoke("execute_pty_create", {
        sessionId,
        command,
        cols: cols ?? DEFAULT_PTY_COLS,
        rows: rows ?? DEFAULT_PTY_ROWS,
        cwd,
        env,
        onData: channel,
      })) as { pid: number | null; session_id: string };

      // Rust's PtyCreateResult.pid is Option<u32> — serializes to `null` when
      // the child didn't expose a pid. Reject that case explicitly so the
      // server doesn't get a pty_ready with a bogus pid cast.
      if (typeof result.pid !== "number") {
        throw new Error(
          `execute_pty_create returned no pid for sessionId=${sessionId}`,
        );
      }

      // Route pty_ready through the same publishQueue that pty_data/pty_exit
      // use. Direct publishResult can arrive AFTER already-queued pty_data
      // chunks on fast-starting commands — the server-side adapter would then
      // see pty_data with no matching pty_ready and drop the output.
      enqueuePublish({
        type: "pty_ready",
        sessionId,
        pid: result.pid,
      });
    } catch (err) {
      // The failure path never reaches the channel.onmessage listener, so
      // no pty_data was queued for this session — publishResult direct is
      // safe here. (enqueuePublish is also out of scope in this catch.)
      await this.publishResult({
        type: "pty_error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handlePtyInput(msg: PtyInputMessage): Promise<void> {
    const { sessionId, data } = msg;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("execute_pty_input", { sessionId, data });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err) || "unknown pty_input error";
      console.error("[desktop-bridge] execute_pty_input failed:", err);
      await this.publishResult({
        type: "pty_error",
        sessionId,
        message,
      });
    }
  }

  private async handlePtyResize(msg: PtyResizeMessage): Promise<void> {
    const { sessionId, cols, rows } = msg;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("execute_pty_resize", { sessionId, cols, rows });
    } catch (err) {
      console.warn(
        `[DesktopSandboxBridge] pty_resize failed sessionId=${sessionId}:`,
        err,
      );
    }
  }

  private async handlePtyKill(msg: PtyKillMessage): Promise<void> {
    const { sessionId } = msg;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("execute_pty_kill", { sessionId });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err) || "unknown pty_kill error";
      console.error("[desktop-bridge] execute_pty_kill failed:", err);
      // Surface the failure to the server so the adapter's failTransport()
      // path can resolve `exited` — otherwise awaiters of handle.exited
      // would only escape via the 1500ms kill-timeout fallback.
      await this.publishResult({
        type: "pty_error",
        sessionId,
        message,
      });
    }
  }

  async stop(): Promise<void> {
    this.isStoppingOrStopped = true;
    this.publishQueue = null;
    if (this.connectionId) {
      try {
        await this.config.disconnectDesktop({
          connectionId: this.connectionId,
        });
      } catch (error) {
        console.warn("[DesktopSandboxBridge] Failed to disconnect:", error);
      }
    }

    if (this.subscription) {
      try {
        this.subscription.unsubscribe();
        this.subscription.removeAllListeners();
      } catch (error) {
        console.warn("[DesktopSandboxBridge] Failed to unsubscribe:", error);
      }
      this.subscription = null;
    }

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (error) {
        console.warn(
          "[DesktopSandboxBridge] Failed to disconnect client:",
          error,
        );
      }
      this.client = null;
    }

    this.connectionId = null;
  }
}
