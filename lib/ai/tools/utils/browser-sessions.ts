import { randomBytes } from "node:crypto";
import type { ToolSet } from "ai";
import { abortableDelay } from "@/lib/utils/abortable-delay";
import type { AnySandbox } from "@/types";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { isE2BSandbox } from "./sandbox-types";
import { buildSandboxCommandOptions } from "./sandbox-command-options";
import { browserSessionCommand } from "./browser-session-program";

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
  private closed = false;
  private cleanupPromise?: Promise<void>;

  constructor(
    private readonly handoffScope?: BrowserHandoffScope,
    private readonly onOwnershipLost?: () => void,
  ) {}

  hasHandoffScope(): boolean {
    return !!this.handoffScope;
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
          getConvexClient().query(api.browserHandoffs.getForBackend, {
            serviceKey: scope.serviceKey,
            userId: scope.userId,
            sessionId: session.sessionId,
          }),
          signal,
        );
        if (!state?.runActive) continue;
        const name = (
          await withCancellation(
            session.sandbox.files.read(`${session.directory}/active-session`, {
              user: "root",
              requestTimeoutMs: 8_000,
            }),
            signal,
          )
        ).trim();
        if (!/^[^/\u0000\r\n]{1,80}$/.test(name)) return false;
        const result = await withCancellation(
          session.sandbox.commands.run(
            'test -S "$AGENT_BROWSER_SOCKET_DIR/$AGENT_BROWSER_SESSION.sock" && agent-browser --json stream status',
            {
              ...buildSandboxCommandOptions(session.sandbox),
              envs: {
                AGENT_BROWSER_SOCKET_DIR: `${session.directory}/sockets`,
                AGENT_BROWSER_CONFIG: `${session.directory}/config.json`,
                AGENT_BROWSER_SESSION: name,
              },
              timeoutMs: 7_000,
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
          data.connected !== false &&
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
    if (!isE2BSandbox(sandbox)) return {};
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
      // Short enough for Unix socket paths, random across factories/runs, and
      // memory-backed so checkpoints are not part of the reusable workspace.
      const directory = `/dev/shm/hackerai-browser-${randomBytes(12).toString("hex")}`;
      const ready = sandbox.commands
        .run(
          browserSessionCommand("prepare", directory, this.expiresAt, gate),
          {
            ...buildSandboxCommandOptions(sandbox),
            timeoutMs: 20_000,
          },
        )
        .then((result) => {
          if (result.exitCode !== 0)
            throw new Error("Could not prepare private browser sessions.");
          if (gate && !result.stdout?.trim())
            throw new Error("Browser command gate is unavailable.");
          return gate ? result.stdout.trim() : undefined;
        });
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
          state: await getConvexClient().query(
            api.browserHandoffs.getForBackend,
            {
              serviceKey: scope.serviceKey,
              userId: scope.userId,
              sessionId: session.sessionId,
            },
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
            getConvexClient().query(api.browserHandoffs.getForBackend, {
              serviceKey: scope.serviceKey,
              userId: scope.userId,
              sessionId: session.sessionId,
            }),
          ),
        ),
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

  async getExitNotes(): Promise<Array<{ id: string; text: string }>> {
    if (!this.handoffScope || this.closed) return [];
    const scope = this.handoffScope;
    // Preview registration is optional, but saved notes are user instructions.
    // A failed read must not silently let the Agent act without those updates.
    const notes = await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.registered)
        .map((session) =>
          getConvexClient().query(api.browserHandoffs.getExitNotesForBackend, {
            serviceKey: scope.serviceKey,
            userId: scope.userId,
            sessionId: session.sessionId,
          }),
        ),
    );
    return notes.flat();
  }

  /** End ownership once, preventing any subsequent browser preparation. */
  cleanup(): Promise<void> {
    this.closed = true;
    this.cleanupPromise ??= this.cleanupAll();
    return this.cleanupPromise;
  }

  /** Drain in-flight setup before erasing active and failed directories. */
  private async cleanupAll(): Promise<void> {
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
