import { randomBytes } from "node:crypto";
import path from "node:path";
import { cloudflareInitScript, CLOUDFLARE_PAGE_URL_SCRIPT } from "./cloudflare";
import type { CentrifugoSandbox } from "../tools/utils/centrifugo-sandbox";
import { augmentCommandPath } from "../tools/utils/sandbox-command-options";
import {
  connectedBrowserCommand,
  connectedBrowserRequest,
} from "./connected-browser-program";

/** Owns the browser namespace for one connected-host Agent run. */
export class ConnectedChallengeBrowser {
  private readonly owner = randomBytes(12).toString("hex");
  private readonly encryptionKey = randomBytes(32).toString("hex");
  private preparation?: Promise<Record<string, string>>;
  private closed = false;

  constructor(
    private sandbox: CentrifugoSandbox,
    private readonly expiresAt: number,
    private readonly cloudflare?: {
      urls: readonly string[];
      enabled: () => Promise<boolean>;
    },
  ) {}

  reconnect(sandbox: CentrifugoSandbox) {
    if (
      sandbox.getConnectionInfo().connectionId !==
      this.sandbox.getConnectionInfo().connectionId
    )
      throw new Error("Browser connection changed.");
    this.sandbox = sandbox;
  }

  private async request(
    action: "prepare" | "evaluate" | "cleanup" | "cloudflare",
    signal?: AbortSignal,
    script?: string,
    sessionName?: string,
    details?: Record<string, unknown>,
  ) {
    signal?.throwIfAborted();
    try {
      const reply = await this.sandbox.commands.run(
        augmentCommandPath(connectedBrowserCommand, this.sandbox),
        {
          stdin: connectedBrowserRequest({
            action,
            owner: this.owner,
            expiresAt: this.expiresAt,
            script,
            sessionName,
            ...details,
          }),
          signal,
          timeoutMs: action === "cloudflare" ? 35_000 : 10_000,
        },
      );
      signal?.throwIfAborted();
      if (reply.exitCode !== 0 || reply.stdout.length > 65536)
        throw new Error();
      return JSON.parse(reply.stdout);
    } catch {
      signal?.throwIfAborted();
      throw new Error("Owned connected browser unavailable.");
    }
  }

  async prepare(): Promise<Record<string, string>> {
    if (this.closed || Date.now() >= this.expiresAt)
      throw new Error("Browser ownership ended.");
    if (!this.sandbox.supportsCommandStdin()) return {};
    this.preparation ??= (async () => {
      const urls =
        this.cloudflare?.urls.length &&
        (await this.cloudflare.enabled().catch(() => false))
          ? this.cloudflare.urls
          : [];
      if (this.closed) throw new Error("Browser ownership ended.");
      return this.request(
        "prepare",
        undefined,
        undefined,
        undefined,
        urls.length
          ? { initScript: cloudflareInitScript([...urls]) }
          : undefined,
      );
    })().then(({ root, name }) => {
      const paths = this.sandbox.isWindows() ? path.win32 : path.posix;
      if (
        typeof root !== "string" ||
        root.length > 500 ||
        !paths.isAbsolute(root) ||
        paths.basename(root) !== `hackerai-captcha-${this.owner}` ||
        name !== `captcha-${this.owner}`
      )
        throw new Error("Invalid browser namespace.");
      return {
        AGENT_BROWSER_SOCKET_DIR: paths.join(root, "sockets"),
        AGENT_BROWSER_SESSION: name,
        AGENT_BROWSER_CONFIG: paths.join(root, "config.json"),
        AGENT_BROWSER_ENCRYPTION_KEY: this.encryptionKey,
        HACKERAI_BROWSER_STATE_DIR: paths.join(root, "state"),
      };
    });
    const env = await this.preparation;
    if (this.closed) throw new Error("Browser ownership ended.");
    return env;
  }

  async getBrowser(signal: AbortSignal, sessionName?: string) {
    signal.throwIfAborted();
    if (this.closed || !this.preparation || Date.now() >= this.expiresAt)
      throw new Error("Open an owned browser in this run first.");
    await this.preparation;
    return {
      identity: this.owner,
      deliverCloudflare: async (
        userAgent: string,
        page: { url: string; documentId: string; originalUserAgent: string },
        script: string,
      ): Promise<unknown> => {
        signal.throwIfAborted();
        if (this.closed) throw new Error("Browser ownership ended.");
        const identityScript = `(${CLOUDFLARE_PAGE_URL_SCRIPT} === ${JSON.stringify(page.url)} && String(performance.timeOrigin) === ${JSON.stringify(page.documentId)})`;
        const reply = await this.request(
          "cloudflare",
          signal,
          script,
          sessionName,
          {
            userAgent,
            originalUserAgent: page.originalUserAgent,
            identityScript,
          },
        );
        signal.throwIfAborted();
        if (this.closed || reply.ok !== true)
          throw new Error("Browser ownership ended.");
        return reply.result;
      },
      evaluate: async (script: string): Promise<unknown> => {
        signal.throwIfAborted();
        if (this.closed) throw new Error("Browser ownership ended.");
        const reply = await this.request(
          "evaluate",
          signal,
          script,
          sessionName,
        );
        if (this.closed || reply.ok !== true)
          throw new Error("Browser ownership ended.");
        return reply.result;
      },
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.preparation) return;
    await this.preparation.catch(() => undefined);
    await this.request("cleanup").catch(() => undefined);
  }
}
