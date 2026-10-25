import { Sandbox } from "@e2b/code-interpreter";
import { NotFoundError } from "e2b";
import { z } from "zod";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import {
  readCloudWorkspaceState,
  assertCloudWorkspaceAvailable,
  CloudWorkspaceUnavailableError,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import {
  workspaceReaderCommand,
  WorkspaceFileError,
  type WorkspaceRequest,
} from "./workspace-files";

export const listingSchema = z.object({
  entries: z
    .array(
      z.object({
        name: z.string().max(255),
        kind: z.enum(["file", "directory", "symlink", "other"]),
        size: z.number().nonnegative(),
        modified: z.number(),
      }),
    )
    .max(100),
  total: z.number().int().min(0).max(5000),
  nextOffset: z.number().int().min(0).max(5000).nullable(),
});

/** Discover only existing owner workspaces. Never invoke acquisition/create or
 * fall back to a different sandbox after the client has pinned its identity. */
export async function accessCloudWorkspaceFiles(
  userId: string,
  region: TriggerRunRegion | undefined,
  input: WorkspaceRequest,
) {
  const state = await readCloudWorkspaceState(userId);
  if (state && state.phase !== "e2b")
    throw new CloudWorkspaceUnavailableError();
  const cluster = getE2BClusterRouting(state?.region ?? region).createCluster;
  const options = { ...cluster.connectionOptions, requestTimeoutMs: 10_000 };
  let sandboxId = input.sandboxId ?? state?.destinationId;
  if (state && sandboxId !== state.destinationId)
    throw new WorkspaceFileError("workspace_changed", 409);
  if (!sandboxId) {
    const pages = Sandbox.list({
      ...options,
      limit: 100,
      query: {
        metadata: { userID: userId, template: cluster.template },
        state: ["running", "paused"],
      },
    });
    const found = await pages.nextItems();
    // An ambiguous oversized inventory must not silently select a partial result.
    if (pages.hasNext)
      throw new WorkspaceFileError("workspace_unavailable", 503);
    const owned = found.filter(
      (item) =>
        item.metadata?.userID === userId &&
        item.metadata?.template === cluster.template,
    );
    owned.sort(
      (a, b) =>
        Number(b.state === "running") - Number(a.state === "running") ||
        b.startedAt.getTime() - a.startedAt.getTime(),
    );
    sandboxId = owned[0]?.sandboxId;
  }
  if (!sandboxId) return { state: "missing" as const };
  let info;
  try {
    info = await Sandbox.getInfo(sandboxId, options);
  } catch (error) {
    if (error instanceof NotFoundError)
      return { state: "missing" as const, sandboxId };
    throw error;
  }
  if (
    info.metadata?.userID !== userId ||
    info.metadata?.template !== cluster.template
  )
    throw new WorkspaceFileError("not_found", 404);
  await assertCloudWorkspaceAvailable(userId, sandboxId);
  if (
    input.action === "status" ||
    (info.state === "paused" && input.action !== "resume")
  ) {
    return {
      state:
        info.state === "running" ? ("running" as const) : ("paused" as const),
      sandboxId,
    };
  }
  if (!["running", "paused"].includes(info.state))
    return { state: "missing" as const };
  // Reading files must not shorten a concurrently running Agent's sandbox lease.
  const sandbox = await Sandbox.connect(sandboxId, options);
  await assertCloudWorkspaceAvailable(userId, sandboxId);
  const request =
    input.action === "resume" ? { ...input, action: "list" as const } : input;
  const result = await sandbox.commands.run(workspaceReaderCommand(request), {
    user: "root",
    cwd: "/home/user",
    timeoutMs: 15_000,
  });
  if (result.exitCode !== 0)
    throw new WorkspaceFileError("workspace_unavailable", 503);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new WorkspaceFileError("workspace_unavailable", 503);
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const known = new Set([
      "invalid_path",
      "not_file",
      "file_too_large",
      "directory_too_large",
      "not_found",
      "unreadable_path",
      "file_changed",
      "invalid_request",
    ]);
    const code = String(parsed.error);
    throw new WorkspaceFileError(
      known.has(code) ? code : "workspace_unavailable",
      code === "not_found" ? 404 : 400,
    );
  }
  // Recheck the recovery/deletion fence before returning any file bytes.
  await assertCloudWorkspaceAvailable(userId, sandboxId);
  if (request.action === "list")
    return {
      state: "running" as const,
      sandboxId,
      root: "/home/user",
      environmentLabel: "Cloud",
      ...listingSchema.parse(parsed),
    };
  const file = z
    .object({
      data: z
        .string()
        .max(2_800_000)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      size: z
        .number()
        .int()
        .min(0)
        .max(50 * 1024 * 1024),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      nextByteOffset: z
        .number()
        .int()
        .min(0)
        .max(50 * 1024 * 1024)
        .nullable(),
    })
    .parse(parsed);
  return {
    state: "running" as const,
    sandboxId,
    root: "/home/user",
    environmentLabel: "Cloud",
    ...file,
  };
}
