import {
  prepareMiosaRetirement,
  RETIRE_MIOSA_LUA,
} from "./lib/retire-miosa-workspace.mjs";
// Exercise the actual production Lua against isolated Redis, including both
// serializations of confirmation racing admission. No provider calls or credentials.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const guard = readFileSync(
  new URL("../lib/ai/tools/utils/cloud-workspace-guard.ts", import.meta.url),
  "utf8",
);
const store = readFileSync(
  new URL("../lib/cloud-recovery/store.ts", import.meta.url),
  "utf8",
);
const scripts = (source, name) =>
  [
    ...source
      .slice(source.indexOf(`export async function ${name}(`))
      .matchAll(/\.eval\(\s*`([\s\S]*?)`/g),
  ].map((match) => match[1]);
const selection = readFileSync(
  new URL(
    "../lib/ai/tools/utils/cloud-workspace-selection.ts",
    import.meta.url,
  ),
  "utf8",
);
const [selectionLua] = scripts(selection, "selectWorkspaceRegion");
assert.ok(selectionLua);
const [admitLua] = scripts(guard, "assertCloudWorkspaceAvailable");
const [confirmLua] = scripts(store, "decideConsent");
const [failLua] = scripts(store, "failConsent");
const [retryLua] = scripts(store, "retryPreflightConsent");
const [reconcileLua] = scripts(store, "reconcileLegacyPreflightFailure");
const [claimLua, updateLua, finishLua, cancelLua] = scripts(
  guard,
  "claimE2BDiskRecovery",
);
const [cleanupLua, cleanupFinishLua] = scripts(
  guard,
  "claimCloudWorkspaceCleanup",
);
for (const lua of [
  admitLua,
  confirmLua,
  claimLua,
  finishLua,
  cleanupLua,
  cleanupFinishLua,
])
  assert.ok(lua);
const dir = mkdtempSync(join(tmpdir(), "cloud-recovery-admission-"));
const socket = join(dir, "redis.sock");
const server = spawn(
  "redis-server",
  [
    "--port",
    "0",
    "--unixsocket",
    socket,
    "--unixsocketperm",
    "700",
    "--save",
    "",
    "--appendonly",
    "no",
  ],
  { stdio: "ignore" },
);
let startupError;
server.on("error", (error) => {
  startupError = error;
});
const command = (...args) =>
  JSON.parse(
    execFileSync("redis-cli", ["-s", socket, "--json", ...args.map(String)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
const keys = {
  workspace: "workspace",
  activity: "activity",
  consent: "consent",
  result: "result",
  region: "region",
};
const target = { sandboxId: "original-files", region: "us-east-1" };
const offered = {
  token: "consent-token",
  status: "offered",
  target,
  issuedAt: 100,
};
const restored = {
  version: 1,
  phase: "e2b",
  token: "owner",
  sourceId: target.sandboxId,
  destinationId: target.sandboxId,
  region: target.region,
};
const recovery = {
  version: 1,
  phase: "recovery",
  token: offered.token,
  sandboxId: target.sandboxId,
  region: target.region,
};
const set = (key, value) => command("SET", key, JSON.stringify(value));
const get = (key) => {
  const value = command("GET", key);
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const evalLua = (lua, selectedKeys, args) =>
  command("EVAL", lua, selectedKeys.length, ...selectedKeys, ...args);
const admit = (id = "") =>
  evalLua(
    admitLua,
    [keys.workspace, keys.activity, keys.consent, keys.result],
    [900, id],
  );
const confirm = (yes = true) =>
  evalLua(
    confirmLua,
    [keys.consent, keys.activity, keys.workspace],
    [
      offered.token,
      JSON.stringify({ ...offered, status: yes ? "confirmed" : "declined" }),
      offered.issuedAt,
      yes ? "1" : "0",
    ],
  );
const cleanup = { version: 1, phase: "cleanup", token: "cleanup-owner" };
const claimCleanup = (previous = "") =>
  evalLua(
    cleanupLua,
    [keys.workspace, keys.consent, keys.result],
    [previous, JSON.stringify(cleanup)],
  );
const finishCleanup = (success, previous = "") =>
  evalLua(
    cleanupFinishLua,
    [keys.workspace, keys.region],
    [JSON.stringify(cleanup), previous, success ? "1" : "0"],
  );
const reset = () => {
  command("FLUSHDB");
  set(keys.consent, offered);
};
try {
  for (let i = 0; i < 100; i++) {
    if (startupError) throw startupError;
    try {
      if (command("PING") === "PONG") break;
    } catch {}
    if (i === 99) throw new Error("Local Redis failed to start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Execute the real selection CAS: a second tab and concurrent preservation
  // fences must never replace the winning workspace binding.
  const selectionKeys = [
    "selection-region",
    "selection-migration",
    "selection-failures",
    "selection-consent",
    "selection-result",
  ];
  const selectRegion = (region) =>
    command(
      "EVAL",
      selectionLua,
      selectionKeys.length,
      ...selectionKeys,
      region,
    );
  command("DEL", ...selectionKeys);
  assert.equal(selectRegion("eu-central-1"), 1);
  assert.equal(selectRegion("us-east-1"), 0);
  assert.equal(command("GET", selectionKeys[0]), "eu-central-1");
  assert.equal(command("TTL", selectionKeys[0]), -1);
  for (const fence of selectionKeys.slice(1)) {
    command("DEL", ...selectionKeys);
    command("SET", fence, "preserved");
    assert.equal(selectRegion("us-east-1"), 0);
    assert.equal(command("GET", selectionKeys[0]), null);
    assert.equal(command("GET", fence), "preserved");
  }
  command("DEL", ...selectionKeys);
  reset();
  assert.equal(confirm(), 1);
  assert.equal(
    admit(),
    0,
    "confirmed recovery must block a newly arriving Agent",
  );
  assert.equal(
    command("GET", keys.activity),
    null,
    "rejected admission must not poison the recovery idle window",
  );
  assert.equal(
    claimCleanup(),
    0,
    "confirmation must also preserve files against cleanup",
  );
  assert.equal(
    confirm(),
    0,
    "a duplicate confirmation cannot dispatch another recovery",
  );
  assert.equal(
    evalLua(
      claimLua,
      [keys.workspace, keys.activity, keys.result, keys.consent],
      [
        "",
        JSON.stringify(recovery),
        offered.token,
        offered.token,
        target.sandboxId,
        target.region,
      ],
    ),
    1,
  );
  assert.equal(get(keys.consent).status, "executing");
  assert.equal(admit(), 0);
  assert.equal(
    command("TTL", keys.workspace),
    -1,
    "interrupted recovery must retain its fence indefinitely",
  );
  const result = { token: offered.token, status: "verified_ready", ...target };
  assert.equal(
    evalLua(
      finishLua,
      [keys.workspace, keys.result],
      [
        JSON.stringify(recovery),
        JSON.stringify(restored),
        JSON.stringify(result),
      ],
    ),
    1,
  );
  assert.equal(admit("other-files"), 0);
  assert.equal(
    admit(target.sandboxId),
    1,
    "verified recovery must allow its original files to reconnect",
  );
  set(keys.consent, {
    ...offered,
    status: "executing",
    target: { sandboxId: target.sandboxId },
  });
  set(keys.result, {
    token: offered.token,
    status: "verified_ready",
    sandboxId: target.sandboxId,
  });
  assert.equal(
    admit(target.sandboxId),
    0,
    "missing region is not a verified recovery receipt",
  );
  assert.equal(claimCleanup(JSON.stringify(restored)), 0);
  set(keys.consent, { ...offered, status: "executing" });
  set(keys.result, { ...result, token: "other-consent" });
  assert.equal(
    admit(target.sandboxId),
    0,
    "a stale receipt must not release consent",
  );

  reset();
  assert.equal(admit(), 1);
  assert.equal(
    confirm(),
    0,
    "Cloud admission winning first must keep confirmation unconsumed",
  );
  assert.equal(get(keys.consent).status, "offered");
  assert.equal(confirm(false), 1, "declining does not require idle Cloud work");
  assert.ok(command("TTL", keys.activity) > 0);
  reset();
  assert.equal(claimCleanup(), 1);
  assert.equal(confirm(), 0, "cleanup winning first must prevent confirmation");
  set(keys.region, "eu-central-1");
  assert.equal(finishCleanup(false), 1);
  assert.equal(
    get(keys.region),
    "eu-central-1",
    "partial cleanup preserves placement",
  );
  assert.equal(claimCleanup(), 1);
  set(keys.workspace, { ...cleanup, token: "other-owner" });
  assert.equal(finishCleanup(true), 0);
  assert.equal(
    get(keys.region),
    "eu-central-1",
    "lost ownership cannot reset routing",
  );
  set(keys.workspace, cleanup);
  assert.equal(finishCleanup(true), 1);
  assert.equal(
    command("GET", keys.region),
    null,
    "only successful owned cleanup may reset routing",
  );

  reset();
  set(keys.consent, { ...offered, status: "executing" });
  set(keys.result, result);
  set(keys.workspace, restored);
  set(keys.region, "us-east-1");
  assert.equal(claimCleanup(JSON.stringify(restored)), 1);
  assert.equal(finishCleanup(true), 1);
  assert.equal(
    admit(),
    1,
    "a completed recovery receipt must not strand a later authorized fresh workspace",
  );
  const fail = () =>
    evalLua(
      failLua,
      [keys.consent, keys.workspace, keys.result],
      [offered.token],
    );
  const retry = () =>
    evalLua(
      retryLua,
      [
        keys.consent,
        keys.workspace,
        keys.result,
        keys.activity,
        "attempt-archive",
      ],
      [
        offered.token,
        JSON.stringify({ ...offered, token: "fresh-consent", issuedAt: 200 }),
      ],
    );
  const claimRecovery = () =>
    evalLua(
      claimLua,
      [keys.workspace, keys.activity, keys.result, keys.consent],
      [
        "",
        JSON.stringify(recovery),
        offered.token,
        offered.token,
        target.sandboxId,
        target.region,
      ],
    );
  reset();
  assert.equal(confirm(), 1);
  assert.equal(fail(), 1);
  assert.equal(get(keys.consent).failurePhase, "before_reboot");
  const failedReceipt = get(keys.consent);
  assert.equal(
    claimRecovery(),
    0,
    "a late dispatch cannot use failed approval",
  );
  assert.equal(retry(), 1);
  assert.deepEqual(get("attempt-archive"), failedReceipt);
  assert.equal(get(keys.consent).token, "fresh-consent");
  assert.equal(get(keys.consent).status, "offered");
  assert.equal(get(keys.consent).confirmedAt, undefined);
  assert.equal(
    claimRecovery(),
    0,
    "old worker cannot consume fresh unapproved offer",
  );
  assert.equal(retry(), 0, "concurrent status reads rotate only once");
  assert.equal(fail(), 0, "late failure cannot poison a newer approval");
  assert.equal(get(keys.consent).status, "offered");

  reset();
  assert.equal(confirm(), 1);
  assert.equal(claimRecovery(), 1);
  assert.equal(fail(), 1);
  assert.equal(get(keys.consent).failurePhase, "reboot_or_unknown");
  assert.equal(
    retry(),
    0,
    "claim winning before failure must never enable another reboot",
  );
  assert.deepEqual(get(keys.workspace), recovery);
  for (const blocker of [
    keys.workspace,
    keys.result,
    keys.activity,
    "attempt-archive",
  ]) {
    reset();
    set(keys.consent, failedReceipt);
    set(blocker, { owner: "other" });
    assert.equal(retry(), 0, `preserve ${blocker} before renewal`);
    assert.deepEqual(get(keys.consent), failedReceipt);
  }
  for (const phase of [undefined, "reboot_or_unknown"]) {
    reset();
    set(keys.consent, { ...failedReceipt, failurePhase: phase });
    assert.equal(
      retry(),
      0,
      "historical and uncertain failures require review",
    );
  }
  reset();
  set(keys.consent, {
    ...failedReceipt,
    target: { ...target, sandboxId: "other" },
  });
  assert.equal(retry(), 0, "retry must retain exact target");

  for (const previous of [null, restored]) {
    reset();
    set(keys.consent, { ...offered, status: "executing" });
    set(keys.workspace, recovery);
    const cancel = () =>
      evalLua(
        cancelLua,
        [keys.workspace, keys.consent],
        [
          JSON.stringify(recovery),
          offered.token,
          previous ? JSON.stringify(previous) : "",
        ],
      );
    assert.equal(
      cancel(),
      1,
      "pre-reboot owner can restore the prior routing record",
    );
    assert.deepEqual(get(keys.workspace), previous);
    assert.equal(get(keys.consent).failurePhase, "before_reboot");
    assert.equal(
      retry(),
      1,
      "pre-reboot failure can request fresh approval with or without existing routing",
    );
    assert.equal(claimRecovery(), 0);
  }
  reset();
  set(keys.consent, { ...offered, status: "executing" });
  set(keys.workspace, recovery);
  const marker = { ...recovery, step: "reboot_requested" };
  assert.equal(
    evalLua(
      updateLua,
      [keys.workspace],
      [JSON.stringify(recovery), JSON.stringify(marker)],
    ),
    1,
  );
  assert.equal(
    evalLua(
      cancelLua,
      [keys.workspace, keys.consent],
      [JSON.stringify(marker), offered.token, ""],
    ),
    0,
    "even the matching owner cannot undo the durable reboot boundary",
  );
  assert.equal(get(keys.consent).status, "executing");
  assert.deepEqual(get(keys.workspace), marker);
  reset();
  set(keys.consent, { ...offered, status: "confirmed" });
  set(keys.workspace, restored);
  set(keys.result, {
    ...target,
    token: "previous-completed-attempt",
    status: "verified_ready",
  });
  assert.equal(fail(), 1);
  assert.equal(get(keys.consent).failurePhase, "before_reboot");
  assert.equal(
    retry(),
    1,
    "a prior completed recovery does not prevent a new preflight retry",
  );
  assert.deepEqual(get(keys.workspace), restored);

  const historical = { ...offered, status: "failed" };
  const historicalRaw = JSON.stringify(historical);
  const reconcile = () =>
    evalLua(
      reconcileLua,
      [
        keys.consent,
        keys.workspace,
        keys.result,
        keys.activity,
        "review-archive",
      ],
      [
        historicalRaw,
        JSON.stringify({
          receipt: historical,
          evidence: "synthetic verified review",
        }),
      ],
    );
  reset();
  set(keys.consent, historical);
  assert.equal(reconcile(), 1);
  assert.equal(get(keys.consent).failurePhase, "before_reboot");
  assert.equal(
    get(keys.consent).token,
    historical.token,
    "review never grants or dispatches consent",
  );
  assert.deepEqual(get("review-archive").receipt, historical);
  assert.equal(reconcile(), 0);
  for (const blocker of [
    keys.workspace,
    keys.result,
    keys.activity,
    "review-archive",
  ]) {
    reset();
    set(keys.consent, historical);
    set(blocker, { owner: "other" });
    assert.equal(reconcile(), 0);
    assert.deepEqual(get(keys.consent), historical);
  }
  reset();
  set(keys.consent, { ...historical, token: "changed" });
  assert.equal(
    reconcile(),
    0,
    "operator reconciliation must compare the complete receipt",
  );
  console.log(
    "PASS preflight failure renewal, obsolete workers, ambiguous outcomes and audited legacy reconciliation",
  );

  const legacy = {
    version: 1,
    phase: "cleanup",
    token: "old-owner",
    recovery: {
      operation: "miosa-to-e2b",
      e2bId: "old-files",
      phase: "destination_staged",
    },
  };
  const retirementId = "12345678-1234-1234-1234-123456789abc";
  const retirementInput = {
    userId: "user_retirement",
    expectedRaw: JSON.stringify(legacy),
    sandboxInfo: {
      sandboxId: "fresh-files",
      state: "paused",
      lifecycle: { onTimeout: "pause" },
      metadata: { userID: "user_retirement", miosaRetirementId: retirementId },
    },
    region: "us-east-1",
    retirementId,
    providerRetirementAuthorized: true,
  };
  const plan = prepareMiosaRetirement(retirementInput);
  const retire = () => evalLua(RETIRE_MIOSA_LUA, plan.keys, plan.args);
  const resetRetirement = () => {
    command("DEL", ...plan.keys);
    set(plan.keys[0], legacy);
  };
  resetRetirement();
  assert.equal(retire(), "retired");
  assert.deepEqual(
    get(plan.keys[5]),
    legacy,
    "exact original fence is archived",
  );
  assert.equal(get(plan.keys[0]).destinationId, "fresh-files");
  assert.equal(get(plan.keys[4]), "us-east-1");
  assert.equal(
    retire(),
    "state_changed",
    "repeated retirement cannot replace the new workspace",
  );
  for (const index of [1, 2, 3]) {
    resetRetirement();
    set(plan.keys[index], { active: true });
    assert.equal(retire(), "busy");
    assert.deepEqual(get(plan.keys[0]), legacy);
    assert.equal(get(plan.keys[5]), null);
  }
  resetRetirement();
  set(plan.keys[6], { sandboxId: "other" });
  assert.equal(retire(), "recovery_changed");
  resetRetirement();
  set(plan.keys[4], "eu-central-1");
  assert.equal(retire(), "region_conflict");
  resetRetirement();
  set(plan.keys[0], { ...legacy, phase: "deleted" });
  assert.equal(retire(), "state_changed");
  for (const invalid of [
    { ...legacy, phase: "deleted" },
    { ...legacy, recovery: { operation: "e2b-disk-recovery" } },
    { ...legacy, phase: "recovery" },
  ])
    assert.throws(() =>
      prepareMiosaRetirement({
        ...retirementInput,
        expectedRaw: JSON.stringify(invalid),
      }),
    );
  assert.throws(() =>
    prepareMiosaRetirement({
      ...retirementInput,
      providerRetirementAuthorized: false,
    }),
  );
  assert.throws(() =>
    prepareMiosaRetirement({
      ...retirementInput,
      sandboxInfo: {
        ...retirementInput.sandboxInfo,
        metadata: { userID: "user_other" },
      },
    }),
  );
  const existing = { ...restored, recoveryPending: legacy };
  const existingInput = {
    ...retirementInput,
    expectedRaw: JSON.stringify(existing),
    sandboxInfo: {
      ...retirementInput.sandboxInfo,
      sandboxId: restored.destinationId,
    },
  };
  const existingPlan = prepareMiosaRetirement(existingInput);
  command("DEL", ...existingPlan.keys);
  set(existingPlan.keys[0], existing);
  assert.equal(
    evalLua(RETIRE_MIOSA_LUA, existingPlan.keys, existingPlan.args),
    "retired",
  );
  assert.deepEqual(
    get(existingPlan.keys[0]),
    restored,
    "existing E2B identity is unchanged",
  );
  assert.throws(() =>
    prepareMiosaRetirement({ ...existingInput, region: "eu-central-1" }),
  );
  console.log(
    "PASS Miosa retirement archives fences, preserves current E2B, and rejects active recovery or concurrent changes",
  );
  console.log(
    "PASS confirmation/admission race in both orders, recovery claim/reconnect, cleanup fencing, and durable routing reset",
  );
} finally {
  try {
    command("SHUTDOWN", "NOSAVE");
  } catch {}
  server.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}
