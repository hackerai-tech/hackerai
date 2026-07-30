import { EventEmitter } from "events";
import { Centrifuge, type Subscription } from "centrifuge";

import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import {
  sandboxConnectionChannel,
  type CommandResponseMessage,
  type CommandMessage,
  type FileRequestMessage,
  type FileResponseMessage,
  type FileOkMessage,
  type FileStatResultMessage,
  type FileReadResultMessage,
  type FileListResultMessage,
} from "@/lib/centrifugo/types";
import { presenceHasConnectionId } from "@/lib/centrifugo/presence";
import { getPlatformDisplayName, escapeShellValue } from "./platform-utils";
import type { ConnectionInfo } from "./sandbox-types";
import { validateDownloadUrl } from "./path-validation";

const VALID_MESSAGE_TYPES = new Set([
  "command",
  "command_cancel",
  "command_cancel_result",
  "stdout",
  "stderr",
  "exit",
  "error",
]);

const IGNORED_MESSAGE_TYPES = new Set([
  "file_stat",
  "file_read",
  "file_write",
  "file_append",
  "file_remove",
  "file_list",
  "file_ok",
  "file_error",
  "file_stat_result",
  "file_read_result",
  "file_list_result",
  "pty_create",
  "pty_input",
  "pty_resize",
  "pty_kill",
  "pty_ready",
  "pty_data",
  "pty_exit",
  "pty_error",
]);

const FILE_DOWNLOAD_TIMEOUT_MS = 120000;
const SETUP_COMMAND_TIMEOUT_MS = 30000;
const SETUP_COMMAND_MAX_ATTEMPTS = 2;
const SETUP_COMMAND_RETRY_DELAY_MS = 500;
const COMMAND_CANCEL_ACK_TIMEOUT_MS = 5000;
const TRANSIENT_COMMAND_TIMEOUT_ERROR_PATTERN =
  /\b(?:deadline_exceeded|operation timed out:.*\btimeoutMs\b|exceeding ['"]?timeoutMs['"]?|Command timeout after \d+ms)\b/i;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const getPathBasename = (path: string): string | undefined => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1];
};

const redactTransferDetails = (
  value: string,
  url: string,
  paths: string[],
): string => {
  let redacted = value;
  const urlVariants = [url];
  let urlPathname: string | undefined;
  try {
    const parsed = new URL(url);
    urlVariants.push(`${parsed.origin}${parsed.pathname}`);
    if (parsed.pathname && parsed.pathname !== "/") {
      urlPathname = parsed.pathname;
      urlVariants.push(parsed.pathname);
    }
  } catch {
    urlVariants.push(url.split("?")[0]);
  }
  for (const urlVariant of new Set(
    urlVariants.sort((left, right) => right.length - left.length),
  )) {
    redacted = redacted.split(urlVariant).join("[redacted-url]");
  }
  const pathVariants = paths.flatMap((path) => [path, getPathBasename(path)]);
  for (const path of new Set(
    pathVariants
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.length - left.length),
  )) {
    redacted = redacted.split(path).join("[redacted-destination-path]");
  }
  const sourceBasename = urlPathname ? getPathBasename(urlPathname) : undefined;
  if (sourceBasename) {
    redacted = redacted.split(sourceBasename).join("[redacted-url]");
  }
  return redacted;
};

const isTransientCommandTimeoutError = (error: unknown): boolean =>
  TRANSIENT_COMMAND_TIMEOUT_ERROR_PATTERN.test(getErrorMessage(error));

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const serializePromptText = (value: string): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

export function parseSandboxMessage(
  data: unknown,
): CommandResponseMessage | null {
  if (typeof data !== "object" || data === null) {
    console.warn("Invalid sandbox message: not an object", data);
    return null;
  }

  const msg = data as Record<string, unknown>;

  if (typeof msg.type === "string" && IGNORED_MESSAGE_TYPES.has(msg.type)) {
    return null;
  }

  if (typeof msg.type !== "string" || !VALID_MESSAGE_TYPES.has(msg.type)) {
    console.warn("Invalid sandbox message: unknown type", msg.type);
    return null;
  }

  if (typeof msg.commandId !== "string") {
    console.warn("Invalid sandbox message: commandId is not a string", msg);
    return null;
  }

  switch (msg.type) {
    case "exit":
      if (typeof msg.exitCode !== "number") {
        console.warn("Invalid exit message: missing exitCode", msg);
        return null;
      }
      break;
    case "stdout":
    case "stderr":
      if (typeof msg.data !== "string") {
        console.warn(`Invalid ${msg.type} message: missing data`, msg);
        return null;
      }
      break;
    case "error":
      if (typeof msg.message !== "string") {
        console.warn("Invalid error message: missing message field", msg);
        return null;
      }
      break;
    case "command":
      if (typeof msg.command !== "string") {
        console.warn("Invalid command message: missing command", msg);
        return null;
      }
      break;
    case "command_cancel":
      break;
    case "command_cancel_result":
      if (typeof msg.canceled !== "boolean") {
        console.warn(
          "Invalid command_cancel_result message: missing canceled",
          msg,
        );
        return null;
      }
      break;
  }

  return data as CommandResponseMessage;
}

const VALID_FILE_RESPONSE_TYPES = new Set([
  "file_ok",
  "file_error",
  "file_stat_result",
  "file_read_result",
  "file_list_result",
]);

function parseFileResponseMessage(data: unknown): FileResponseMessage | null {
  if (typeof data !== "object" || data === null) return null;

  const msg = data as Record<string, unknown>;
  if (
    typeof msg.type !== "string" ||
    !VALID_FILE_RESPONSE_TYPES.has(msg.type)
  ) {
    return null;
  }
  if (typeof msg.requestId !== "string") return null;

  switch (msg.type) {
    case "file_error":
      return typeof msg.message === "string"
        ? (data as FileResponseMessage)
        : null;
    case "file_stat_result":
      return (msg.kind === "file" ||
        msg.kind === "missing" ||
        msg.kind === "not_file") &&
        typeof msg.path === "string"
        ? (data as FileResponseMessage)
        : null;
    case "file_read_result":
      return typeof msg.path === "string" &&
        typeof msg.sizeBytes === "number" &&
        typeof msg.totalLines === "number"
        ? (data as FileResponseMessage)
        : null;
    case "file_list_result":
      return Array.isArray(msg.entries) ? (data as FileResponseMessage) : null;
    case "file_ok":
      return data as FileResponseMessage;
    default:
      return null;
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid?: number;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;
type FileRequestInput = DistributiveOmit<
  FileRequestMessage,
  "requestId" | "targetConnectionId"
>;

export interface CentrifugoConfig {
  wsUrl: string;
  tokenSecret: string;
}

/**
 * Centrifugo-based sandbox that implements E2B-compatible interface.
 * Uses Centrifugo pub/sub for real-time command streaming.
 */
export class CentrifugoSandbox extends EventEmitter {
  readonly sandboxKind = "centrifugo" as const;
  private activeClients: Centrifuge[] = [];

  constructor(
    private userId: string,
    private connectionInfo: ConnectionInfo,
    private config: CentrifugoConfig,
    private workingDirectory?: string,
  ) {
    super();
  }

  getConnectionId(): string {
    return this.connectionInfo.connectionId;
  }

  getConnectionName(): string {
    return this.connectionInfo.name;
  }

  getWorkingDirectory(): string | undefined {
    return this.workingDirectory;
  }

  supportsPty(): boolean {
    return this.connectionInfo.capabilities?.pty !== false;
  }

  supportsNativeFileRelay(): boolean {
    return (
      this.connectionInfo.isDesktop === true &&
      this.connectionInfo.capabilities?.files === true
    );
  }

  getUserId(): string {
    return this.userId;
  }

  getWsUrl(): string {
    return this.config.wsUrl;
  }

  /**
   * Mint a short-lived Centrifugo JWT for this sandbox's user. Keeps the
   * signing secret encapsulated — callers never see `tokenSecret`.
   */
  async issueToken(ttlSeconds: number): Promise<string> {
    return generateCentrifugoToken(this.userId, ttlSeconds);
  }

  /**
   * Get sandbox context for AI based on mode
   */
  getSandboxContext(): string | null {
    const { capabilities, osInfo } = this.connectionInfo;

    if (osInfo) {
      const { platform, arch, release, hostname } = osInfo;
      const platformName = getPlatformDisplayName(platform);

      const shellInfo =
        platform === "win32"
          ? `Commands are invoked via cmd.exe /C (NOT PowerShell). Use cmd.exe syntax — do not use PowerShell cmdlets or syntax like Invoke-WebRequest, $env:, or backtick escapes.`
          : `Commands are invoked via /bin/bash -c.`;
      const agentBrowserProbe =
        platform === "win32"
          ? "where agent-browser && agent-browser --version"
          : "command -v agent-browser && agent-browser --version";
      const projectContext = this.workingDirectory
        ? `\nActive project folder: ${serializePromptText(this.workingDirectory)}\nRun commands from this folder by default and resolve relative file paths from it.`
        : "";
      return `You are executing commands on ${platformName} ${release} (${arch}) in DANGEROUS MODE.
${shellInfo}
Commands run directly on the host OS "${hostname}" without Docker isolation. Be careful with:
- File system operations (no sandbox protection)
- Network operations (direct access to host network)
- Process management (can affect host system)${projectContext}

Browser automation is host-dependent on this connection. Chromium and agent-browser are preinstalled only in the Cloud sandbox. If browser automation is needed, first check with \`${agentBrowserProbe}\`. Use agent-browser only if it is already installed, and do not install browser automation packages on the host unless the user explicitly asks.${capabilities?.pty === false ? "\n\nInteractive PTY sessions are not available on this connection. Use non-interactive terminal commands only." : ""}`;
    }

    return null;
  }

  /**
   * Get OS context for AI when in dangerous mode (alias for backwards compatibility)
   */
  getOsContext(): string | null {
    return this.getSandboxContext();
  }

  private async runFileRequest<T extends FileResponseMessage>(
    input: FileRequestInput,
    expectedTypes: Set<string>,
    timeoutMs = 30000,
  ): Promise<T> {
    if (!this.supportsNativeFileRelay()) {
      throw new Error("Native desktop file relay is not available.");
    }

    const requestId = crypto.randomUUID();
    const channel = sandboxConnectionChannel(
      this.userId,
      this.connectionInfo.connectionId,
    );
    const tokenExpSeconds = Math.ceil(timeoutMs / 1000) + 30;
    const token = await generateCentrifugoToken(this.userId, tokenExpSeconds);
    const client = new Centrifuge(this.config.wsUrl, { token });
    this.activeClients.push(client);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timeoutId: NodeJS.Timeout | undefined;
      let subscription: Subscription | undefined;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        if (subscription) {
          try {
            subscription.unsubscribe();
            subscription.removeAllListeners();
          } catch {
            // Ignore cleanup errors.
          }
        }
        try {
          client.disconnect();
        } catch {
          // Ignore disconnect errors.
        }
        const idx = this.activeClients.indexOf(client);
        if (idx !== -1) {
          this.activeClients.splice(idx, 1);
        }
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      timeoutId = setTimeout(() => {
        fail(
          new Error(
            `Desktop file request timed out after ${timeoutMs}ms connectionId=${this.connectionInfo.connectionId}`,
          ),
        );
      }, timeoutMs + 5000);

      subscription = client.newSubscription(channel);
      subscription.on("publication", (ctx) => {
        if (settled) return;

        const message = parseFileResponseMessage(ctx.data);
        if (!message || message.requestId !== requestId) return;

        if (message.type === "file_error") {
          fail(new Error(message.message));
          return;
        }
        if (!expectedTypes.has(message.type)) {
          return;
        }

        settled = true;
        cleanup();
        resolve(message as T);
      });

      subscription.on("error", (ctx) => {
        fail(
          new Error(
            `Centrifugo file subscription error: ${ctx.error?.message ?? "unknown"}`,
          ),
        );
      });

      subscription.on("subscribed", () => {
        if (settled || !subscription) return;

        void (async () => {
          try {
            const presence = await subscription!.presence();
            if (
              !presenceHasConnectionId(
                presence,
                this.connectionInfo.connectionId,
              )
            ) {
              fail(
                new Error(
                  `Local sandbox connection ${this.connectionInfo.connectionId} is not subscribed to the file relay. Reconnect the Desktop app, wait until it is ready, then try again.`,
                ),
              );
              return;
            }
          } catch (error) {
            console.warn(
              "[local-file]",
              JSON.stringify({
                event: "local_file_presence_check_failed",
                service: "web",
                request_id: requestId,
                connection_id: this.connectionInfo.connectionId,
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          }

          if (settled || !subscription) return;
          const request = {
            ...input,
            path: this.resolveWorkingPath(input.path),
            requestId,
            targetConnectionId: this.connectionInfo.connectionId,
          } as FileRequestMessage;

          try {
            await subscription.publish(request);
          } catch (error) {
            fail(
              new Error(
                `Failed to publish desktop file request: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
          }
        })();
      });

      subscription.subscribe();
      client.connect();
    });
  }

  commands = {
    run: async (
      command: string,
      opts?: {
        envVars?: Record<string, string>;
        cwd?: string;
        timeoutMs?: number;
        background?: boolean;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
        displayName?: string;
        signal?: AbortSignal;
        onCancelReady?: (cancel: () => Promise<boolean>) => void;
      },
    ): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      pid?: number;
    }> => {
      const commandId = crypto.randomUUID();
      const timeout = opts?.timeoutMs ?? 30000;
      const channel = sandboxConnectionChannel(
        this.userId,
        this.connectionInfo.connectionId,
      );

      // Generate short-lived JWT for this subscription (30s + command timeout)
      const tokenExpSeconds = Math.ceil(timeout / 1000) + 30;
      const token = await generateCentrifugoToken(this.userId, tokenExpSeconds);

      // Create a centrifuge client for this command
      const client = new Centrifuge(this.config.wsUrl, {
        token,
      });
      this.activeClients.push(client);

      const result = await new Promise<CommandResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timeoutId: NodeJS.Timeout | undefined;
        let cancelAckTimeoutId: NodeJS.Timeout | undefined;
        let subscription: Subscription | undefined;
        let publishedCommand = false;
        let commandPublishInFlight = false;
        let cancelRequested = false;
        let cancelPublishStarted = false;
        let cancelTriggeredBySignal = false;
        let cancelAttemptPromise: Promise<boolean> | null = null;
        let resolveCancelAttempt: ((confirmed: boolean) => void) | null = null;

        const maxWaitTime = timeout + 5000; // Add 5s buffer for network

        // Timing diagnostics — track which phase we reached before timeout
        const t0 = Date.now();
        let tConnected = 0;
        let tSubscribed = 0;
        let tPublished = 0;
        let tFirstMessage = 0;

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          if (cancelAckTimeoutId) {
            clearTimeout(cancelAckTimeoutId);
            cancelAckTimeoutId = undefined;
          }
          if (subscription) {
            try {
              subscription.unsubscribe();
              subscription.removeAllListeners();
            } catch {
              // Ignore errors during cleanup
            }
          }
          try {
            client.disconnect();
          } catch {
            // Ignore errors during disconnect
          }
          const idx = this.activeClients.indexOf(client);
          if (idx !== -1) {
            this.activeClients.splice(idx, 1);
          }
          opts?.signal?.removeEventListener("abort", handleAbort);
        };

        const resolveCanceled = () => {
          if (settled) return;
          resolveCancelAttempt?.(true);
          resolveCancelAttempt = null;
          cancelAttemptPromise = null;
          settled = true;
          cleanup();
          resolve({
            stdout,
            stderr,
            exitCode: 130,
          });
        };

        const failCancellation = (message: string) => {
          if (cancelAckTimeoutId) {
            clearTimeout(cancelAckTimeoutId);
            cancelAckTimeoutId = undefined;
          }
          resolveCancelAttempt?.(false);
          resolveCancelAttempt = null;
          cancelAttemptPromise = null;
          cancelRequested = false;
          cancelPublishStarted = false;

          if (cancelTriggeredBySignal && !settled) {
            settled = true;
            cleanup();
            reject(new Error(message));
          }
        };

        const publishCancel = () => {
          if (settled) return;
          cancelRequested = true;
          if (!publishedCommand || !subscription) {
            if (commandPublishInFlight) return;
            resolveCanceled();
            return;
          }
          if (cancelPublishStarted) return;
          cancelPublishStarted = true;
          const attempt = cancelAttemptPromise;
          cancelAckTimeoutId = setTimeout(() => {
            if (cancelAttemptPromise === attempt) {
              failCancellation(
                "Local command cancellation was not acknowledged.",
              );
            }
          }, COMMAND_CANCEL_ACK_TIMEOUT_MS);

          subscription
            .publish({
              type: "command_cancel",
              commandId,
              targetConnectionId: this.connectionInfo.connectionId,
            })
            .catch(() => {
              if (cancelAttemptPromise === attempt) {
                failCancellation(
                  "Failed to publish local command cancellation.",
                );
              }
            });
        };

        const requestCancellation = (
          triggeredBySignal = false,
        ): Promise<boolean> => {
          cancelTriggeredBySignal ||= triggeredBySignal;
          if (settled) return Promise.resolve(true);
          if (cancelAttemptPromise) return cancelAttemptPromise;

          cancelAttemptPromise = new Promise<boolean>((resolveAttempt) => {
            resolveCancelAttempt = resolveAttempt;
          });
          publishCancel();
          return cancelAttemptPromise;
        };

        const handleAbort = () => {
          void requestCancellation(true);
        };

        opts?.onCancelReady?.(() => requestCancellation(false));

        if (opts?.signal?.aborted) {
          resolveCanceled();
          return;
        }
        opts?.signal?.addEventListener("abort", handleAbort, { once: true });

        // Set up timeout
        timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            const phases = [
              `connected: ${tConnected ? `${tConnected - t0}ms` : "no"}`,
              `subscribed: ${tSubscribed ? `${tSubscribed - t0}ms` : "no"}`,
              `published: ${tPublished ? `${tPublished - t0}ms` : "no"}`,
              `firstMsg: ${tFirstMessage ? `${tFirstMessage - t0}ms` : "no"}`,
            ].join(", ");
            reject(
              new Error(
                `Command timeout after ${maxWaitTime}ms [${phases}]` +
                  ` connectionId=${this.connectionInfo.connectionId}`,
              ),
            );
          }
        }, maxWaitTime);

        // Subscribe to the sandbox channel
        subscription = client.newSubscription(channel);

        subscription.on("publication", (ctx) => {
          if (settled) return;

          const message = parseSandboxMessage(ctx.data);
          if (!message) return;
          if (message.commandId !== commandId) return;
          if (message.type === "command" || message.type === "command_cancel") {
            return;
          }
          if (!tFirstMessage) tFirstMessage = Date.now();

          switch (message.type) {
            case "stdout":
              stdout += message.data;
              opts?.onStdout?.(message.data);
              break;
            case "stderr":
              stderr += message.data;
              opts?.onStderr?.(message.data);
              break;
            case "exit":
              if (cancelRequested) {
                resolveCanceled();
                break;
              }
              settled = true;
              cleanup();
              resolve({
                stdout,
                stderr,
                exitCode: message.exitCode,
                pid: message.pid,
              });
              break;
            case "command_cancel_result":
              if (!cancelRequested) break;
              if (message.canceled) {
                resolveCanceled();
              } else {
                failCancellation(
                  "Local command cancellation was not confirmed.",
                );
              }
              break;
            case "error":
              if (cancelRequested) {
                resolveCanceled();
                break;
              }
              console.warn(
                "[local-command]",
                JSON.stringify({
                  event: "local_command_error_received",
                  service: "web",
                  command_id: commandId,
                  connection_id: this.connectionInfo.connectionId,
                  stdout_length: stdout.length,
                  stderr_length: stderr.length,
                  message: message.message,
                }),
              );
              settled = true;
              cleanup();
              resolve({
                stdout,
                stderr: stderr
                  ? `${stderr}\n${message.message}`
                  : message.message,
                exitCode: -1,
              });
              break;
          }
        });

        subscription.on("error", (ctx) => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Centrifugo subscription error: ${ctx.error?.message ?? "unknown"}`,
              ),
            );
          }
        });

        // Wait for subscription to be fully established before publishing command.
        // "subscribed" fires after the server confirms the subscription,
        // ensuring we receive messages published to the channel.
        subscription.on("subscribed", () => {
          if (settled) return;
          tSubscribed = Date.now();

          void (async () => {
            try {
              const presence = await subscription!.presence();
              if (
                !presenceHasConnectionId(
                  presence,
                  this.connectionInfo.connectionId,
                )
              ) {
                if (settled) return;
                settled = true;
                cleanup();
                reject(
                  new Error(
                    `Local sandbox connection ${this.connectionInfo.connectionId} is not subscribed to the command relay. Reconnect the local runner or Desktop app, wait until it is ready, then try again.`,
                  ),
                );
                return;
              }
            } catch (error) {
              console.warn(
                "[local-command]",
                JSON.stringify({
                  event: "local_command_presence_check_failed",
                  service: "web",
                  command_id: commandId,
                  connection_id: this.connectionInfo.connectionId,
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
              );
            }

            if (settled) return;
            const commandMessage: CommandMessage = {
              type: "command",
              commandId,
              command,
              env: opts?.envVars,
              cwd: opts?.cwd ?? this.workingDirectory,
              timeout,
              background: opts?.background,
              displayName: opts?.displayName,
              targetConnectionId: this.connectionInfo.connectionId,
            };

            commandPublishInFlight = true;
            subscription!
              .publish(commandMessage)
              .then(() => {
                commandPublishInFlight = false;
                tPublished = Date.now();
                publishedCommand = true;
                if (cancelRequested || opts?.signal?.aborted) {
                  publishCancel();
                }
              })
              .catch((err: unknown) => {
                commandPublishInFlight = false;
                if (cancelRequested || opts?.signal?.aborted) {
                  failCancellation(
                    "Command publication failed while cancellation was pending.",
                  );
                }
                if (!settled) {
                  settled = true;
                  cleanup();
                  reject(
                    new Error(
                      `Failed to publish command: ${
                        err instanceof Error
                          ? err.message
                          : (() => {
                              try {
                                return JSON.stringify(err);
                              } catch {
                                return String(err);
                              }
                            })()
                      }`,
                    ),
                  );
                }
              });
          })().catch((err: unknown) => {
            if (!settled) {
              commandPublishInFlight = false;
              settled = true;
              cleanup();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        });

        subscription.subscribe();
        client.connect();

        client.on("connected", () => {
          tConnected = Date.now();
        });

        client.on("error", (ctx) => {
          if (!settled) {
            settled = true;
            cleanup();
            const msg = ctx.error?.message ?? "unknown";
            const isConnectionLimit =
              msg.includes("connection limit") || ctx.error?.code === 4503;
            reject(
              new Error(
                isConnectionLimit
                  ? "Centrifugo connection limit reached. The server has too many active connections. Please try again later."
                  : `Centrifugo client error: ${msg}`,
              ),
            );
          }
        });
      });

      return result;
    },
  };

  // Escape paths for shell using single quotes (prevents $(), backticks, etc.)
  private static escapePath(path: string): string {
    return `'${path.replace(/'/g, "'\\''")}'`;
  }

  private resolveWorkingPath(path: string): string {
    if (!this.workingDirectory) return path;
    const isAbsolute =
      path.startsWith("/") ||
      (this.isWindows() && path.startsWith("\\")) ||
      /^[A-Za-z]:[\\/]/.test(path);
    if (isAbsolute) return path;

    const separator = this.workingDirectory.includes("\\") ? "\\" : "/";
    const base = this.workingDirectory.replace(/[\\/]+$/, "");
    const relative = path.replace(/^[\\/]+/, "");
    return `${base}${separator}${relative}`;
  }

  // Max chunk size ~500KB base64 to stay under size limits (bash path)
  private static readonly MAX_CHUNK_SIZE = 500 * 1024;

  // Keep native file relay messages comfortably below common WebSocket frame
  // limits after JSON overhead. Base64 chunks must stay divisible by 4.
  private static readonly MAX_NATIVE_FILE_MESSAGE_CHARS = 48 * 1024;

  // cmd.exe has an ~8191 character command line limit. Reserve room for
  // `echo `, redirect operator, and file path — keep data under 7000 chars.
  private static readonly MAX_CMD_CHUNK_SIZE = 7000;

  /** Extract parent directory from a path, handling both `/` and `\` separators. */
  private static parentDir(path: string): string {
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return lastSep > 0 ? path.substring(0, lastSep) : "";
  }

  /**
   * Whether the target machine is Windows in dangerous mode.
   * Docker containers are always Linux regardless of host OS.
   */
  isWindows(): boolean {
    return this.connectionInfo.osInfo?.platform === "win32";
  }

  /**
   * Convert Unix-style paths (e.g. /tmp/hackerai-upload/file.png) to
   * Windows-native paths when running on a Windows sandbox.
   * Paths are generated before the sandbox platform is known, so they
   * always arrive in Unix form and need translating here.
   */
  private toNativePath(path: string): string {
    if (!this.isWindows()) return path;
    if (path.startsWith("/tmp/")) {
      return "C:\\temp" + path.slice(4).replace(/\//g, "\\");
    }
    // Translate any remaining absolute Unix paths to Windows-style
    return path.replace(/\//g, "\\");
  }

  /**
   * Escape a value for the target platform's shell.
   * Uses double quotes on Windows (cmd.exe), single quotes on POSIX.
   */
  private escapeForTarget(value: string): string {
    return escapeShellValue(value, this.connectionInfo.osInfo?.platform);
  }

  /**
   * Convert a Windows path (`C:\temp\foo`) to its MSYS/git-bash form
   * (`/c/temp/foo`). Leaves POSIX paths untouched. Used when the remote
   * shell is git-bash on Windows — since PR #346, that's the default, so
   * cmd.exe syntax like `if not exist` and backslash paths break.
   */
  private static toBashPath(path: string): string {
    const drive = path.match(/^([A-Za-z]):[\\/](.*)$/);
    if (drive) {
      return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
    }
    return path.replace(/\\/g, "/");
  }

  // Cache for detected remote shell (git-bash vs cmd.exe on Windows)
  private shellKind: "bash" | "cmd" | null = null;

  /**
   * Detect whether the remote shell is bash (git-bash on Windows, or any
   * POSIX host) or cmd.exe. Cached per sandbox instance.
   *
   * Probe: `echo $BASH_VERSION` — bash substitutes the version string,
   * cmd.exe echoes the literal `$BASH_VERSION`.
   */
  private async detectShell(): Promise<"bash" | "cmd"> {
    if (this.shellKind) return this.shellKind;
    if (!this.isWindows()) {
      this.shellKind = "bash";
      return "bash";
    }
    const probe = await this.runSetupCommand("echo $BASH_VERSION", {
      displayName: "",
    });
    this.shellKind = /^\d/.test(probe.stdout.trim()) ? "bash" : "cmd";
    return this.shellKind;
  }

  private async runSetupCommand(
    command: string,
    options: { displayName?: string; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    for (let attempt = 1; attempt <= SETUP_COMMAND_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.commands.run(command, {
          timeoutMs: options.timeoutMs ?? SETUP_COMMAND_TIMEOUT_MS,
          displayName: options.displayName ?? "",
        });
      } catch (error) {
        if (
          attempt === SETUP_COMMAND_MAX_ATTEMPTS ||
          !isTransientCommandTimeoutError(error)
        ) {
          throw error;
        }
        console.warn(
          `[centrifugo-setup] command timeout on attempt ${attempt}/${SETUP_COMMAND_MAX_ATTEMPTS}, retrying: ${getErrorMessage(error)}`,
        );
        await delay(SETUP_COMMAND_RETRY_DELAY_MS * attempt);
      }
    }

    throw new Error("Setup command failed without returning a result");
  }

  /**
   * Shell-aware context bundle for file operations: resolves the remote
   * shell kind, converts a raw path to the form that shell expects, and
   * returns escaping helpers for paths and arbitrary shell values.
   *
   * Centralizes the branching that used to be duplicated across every
   * `files.*` method and `ensureDirectory`.
   */
  private async shellContext(rawPath: string): Promise<{
    useBash: boolean;
    path: string;
    escapePath: (value: string) => string;
    escapeValue: (value: string) => string;
  }> {
    const shell = await this.detectShell();
    const useBash = shell === "bash";
    const nativePath = this.toNativePath(this.resolveWorkingPath(rawPath));
    const path = useBash
      ? CentrifugoSandbox.toBashPath(nativePath)
      : nativePath;
    const escapePath = useBash
      ? (v: string) => CentrifugoSandbox.escapePath(v)
      : (v: string) => this.escapeForTarget(v);
    const escapeValue = useBash
      ? (v: string) => `'${v.replace(/'/g, "'\\''")}'`
      : (v: string) => this.escapeForTarget(v);
    return { useBash, path, escapePath, escapeValue };
  }

  /**
   * Ensure a directory exists on the target, using the correct command for the shell.
   */
  private async ensureDirectory(dir: string): Promise<void> {
    if (!dir) return;
    const {
      useBash,
      path: shellDir,
      escapePath,
    } = await this.shellContext(dir);
    const escaped = escapePath(shellDir);
    // cmd.exe mkdir creates parent dirs by default; use `if not exist` to
    // skip gracefully when it already exists without swallowing real errors.
    const command = useBash
      ? `mkdir -p ${escaped}`
      : `if not exist ${escaped} mkdir ${escaped}`;
    const result = await this.commands.run(command, { displayName: "" });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create directory ${dir}: ${result.stderr}`);
    }
  }

  // Cache for detected HTTP client (curl or wget)
  private httpClient: "curl" | "wget" | null = null;
  private snapCurlFallbackSelected = false;

  // Cache for detected curl capabilities (probed once per sandbox).
  // --retry-all-errors requires curl >= 7.71.0
  // --retry-connrefused requires curl >= 7.52.0
  private curlCaps: {
    retryAllErrors: boolean;
    retryConnrefused: boolean;
    sslNoRevoke: boolean;
  } | null = null;

  private async detectCurlCaps(): Promise<{
    retryAllErrors: boolean;
    retryConnrefused: boolean;
    sslNoRevoke: boolean;
  }> {
    if (this.curlCaps) return this.curlCaps;
    try {
      const probe = await this.runSetupCommand("curl --help all 2>&1", {
        displayName: "",
      });
      const help = probe.stdout || "";
      this.curlCaps = {
        retryAllErrors: help.includes("--retry-all-errors"),
        retryConnrefused: help.includes("--retry-connrefused"),
        sslNoRevoke: help.includes("--ssl-no-revoke"),
      };
    } catch {
      this.curlCaps = {
        retryAllErrors: false,
        retryConnrefused: false,
        sslNoRevoke: false,
      };
    }
    return this.curlCaps;
  }

  /**
   * Detect available HTTP client (curl or wget).
   * Alpine Linux uses wget by default, most other distros have curl.
   * On Windows (cmd.exe), curl resolves to the real curl.exe bundled with Win10+.
   */
  private async detectHttpClient(): Promise<"curl" | "wget"> {
    if (this.httpClient) return this.httpClient;

    // On Windows, curl.exe is bundled since Win10 build 17063 and there's no
    // wget to fall back to. Skip detection since `command -v` is POSIX-only.
    // If curl is missing on an older Windows Server, the download command
    // itself will fail with a clear "curl is not recognized" error.
    if (this.isWindows()) {
      this.httpClient = "curl";
      return "curl";
    }

    const curlCheck = await this.runSetupCommand("command -v curl || true", {
      displayName: "",
    });
    const curlPath = curlCheck.stdout.trim().split(/\s+/)[0] ?? "";
    // Strict Snap packages use a private /tmp mount namespace. A shell probe
    // can report the destination writable while Snap curl still cannot open
    // that same host path, so prefer the already-supported wget when present.
    if (curlPath && !curlPath.endsWith("/snap/bin/curl")) {
      this.httpClient = "curl";
      return "curl";
    }

    const wgetCheck = await this.runSetupCommand("command -v wget || true", {
      displayName: "",
    });
    if (wgetCheck.stdout.includes("wget")) {
      if (curlPath.endsWith("/snap/bin/curl")) {
        this.snapCurlFallbackSelected = true;
        console.warn(
          "[centrifugo-http]",
          JSON.stringify({
            level: "warn",
            event: "centrifugo_http_client_fallback_selected",
            service: "web",
            environment:
              process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
            timestamp: new Date().toISOString(),
            trace_id: this.connectionInfo.connectionId,
            user_id: this.userId,
            connection_id: this.connectionInfo.connectionId,
            from_client: "curl",
            from_package: "snap",
            to_client: "wget",
            reason: "snap_filesystem_confinement",
          }),
        );
      }
      this.httpClient = "wget";
      return "wget";
    }

    if (curlPath) {
      this.httpClient = "curl";
      return "curl";
    }

    this.httpClient = "curl";
    return "curl";
  }

  private async statNativeFile(
    rawPath: string,
  ): Promise<FileStatResultMessage> {
    return this.runFileRequest<FileStatResultMessage>(
      { type: "file_stat", path: rawPath },
      new Set(["file_stat_result"]),
      30000,
    );
  }

  private async readNativeTextFile(
    rawPath: string,
    options: {
      range?: [number, number];
      maxFullBytes?: number;
      maxResultBytes?: number;
    } = {},
  ): Promise<FileReadResultMessage> {
    return this.runFileRequest<FileReadResultMessage>(
      {
        type: "file_read",
        path: rawPath,
        ...(options.range ? { range: options.range } : {}),
        ...(typeof options.maxFullBytes === "number"
          ? { maxFullBytes: options.maxFullBytes }
          : {}),
        ...(typeof options.maxResultBytes === "number"
          ? { maxResultBytes: options.maxResultBytes }
          : {}),
      },
      new Set(["file_read_result"]),
      120000,
    );
  }

  private async writeNativeFile(
    rawPath: string,
    content: string | Buffer | ArrayBuffer,
  ): Promise<void> {
    if (
      typeof content === "string" &&
      Buffer.byteLength(content, "utf8") <=
        CentrifugoSandbox.MAX_NATIVE_FILE_MESSAGE_CHARS
    ) {
      await this.runFileRequest<FileOkMessage>(
        {
          type: "file_write",
          path: rawPath,
          content,
        },
        new Set(["file_ok"]),
        120000,
      );
      return;
    }

    const encodedContent =
      typeof content === "string"
        ? Buffer.from(content, "utf8").toString("base64")
        : content instanceof ArrayBuffer
          ? Buffer.from(content).toString("base64")
          : content.toString("base64");

    if (encodedContent.length === 0) {
      await this.runFileRequest<FileOkMessage>(
        {
          type: "file_write",
          path: rawPath,
          content: "",
          isBase64: true,
        },
        new Set(["file_ok"]),
        120000,
      );
      return;
    }

    for (
      let offset = 0;
      offset < encodedContent.length;
      offset += CentrifugoSandbox.MAX_NATIVE_FILE_MESSAGE_CHARS
    ) {
      const chunk = encodedContent.slice(
        offset,
        offset + CentrifugoSandbox.MAX_NATIVE_FILE_MESSAGE_CHARS,
      );
      await this.runFileRequest<FileOkMessage>(
        {
          type: offset === 0 ? "file_write" : "file_append",
          path: rawPath,
          content: chunk,
          isBase64: true,
        },
        new Set(["file_ok"]),
        120000,
      );
    }
  }

  private async appendNativeTextFile(
    rawPath: string,
    content: string,
  ): Promise<void> {
    await this.runFileRequest<FileOkMessage>(
      {
        type: "file_append",
        path: rawPath,
        content,
      },
      new Set(["file_ok"]),
      120000,
    );
  }

  private async removeNativeFile(rawPath: string): Promise<void> {
    await this.runFileRequest<FileOkMessage>(
      { type: "file_remove", path: rawPath },
      new Set(["file_ok"]),
      30000,
    );
  }

  private async listNativeFiles(
    rawPath: string,
  ): Promise<Array<{ name: string }>> {
    const result = await this.runFileRequest<FileListResultMessage>(
      { type: "file_list", path: rawPath },
      new Set(["file_list_result"]),
      30000,
    );
    return result.entries;
  }

  files = {
    stat: async (rawPath: string): Promise<FileStatResultMessage> => {
      return this.statNativeFile(rawPath);
    },

    readText: async (
      rawPath: string,
      options?: {
        range?: [number, number];
        maxFullBytes?: number;
        maxResultBytes?: number;
      },
    ): Promise<FileReadResultMessage> => {
      return this.readNativeTextFile(rawPath, options);
    },

    append: async (rawPath: string, content: string): Promise<void> => {
      if (this.supportsNativeFileRelay()) {
        await this.appendNativeTextFile(rawPath, content);
        return;
      }

      const existingContent = await this.files.read(rawPath).catch(() => "");
      await this.files.write(rawPath, existingContent + content);
    },

    write: async (
      rawPath: string,
      content: string | Buffer | ArrayBuffer,
    ): Promise<void> => {
      if (this.supportsNativeFileRelay()) {
        await this.writeNativeFile(rawPath, content);
        return;
      }

      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const fileName = path.split(/[/\\]/).pop() || "file";

      // Ensure parent directory exists. Pass the native (unconverted) dir
      // so ensureDirectory re-applies its own shell-aware path handling.
      const dir = CentrifugoSandbox.parentDir(this.toNativePath(rawPath));
      if (dir) {
        await this.ensureDirectory(dir);
      }

      let contentStr: string;
      let isBinary = false;

      if (typeof content === "string") {
        contentStr = content;
      } else if (content instanceof ArrayBuffer) {
        contentStr = Buffer.from(content).toString("base64");
        isBinary = true;
      } else {
        contentStr = content.toString("base64");
        isBinary = true;
      }

      if (!useBash) {
        // Windows cmd.exe: use certutil to decode base64
        const escapedPath = escapePath(path);
        const b64 = isBinary
          ? contentStr
          : Buffer.from(contentStr).toString("base64");

        // Chunk to stay within cmd.exe's ~8191 char command line limit.
        const chunkSize = CentrifugoSandbox.MAX_CMD_CHUNK_SIZE;
        const chunks: string[] = [];
        if (b64.length > chunkSize) {
          for (let i = 0; i < b64.length; i += chunkSize) {
            chunks.push(b64.slice(i, i + chunkSize));
          }
        } else {
          chunks.push(b64);
        }

        // Write base64 to temp file, then certutil -decode to target
        // certutil adds header/footer lines, so we write raw base64 via echo
        const tempFile = this.escapeForTarget(`${path}.b64tmp.${Date.now()}`);
        for (let i = 0; i < chunks.length; i++) {
          const operator = i === 0 ? ">" : ">>";
          const result = await this.commands.run(
            `echo ${chunks[i]} ${operator} ${tempFile}`,
            { displayName: i === 0 ? `Writing: ${fileName}` : "" },
          );
          if (result.exitCode !== 0) {
            throw new Error(`Failed to write file: ${result.stderr}`);
          }
        }
        // Decode and clean up temp file
        const decodeResult = await this.commands.run(
          `certutil -decode ${tempFile} ${escapedPath} >nul & del /q /f ${tempFile}`,
          { displayName: "" },
        );
        if (decodeResult.exitCode !== 0) {
          // Clean up temp file on failure
          await this.commands.run(`del /q /f ${tempFile}`, {
            displayName: "",
          });
          throw new Error(`Failed to write file: ${decodeResult.stderr}`);
        }
      } else if (
        isBinary &&
        contentStr.length > CentrifugoSandbox.MAX_CHUNK_SIZE
      ) {
        // POSIX: Chunk large binary files to stay under size limits
        const chunks: string[] = [];
        for (
          let i = 0;
          i < contentStr.length;
          i += CentrifugoSandbox.MAX_CHUNK_SIZE
        ) {
          chunks.push(
            contentStr.slice(i, i + CentrifugoSandbox.MAX_CHUNK_SIZE),
          );
        }

        const escapedPath = escapePath(path);
        for (let i = 0; i < chunks.length; i++) {
          const operator = i === 0 ? ">" : ">>";
          const result = await this.commands.run(
            `printf '%s' "${chunks[i]}" | base64 -d ${operator} ${escapedPath}`,
            { displayName: i === 0 ? `Writing: ${fileName}` : "" },
          );
          if (result.exitCode !== 0) {
            throw new Error(`Failed to write file: ${result.stderr}`);
          }
        }
      } else {
        const escapedPath = escapePath(path);
        // Docker containers and Unix dangerous-mode hosts use cat heredoc
        // (more efficient — no ~33% base64 inflation or arg length limits).
        let command: string;
        if (isBinary) {
          command = `printf '%s' "${contentStr}" | base64 -d > ${escapedPath}`;
        } else {
          const delimiter = `HACKERAI_EOF_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
          command = `cat > ${escapedPath} <<'${delimiter}'\n${contentStr}\n${delimiter}`;
        }

        const result = await this.commands.run(command, {
          displayName: `Writing: ${fileName}`,
        });
        if (result.exitCode !== 0) {
          throw new Error(`Failed to write file: ${result.stderr}`);
        }
      }
    },

    read: async (rawPath: string): Promise<string> => {
      if (this.supportsNativeFileRelay()) {
        const payload = await this.readNativeTextFile(rawPath);
        if (payload.tooLarge) {
          throw new Error(`File is too large to read in full: ${rawPath}`);
        }
        return payload.content ?? "";
      }

      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const fileName = path.split(/[/\\]/).pop() || "file";
      const escaped = escapePath(path);
      // cmd.exe uses `type`, bash uses `cat`
      const command = useBash ? `cat ${escaped}` : `type ${escaped}`;
      const result = await this.commands.run(command, {
        displayName: `Reading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr}`);
      }
      return result.stdout;
    },

    copyLocal: async (
      sourceRawPath: string,
      destRawPath: string,
    ): Promise<void> => {
      const sourceCtx = await this.shellContext(sourceRawPath);
      const destCtx = await this.shellContext(destRawPath);
      const fileName = destCtx.path.split(/[/\\]/).pop() || "file";
      const dir = CentrifugoSandbox.parentDir(destCtx.path);

      const mkdirPart = !dir
        ? ""
        : destCtx.useBash
          ? `mkdir -p ${destCtx.escapePath(dir)} &&`
          : `if not exist ${destCtx.escapePath(dir)} mkdir ${destCtx.escapePath(dir)} &&`;
      const copyPart = destCtx.useBash
        ? `cp -f ${sourceCtx.escapePath(sourceCtx.path)} ${destCtx.escapePath(destCtx.path)}`
        : `copy /Y ${sourceCtx.escapePath(sourceCtx.path)} ${destCtx.escapePath(destCtx.path)} >nul`;

      const result = await this.commands.run(`${mkdirPart} ${copyPart}`, {
        displayName: `Preparing: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to prepare local file: ${result.stderr || result.stdout}`,
        );
      }
    },

    remove: async (rawPath: string): Promise<void> => {
      if (this.supportsNativeFileRelay()) {
        await this.removeNativeFile(rawPath);
        return;
      }

      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const fileName = path.split(/[/\\]/).pop() || "file";
      const escaped = escapePath(path);
      // cmd.exe: try both del (files) and rmdir (dirs) to handle either case
      const command = useBash
        ? `rm -rf ${escaped}`
        : `del /q /f ${escaped} 2>nul & rmdir /s /q ${escaped} 2>nul`;
      const result = await this.commands.run(command, {
        displayName: `Removing: ${fileName}`,
      });
      // Under cmd.exe, if both del and rmdir fail the path didn't exist — that's OK for rm -rf semantics
      if (useBash && result.exitCode !== 0) {
        throw new Error(`Failed to remove file: ${result.stderr}`);
      }
    },

    list: async (rawPath: string = "/"): Promise<{ name: string }[]> => {
      if (this.supportsNativeFileRelay()) {
        return this.listNativeFiles(rawPath);
      }

      const { useBash, path, escapePath } = await this.shellContext(rawPath);
      const dirName = path.split(/[/\\]/).pop() || path;
      const escaped = escapePath(path);
      // cmd.exe: `dir /b /a-d` lists files only (no dirs), one per line
      const command = useBash
        ? `find ${escaped} -maxdepth 1 -type f 2>/dev/null || true`
        : `dir /b /a-d ${escaped} 2>nul`;
      const result = await this.commands.run(command, {
        displayName: `Listing: ${dirName}`,
      });
      if (result.exitCode !== 0) return [];

      return result.stdout
        .split("\n")
        .filter(Boolean)
        .map((name) => {
          // cmd.exe `dir /b` returns relative names; prepend the directory path.
          // bash `find` already returns full paths, so only rewrite under cmd.
          if (!useBash && !name.startsWith(path)) {
            const sep = path.endsWith("/") || path.endsWith("\\") ? "" : "/";
            return { name: `${path}${sep}${name.trim()}` };
          }
          return { name: name.trim() };
        });
    },

    downloadFromUrl: async (url: string, rawPath: string): Promise<void> => {
      validateDownloadUrl(url);
      // When the shell is git-bash (default on Windows since PR #346),
      // emit POSIX syntax with MSYS-form paths. cmd.exe syntax like
      // `if not exist` breaks under bash and leaves the target dir missing,
      // causing curl to fail with the Windows "invalid filename syntax" error.
      const { useBash, path, escapePath, escapeValue } =
        await this.shellContext(rawPath);
      const httpClient = await this.detectHttpClient();
      const dir = CentrifugoSandbox.parentDir(path);
      const fileName = path.split(/[/\\]/).pop() || "file";

      const escapedPath = escapePath(path);
      const escapedUrl = escapeValue(url);
      const escapedDir = dir ? escapePath(dir) : "";

      // Combine mkdir + download into a single command to avoid separate
      // round-trips through the sandbox bridge (e.g. Tauri desktop app),
      // ensuring the directory exists in the same shell session as the download.
      // Skip mkdir entirely for root-level destinations (parentDir returns "")
      // to avoid `mkdir -p ''` / `mkdir "C:"` on valid drive-root paths.
      const mkdirPart = !dir
        ? ""
        : useBash
          ? `mkdir -p ${escapedDir} &&`
          : `if not exist ${escapedDir} mkdir ${escapedDir} &&`;
      let downloadPart: string;
      if (httpClient === "curl") {
        const caps = await this.detectCurlCaps();
        const curlFlags = [
          "-fsSL",
          this.isWindows() && caps.sslNoRevoke ? "--ssl-no-revoke" : "",
          "--retry 3",
          "--retry-delay 1",
          caps.retryAllErrors ? "--retry-all-errors" : "",
          caps.retryConnrefused ? "--retry-connrefused" : "",
        ]
          .filter(Boolean)
          .join(" ");
        downloadPart = `curl ${curlFlags} -o ${escapedPath} ${escapedUrl}`;
      } else {
        downloadPart = `wget -q --tries=3 --waitretry=1 -O ${escapedPath} ${escapedUrl}`;
      }
      const command = `${mkdirPart} ${downloadPart}`;

      // JS-level retry safety net on top of curl's --retry, for transient
      // network/TLS errors that can survive curl's own retry loop:
      //   7  = couldn't connect
      //   18 = partial transfer
      //   23 = write error
      //   28 = operation timeout
      //   35 = TLS handshake/read error (e.g. S3 "unexpected eof")
      //   56 = failure receiving network data
      //   92 = HTTP/2 stream error
      //   124 = local command wrapper timeout
      const transientExitCodes =
        httpClient === "curl"
          ? new Set([7, 18, 23, 28, 35, 56, 92, 124])
          : new Set([4, 124]);
      const MAX_ATTEMPTS = 3;

      let result: Awaited<ReturnType<typeof this.commands.run>> | null = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          result = await this.commands.run(command, {
            displayName:
              attempt === 1
                ? `Downloading: ${fileName}`
                : `Downloading: ${fileName} (retry ${attempt - 1})`,
            timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
          });
        } catch (error) {
          if (
            attempt === MAX_ATTEMPTS ||
            !isTransientCommandTimeoutError(error)
          ) {
            throw error;
          }
          console.warn(
            `[centrifugo-download] command timeout on attempt ${attempt}/${MAX_ATTEMPTS}, retrying: ${redactTransferDetails(getErrorMessage(error), url, [rawPath, path])}`,
          );
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }

        if (result.exitCode === 0) break;
        if (
          attempt === MAX_ATTEMPTS ||
          !transientExitCodes.has(result.exitCode)
        ) {
          break;
        }
        console.warn(
          `[centrifugo-download] ${httpClient} exit ${result.exitCode} on attempt ${attempt}/${MAX_ATTEMPTS}, retrying`,
        );
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      if (!result) {
        throw new Error("Download command failed without returning a result");
      }
      if (result.exitCode !== 0) {
        // Gather diagnostic info to help debug write failures (e.g. curl exit 23).
        // Fall back to the target's own directory context when the destination
        // is a drive root and `dir` is empty. Avoid listing directory contents:
        // this can be a user's local machine in desktop dangerous mode.
        const diagDir = escapedDir || (useBash ? "/" : '"."');
        const diagCmd = useBash
          ? `test -d ${diagDir} && echo target_dir_exists=true || echo target_dir_exists=false; test -w ${diagDir} && echo target_dir_writable=true || echo target_dir_writable=false; df -h /tmp 2>&1 | sed -n '1,2p'`
          : `if exist ${diagDir} (echo target_dir_exists=true) else (echo target_dir_exists=false) & (pushd ${diagDir} >nul 2>nul && (copy /Y NUL .hackerai_write_probe.tmp >nul 2>nul && del /q .hackerai_write_probe.tmp >nul 2>nul && echo target_dir_writable=true || echo target_dir_writable=false) & popd >nul 2>nul) || echo target_dir_writable=false`;
        const diag = await this.commands.run(diagCmd, { displayName: "" });
        const safeStderr = redactTransferDetails(result.stderr, url, [
          rawPath,
          path,
        ]);
        throw new Error(
          `Failed to download file: ${safeStderr}\n` +
            `  source: [redacted-url]\n` +
            `  destination: [redacted-destination-path]\n` +
            `  command: ${httpClient}\n` +
            `  exitCode: ${result.exitCode}\n` +
            `  diagnostics: ${diag.stdout}`,
        );
      }
    },

    uploadToUrl: async (
      rawPath: string,
      uploadUrl: string,
      contentType: string,
    ): Promise<void> => {
      const { path, escapePath, escapeValue } =
        await this.shellContext(rawPath);
      const httpClient = await this.detectHttpClient();

      if (httpClient === "wget") {
        const versionCheck = await this.runSetupCommand("wget 2>&1 | head -1", {
          displayName: "",
        });
        if (versionCheck.stdout.toLowerCase().includes("busybox")) {
          if (this.snapCurlFallbackSelected) {
            throw new Error(
              "File upload failed: Snap curl cannot safely access sandbox file paths, and BusyBox wget does not support PUT requests. Install GNU wget or a native curl package to enable file uploads.",
            );
          }
          throw new Error(
            "File upload failed: curl is not available and BusyBox wget does not support PUT requests. " +
              "Install curl to enable file uploads (e.g., 'apk add curl' on Alpine or 'apt install curl' on Debian).",
          );
        }
      }

      const fileName = path.split(/[/\\]/).pop() || "file";
      const escapedPath = escapePath(path);
      const escapedUrl = escapeValue(uploadUrl);
      const escapedContentType = escapeValue(`Content-Type: ${contentType}`);
      const curlUploadFlags =
        httpClient === "curl"
          ? [
              "-fsSL",
              this.isWindows() && (await this.detectCurlCaps()).sslNoRevoke
                ? "--ssl-no-revoke"
                : "",
            ]
              .filter(Boolean)
              .join(" ")
          : "";

      const command =
        httpClient === "curl"
          ? `curl ${curlUploadFlags} -X PUT -H ${escapedContentType} --data-binary @${escapedPath} ${escapedUrl}`
          : `wget -q --method=PUT --header=${escapedContentType} --body-file=${escapedPath} -O - ${escapedUrl}`;

      const result = await this.commands.run(command, {
        timeoutMs: 120000,
        displayName: `Uploading: ${fileName}`,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Failed to upload file: ${result.stderr}`);
      }
    },
  };

  getHost(_port: number): string {
    return "";
  }

  async close(): Promise<void> {
    for (const client of this.activeClients) {
      try {
        client.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.activeClients = [];
    this.emit("close");
  }
}
