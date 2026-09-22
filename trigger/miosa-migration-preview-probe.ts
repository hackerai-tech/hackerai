import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { Sandbox } from "@e2b/code-interpreter";
import { z } from "zod";
import { getConfiguredE2BClustersForCleanup } from "@/lib/ai/tools/utils/e2b-cluster";

/** Temporary Preview-only probe used to select a disposable migration fixture. */
export const miosaMigrationPreviewProbe = schemaTask({
  id: "miosa-migration-preview-probe",
  schema: z.object({ userId: z.string().min(1).max(256) }),
  maxDuration: 60,
  run: async ({ userId }, { ctx }) => {
    if (ctx.environment.type !== "PREVIEW") {
      throw new AbortTaskRunError("Preview-only task");
    }

    const workspaces: Array<{
      cluster: string;
      sandboxId: string;
      state: string;
    }> = [];
    for (const cluster of getConfiguredE2BClustersForCleanup()) {
      const paginator = Sandbox.list({
        ...cluster.connectionOptions,
        requestTimeoutMs: 5_000,
        query: {
          metadata: { userID: userId },
          state: ["running", "paused"],
        },
        limit: 100,
      });
      do {
        const page = await paginator.nextItems({ requestTimeoutMs: 5_000 });
        workspaces.push(
          ...page.map((workspace) => ({
            cluster: cluster.cluster,
            sandboxId: workspace.sandboxId,
            state: workspace.state,
          })),
        );
        if (workspaces.length > 100) {
          throw new AbortTaskRunError("Preview fixture inventory too large");
        }
      } while (paginator.hasNext);
    }

    return { count: workspaces.length, workspaces };
  },
});
