import "server-only";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { resolveEnvironmentConnection } from "./environment";
import { CentrifugoSandbox } from "@/lib/ai/tools/utils/centrifugo-sandbox";
import {
  workspaceReaderCommand,
  WorkspaceFileError,
  type WorkspaceRequest,
} from "./workspace-files";
import { z } from "zod";

const resultSchema = z.object({
  root: z.string(),
  entries: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(["file", "directory", "symlink", "other"]),
        size: z.number().nonnegative(),
        modified: z.number(),
      }),
    )
    .max(100)
    .optional(),
  total: z.number().int().min(0).max(5000).optional(),
  nextOffset: z.number().int().min(0).max(5000).nullable().optional(),
  data: z
    .string()
    .max(1_400_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .optional(),
  size: z
    .number()
    .int()
    .min(0)
    .max(50 * 1024 * 1024)
    .optional(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  nextByteOffset: z
    .number()
    .int()
    .min(0)
    .max(50 * 1024 * 1024)
    .nullable()
    .optional(),
});

const listResultSchema = resultSchema.required({
  entries: true,
  total: true,
  nextOffset: true,
});
const fileResultSchema = resultSchema.required({
  data: true,
  size: true,
  revision: true,
  nextByteOffset: true,
});

/** Resolve an authenticated owner connection, then pin every read to its session.
 * This path never acquires a sandbox or chooses a different environment.
 */
export async function accessLocalWorkspaceFiles(
  userId: string,
  preference: string,
  input: WorkspaceRequest,
  root?: string,
) {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  const wsUrl = process.env.CENTRIFUGO_WS_URL;
  const tokenSecret = process.env.CENTRIFUGO_TOKEN_SECRET;
  if (!serviceKey || !wsUrl || !tokenSecret)
    throw new WorkspaceFileError("workspace_unavailable", 503);
  const client = getConvexClient();
  const resolvedPreference = await client.query(
    api.localSandbox.resolveEnvironmentPreferenceForBackend,
    { serviceKey, userId, preference },
  );
  const connections = await client.query(
    api.localSandbox.listConnectionsForBackend,
    { serviceKey, userId },
  );
  // The legacy Desktop alias is ambiguous when more than one installation exists.
  const matches = connections.filter((c) => c.isDesktop);
  if (resolvedPreference === "desktop" && matches.length > 1)
    throw new WorkspaceFileError("select_environment", 409);
  const connection = resolveEnvironmentConnection(
    connections,
    resolvedPreference,
    input.sandboxId,
  );
  if (!connection)
    return { state: "disconnected" as const, environmentLabel: "Local" };
  if (input.sandboxId && input.sandboxId !== connection.connectionId)
    throw new WorkspaceFileError("workspace_changed", 409);
  if (connection.osInfo?.platform === "win32")
    return { state: "unsupported" as const, environmentLabel: connection.name };
  const sandbox = new CentrifugoSandbox(
    userId,
    connection,
    { wsUrl, tokenSecret },
    root,
    undefined,
    input.chatId,
  );
  try {
    const result = await sandbox.commands.run(
      workspaceReaderCommand(
        {
          ...input,
          action:
            input.action === "status" || input.action === "resume"
              ? "list"
              : input.action,
        },
        root ?? null,
      ),
      { timeoutMs: 15_000, displayName: "Browse workspace files" },
    );
    if (result.exitCode !== 0)
      throw new WorkspaceFileError("local_reader_unavailable", 503);
    const parsed = JSON.parse(result.stdout);
    if (parsed.error) {
      const allowed = [
        "invalid_request",
        "not_found",
        "unreadable_path",
        "file_too_large",
        "file_changed",
        "directory_too_large",
        "invalid_path",
        "not_file",
      ];
      throw new WorkspaceFileError(
        allowed.includes(parsed.error) ? parsed.error : "workspace_unavailable",
      );
    }
    const validated = (
      input.action === "list" ||
      input.action === "status" ||
      input.action === "resume"
        ? listResultSchema
        : fileResultSchema
    ).parse(parsed);
    return {
      ...validated,
      state: "running" as const,
      sandboxId: connection.connectionId,
      environmentLabel: connection.name,
      root: root ?? validated.root,
    };
  } finally {
    await sandbox.close();
  }
}
