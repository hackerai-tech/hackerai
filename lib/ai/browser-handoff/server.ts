import "server-only";

import { Sandbox } from "@e2b/code-interpreter";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import { browserSessionCommand } from "@/lib/ai/tools/utils/browser-session-program";
import { buildSandboxCommandOptions } from "@/lib/ai/tools/utils/sandbox-command-options";
import { browserBridgeCommand } from "./bridge-program";

export type BrowserSessionLocation = {
  userId: string;
  sandboxId: string;
  triggerRegion: string | null;
  directory: string;
  expiresAt: number;
};

export class BrowserPreviewUnavailable extends Error {
  constructor(readonly state: "loading" | "disconnected" | "closed") {
    super(`Browser preview ${state}`);
  }
}

const SESSION_NAME_RE = /^[^/\u0000\r\n]{1,80}$/;

/** Connect only to the exact running, user-owned cloud workspace. */
export async function connectBrowserSandbox(session: BrowserSessionLocation) {
  const region = session.triggerRegion as TriggerRunRegion | null;
  const cluster = getE2BClusterRouting(region ?? undefined).createCluster;
  const options = cluster.connectionOptions ?? {};
  const info = await Sandbox.getInfo(session.sandboxId, {
    ...options,
    requestTimeoutMs: 8_000,
  });
  if (
    info.state !== "running" ||
    info.metadata?.userID !== session.userId ||
    info.metadata?.e2bCluster !== cluster.cluster ||
    info.metadata?.template !== cluster.template
  ) {
    throw new BrowserPreviewUnavailable("disconnected");
  }
  return Sandbox.connect(session.sandboxId, {
    ...options,
    timeoutMs: 60_000,
    requestTimeoutMs: 8_000,
  });
}

export async function getActiveBrowserSessionName(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
) {
  let name: string;
  try {
    name = (
      await sandbox.files.read(`${session.directory}/active-session`, {
        user: "root",
        requestTimeoutMs: 8_000,
      })
    ).trim();
  } catch {
    throw new BrowserPreviewUnavailable("loading");
  }
  if (!SESSION_NAME_RE.test(name))
    throw new BrowserPreviewUnavailable("closed");
  return name;
}

async function getPrivateStreamPort(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
) {
  const result = await sandbox.commands.run(
    "agent-browser --json stream status",
    {
      ...buildSandboxCommandOptions(sandbox),
      envs: {
        AGENT_BROWSER_SOCKET_DIR: `${session.directory}/sockets`,
        AGENT_BROWSER_CONFIG: `${session.directory}/config.json`,
        AGENT_BROWSER_SESSION: browserSessionName,
      },
      timeoutMs: 7_000,
    },
  );
  if (result.exitCode !== 0) throw new BrowserPreviewUnavailable("closed");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new BrowserPreviewUnavailable("disconnected");
  }
  const data = (
    parsed.data && typeof parsed.data === "object" ? parsed.data : parsed
  ) as Record<string, unknown>;
  const port = data.port;
  if (data.connected === false) throw new BrowserPreviewUnavailable("closed");
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    throw new BrowserPreviewUnavailable("loading");
  return port as number;
}

export async function captureBrowserFrame(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
) {
  const port = await getPrivateStreamPort(sandbox, session, browserSessionName);
  const result = await sandbox.commands.run(
    browserBridgeCommand(port, "frame"),
    {
      ...buildSandboxCommandOptions(sandbox),
      timeoutMs: 8_000,
    },
  );
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
  let frame: {
    data: string;
    width: number;
    height: number;
    capturedAt: number;
  };
  try {
    frame = JSON.parse(result.stdout) as typeof frame;
  } catch {
    throw new BrowserPreviewUnavailable("disconnected");
  }
  if (
    typeof frame.data !== "string" ||
    frame.data.length > 900_000 ||
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    !Number.isFinite(frame.capturedAt)
  )
    throw new BrowserPreviewUnavailable("disconnected");
  const image = Buffer.from(frame.data, "base64");
  if (image.byteLength < 4 || image.byteLength > 675_000)
    throw new BrowserPreviewUnavailable("disconnected");
  const mime =
    image[0] === 0xff && image[1] === 0xd8
      ? "image/jpeg"
      : image[0] === 0x89 && image[1] === 0x50
        ? "image/png"
        : null;
  if (!mime) throw new BrowserPreviewUnavailable("disconnected");
  return {
    image: `data:${mime};base64,${frame.data}`,
    width: frame.width,
    height: frame.height,
    capturedAt: frame.capturedAt,
    browserSessionName,
  };
}

export async function sendBrowserInput(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  events: ReadonlyArray<Record<string, unknown>>,
) {
  const port = await getPrivateStreamPort(sandbox, session, browserSessionName);
  const handle = await sandbox.commands.run(
    browserBridgeCommand(port, "input"),
    {
      ...buildSandboxCommandOptions(sandbox),
      background: true,
      stdin: true,
      timeoutMs: 8_000,
    },
  );
  // Text, including passwords, is sent only through protected process stdin.
  // It is never interpolated into a command, logged, or persisted.
  await handle.sendStdin(JSON.stringify(events));
  await handle.closeStdin();
  const result = await handle.wait();
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
}

export async function setAgentBrowserPaused(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  paused: boolean,
) {
  const result = await sandbox.commands.run(
    browserSessionCommand(
      paused ? "pause" : "resume",
      session.directory,
      session.expiresAt,
    ),
    { ...buildSandboxCommandOptions(sandbox), timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
}
