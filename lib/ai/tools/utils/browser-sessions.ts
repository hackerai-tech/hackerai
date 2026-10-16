import { randomBytes } from "node:crypto";
import type { AnySandbox } from "@/types";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getPostHogBooleanFlagDecisionForUser } from "@/lib/posthog/server";
import { isE2BSandbox } from "./sandbox-types";
import { buildSandboxCommandOptions } from "./sandbox-command-options";
import { browserSessionCommand } from "./browser-session-program";

// Agent tasks have a four-hour wall-clock limit. Keep a small cleanup grace;
// a detached sandbox watchdog also expires checkpoints after a worker crash.
export const BROWSER_SESSION_MAX_LIFETIME_MS = (4 * 60 + 5) * 60 * 1000;

type BrowserSession = {
  sessionId: string;
  sandbox: AnySandbox;
  directory: string;
  ready: Promise<string | undefined>;
  registered: boolean;
  registration?: Promise<void>;
};

export const BROWSER_HANDOFF_FLAG = "agent-browser-human-handoff";

type BrowserHandoffScope = {
  userId: string;
  chatId: string;
  runId: string;
  agentId: string;
  triggerRegion?: string;
  serviceKey: string;
};

/** One owner per tool factory, never shared between a parent and its children. */
export class BrowserSessions {
  private readonly encryptionKey = randomBytes(32).toString("hex");
  private readonly expiresAt = Date.now() + BROWSER_SESSION_MAX_LIFETIME_MS;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly failedSessions = new Set<BrowserSession>();
  private closed = false;
  private cleanupPromise?: Promise<void>;
  private handoffEnabled?: Promise<boolean>;

  constructor(private readonly handoffScope?: BrowserHandoffScope) {}

  handoffEnabledForRun(): Promise<boolean> {
    this.handoffEnabled ??= this.handoffScope
      ? getPostHogBooleanFlagDecisionForUser(
          BROWSER_HANDOFF_FLAG,
          this.handoffScope.userId,
          undefined,
          { sendFeatureFlagEvents: false },
        ).then((decision) => decision === true)
      : Promise.resolve(false);
    return this.handoffEnabled;
  }

  /** Retry failed setup on the next call, retaining every attempt for cleanup. */
  async prepare(sandbox: AnySandbox): Promise<Record<string, string>> {
    if (this.closed || Date.now() >= this.expiresAt) {
      throw new Error(
        "Browser session ownership has ended. Start a new Agent run.",
      );
    }
    if (!isE2BSandbox(sandbox)) return {};
    const sandboxId = sandbox.sandboxId;
    if (!sandboxId)
      throw new Error("Browser session sandbox identity is unavailable.");
    const gate = this.handoffScope ? await this.handoffEnabledForRun() : false;
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

  async getExitNotes(): Promise<Array<{ id: string; text: string }>> {
    if (!this.handoffScope || this.closed) return [];
    const scope = this.handoffScope;
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
