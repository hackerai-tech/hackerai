import { rethrowBrowserHandoffReadError } from "@/lib/ai/browser-handoff/read-error";
import { randomBytes } from "node:crypto";
import type { ToolSet } from "ai";
import { abortableDelay } from "@/lib/utils/abortable-delay";
import type { AnySandbox } from "@/types";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { isE2BSandbox } from "./sandbox-types";
import { buildSandboxCommandOptions } from "./sandbox-command-options";
import { browserSessionCommand } from "./browser-session-program";
import { AGENT_BROWSER_IDLE_TIMEOUT_MS } from "./agent-browser-runtime";
import { ConnectedChallengeBrowser } from "../../captcha/connected-browser";
import {
  cloudflareInitScript,
  cloudflareReleaseScript,
} from "../../captcha/cloudflare";

import { BROWSER_SESSION_MAX_LIFETIME_MS } from "@/lib/ai/browser-handoff/constants";
export { BROWSER_SESSION_MAX_LIFETIME_MS } from "@/lib/ai/browser-handoff/constants";

type BrowserSession = {
  sessionId: string;
  sandbox: AnySandbox;
  directory: string;
  ready: Promise<string | undefined>;
  registered: boolean;
  registration?: Promise<void>;
};

type BrowserHandoffScope = {
  userId: string;
  chatId: string;
  runId: string;
  agentId: string;
  triggerRegion?: string;
  serviceKey: string;
};

const diagnosticId = (value: string, secret: string) =>
  /^[A-Za-z0-9:_-]{1,128}$/.test(value) && (!secret || !value.includes(secret))
    ? value
    : "unknown";

// Convex HTTP reads can outlive Stop; detach the waiter without admitting work.
function withCancellation<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** One owner per tool factory, never shared between a parent and its children. */
export class BrowserSessions {
  private readonly encryptionKey = randomBytes(32).toString("hex");
  private readonly expiresAt = Date.now() + BROWSER_SESSION_MAX_LIFETIME_MS;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly failedSessions = new Set<BrowserSession>();
  private readonly connectedBrowsers = new Map<
    string,
    ConnectedChallengeBrowser
  >();
  private activeConnectedBrowser?: ConnectedChallengeBrowser;
  private connectedTargetSelected = false;
  private closed = false;
  private cleanupPromise?: Promise<void>;
  private readonly readCounts = {
    state: { calls: 0, succeeded: 0, rejected: 0 },
    notes: { calls: 0, succeeded: 0, rejected: 0 },
  };

  constructor(
    private readonly handoffScope?: BrowserHandoffScope,
    private readonly onOwnershipLost?: () => void,
    private readonly enableConnectedChallenges = false,
    private readonly cloudflare?: {
      urls: string[];
      enabled: () => Promise<boolean>;
    },
  ) {}

  private async observeRead<T>(
    kind: "state" | "notes",
    read: () => Promise<T>,
  ): Promise<T> {
    const counts = this.readCounts[kind];
    counts.calls++;
    try {
      const result = await read();
      counts.succeeded++;
      return result;
    } catch (error) {
      counts.rejected++;
      throw error;
    }
  }

  private reportReadSummary() {
    const { state, notes } = this.readCounts;
    if (!this.handoffScope || state.calls + notes.calls === 0) return;
    try {
      // One snapshot per used owner. SDK retries are inside each logical read;
      // fulfilled reads do not establish control admission or customer recovery.
      // Stop can detach a pending read, which may settle after this snapshot.
      console.info(
        JSON.stringify({
          event: "browser_handoff_read_summary",
          trigger_run_id: diagnosticId(
            this.handoffScope.runId,
            this.handoffScope.serviceKey,
          ),
          agent_id: diagnosticId(
            this.handoffScope.agentId,
            this.handoffScope.serviceKey,
          ),
          summary_phase: "cleanup_start",
          counts_unit: "logical_query",
          state_read_calls: state.calls,
          state_read_succeeded: state.succeeded,
          state_read_rejected: state.rejected,
          state_read_pending: state.calls - state.succeeded - state.rejected,
          note_read_calls: notes.calls,
          note_read_succeeded: notes.succeeded,
          note_read_rejected: notes.rejected,
          note_read_pending: notes.calls - notes.succeeded - notes.rejected,
        }),
      );
    } catch {
      // Diagnostics cannot replace cleanup or the original ownership/read error.
    }
  }

  hasHandoffScope(): boolean {
    return !!this.handoffScope;
  }

  hasConnectedChallengeScope(): boolean {
    return this.enableConnectedChallenges;
  }

  /** Resolve a flagless Cloud snapshot before dispatch, while retaining its sticky session. */
  async captureChallengeTarget(
    sandbox: AnySandbox,
    sessionName?: string,
    runtimeDefault = "default",
  ) {
    // Optional setup can be unavailable while ordinary browsing still works.
    // Skip automatic inspection then; later ownership/name failures still throw.
    if (isE2BSandbox(sandbox)) {
      if (!this.sessions.get(sandbox.sandboxId)?.registered) return undefined;
    } else if (
      !this.enableConnectedChallenges ||
      !sandbox.supportsCommandStdin() ||
      runtimeDefault === "default"
    )
      return undefined;
    let name = sessionName ?? runtimeDefault;
    if (
      sessionName === undefined &&
      isE2BSandbox(sandbox) &&
      runtimeDefault === "default"
    ) {
      const session = this.sessions.get(sandbox.sandboxId);
      if (!session || this.closed) throw new Error("Browser ownership ended.");
      name = (
        await sandbox.files.read(`${session.directory}/active-session`, {
          user: "root",
          requestTimeoutMs: 8000,
        })
      ).trim();
    }
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name))
      throw new Error("Browser session identity is unavailable.");
    return { sandbox, sessionName: name };
  }

  /** Pin a CAPTCHA operation to an already-open browser owned by this run.
   * JavaScript (including any solver response) goes over stdin, never argv,
   * terminal streaming, checkpoint files or the model's tool result.
   */
  async getChallengeBrowser(
    signal: AbortSignal,
    target?: { sandbox: AnySandbox; sessionName: string },
  ): Promise<{
    identity: string;
    evaluate: (script: string) => Promise<unknown>;
    deliverCloudflare?: (
      userAgent: string,
      page: { url: string; documentId: string; originalUserAgent: string },
      script: string,
    ) => Promise<unknown>;
  }> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Browser session ownership has ended.");
    if (target ? !isE2BSandbox(target.sandbox) : this.connectedTargetSelected) {
      const connected =
        target && !isE2BSandbox(target.sandbox)
          ? this.connectedBrowsers.get(
              target.sandbox.getConnectionInfo().connectionId,
            )
          : this.activeConnectedBrowser;
      if (!connected) throw new Error("Open an owned connected browser first.");
      return connected.getBrowser(signal, target?.sessionName);
    }
    const scope = this.handoffScope;
    const session =
      target && isE2BSandbox(target.sandbox)
        ? this.sessions.get(target.sandbox.sandboxId)
        : [...this.sessions.values()].findLast((s) => s.registered);
    if (
      !scope ||
      !session?.registered ||
      !isE2BSandbox(session.sandbox) ||
      this.closed
    )
      throw new Error(
        "Open an owned Cloud browser before inspecting challenges.",
      );
    const sandbox = session.sandbox;
    const name = (
      await withCancellation(
        sandbox.files.read(`${session.directory}/active-session`, {
          user: "root",
          requestTimeoutMs: 8000,
          signal,
        }),
        signal,
      )
    ).trim();
    if (!name || name.length > 80 || /[/\x00\r\n]/.test(name))
      throw new Error("Browser session identity is unavailable.");
    if (target && name !== target.sessionName)
      throw new Error("The snapshot browser session changed.");
    const assertOwned = async () => {
      signal.throwIfAborted();
      if (this.closed || Date.now() >= this.expiresAt)
        throw new Error("Browser session ownership has ended.");
      const state = await withCancellation(
        getConvexClient().query(api.browserHandoffs.getForBackend, {
          serviceKey: scope.serviceKey,
          userId: scope.userId,
          sessionId: session.sessionId,
        }),
        signal,
      );
      if (!state?.runActive || state.state !== "agent")
        throw new Error("Browser is unavailable or waiting for human control.");
      const currentName = (
        await withCancellation(
          sandbox.files.read(`${session.directory}/active-session`, {
            user: "root",
            requestTimeoutMs: 8000,
            signal,
          }),
          signal,
        )
      ).trim();
      if (currentName !== name)
        throw new Error("The active browser session changed.");
    };
    await assertOwned();
    return {
      identity: `${session.sessionId}:${name}`,
      deliverCloudflare: async (userAgent, page, script) => {
        await assertOwned();
        const handle = await sandbox.commands.run(
          browserSessionCommand(
            "cloudflare",
            session.directory,
            this.expiresAt,
          ),
          {
            ...buildSandboxCommandOptions(sandbox),
            stdin: true,
            background: true,
            timeoutMs: 10000,
          },
        );
        try {
          await assertOwned();
          await withCancellation(
            handle.sendStdin(
              JSON.stringify({ userAgent, ...page, script, sessionName: name }),
            ),
            signal,
          );
          await withCancellation(handle.closeStdin(), signal);
          const result = await withCancellation(handle.wait(), signal);
          if (
            result.exitCode !== 0 ||
            result.stdout.length > 1024 ||
            JSON.parse(result.stdout).result === undefined
          )
            throw new Error();
          return JSON.parse(result.stdout).result;
        } catch {
          await handle.kill().catch(() => false);
          signal.throwIfAborted();
          throw new Error("Managed browser challenge delivery failed.");
        }
      },
      evaluate: async (script) => {
        await assertOwned();
        // A status probe never starts a daemon. Refuse eval after idle shutdown.
        const status = await withCancellation(
          sandbox.commands.run(
            browserSessionCommand("status", session.directory, this.expiresAt),
            { ...buildSandboxCommandOptions(sandbox), timeoutMs: 5000 },
          ),
          signal,
        );
        const probe = JSON.parse(status.stdout);
        if (
          status.exitCode !== 0 ||
          probe.success !== true ||
          (probe.data ?? probe).connected !== true
        )
          throw new Error("The owned browser is no longer connected.");
        const env = await this.prepare(sandbox);
        signal.throwIfAborted();
        const gateBin = `/tmp/${session.directory.split("/").at(-1)}/bin`;
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        const handle = await sandbox.commands.run(
          `${gateBin}/agent-browser --session ${quote(name)} eval --stdin --json`,
          {
            ...buildSandboxCommandOptions(sandbox, undefined, {
              AGENT_BROWSER_SOCKET_DIR: env.AGENT_BROWSER_SOCKET_DIR,
              AGENT_BROWSER_CONFIG: env.AGENT_BROWSER_CONFIG,
              AGENT_BROWSER_SESSION: name,
              AGENT_BROWSER_IDLE_TIMEOUT_MS: String(
                AGENT_BROWSER_IDLE_TIMEOUT_MS,
              ),
            }),
            stdin: true,
            background: true,
            timeoutMs: 10_000,
          },
        );
        try {
          await assertOwned();
          await withCancellation(handle.sendStdin(script), signal);
          await withCancellation(handle.closeStdin(), signal);
          const result = await withCancellation(handle.wait(), signal);
          signal.throwIfAborted();
          if (result.stdout.length > 32768) throw new Error();
          const parsed = JSON.parse(result.stdout);
          if (parsed.success !== true) throw new Error();
          return parsed.data?.result;
        } catch {
          await handle.kill().catch(() => false);
          signal.throwIfAborted();
          throw new Error("Browser challenge inspection or delivery failed.");
        }
      },
    };
  }

  /** A completion repair may only wait on this owner's already-live browser. */
  async canRecoverHumanHandoff(signal?: AbortSignal): Promise<boolean> {
    if (!this.handoffScope || this.closed || Date.now() >= this.expiresAt)
      return false;
    const scope = this.handoffScope;
    for (const session of [...this.sessions.values()].reverse()) {
      if (!session.registered || !isE2BSandbox(session.sandbox)) continue;
      try {
        const state = await withCancellation(
          this.observeRead("state", () =>
            getConvexClient(signal).query(api.browserHandoffs.getForBackend, {
              serviceKey: scope.serviceKey,
              userId: scope.userId,
              sessionId: session.sessionId,
            }),
          ),
          signal,
        );
        if (!state?.runActive) continue;
        const result = await withCancellation(
          session.sandbox.commands.run(
            browserSessionCommand("status", session.directory, this.expiresAt),
            {
              ...buildSandboxCommandOptions(session.sandbox),
              timeoutMs: 5_000,
            },
          ),
          signal,
        );
        if (result.exitCode !== 0) return false;
        const parsed = JSON.parse(result.stdout);
        const data = parsed.data ?? parsed;
        return (
          !this.closed &&
          !signal?.aborted &&
          parsed.success === true &&
          data.connected === true &&
          Number.isInteger(data.port) &&
          data.port > 0 &&
          data.port <= 65535
        );
      } catch {
        // Missing ownership, socket or stream is not permission to reopen it.
        return false;
      }
    }
    return false;
  }

  /** Retry failed setup on the next call, retaining every attempt for cleanup. */
  async prepare(sandbox: AnySandbox): Promise<Record<string, string>> {
    if (this.closed) {
      throw new Error(
        "Browser session ownership has ended. Start a new Agent run.",
      );
    }
    this.connectedTargetSelected = !isE2BSandbox(sandbox);
    if (!isE2BSandbox(sandbox)) {
      if (!this.enableConnectedChallenges || !sandbox.supportsCommandStdin()) {
        this.activeConnectedBrowser = undefined;
        return {};
      }
      const connectionId = sandbox.getConnectionInfo().connectionId;
      let browser = this.connectedBrowsers.get(connectionId);
      if (!browser) {
        browser = new ConnectedChallengeBrowser(
          sandbox,
          this.expiresAt,
          this.cloudflare,
        );
        this.connectedBrowsers.set(connectionId, browser);
      } else browser.reconnect(sandbox);
      this.activeConnectedBrowser = browser;
      // An optional solver must not prevent ordinary terminal commands on
      // hosts without Node or with incompatible browser configuration. The
      // failed owner remains unavailable to challenge operations for this run.
      return browser.prepare().catch(() => ({}));
    }
    this.activeConnectedBrowser = undefined;
    if (Date.now() >= this.expiresAt)
      throw new Error(
        "Browser session ownership has ended. Start a new Agent run.",
      );
    const sandboxId = sandbox.sandboxId;
    if (!sandboxId)
      throw new Error("Browser session sandbox identity is unavailable.");
    const gate = this.hasHandoffScope();
    let session = this.sessions.get(sandboxId);
    if (!session) {
      // Publish the preparation promise before awaiting rollout I/O, so two
      // commands preparing the same sandbox retain one owner and namespace.
      const directory = `/dev/shm/hackerai-browser-${randomBytes(12).toString("hex")}`;
      const ready = (async () => {
        const cloudflareUrls =
          this.cloudflare?.urls.length &&
          (await this.cloudflare.enabled().catch(() => false))
            ? this.cloudflare.urls
            : [];
        if (this.closed)
          throw new Error("Browser session ownership has ended.");
        const result = await sandbox.commands.run(
          browserSessionCommand(
            "prepare",
            directory,
            this.expiresAt,
            gate,
            cloudflareUrls.length
              ? cloudflareInitScript(cloudflareUrls)
              : undefined,
          ),
          { ...buildSandboxCommandOptions(sandbox), timeoutMs: 20000 },
        );
        if (result.exitCode !== 0)
          throw new Error("Could not prepare private browser sessions.");
        if (gate && !result.stdout?.trim())
          throw new Error("Browser command gate is unavailable.");
        return gate ? result.stdout.trim() : undefined;
      })();
      session = {
        sessionId: randomBytes(16).toString("hex"),
        sandbox,
        directory,
        ready,
        registered: false,
      };
      this.sessions.set(sandboxId, session);
      const created = session;
      ready.catch(() => {
        if (!this.closed && this.sessions.get(sandboxId) === created) {
          this.sessions.delete(sandboxId);
          this.failedSessions.add(created);
        }
      });
    }
    session.sandbox = sandbox;
    const originalPath = await session.ready;
    if (this.closed) throw new Error("Browser session ownership has ended.");
    if (gate && this.handoffScope && !session.registered) {
      const current = session;
      current.registration ??= getConvexClient()
        .mutation(api.browserHandoffs.registerForBackend, {
          serviceKey: this.handoffScope.serviceKey,
          sessionId: current.sessionId,
          userId: this.handoffScope.userId,
          chatId: this.handoffScope.chatId,
          runId: this.handoffScope.runId,
          agentId: this.handoffScope.agentId,
          sandboxId,
          triggerRegion: this.handoffScope.triggerRegion,
          directory: current.directory,
          expiresAt: this.expiresAt,
        })
        .then((registered) => {
          current.registered = registered;
        })
        .catch(() => {
          // Browser automation remains available if the optional viewer is
          // unavailable. No control grant can exist without registration.
          console.warn("[browser-sessions] viewer registration unavailable");
        })
        .finally(() => {
          current.registration = undefined;
        });
      await current.registration;
    }
    return {
      AGENT_BROWSER_SOCKET_DIR: `${session.directory}/sockets`,
      AGENT_BROWSER_SESSION: "default",
      AGENT_BROWSER_CONFIG: `${session.directory}/config.json`,
      // Explicit checkpoints only. Never let the CLI auto-save in ~/.agent-browser.
      AGENT_BROWSER_ENCRYPTION_KEY: this.encryptionKey,
      HACKERAI_BROWSER_STATE_DIR: `${session.directory}/state`,
      ...(gate && originalPath
        ? {
            PATH: `/tmp/${session.directory.split("/").at(-1)}/bin:${originalPath}`,
          }
        : {}),
    };
  }

  /** Park a requested handoff without occupying a sandbox process. */
  async waitForHumanHandoff(
    signal?: AbortSignal,
    requestAnotherTakeover = false,
  ): Promise<void> {
    signal?.throwIfAborted();
    const scope = this.handoffScope;
    if (!scope || this.closed)
      throw new Error("Browser handoff is unavailable for this run.");
    const sessions = [...this.sessions.values()].filter((s) => s.registered);
    const states = await withCancellation(
      Promise.all(
        sessions.map(async (session) => ({
          session,
          state: await this.observeRead("state", () =>
            getConvexClient(signal).query(api.browserHandoffs.getForBackend, {
              serviceKey: scope.serviceKey,
              userId: scope.userId,
              sessionId: session.sessionId,
            }),
          ),
        })),
      ),
      signal,
    );
    signal?.throwIfAborted();
    const current = states.find(({ state }) => state?.runActive);
    if (!current?.state)
      throw new Error(
        "Open a browser in this Cloud Agent run before requesting handoff.",
      );
    if (current.state.state === "agent" && this.cloudflare?.urls.length) {
      try {
        const target = await this.captureChallengeTarget(
          current.session.sandbox,
        );
        if (!target) throw new Error("Browser session ownership has ended.");
        const browser = await this.getChallengeBrowser(
          signal ?? new AbortController().signal,
          target,
        );
        await browser.evaluate(cloudflareReleaseScript(this.cloudflare.urls));
      } catch {
        // Optional widget recovery must not prevent control of the browser.
        // Admission below still checks ownership; this does not promise that
        // the current CAPTCHA is usable or that manual verification can pass.
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
    }
    const accepted = await withCancellation(
      getConvexClient().mutation(api.browserHandoffs.requestWaitForBackend, {
        serviceKey: scope.serviceKey,
        userId: scope.userId,
        sessionId: current.session.sessionId,
        expectedUpdatedAt: current.state.updatedAt,
        ...(requestAnotherTakeover ? { requestAnotherTakeover: true } : {}),
      }),
      signal,
    );
    signal?.throwIfAborted();
    if (!accepted)
      throw new Error(
        "Browser ownership changed. Read the handoff context and inspect the current browser before deciding what to do next.",
      );
    // Uses the same cancellation, ownership and recovery gate as every other
    // tool. Resume only admits work after the private note and browser gate
    // have been committed; no foreground sandbox timer needs to finish.
    await this.waitForAgentControl(signal);
  }

  /** Hold the owning Agent at model, tool and normal-completion boundaries. */
  async waitForAgentControl(signal?: AbortSignal): Promise<boolean> {
    let waited = false;
    while (true) {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Browser session ownership has ended.");
      if (!this.handoffScope) return waited;
      const scope = this.handoffScope;
      const sessions = [...this.sessions.values()].filter((s) => s.registered);
      if (!sessions.length) return waited;
      if (Date.now() >= this.expiresAt)
        throw new Error("Browser session ownership has ended.");
      const states = await withCancellation(
        Promise.all(
          sessions.map((session) =>
            this.observeRead("state", () =>
              getConvexClient(signal).query(api.browserHandoffs.getForBackend, {
                serviceKey: scope.serviceKey,
                userId: scope.userId,
                sessionId: session.sessionId,
              }),
            ),
          ),
        ).catch(rethrowBrowserHandoffReadError),
        signal,
      );
      signal?.throwIfAborted();
      // Replaced sandboxes remain in our map for cleanup. Only the latest
      // registered owner can authorize work; stale rows must not block it.
      const currentStates = states.filter((state) => state?.runActive);
      if (states.length > 0 && currentStates.length === 0) {
        // Fail closed before any action, but let the owning worker settle its
        // already-produced output/usage as cancellation instead of provider error.
        this.onOwnershipLost?.();
        signal?.throwIfAborted();
        throw new Error("Browser session ownership has ended.");
      }
      if (currentStates.every((state) => state?.state === "agent"))
        return waited;
      // Expired grants become recovery, which still requires an explicit resume.
      waited = true;
      await abortableDelay(1000, signal);
    }
  }

  guardTools(tools: ToolSet, signal?: AbortSignal): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, definition]) => {
        const execute = definition.execute;
        if (!execute) return [name, definition];
        return [
          name,
          {
            ...definition,
            execute: async (...args: Parameters<typeof execute>) => {
              const signals = [signal, args[1].abortSignal].filter(
                (s): s is AbortSignal => !!s,
              );
              const waited = await this.waitForAgentControl(
                signals.length ? AbortSignal.any(signals) : undefined,
              );
              if (waited)
                return {
                  error:
                    "Human browser takeover completed. This queued action was not executed. Read the user's handoff context and take a fresh browser snapshot before deciding the next action.",
                };
              return await execute(...args);
            },
          },
        ];
      }),
    ) as ToolSet;
  }

  async getExitNotes(
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; text: string }>> {
    if (!this.handoffScope || this.closed) return [];
    const scope = this.handoffScope;
    // Preview registration is optional, but saved notes are user instructions.
    // A failed read must not silently let the Agent act without those updates.
    const notes = await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.registered)
        .map((session) =>
          this.observeRead("notes", () =>
            getConvexClient(signal).query(
              api.browserHandoffs.getExitNotesForBackend,
              {
                serviceKey: scope.serviceKey,
                userId: scope.userId,
                sessionId: session.sessionId,
              },
            ),
          ),
        ),
    ).catch(rethrowBrowserHandoffReadError);
    return notes.flat();
  }

  /** End ownership once, preventing any subsequent browser preparation. */
  cleanup(): Promise<void> {
    this.closed = true;
    if (!this.cleanupPromise) this.reportReadSummary();
    this.cleanupPromise ??= this.cleanupAll();
    return this.cleanupPromise;
  }

  /** Drain in-flight setup before erasing active and failed directories. */
  private async cleanupAll(): Promise<void> {
    await Promise.allSettled(
      [...this.connectedBrowsers.values()].map((browser) => browser.close()),
    );
    this.connectedBrowsers.clear();
    this.activeConnectedBrowser = undefined;
    const results = await Promise.allSettled(
      [...this.sessions.values(), ...this.failedSessions].map(
        async (session) => {
          const { sandbox } = session;
          await session.ready.catch(() => undefined);
          try {
            const result = await sandbox.commands.run(
              browserSessionCommand(
                "cleanup",
                session.directory,
                this.expiresAt,
              ),
              { ...buildSandboxCommandOptions(sandbox), timeoutMs: 20_000 },
            );
            if (result.exitCode !== 0)
              throw new Error("Browser cleanup failed.");
          } finally {
            if (session.registered && this.handoffScope) {
              await getConvexClient()
                .mutation(api.browserHandoffs.closeForBackend, {
                  serviceKey: this.handoffScope.serviceKey,
                  sessionId: session.sessionId,
                })
                .catch(() => {
                  console.warn(
                    "[browser-sessions] viewer revocation unavailable",
                  );
                });
            }
          }
        },
      ),
    );
    // Do not log command bodies, SDK errors, paths, or the encryption key.
    if (results.some((result) => result.status === "rejected")) {
      console.warn("[browser-sessions] cleanup incomplete");
    }
    this.sessions.clear();
    this.failedSessions.clear();
  }
}
