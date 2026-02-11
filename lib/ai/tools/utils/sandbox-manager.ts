import type { Sandbox } from "@e2b/code-interpreter";
import type { SandboxInfo, SandboxManager, SandboxType } from "@/types";
import { ensureSandboxConnection } from "./sandbox";
import { SANDBOX_ENVIRONMENT_TOOLS } from "./sandbox-tools";

export class DefaultSandboxManager implements SandboxManager {
  private sandbox: Sandbox | null = null;

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: Sandbox) => void,
    initialSandbox?: Sandbox | null,
  ) {
    this.sandbox = initialSandbox || null;
  }

  getSandboxInfo(): SandboxInfo | null {
    return { type: "e2b" };
  }

  getSandboxType(toolName: string): SandboxType | undefined {
    if (!SANDBOX_ENVIRONMENT_TOOLS.includes(toolName as any)) {
      return undefined;
    }
    return "e2b";
  }

  async getSandbox(): Promise<{
    sandbox: Sandbox;
  }> {
    if (!this.sandbox) {
      const result = await ensureSandboxConnection(
        {
          userID: this.userID,
          setSandbox: this.setSandboxCallback,
        },
        {
          initialSandbox: this.sandbox,
        },
      );
      this.sandbox = result.sandbox;
    }

    if (!this.sandbox) {
      throw new Error("Failed to initialize sandbox");
    }

    return { sandbox: this.sandbox };
  }

  setSandbox(sandbox: Sandbox): void {
    this.sandbox = sandbox;
    this.setSandboxCallback(sandbox);
  }
}
