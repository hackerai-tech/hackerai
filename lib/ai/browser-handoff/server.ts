import "server-only";
import { createHash, randomBytes } from "node:crypto";

import { Sandbox } from "@e2b/code-interpreter";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import { browserSessionCommand } from "@/lib/ai/tools/utils/browser-session-program";
import { buildSandboxCommandOptions } from "@/lib/ai/tools/utils/sandbox-command-options";
import { browserBridgeCommand } from "./bridge-program";
import { browserDaemonCommand } from "./daemon-program";
import {
  browserRelayProgram,
  RELAY_START_PROGRAM,
  RELAY_STOP_PROGRAM,
} from "./relay-program";

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
  let info: Awaited<ReturnType<typeof Sandbox.getInfo>>;
  try {
    info = await Sandbox.getInfo(session.sandboxId, {
      ...options,
      requestTimeoutMs: 8_000,
    });
  } catch {
    console.warn("[browser-preview] sandbox lookup unavailable");
    throw new BrowserPreviewUnavailable("disconnected");
  }
  if (
    info.state !== "running" ||
    info.metadata?.userID !== session.userId ||
    // Older reusable sandboxes predate cluster metadata. The selected E2B
    // account and endpoint still bind discovery to the intended region.
    (info.metadata?.e2bCluster != null &&
      info.metadata.e2bCluster !== cluster.cluster) ||
    info.metadata?.template !== cluster.template
  ) {
    console.warn("[browser-preview] sandbox identity mismatch");
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

export async function getPrivateStreamPort(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
) {
  const result = await sandbox.commands.run(
    browserDaemonCommand(session.directory, browserSessionName, {
      action: "stream_status",
    }),
    {
      ...buildSandboxCommandOptions(sandbox),
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

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const relayDirectory = (session: BrowserSessionLocation, grant: string) =>
  `${session.directory}/relay-${createHash("sha256").update(grant).digest("hex").slice(0, 24)}`;

export async function startBrowserRelay(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  grant: string,
  origin: string,
  streamPort?: number,
) {
  const port =
    streamPort ??
    (await getPrivateStreamPort(sandbox, session, browserSessionName));
  const handle = await sandbox.commands.run(
    `node -e ${quote(RELAY_START_PROGRAM)}`,
    {
      ...buildSandboxCommandOptions(sandbox),
      background: true,
      stdin: true,
      timeoutMs: 8000,
    },
  );
  await handle.sendStdin(
    JSON.stringify({
      directory: relayDirectory(session, grant),
      config: {
        root: session.directory,
        port,
        browserSessionName,
        grant,
        origin,
        expiresAt: session.expiresAt,
      },
      program: browserRelayProgram(),
      // Expires before the eventual database grant, even if startup is slow.
      lease: Date.now() + 25_000,
    }),
  );
  await handle.closeStdin();
  const result = await handle.wait();
  const relayPort = Number(result.stdout.trim());
  if (
    result.exitCode !== 0 ||
    !Number.isInteger(relayPort) ||
    relayPort < 1 ||
    relayPort > 65535
  )
    throw new BrowserPreviewUnavailable("disconnected");
  return `https://${sandbox.getHost(relayPort)}`;
}

export async function renewBrowserRelay(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  grant: string,
  lease: number,
) {
  const directory = relayDirectory(session, grant);
  // Atomic replacement avoids a transient empty lease read in the relay.
  const program = `const fs=require('node:fs');const d=process.argv[1];if(fs.existsSync(d)){if(fs.existsSync(d+'/revoked')||fs.existsSync(d+'/closed'))process.exit(1);fs.writeFileSync(d+'/lease.next',process.argv[2],{mode:384});fs.renameSync(d+'/lease.next',d+'/lease');}`;
  const result = await sandbox.commands.run(
    `node -e ${quote(program)} ${quote(directory)} ${lease}`,
    {
      ...buildSandboxCommandOptions(sandbox),
      timeoutMs: 5000,
    },
  );
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
}

export async function stopBrowserRelays(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  grant?: string,
) {
  // A permanent tombstone prevents a late heartbeat from resurrecting control.
  // Wait for the stream close handshake to drain accepted input before resume.
  const result = await sandbox.commands.run(
    `node -e ${quote(RELAY_STOP_PROGRAM)} ${quote(session.directory)}${grant ? ` ${quote(relayDirectory(session, grant))}` : ""}`,
    {
      ...buildSandboxCommandOptions(sandbox),
      timeoutMs: 7000,
    },
  );
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
}

export async function captureBrowserFrame(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  requireFresh = false,
  streamPort?: number,
) {
  const port =
    streamPort ??
    (await getPrivateStreamPort(sandbox, session, browserSessionName));
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
  let imageUrl = `data:${mime};base64,${frame.data}`;
  let capturedAt = frame.capturedAt;
  if (requireFresh) {
    // agent-browser 0.26 can replay cached frames with timestamp=0. A new
    // screenshot proves freshness without assigning a new age to that cache.
    const path = `${session.directory}/preview-${randomBytes(16).toString("hex")}.jpg`;
    capturedAt = Date.now();
    try {
      const screenshot = await sandbox.commands.run(
        browserDaemonCommand(session.directory, browserSessionName, {
          action: "screenshot",
          path,
          format: "jpeg",
          quality: 65,
        }),
        {
          ...buildSandboxCommandOptions(sandbox),
          timeoutMs: 8_000,
        },
      );
      if (screenshot.exitCode !== 0)
        throw new BrowserPreviewUnavailable("disconnected");
      const info = await sandbox.files.getInfo(path, {
        user: "root",
        requestTimeoutMs: 4_000,
      });
      if (info.size < 4 || info.size > 675_000)
        throw new BrowserPreviewUnavailable("disconnected");
      const fresh = Buffer.from(
        await sandbox.files.read(path, {
          format: "bytes",
          user: "root",
          requestTimeoutMs: 4_000,
        }),
      );
      if (
        fresh.byteLength < 4 ||
        fresh.byteLength > 675_000 ||
        fresh[0] !== 0xff ||
        fresh[1] !== 0xd8
      )
        throw new BrowserPreviewUnavailable("disconnected");
      imageUrl = `data:image/jpeg;base64,${fresh.toString("base64")}`;
    } finally {
      // The private memory-backed run directory is also erased at run cleanup.
      await sandbox.files
        .remove(path, { user: "root", requestTimeoutMs: 4_000 })
        .catch(() => undefined);
    }
  }
  return {
    image: imageUrl,
    width: frame.width,
    height: frame.height,
    capturedAt,
    browserSessionName,
  };
}

/** Resize only the currently granted session; callers hold the input lease. */
export async function resizeBrowserViewport(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  width: number,
  height: number,
) {
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value >= 240 && value <= 2560,
    )
  )
    throw new Error("Invalid browser viewport");
  const result = await sandbox.commands.run(
    browserDaemonCommand(session.directory, browserSessionName, {
      action: "viewport",
      width,
      height,
      deviceScaleFactor: 1,
    }),
    {
      ...buildSandboxCommandOptions(sandbox),
      timeoutMs: 7_000,
    },
  );
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
  const frame = await captureBrowserFrame(
    sandbox,
    session,
    browserSessionName,
    true,
  );
  // The fresh screenshot uses the new viewport, but the stream can replay
  // metadata from before the resize. Keep input coordinates in the new space.
  return { ...frame, width, height };
}

export async function sendBrowserInput(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  events: ReadonlyArray<Record<string, unknown>>,
  streamPort?: number,
) {
  const port =
    streamPort ??
    (await getPrivateStreamPort(sandbox, session, browserSessionName));
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
