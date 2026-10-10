import { recordTerminalMaintenance } from "@/lib/centrifugo/terminal-maintenance-metrics";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnySandbox } from "@/types";
import { localEnvironmentIdentity } from "@/lib/sandbox/environment";
import { asCommonSandbox, isCentrifugoSandbox } from "./sandbox-types";
import {
  listOwnerOnlyPosixFiles,
  readOwnerOnlyPosixFile,
  removeOwnerOnlyPosixFile,
  usesOwnerOnlyPosixFileTransport,
  writeOwnerOnlyPosixFile,
} from "./owner-only-posix-file";
import { pruneLocalTerminalRecords } from "./local-terminal-retention";

// Records are sandbox artifacts, not a second process registry. In particular,
// a persisted PID must never be used to reconnect to or kill a process.
export const TERMINAL_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 64;
const lastPrunedAt = new Map<string, number>();
const recordSchema = z.object({
  version: z.literal(1),
  session: z.string().regex(/^[a-f0-9]{8}$/),
  sandboxInstance: z.string().max(256),
  command: z.string().max(32_768),
  workingDirectory: z.string().max(4096).optional(),
  pid: z.number().int().nonnegative(),
  status: z.enum(["running", "completed", "failed", "stopped", "unknown"]),
  exitCode: z.number().nullable(),
  exitReason: z.string().max(128).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  output: z.string().max(262_144),
  outputTruncated: z.boolean(),
  artifactPaths: z.array(z.string().max(4096)).max(32),
});
export type TerminalExecutionRecord = z.infer<typeof recordSchema>;

export function terminalSandboxInstance(sandbox: AnySandbox): string {
  if (isCentrifugoSandbox(sandbox)) {
    const connection =
      typeof sandbox.getConnectionInfo === "function"
        ? sandbox.getConnectionInfo()
        : { connectionId: sandbox.getConnectionId() };
    return `connection:${localEnvironmentIdentity(connection)}`;
  }
  return `e2b:${sandbox.sandboxId}`;
}

export function createTerminalRecordStore(
  sandbox: AnySandbox,
  userId: string,
  scopeId: string,
) {
  const scope = createHash("sha256")
    .update(JSON.stringify([userId, scopeId, terminalSandboxInstance(sandbox)]))
    .digest("hex");
  const base = isCentrifugoSandbox(sandbox) ? "/tmp" : "/home/user";
  const root = `${base}/terminal_execution_records`;
  const directory = `${root}/${scope}`;
  const files = asCommonSandbox(sandbox).files;
  const ownerOnlyPosix = usesOwnerOnlyPosixFileTransport(sandbox);
  const pathFor = (session: string) => {
    if (!/^[a-f0-9]{8}$/.test(session))
      throw new Error("Invalid terminal session ID");
    return `${directory}/${session}.json`;
  };
  const readRecord = async (
    session: string,
    operation: "recovery_read" | "retention_read" = "recovery_read",
  ): Promise<TerminalExecutionRecord | null> => {
    let payloadBytes = 0;
    let outcome: "success" | "failure" | "rejected" = "failure";
    try {
      const recordPath = pathFor(session);
      const raw = ownerOnlyPosix
        ? await readOwnerOnlyPosixFile(
            sandbox,
            root,
            directory,
            recordPath,
            2_000_001,
          )
        : await files.read(recordPath);
      payloadBytes = Buffer.byteLength(raw, "utf8");
      outcome = "rejected";
      if (raw.length > 2_000_000) return null;
      const record = recordSchema.parse(JSON.parse(raw));
      if (
        record.session !== session ||
        record.sandboxInstance !== terminalSandboxInstance(sandbox)
      )
        return null;
      outcome = "success";
      return record;
    } catch {
      return null;
    } finally {
      recordTerminalMaintenance(sandbox, {
        operation,
        outcome,
        payloadBytes,
        transport: ownerOnlyPosix ? "posix_command" : "native_file",
      });
    }
  };

  return {
    checkpointOnStart: true,
    checkpointOnOutput: true,
    pruneOnStart: true,
    pathFor,
    async save(record: TerminalExecutionRecord): Promise<string | null> {
      let payloadBytes = 0;
      let outcome: "success" | "failure" = "failure";
      try {
        const validated = recordSchema.parse(record);
        const path = pathFor(record.session);
        const content = JSON.stringify(validated);
        payloadBytes = Buffer.byteLength(content, "utf8");
        if (ownerOnlyPosix) {
          await writeOwnerOnlyPosixFile(
            sandbox,
            root,
            directory,
            path,
            content,
          );
        } else {
          // Native and cloud file APIs create parents without exposing the
          // record in a shell command. A torn write is rejected by read().
          await files.write(path, content);
        }
        outcome = "success";
        return path;
      } catch {
        return null; // Persistence failure must not interrupt or replay a command.
      } finally {
        recordTerminalMaintenance(sandbox, {
          operation: "checkpoint_write",
          outcome,
          payloadBytes,
          transport: ownerOnlyPosix ? "posix_command" : "native_file",
        });
      }
    },
    async read(session: string): Promise<TerminalExecutionRecord | null> {
      const record = await readRecord(session);
      return record &&
        record.updatedAt >= Date.now() - TERMINAL_RECORD_RETENTION_MS
        ? record
        : null;
    },
    async prune(): Promise<void> {
      // Avoid rereading every retained record on every command. This cache
      // bounds only retention work; it is never used for record retrieval.
      if (Date.now() - (lastPrunedAt.get(directory) ?? 0) < 60_000) {
        recordTerminalMaintenance(sandbox, {
          operation: "prune_route",
          outcome: "throttled",
          transport: ownerOnlyPosix ? "posix_command" : "native_file",
        });
        return;
      }
      lastPrunedAt.set(directory, Date.now());
      if (lastPrunedAt.size > 256)
        lastPrunedAt.delete(lastPrunedAt.keys().next().value!);
      let fallbackStarted = false;
      let fallbackOutcome: "success" | "failure" = "failure";
      try {
        if (
          await pruneLocalTerminalRecords(sandbox, {
            root,
            directory,
            sandboxInstance: terminalSandboxInstance(sandbox),
            schema: z.toJSONSchema(recordSchema),
            cutoff: Date.now() - TERMINAL_RECORD_RETENTION_MS,
            maxRecords: MAX_RECORDS,
          })
        )
          return;
        fallbackStarted = true;
        const entries = ownerOnlyPosix
          ? await listOwnerOnlyPosixFiles(sandbox, root, directory)
          : await files.list(directory);
        const records = await Promise.all(
          entries.map(async ({ name }) => {
            // Never trust paths from a sandbox directory listing.
            const match = /^([a-f0-9]{8})\.json$/.exec(
              name.split(/[\\/]/).pop() ?? "",
            );
            if (!match) return null;
            const record = await readRecord(match[1], "retention_read");
            // A concurrent write or transport error is not proof of expiry.
            return record
              ? { session: match[1], updatedAt: record.updatedAt }
              : null;
          }),
        );
        const sorted = records
          .filter((r) => r !== null)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        await Promise.all(
          sorted
            .filter(
              (r, i) =>
                i >= MAX_RECORDS ||
                r.updatedAt < Date.now() - TERMINAL_RECORD_RETENTION_MS,
            )
            .map((r) =>
              ownerOnlyPosix
                ? removeOwnerOnlyPosixFile(
                    sandbox,
                    root,
                    directory,
                    pathFor(r.session),
                  )
                : files.remove(pathFor(r.session)),
            ),
        );
        fallbackOutcome = "success";
      } catch {
        /* Retention is best effort when the sandbox disconnects. */
      } finally {
        if (fallbackStarted)
          recordTerminalMaintenance(sandbox, {
            operation: "prune_fallback",
            outcome: fallbackOutcome,
            transport: ownerOnlyPosix ? "posix_command" : "native_file",
          });
      }
    },
  };
}
