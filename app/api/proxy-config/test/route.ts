import { isIP } from "node:net";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getUserProxyConfigForBackend } from "@/lib/db/actions";
import { DefaultSandboxManager } from "@/lib/ai/tools/utils/sandbox-manager";
import { buildAgentProxyEnvironment } from "@/lib/ai/tools/utils/proxy-config";
import { ChatSDKError } from "@/lib/errors";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";

export const maxDuration = 60;

const EXIT_IP_COMMAND =
  "curl --fail --silent --show-error --max-time 20 https://api.ipify.org";

export async function POST(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);
    if (subscription === "free") {
      return NextResponse.json(
        { error: "A paid Cloud Agent plan is required" },
        { status: 403 },
      );
    }
    await assertUserCanMakeCostIncurringRequest(userId);

    const config = await getUserProxyConfigForBackend({ userId });
    if (!config) {
      return NextResponse.json(
        { error: "Enable and save a proxy before testing it" },
        { status: 400 },
      );
    }

    const envs = buildAgentProxyEnvironment(config);
    const sandboxManager = new DefaultSandboxManager(userId, () => undefined);
    const { sandbox } = await sandboxManager.getSandbox();
    const startedAt = performance.now();
    const result = await sandbox.commands.run(EXIT_IP_COMMAND, {
      cwd: "/home/user",
      user: "root",
      timeoutMs: 25_000,
      envs: envs ? { ...envs } : undefined,
    });
    const exitIp = result.stdout.trim();

    if (result.exitCode !== 0 || isIP(exitIp) === 0) {
      return NextResponse.json(
        { error: "The proxy did not return a valid public IP address" },
        { status: 502 },
      );
    }

    return NextResponse.json({
      exitIp,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();

    // Never log command output or environment variables: both may contain
    // proxy credentials or provider-specific error details.
    console.error("Proxy connection test failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Could not connect through the proxy" },
      { status: 502 },
    );
  }
}
