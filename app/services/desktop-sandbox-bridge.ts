import { Centrifuge, type Subscription } from "centrifuge";
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
        | null;
      msSinceDisconnected: number | null;
      msSinceLastHeartbeat: number | null;
      msSinceCreated: number | null;
    };

interface StreamChunk {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number;
  message?: string;
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
}

export class DesktopSandboxBridge {
  private client: Centrifuge | null = null;
  private subscription: Subscription | null = null;
  private connectionId: string | null = null;
  private activeCommands = new Set<string>();
  private config: DesktopBridgeConfig;

  constructor(config: DesktopBridgeConfig) {
    this.config = config;
  }

  getConnectionId(): string | null {
    return this.connectionId;
  }

  private terminateClient(): void {
    const client = this.client;
    this.client = null;
    this.connectionId = null;
    try {
      client?.disconnect();
    } catch {
      // already in a terminal state
    }
  }

  async start(): Promise<string> {
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
            this.terminateClient();
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
        this.terminateClient();
        throw new Error(`Centrifugo refresh aborted: ${result.reason}`);
      },
    });

    const userId = this.extractUserIdFromToken(centrifugoToken);
    const channel = sandboxConnectionChannel(userId, connectionId);
    this.subscription = this.client.newSubscription(channel);

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

    try {
      const { invoke, Channel } = await import("@tauri-apps/api/core");

      const channel = new Channel<StreamChunk>();
      channel.onmessage = async (chunk) => {
        await this.forwardChunk(commandId, chunk);
      };

      await invoke("execute_stream_command", {
        commandId,
        command: command.command,
        cwd: command.cwd,
        env: command.env,
        timeoutMs: command.timeout ?? 30000,
        onEvent: channel,
      });
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
      this.activeCommands.delete(commandId);
    }
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
    const { requestId, path, content, isBase64 } = message;
    try {
      await this.callLocalFileServer("/files/write", {
        path,
        content,
        is_base64: Boolean(isBase64),
      });
      await this.publishResult({ type: "file_ok", requestId });
    } catch (error) {
      await this.publishFileError(requestId, error);
    }
  }

  private async handleFileAppend(message: FileAppendMessage): Promise<void> {
    const { requestId, path, content } = message;
    try {
      await this.callLocalFileServer("/files/append", {
        path,
        content,
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
    if (!this.activeCommands.has(command.commandId)) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("cancel_stream_command", {
      commandId: command.commandId,
    });
  }

  private async forwardChunk(
    commandId: string,
    chunk: StreamChunk,
  ): Promise<void> {
    switch (chunk.type) {
      case "stdout":
        if (chunk.data) {
          await this.publishResult({
            type: "stdout",
            commandId,
            data: chunk.data,
          });
        }
        break;
      case "stderr":
        if (chunk.data) {
          await this.publishResult({
            type: "stderr",
            commandId,
            data: chunk.data,
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
        });
        break;
    }
  }

  private async publishResult(message: SandboxMessage): Promise<void> {
    if (!this.subscription) {
      throw new Error(
        "[DesktopSandboxBridge] Cannot publish result: subscription is null",
      );
    }
    try {
      await this.subscription.publish(message);
    } catch (error) {
      console.error("[DesktopSandboxBridge] Failed to publish result:", error);
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
