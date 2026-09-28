import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnySandbox } from "@/types";
import { localEnvironmentIdentity } from "@/lib/sandbox/environment";
import {
  asCommonSandbox,
  isCentrifugoSandbox,
  isMiosaSandbox,
} from "./sandbox-types";
import {
  listOwnerOnlyPosixFiles,
  readOwnerOnlyPosixFile,
  removeOwnerOnlyPosixFile,
  usesOwnerOnlyPosixFileTransport,
  writeOwnerOnlyPosixFile,
} from "./owner-only-posix-file";

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
  return `${isMiosaSandbox(sandbox) ? "miosa" : "e2b"}:${sandbox.sandboxId}`;
}

export function createTerminalRecordStore(
  sandbox: AnySandbox,
  userId: string,
  scopeId: string,
) {
  const lifecycleOnly = isMiosaSandbox(sandbox);
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
  ): Promise<TerminalExecutionRecord | null> => {
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
      if (raw.length > 2_000_000) return null;
      const record = recordSchema.parse(JSON.parse(raw));
      return record.session === session &&
        record.sandboxInstance === terminalSandboxInstance(sandbox)
        ? record
        : null;
    } catch {
      return null;
    }
  };

  return {
    // MIOSA implements a logical file operation with staged uploads/downloads
    // plus guest exec calls. Startup checkpoints, ten-second output
    // checkpoints, and a directory-wide prune on every terminal command
    // multiplied ordinary Agent activity into thousands of provider requests.
    // Explicit lifecycle checkpoints still retain evidence when the command
    // yields, exits, or is cancelled; only the continuous maintenance is
    // deferred for this high-overhead transport.
    checkpointOnStart: !lifecycleOnly,
    checkpointOnOutput: !lifecycleOnly,
    pruneOnStart: !lifecycleOnly,
    pathFor,
    async save(record: TerminalExecutionRecord): Promise<string | null> {
      try {
        const validated = recordSchema.parse(record);
        const path = pathFor(record.session);
        if (ownerOnlyPosix) {
          await writeOwnerOnlyPosixFile(
            sandbox,
            root,
            directory,
            path,
            JSON.stringify(validated),
          );
        } else {
          // Native and cloud file APIs create parents without exposing the
          // record in a shell command. A torn write is rejected by read().
          await files.write(path, JSON.stringify(validated));
        }
        return path;
      } catch {
        return null; // Persistence failure must not interrupt or replay a command.
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
      if (Date.now() - (lastPrunedAt.get(directory) ?? 0) < 60_000) return;
      lastPrunedAt.set(directory, Date.now());
      if (lastPrunedAt.size > 256)
        lastPrunedAt.delete(lastPrunedAt.keys().next().value!);
      try {
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
            const record = await readRecord(match[1]);
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
      } catch {
        /* Retention is best effort when the sandbox disconnects. */
      }
    },
  };
}
