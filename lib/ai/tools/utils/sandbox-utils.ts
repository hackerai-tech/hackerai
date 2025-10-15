import type { Sandbox } from "@e2b/code-interpreter";
import type { SandboxContext } from "@/types";
import { createOrConnectPersistentTerminal } from "./sandbox";

const SANDBOX_TEMPLATE = "terminal-agent-sandbox";
const BASH_SANDBOX_TIMEOUT = 15 * 60 * 1000;

export const ensureSandboxConnection = async (
  context: SandboxContext,
  options: {
    initialSandbox?: Sandbox | null;
    enforceVersion?: boolean;
  } = {},
): Promise<{ sandbox: Sandbox }> => {
  const { userID, setSandbox } = context;
  const { initialSandbox, enforceVersion = false } = options;

  let sandbox = initialSandbox;

  if (!sandbox) {
    try {
      sandbox = await createOrConnectPersistentTerminal(
        userID,
        SANDBOX_TEMPLATE,
        BASH_SANDBOX_TIMEOUT,
        enforceVersion,
      );
      setSandbox(sandbox);
    } catch (error) {
      console.error("Error creating persistent sandbox:", error);
      throw new Error(
        `Failed creating persistent sandbox: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  return { sandbox };
};
