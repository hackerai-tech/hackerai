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

/** Closed acquisition-verification steps; never carries policy or settings. */
const CLOUD_NETWORK_SUBOPERATIONS = [
  "settings_read",
  "ready_cache_check",
  "provider_info_read",
  "policy_compare",
  "settings_recheck",
  "policy_apply",
  "post_check",
] as const;
export type CloudNetworkSuboperation =
  (typeof CLOUD_NETWORK_SUBOPERATIONS)[number];
export type ReportCloudNetworkSuboperation = (
  suboperation: CloudNetworkSuboperation,
) => void;
export function parseCloudNetworkSuboperation(
  value: unknown,
): CloudNetworkSuboperation | undefined {
  return typeof value === "string" &&
    (CLOUD_NETWORK_SUBOPERATIONS as readonly string[]).includes(value)
    ? (value as CloudNetworkSuboperation)
    : undefined;
}

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
  report?: ReportCloudNetworkSuboperation,
) {
  report?.("provider_info_read");
  const info = await sandbox.getInfo({ signal, requestTimeoutMs: 15_000 });
  report?.("policy_compare");
  if (info.metadata?.userID !== userId)
    throw new Error("Workspace ownership mismatch");
  // Replacing egress must not clear an externally managed proxy or transform.
  if (
    info.network?.egressProxy ||
    Object.keys(info.network?.rules ?? {}).length
  )
    throw new Error("Externally managed network configuration");
  const network = e2bNetwork(policy);
  return (
    sameList(info.network?.allowOut, network.allowOut) &&
    sameList(info.network?.denyOut, network.denyOut)
  );
}
async function applyToSandbox(
  sandbox: Sandbox,
  userId: string,
  policy: NetworkPolicy,
  signal: AbortSignal,
  onWrite: () => void,
) {
  if (await matchesSandboxPolicy(sandbox, userId, policy, signal)) return;
  onWrite();
  await sandbox.updateNetwork(e2bNetwork(policy), {
    signal,
    requestTimeoutMs: 15_000,
  });
  if (!(await matchesSandboxPolicy(sandbox, userId, policy, signal)))
    throw new Error("Network readback mismatch");
}

/** One workspace-wide writer, shared by Settings and sandbox acquisition. */
async function applyNetwork(
  userId: string,
  input?: { policy: NetworkPolicy; expectedRevision: number },
  connected?: Sandbox,
  parentSignal?: AbortSignal,
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
    const clusters = getConfiguredE2BClustersForCleanup();
    if (!clusters.length) throw new Error("Cloud provider unavailable");
    const seen = new Set<string>();
    if (connected) {
      await assertCloudWorkspaceAvailable(userId, connected.sandboxId);
      await applyToSandbox(connected, userId, settings.policy, signal, onWrite);
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
          );
          seen.add(info.sandboxId);
        }
      } while (pages.hasNext);
    }
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
      "Network settings were saved but could not be verified on every running cloud workspace. Some workspaces may already use them. Retry Apply; files were preserved.",
    );
  }
}
export async function saveNetworkSettings(
  userId: string,
  policy: NetworkPolicy,
  expectedRevision: number,
) {
  return applyNetwork(userId, { policy, expectedRevision });
}
export async function ensureCloudNetwork(
  sandbox: Sandbox,
  userId: string,
  signal?: AbortSignal,
  onSuboperation?: ReportCloudNetworkSuboperation,
) {
  // Names the step entered next for failure diagnostics. A reporter failure
  // must never change network policy, provider calls or the original error.
  const report: ReportCloudNetworkSuboperation = (suboperation) => {
    try {
      onSuboperation?.(suboperation);
    } catch {
      /* Best-effort diagnostics only. */
    }
  };
  report("settings_read");
  const saved = await readNetworkSettings(userId);
  report("ready_cache_check");
  // An unsaved setting still promises Internet access in the UI; it must not
  // silently inherit stale provider restrictions from a reused workspace.
  const settings = saved ?? defaultNetworkSettings();
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
        report,
      )
    ) {
      report("settings_recheck");
      const current =
        (await readNetworkSettings(userId)) ?? defaultNetworkSettings();
      if (
        current.status === "ready" &&
        current.revision === settings.revision
      ) {
        report("post_check");
        verificationSignal.throwIfAborted();
        checked.set(sandbox, settings.revision);
        return;
      }
    }
  }
  // applyNetwork rewraps its internal failures, so one umbrella step suffices.
  report("policy_apply");
  await applyNetwork(
    userId,
    saved ? undefined : { policy: DEFAULT_NETWORK_POLICY, expectedRevision: 0 },
    sandbox,
    signal,
  );
}
export const defaultNetworkSettings = (): NetworkSettings => ({
  policy: DEFAULT_NETWORK_POLICY,
  revision: 0,
  status: "ready",
});
