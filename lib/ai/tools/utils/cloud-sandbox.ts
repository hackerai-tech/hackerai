import type { AnySandbox, SandboxBootInfo } from "@/types";
import { getCloudSandboxProvider } from "./cloud-sandbox-provider";
import { ensureSandboxConnection } from "./sandbox";
import { isE2BSandbox } from "./sandbox-types";

export async function ensureCloudSandboxConnection(options: {
  userId: string;
  initialSandbox?: AnySandbox | null;
  setSandbox: (sandbox: AnySandbox) => void;
  onBoot?: (info: SandboxBootInfo) => void;
}): Promise<{ sandbox: AnySandbox }> {
  const provider = getCloudSandboxProvider();
  if (provider === "aws-lambda-microvm") {
    if (options.initialSandbox && !isE2BSandbox(options.initialSandbox)) {
      return { sandbox: options.initialSandbox };
    }
    const { ensureAwsLambdaMicrovmConnection } =
      await import("./aws-lambda-microvm");
    const sandbox = await ensureAwsLambdaMicrovmConnection(
      options.userId,
      options.onBoot,
    );
    options.setSandbox(sandbox);
    return { sandbox };
  }

  return ensureSandboxConnection(
    {
      userID: options.userId,
      setSandbox: options.setSandbox,
      onBoot: options.onBoot,
    },
    {
      initialSandbox:
        options.initialSandbox && isE2BSandbox(options.initialSandbox)
          ? options.initialSandbox
          : null,
    },
  );
}

export async function terminateCloudSandboxesForUser(userId: string): Promise<{
  total: number;
  killed: number;
  alreadyGone: number;
}> {
  if (getCloudSandboxProvider() === "aws-lambda-microvm") {
    const { terminateAwsLambdaMicrovmForUser } =
      await import("./aws-lambda-microvm");
    return terminateAwsLambdaMicrovmForUser(userId);
  }

  const paginator = (await import("@e2b/code-interpreter")).Sandbox.list({
    query: { metadata: { userID: userId } },
  });
  const sandboxes = await paginator.nextItems();
  let killed = 0;
  let alreadyGone = 0;
  const { isExpectedMissingResourceCleanupError } =
    await import("@/lib/utils/cleanup-errors");
  const { Sandbox } = await import("@e2b/code-interpreter");
  for (const sandbox of sandboxes) {
    try {
      await Sandbox.kill(sandbox.sandboxId);
      killed++;
    } catch (error) {
      if (isExpectedMissingResourceCleanupError(error)) {
        alreadyGone++;
        console.debug(
          `Sandbox ${sandbox.sandboxId} was already gone during delete`,
          error,
        );
        continue;
      }
      console.error(`Failed to kill sandbox ${sandbox.sandboxId}:`, error);
      throw error;
    }
  }
  return { total: sandboxes.length, killed, alreadyGone };
}
