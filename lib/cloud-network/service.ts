import {
  readProxySecret,
  writeProxySecret,
  deleteProxySecret,
} from "./proxy-vault";
import type { ProxyInput, ProxySecret, ProxySettings } from "./proxy";
import { randomUUID } from "node:crypto";
import { Sandbox } from "@e2b/code-interpreter";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { getConfiguredE2BClustersForCleanup } from "@/lib/ai/tools/utils/e2b-cluster";
import {
  assertCloudWorkspaceAvailable,
  readCloudWorkspaceState,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";
import {
  DEFAULT_NETWORK_POLICY,
  e2bNetwork,
  type NetworkPolicy,
  type NetworkSettings,
} from "./policy";

export class NetworkSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}
const auth = (userId: string) => ({
  userId,
  serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
});
const checked = new WeakMap<Sandbox, number>();
export async function readNetworkSettings(
  userId: string,
): Promise<NetworkSettings | null> {
  return getConvexClient().query(api.cloudNetwork.get, auth(userId));
}
function sameList(a: string[] | undefined, b: string[]) {
  return (
    JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort())
  );
}
async function matchesSandboxPolicy(
  sandbox: Sandbox,
  userId: string,
  policy: NetworkPolicy,
  signal: AbortSignal,
  proxy?: ProxySecret,
  proxyManaged = false,
) {
  const info = await sandbox.getInfo({ signal, requestTimeoutMs: 15_000 });
  if (info.metadata?.userID !== userId)
    throw new Error("Workspace ownership mismatch");
  // Replacing egress must not clear an externally managed proxy or transform.
  if (
    (info.network?.egressProxy && !proxyManaged) ||
    Object.keys(info.network?.rules ?? {}).length
  )
    throw new Error("Externally managed network configuration");
  const network = e2bNetwork(policy, proxy);
  return (
    sameList(info.network?.allowOut, network.allowOut) &&
    sameList(info.network?.denyOut, network.denyOut) &&
    (info.network?.egressProxy?.address ?? "") === (proxy?.address ?? "") &&
    (info.network?.egressProxy?.username ?? "") === (proxy?.username ?? "")
  );
}
async function applyToSandbox(
  sandbox: Sandbox,
  userId: string,
  policy: NetworkPolicy,
  signal: AbortSignal,
  onWrite: () => void,
  proxy?: ProxySecret,
  proxyManaged = false,
) {
  const matches = await matchesSandboxPolicy(
    sandbox,
    userId,
    policy,
    signal,
    proxy,
    proxyManaged,
  );
  // E2B never returns the password. A new/retried proxy revision must be written
  // even when its visible address and username already match.
  if (matches && !proxy) return;
  onWrite();
  await sandbox.updateNetwork(e2bNetwork(policy, proxy), {
    signal,
    requestTimeoutMs: 15_000,
  });
  if (
    !(await matchesSandboxPolicy(
      sandbox,
      userId,
      policy,
      signal,
      proxy,
      proxyManaged,
    ))
  )
    throw new Error("Network readback mismatch");
}

/** One workspace-wide writer, shared by Settings and sandbox acquisition. */
async function applyNetwork(
  userId: string,
  input?: {
    policy: NetworkPolicy;
    expectedRevision: number;
    proxy?: ProxySettings | null;
  },
  connected?: Sandbox,
  parentSignal?: AbortSignal,
  proxyInput?: ProxyInput,
  previousProxy?: ProxySettings | null,
) {
  const client = getConvexClient();
  const token = randomUUID();
  let settings: NetworkSettings | null;
  try {
    settings = await client.mutation(api.cloudNetwork.begin, {
      ...auth(userId),
      token,
      ...input,
    });
  } catch (error) {
    const message =
      error instanceof ConvexError && typeof error.data === "string"
        ? error.data
        : "Network settings are unavailable. Retry shortly.";
    throw new NetworkSettingsError(
      message,
      error instanceof ConvexError ? 409 : 503,
    );
  }
  if (!settings) return null;
  const deadline = AbortSignal.timeout(45_000);
  const signal = parentSignal
    ? AbortSignal.any([deadline, parentSignal])
    : deadline;
  let wrote = false;
  const onWrite = () => {
    wrote = true;
  };
  try {
    const workspace = await readCloudWorkspaceState(userId);
    const destinationId =
      workspace?.phase === "e2b" ? workspace.destinationId : undefined;
    await assertCloudWorkspaceAvailable(userId, destinationId);
    const proxy = settings.proxy
      ? proxyInput
        ? await writeProxySecret(
            userId,
            settings.proxy,
            proxyInput,
            previousProxy,
          )
        : await readProxySecret(userId, settings.proxy)
      : undefined;
    signal.throwIfAborted();
    await assertCloudWorkspaceAvailable(userId, destinationId);
    const clusters = getConfiguredE2BClustersForCleanup();
    if (!clusters.length) throw new Error("Cloud provider unavailable");
    const seen = new Set<string>();
    if (connected) {
      await assertCloudWorkspaceAvailable(userId, connected.sandboxId);
      await applyToSandbox(
        connected,
        userId,
        settings.policy,
        signal,
        onWrite,
        proxy,
        settings.proxyManaged,
      );
      seen.add(connected.sandboxId);
    }
    for (const cluster of clusters) {
      const pages = Sandbox.list({
        ...cluster.connectionOptions,
        requestTimeoutMs: 15_000,
        query: { metadata: { userID: userId }, state: ["running"] },
      });
      let count = 0;
      do {
        if (++count > 10) throw new Error("Workspace inventory limit");
        for (const info of await pages.nextItems({
          signal,
          requestTimeoutMs: 15_000,
        })) {
          if (
            seen.has(info.sandboxId) ||
            (destinationId && info.sandboxId !== destinationId)
          )
            continue;
          if (info.metadata?.userID !== userId)
            throw new Error("Workspace ownership mismatch");
          await assertCloudWorkspaceAvailable(userId, info.sandboxId);
          const sandbox = await Sandbox.connect(info.sandboxId, {
            ...cluster.connectionOptions,
            signal,
            requestTimeoutMs: 15_000,
          });
          await applyToSandbox(
            sandbox,
            userId,
            settings.policy,
            signal,
            onWrite,
            proxy,
            settings.proxyManaged,
          );
          seen.add(info.sandboxId);
        }
      } while (pages.hasNext);
    }
    signal.throwIfAborted();
    if (settings.proxyManaged && !settings.proxy)
      await deleteProxySecret(userId);
    signal.throwIfAborted();
    await client.mutation(api.cloudNetwork.finish, {
      ...auth(userId),
      token,
      success: true,
    });
    if (connected) checked.set(connected, settings.revision);
    return { ...settings, status: "ready" as const };
  } catch {
    await client
      .mutation(api.cloudNetwork.finish, {
        ...auth(userId),
        token,
        success: false,
        releaseLease: !wrote,
      })
      .catch(() => {});
    throw new NetworkSettingsError(
      "Network settings were saved but could not be verified on every running cloud workspace. Some workspaces may already use them. Reload settings and retry Save.",
    );
  }
}
export async function saveNetworkSettings(
  userId: string,
  policy: NetworkPolicy,
  expectedRevision: number,
  proxyInput?: ProxyInput | null,
) {
  if (proxyInput === undefined)
    return applyNetwork(userId, { policy, expectedRevision });
  const previous = await readNetworkSettings(userId);
  if (
    previous?.revision !== expectedRevision &&
    !(previous === null && expectedRevision === 0)
  )
    throw new NetworkSettingsError(
      "Network settings changed. Reload them before saving.",
      409,
    );
  if (proxyInput && process.env.E2B_BYOP_ENABLED !== "true")
    throw new NetworkSettingsError(
      "Cloud proxy setup is not available yet.",
      403,
    );
  if (
    proxyInput &&
    proxyInput.credentials === undefined &&
    previous?.proxy?.authenticated &&
    proxyInput.address !== previous.proxy.address
  )
    throw new NetworkSettingsError(
      "Enter the credentials again when changing the proxy address.",
      400,
    );
  const proxy = proxyInput
    ? {
        address: proxyInput.address,
        authenticated:
          proxyInput.credentials === undefined
            ? Boolean(previous?.proxy?.authenticated)
            : Boolean(proxyInput.credentials),
        revision: randomUUID(),
      }
    : null;
  return applyNetwork(
    userId,
    { policy, expectedRevision, proxy },
    undefined,
    undefined,
    proxyInput ?? undefined,
    previous?.proxy,
  );
}
export async function ensureCloudNetwork(
  sandbox: Sandbox,
  userId: string,
  signal?: AbortSignal,
) {
  const settings = await readNetworkSettings(userId);
  if (!settings) return;
  if (settings.status === "ready" && checked.get(sandbox) === settings.revision)
    return;
  // Parent and delegated runs may acquire the same workspace concurrently.
  // A matching, stable ready policy needs no writer lease or provider mutation.
  if (settings.status === "ready") {
    const verificationSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(15_000), signal])
      : AbortSignal.timeout(15_000);
    if (
      await matchesSandboxPolicy(
        sandbox,
        userId,
        settings.policy,
        verificationSignal,
        settings.proxy
          ? await readProxySecret(userId, settings.proxy)
          : undefined,
        settings.proxyManaged,
      )
    ) {
      const current = await readNetworkSettings(userId);
      if (
        current?.status === "ready" &&
        current.revision === settings.revision
      ) {
        verificationSignal.throwIfAborted();
        checked.set(sandbox, settings.revision);
        return;
      }
    }
  }
  await applyNetwork(userId, undefined, sandbox, signal);
}
export const defaultNetworkSettings = (): NetworkSettings => ({
  policy: DEFAULT_NETWORK_POLICY,
  revision: 0,
  status: "ready",
});

/** Resolve secrets only in trusted server memory immediately before E2B create. */
export async function networkForCreation(
  userId: string,
  settings: NetworkSettings,
) {
  const proxy = settings.proxy
    ? await readProxySecret(userId, settings.proxy)
    : undefined;
  return e2bNetwork(settings.policy, proxy);
}

export async function deleteCloudProxyForAccount(userId: string) {
  const client = getConvexClient();
  const state = await client.query(
    api.cloudNetwork.proxyCleanupState,
    auth(userId),
  );
  if (!state.managed) return;
  if (state.leaseUntil && state.leaseUntil > Date.now())
    throw new NetworkSettingsError(
      "A cloud network update is finishing. Retry account deletion shortly.",
    );
  await deleteProxySecret(userId);
  await client.mutation(api.cloudNetwork.finishProxyCleanup, auth(userId));
}
