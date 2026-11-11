/** @jest-environment node */
jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));
jest.mock("../lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test-service") throw new Error("Unauthorized");
  },
}));
import * as response from "../abuseResponse";
import * as cases from "../abuseCases";
import * as local from "../localSandbox";
import * as suspensions from "../userSuspensions";
import { database } from "../../__mocks__/abuse-database";

// Synthetic identifiers only. The token value stands in for a credential that
// must never be read back or returned by the operator workflow.
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const otherReference = "AB-123e4567-e89b-42d3-a456-426614174001";
const SYNTHETIC_TOKEN = `hsb_${"ab".repeat(32)}`;
const environmentId = "cafecafe-1234-4123-8123-abcdefabcdef";
const ciphertext = "v1.test.nonce.tag.encrypted";
const NOW = Date.parse("2026-03-01T12:00:00Z");
const base = { serviceKey: "test-service", actor: "operator", reference };
const subject = { userId: "subject", chatId: "chat", transport: "local" };
const run = (fn: unknown, ctx: any, args: any) =>
  (fn as any).handler(ctx, args);
const code = (value: string) => ({ data: { code: value } });

const originalEnv = { ...process.env };
let clock: jest.SpyInstance;
beforeEach(() => {
  process.env.ABUSE_OPERATOR_USER_IDS = "operator,reviewer";
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
  clock = jest.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  clock.mockRestore();
  process.env = { ...originalEnv };
});

function context(user: string | null = "subject") {
  return {
    ...database(),
    auth: { getUserIdentity: async () => (user ? { subject: user } : null) },
  } as any;
}
async function seed(ctx: any, { independent = true } = {}) {
  await ctx.db.insert("abuse_cases", {
    reference,
    digest: "1".repeat(64),
    kind: "abuse",
    ciphertext,
    status: "new",
    revision: 0,
    evidenceHold: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  // The reported run has completed: the chat has no active root.
  await ctx.db.insert("chats", { id: "chat", user_id: "subject" });
  await ctx.db.insert("local_sandbox_tokens", {
    user_id: "subject",
    token: SYNTHETIC_TOKEN,
    token_created_at: NOW,
    updated_at: NOW,
  });
  for (const [user_id, client_version, environment_id] of [
    ["subject", "desktop", environmentId],
    ["subject", "0.9.0", undefined],
    ["other", "0.9.0", undefined],
  ])
    await ctx.db.insert("local_sandbox_connections", {
      user_id,
      connection_id: `${user_id}-${client_version}`,
      environment_id,
      client_version,
      connection_name: "synthetic",
      mode: "dangerous",
      status: "connected",
      last_heartbeat: NOW,
      created_at: NOW,
    });
  await ctx.db.insert("user_suspensions", {
    user_id: "subject",
    source_id: "billing",
    source: "stripe",
    category: "dispute_billing_hold",
    status: "active",
  });
  if (independent)
    await ctx.db.insert("user_suspensions", {
      user_id: "subject",
      source_id: "independent",
      source: "support",
      category: "security_abuse",
      status: "active",
    });
}
async function plan(ctx: any, scope: any = subject, args: any = base) {
  return run(response.plan, ctx, { ...args, ...scope });
}
function applyArgs(
  planDigest: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...base,
    ...subject,
    planDigest,
    requestId: "11111111-2222-4333-8444-555555555555",
    requestDigests: ["a".repeat(64)],
    reviewer: "reviewer",
    reviewDate: "2026-02-28",
    retentionReviewDate: "2026-08-28",
    acknowledgeRestriction: true,
    acknowledgeProcessUnconfirmed: true,
    verifiedFacts: ciphertext,
    decision: ciphertext,
    operationToken: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ...overrides,
  };
}
const nothingChanged = (ctx: any) => {
  expect(ctx.tables.abuse_events ?? []).toEqual([]);
  expect(ctx.tables.abuse_responses ?? []).toEqual([]);
  expect(ctx.tables.user_suspensions.map((row: any) => row.source_id)).toEqual([
    "billing",
    "independent",
  ]);
  expect(ctx.tables.local_sandbox_tokens[0].token).toBe(SYNTHETIC_TOKEN);
  expect(
    ctx.tables.local_sandbox_connections.every(
      (row: any) => row.status === "connected",
    ),
  ).toBe(true);
};

test("apply requires an allowlisted operator and reviewer and valid review dates, and a rejection writes nothing", async () => {
  const ctx = context();
  await seed(ctx);
  const { planDigest } = await plan(ctx);
  await expect(
    run(response.apply, ctx, { ...applyArgs(planDigest), actor: "support" }),
  ).rejects.toThrow("access denied");
  await expect(
    run(response.apply, ctx, applyArgs(planDigest, { reviewer: "support" })),
  ).rejects.toMatchObject(code("ABUSE_REVIEW_REQUIRED"));
  for (const dates of [
    { reviewDate: "2026-03-05" },
    { retentionReviewDate: "2026-02-28" },
    { reviewDate: "2026-02-31" },
  ])
    await expect(
      run(response.apply, ctx, applyArgs(planDigest, dates)),
    ).rejects.toMatchObject(code("ABUSE_INVALID_INPUT"));
  nothingChanged(ctx);
});

test("recorded account, chat and environment ownership are verified, and a changed plan fails closed", async () => {
  const ctx = context();
  await seed(ctx);
  await expect(
    plan(ctx, { ...subject, userId: "other" }),
  ).rejects.toMatchObject(code("ABUSE_SCOPE_MISMATCH"));
  await expect(
    plan(ctx, {
      ...subject,
      environmentId: "cafecafe-1234-4123-8123-000000000000",
    }),
  ).rejects.toMatchObject(code("ABUSE_ENVIRONMENT_UNVERIFIED"));
  // The recorded environment is a Desktop one; a local assertion is a mismatch.
  await expect(plan(ctx, { ...subject, environmentId })).rejects.toMatchObject(
    code("ABUSE_ENVIRONMENT_UNVERIFIED"),
  );
  await expect(
    plan(ctx, { ...subject, transport: "cloud", environmentId }),
  ).rejects.toMatchObject(code("ABUSE_INVALID_INPUT"));
  const desktop = { ...subject, transport: "desktop", environmentId };
  const { planDigest } = await plan(ctx, desktop);
  await run(cases.annotate, ctx, {
    ...base,
    expectedRevision: 0,
    kind: "allegation",
    ciphertext,
  });
  const eventsBefore = ctx.tables.abuse_events.length;
  await expect(
    run(response.apply, ctx, { ...applyArgs(planDigest), ...desktop }),
  ).rejects.toMatchObject(code("ABUSE_PLAN_CHANGED"));
  expect(ctx.tables.abuse_events).toHaveLength(eventsBefore);
  expect(ctx.tables.user_suspensions).toHaveLength(2);
  expect(ctx.tables.local_sandbox_tokens[0].token).toBe(SYNTHETIC_TOKEN);
});

test("one reviewed action records evidence first, restricts only the verified account, revokes local access without returning the token, and keeps independent restrictions", async () => {
  const ctx = context();
  await seed(ctx);
  const planned = await plan(ctx);
  expect(planned).toMatchObject({
    restriction: "create",
    localToken: "active",
    connectedLocalConnections: 2,
    activeRootChats: 0,
  });
  const result = await run(response.apply, ctx, applyArgs(planned.planDigest));
  expect(JSON.stringify(result)).not.toContain(SYNTHETIC_TOKEN);
  expect(result.outcome).toBe("applied");
  expect(ctx.tables.abuse_events.map((row: any) => row.kind)).toEqual([
    "verified_fact",
    "decision",
    "containment_started",
  ]);
  expect(ctx.tables.abuse_events[0].ciphertext).toBe(ciphertext);
  expect(
    ctx.tables.user_suspensions.map((row: any) => [
      row.user_id,
      row.source_id,
      row.category,
      row.source,
      row.status,
    ]),
  ).toEqual([
    ["subject", "billing", "dispute_billing_hold", "stripe", "active"],
    ["subject", "independent", "security_abuse", "support", "active"],
    [
      "subject",
      `abuse-late:${reference}`,
      "security_abuse",
      "support",
      "active",
    ],
  ]);
  const token = ctx.tables.local_sandbox_tokens[0];
  expect(token.token).not.toBe(SYNTHETIC_TOKEN);
  expect(token.revoked_at).toBe(NOW);
  expect(
    ctx.tables.local_sandbox_connections.map((row: any) => [
      row.user_id,
      row.status,
    ]),
  ).toEqual([
    ["subject", "disconnected"],
    ["subject", "disconnected"],
    ["other", "connected"],
  ]);
  expect(ctx.tables.abuse_cases[0]).toMatchObject({
    status: "needs_followup",
    evidenceHold: true,
    activeContainmentUserId: "subject",
  });
  expect(result.response).toMatchObject({
    sourceId: `abuse-late:${reference}`,
    restriction: { result: "created", status: "active" },
    localToken: "revoked",
    localConnections: { disconnected: 2, remaining: false },
    processStop: "unconfirmed",
    contained: false,
    reviewDate: "2026-02-28",
    retentionReviewDate: "2026-08-28",
  });
  expect(result.response.outstanding).toContain("process_stop_unconfirmed");

  // Revocation cannot be bypassed by reissuing a token or a new Desktop session.
  const revoked = code("LOCAL_SANDBOX_ACCESS_REVOKED");
  await expect(run(local.getToken, ctx, {})).rejects.toMatchObject(revoked);
  await expect(run(local.regenerateToken, ctx, {})).rejects.toMatchObject(
    revoked,
  );
  await expect(
    run(local.connectDesktop, ctx, { connectionName: "new", environmentId }),
  ).rejects.toMatchObject(revoked);
  await expect(
    run(local.connect, ctx, {
      token: SYNTHETIC_TOKEN,
      connectionName: "new",
      clientVersion: "0.9.0",
    }),
  ).resolves.toMatchObject({ success: false });
  expect(ctx.tables.local_sandbox_connections).toHaveLength(3);
  const other = context("other");
  other.db = ctx.db;
  await expect(run(local.getToken, other, {})).resolves.toHaveProperty("token");
});

test("Desktop sessions beyond the first disconnect batch cannot refresh or heartbeat while access is revoked", async () => {
  const ctx = context();
  await seed(ctx);
  for (let index = 0; index < 100; index++)
    await ctx.db.insert("local_sandbox_connections", {
      user_id: "subject",
      connection_id: `desktop-${index}`,
      client_version: "desktop",
      connection_name: "synthetic",
      mode: "dangerous",
      status: "connected",
      last_heartbeat: NOW,
      created_at: NOW,
    });
  const { planDigest } = await plan(ctx);
  const result = await run(response.apply, ctx, applyArgs(planDigest));
  expect(result.response.localConnections).toEqual({
    disconnected: 100,
    remaining: true,
  });
  expect(result.response.outstanding).toContain("local_connections_remaining");
  const remaining = ctx.tables.local_sandbox_connections
    .filter((row: any) => row.user_id === "subject")
    .filter((row: any) => row.status === "connected")
    .map((row: any) => row.connection_id);
  expect(remaining).toEqual(["desktop-98", "desktop-99"]);

  const refreshed = await run(local.refreshCentrifugoTokenDesktop, ctx, {
    connectionId: "desktop-98",
  });
  expect(refreshed).toMatchObject({
    ok: false,
    terminated: true,
    reason: "connection_inactive",
    disconnectReason: "token_regenerated",
  });
  await expect(
    run(local.heartbeatDesktop, ctx, { connectionId: "desktop-99" }),
  ).resolves.toEqual({ success: false });
  expect(
    ctx.tables.local_sandbox_connections
      .filter((row: any) => row.user_id === "subject")
      .every((row: any) => row.status === "disconnected"),
  ).toBe(true);
  expect(ctx.tables.local_sandbox_heartbeats ?? []).toEqual([]);
});

test("an existing case-specific restriction is adopted without duplication; a resolved one fails closed", async () => {
  const ctx = context();
  await seed(ctx);
  const manual = await ctx.db.insert("user_suspensions", {
    user_id: "subject",
    source_id: `abuse-late:${reference}`,
    source: "support",
    category: "security_abuse",
    status: "active",
    created_at: 1,
  });
  const planned = await plan(ctx);
  expect(planned.restriction).toBe("adopt");
  const result = await run(response.apply, ctx, applyArgs(planned.planDigest));
  expect(result.response.restriction).toEqual({
    result: "adopted",
    status: "active",
  });
  expect(ctx.tables.user_suspensions).toHaveLength(3);
  expect(ctx.tables.abuse_responses[0].suspensionId).toBe(manual);
  expect((await ctx.db.get(manual)).created_at).toBe(1);

  const resolved = context();
  await seed(resolved);
  await resolved.db.insert("user_suspensions", {
    user_id: "subject",
    source_id: `abuse-late:${reference}`,
    source: "support",
    category: "security_abuse",
    status: "resolved",
  });
  await expect(plan(resolved)).rejects.toMatchObject(
    code("ABUSE_RESTRICTION_CONFLICT"),
  );
});

test("a duplicate or lost apply response resumes the recorded response without duplicating evidence or restrictions", async () => {
  const ctx = context();
  await seed(ctx);
  const { planDigest } = await plan(ctx);
  const args = applyArgs(planDigest);
  await run(response.apply, ctx, args);
  const duplicate = await run(response.apply, ctx, {
    ...args,
    operationToken: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  expect(duplicate).toMatchObject({ outcome: "in_progress" });
  expect(duplicate.operationToken).toBeUndefined();
  await expect(
    run(response.retry, ctx, {
      ...base,
      operationToken: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }),
  ).resolves.toMatchObject({ outcome: "in_progress" });
  await expect(
    run(response.apply, ctx, {
      ...args,
      requestId: "22222222-2222-4333-8444-555555555555",
    }),
  ).rejects.toMatchObject(code("ABUSE_RESPONSE_EXISTS"));
  await expect(
    run(response.apply, ctx, { ...args, requestDigests: ["b".repeat(64)] }),
  ).rejects.toMatchObject(code("ABUSE_RESPONSE_EXISTS"));

  clock.mockReturnValue(NOW + 6 * 60_000);
  const resumed = await run(response.apply, ctx, {
    ...args,
    operationToken: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  expect(resumed).toMatchObject({
    outcome: "resumed",
    operationToken: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  expect(ctx.tables.abuse_responses).toHaveLength(1);
  expect(ctx.tables.user_suspensions).toHaveLength(3);
  expect(ctx.tables.abuse_events.map((row: any) => row.kind).sort()).toEqual([
    "containment_started",
    "containment_started",
    "decision",
    "verified_fact",
  ]);
  // The superseded operation can no longer record receipts.
  await expect(
    run(response.discover, ctx, {
      ...base,
      operationToken: args.operationToken,
    }),
  ).rejects.toMatchObject(code("ABUSE_RESPONSE_LEASE_LOST"));
});

test("discovery pages only currently active owned roots and children, and partial cancellation never reports containment", async () => {
  const ctx = context();
  await seed(ctx);
  for (let index = 0; index < 27; index++)
    await ctx.db.insert("chats", {
      id: `active-${index}`,
      user_id: "subject",
      active_trigger_run_id: `run_root${index}`,
      ...(index === 0 ? { active_agent_approval_session_id: "session" } : {}),
    });
  await ctx.db.insert("chats", {
    id: "foreign",
    user_id: "other",
    active_trigger_run_id: "run_foreign",
  });
  for (const [user_id, status, trigger_run_id] of [
    ["subject", "running", "run_child"],
    ["subject", "queued", undefined],
    ["subject", "completed", "run_done"],
    ["other", "running", "run_foreign_child"],
  ])
    await ctx.db.insert("subagent_runs", {
      user_id,
      chat_id: "active-1",
      subagent_id: `sub-${trigger_run_id}`,
      status,
      trigger_run_id,
    });
  const { planDigest } = await plan(ctx);
  const { operationToken } = await run(
    response.apply,
    ctx,
    applyArgs(planDigest),
  );
  const lease = { ...base, operationToken };
  const first = await run(response.discover, ctx, lease);
  expect(first.phase).toBe("roots");
  expect(first.targets).toHaveLength(25);
  let discovered = first;
  for (let call = 0; discovered.phase !== "done" && call < 10; call++)
    discovered = await run(response.discover, ctx, lease);
  expect(discovered.phase).toBe("done");
  const ids = discovered.targets.map((target: any) => target.runId);
  expect(ids).toHaveLength(28);
  expect(ids).toContain("run_child");
  for (const excluded of ["run_foreign", "run_foreign_child", "run_done"])
    expect(ids).not.toContain(excluded);
  expect(discovered.targets[0]).toMatchObject({
    kind: "root",
    chatId: "active-0",
    approvalSessionId: "session",
    state: "pending",
  });

  await expect(
    run(response.recordTarget, ctx, {
      ...lease,
      operationToken: "dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      runId: "run_root0",
      state: "terminal",
    }),
  ).rejects.toMatchObject(code("ABUSE_RESPONSE_LEASE_LOST"));
  for (const runId of ids)
    await run(response.recordTarget, ctx, {
      ...lease,
      runId,
      state: runId === "run_root1" ? "unknown" : "terminal",
      triggerStatus: "CANCELED",
    });
  // A later uncertain observation never downgrades a terminal receipt.
  await run(response.recordTarget, ctx, {
    ...lease,
    runId: "run_root0",
    state: "unknown",
  });
  await expect(
    run(cases.resolve, ctx, {
      ...base,
      expectedRevision: ctx.tables.abuse_cases[0].revision,
      decision: ciphertext,
    }),
  ).rejects.toThrow("still in progress");
  const finished = await run(response.finish, ctx, lease);
  expect(
    finished.cancellations.find((target: any) => target.runId === "run_root0"),
  ).toMatchObject({ state: "terminal", attempts: 1 });
  expect(finished).toMatchObject({ contained: false, inProgress: false });
  expect(finished.outstanding).toEqual(
    expect.arrayContaining([
      "process_stop_unconfirmed",
      "cancellation_unconfirmed",
    ]),
  );
  expect(ctx.tables.abuse_cases[0].status).toBe("needs_followup");
  await expect(run(response.status, ctx, base)).resolves.toEqual(finished);
});

test.each([
  ["another security restriction remains", true],
  ["no security restriction remains", false],
])(
  "resolution releases only this case's restriction; local access stays revoked while %s",
  async (_label, independent) => {
    const ctx = context();
    await seed(ctx, { independent });
    const { planDigest } = await plan(ctx);
    const { operationToken } = await run(
      response.apply,
      ctx,
      applyArgs(planDigest),
    );
    await run(response.finish, ctx, { ...base, operationToken });
    await run(cases.resolve, ctx, {
      ...base,
      expectedRevision: ctx.tables.abuse_cases[0].revision,
      decision: ciphertext,
    });
    expect(
      ctx.tables.user_suspensions.map((row: any) => [
        row.source_id,
        row.status,
      ]),
    ).toEqual([
      ["billing", "active"],
      ...(independent ? [["independent", "active"]] : []),
      [`abuse-late:${reference}`, "resolved"],
    ]);
    expect(ctx.tables.abuse_cases[0].activeContainmentUserId).toBeUndefined();
    if (independent) {
      await expect(run(local.getToken, ctx, {})).rejects.toMatchObject(
        code("LOCAL_SANDBOX_ACCESS_REVOKED"),
      );
    } else {
      const { token } = await run(local.getToken, ctx, {});
      expect(token).toMatch(/^hsb_/);
      expect(token).not.toBe(SYNTHETIC_TOKEN);
    }
  },
);

test("the active-root containment guard is unchanged and competing cases remain blocked", async () => {
  const ctx = context();
  await seed(ctx);
  await ctx.db.insert("chats", {
    id: "live",
    user_id: "subject",
    active_trigger_run_id: "run_live",
  });
  const { planDigest } = await plan(ctx);
  await run(response.apply, ctx, applyArgs(planDigest));
  const revision = () => ctx.tables.abuse_cases[0].revision;
  const begin = {
    ...base,
    userId: "subject",
    transport: "local",
    preserveSnapshot: false,
    decision: ciphertext,
    operationToken: "owner",
  };
  // A completed historical run still cannot be attached to containment.
  await expect(
    run(cases.beginContainment, ctx, {
      ...begin,
      expectedRevision: revision(),
      chatId: "chat",
      runId: "run_historical",
    }),
  ).rejects.toMatchObject(code("ABUSE_ACTIVE_ROOT_CHANGED"));

  await ctx.db.insert("abuse_cases", {
    reference: otherReference,
    digest: "2".repeat(64),
    kind: "abuse",
    ciphertext,
    status: "reviewing",
    revision: 0,
    evidenceHold: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await run(cases.annotate, ctx, {
    ...base,
    reference: otherReference,
    expectedRevision: 0,
    kind: "verified_fact",
    ciphertext,
  });
  await expect(
    run(cases.beginContainment, ctx, {
      ...begin,
      reference: otherReference,
      expectedRevision: 1,
      chatId: "live",
      runId: "run_live",
    }),
  ).rejects.toThrow("existing active containment");
  await expect(
    plan(ctx, subject, { ...base, reference: otherReference }),
  ).rejects.toMatchObject(code("ABUSE_COMPETING_CASE"));

  // The owning case can still use verified active-root containment.
  const contained = await run(cases.beginContainment, ctx, {
    ...begin,
    expectedRevision: revision(),
    chatId: "live",
    runId: "run_live",
  });
  expect(contained.status).toBe("containing");
});

const resolveSource = (ctx: any, sourceId: string) =>
  run(suspensions.resolveBySource, ctx, {
    serviceKey: "test-service",
    userId: "subject",
    sourceId,
    resolvedReason: "support_review",
  });

test("a case-owned restriction cannot be released under a live lease, and leased steps stop once it is lifted", async () => {
  const ctx = context();
  await seed(ctx);
  const { planDigest } = await plan(ctx);
  const { operationToken } = await run(
    response.apply,
    ctx,
    applyArgs(planDigest),
  );
  const lease = { ...base, operationToken };
  await expect(
    resolveSource(ctx, `abuse-late:${reference}`),
  ).rejects.toMatchObject(code("ABUSE_RESPONSE_BUSY"));
  // Independent holds keep their generic resolution behavior.
  await expect(resolveSource(ctx, "independent")).resolves.toEqual({
    resolved: true,
  });
  expect(ctx.tables.local_sandbox_tokens[0].revoked_at).toBe(NOW);

  // An out-of-band change to the stored restriction stops every leased step
  // that can lead to a Trigger effect; only lease release remains possible.
  const late = ctx.tables.user_suspensions.find(
    (row: any) => row.source_id === `abuse-late:${reference}`,
  );
  late.status = "resolved";
  for (const step of [
    response.checkpoint,
    response.discover,
    response.recordTarget,
  ])
    await expect(
      run(step, ctx, { ...lease, runId: "run_x", state: "terminal" }),
    ).rejects.toMatchObject(code("ABUSE_RESTRICTION_CONFLICT"));
  await expect(run(response.finish, ctx, lease)).resolves.toMatchObject({
    inProgress: false,
    restriction: { status: "resolved" },
  });
  await expect(
    run(response.retry, ctx, {
      ...base,
      operationToken: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }),
  ).rejects.toMatchObject(code("ABUSE_RESTRICTION_CONFLICT"));
});

test("releasing a case restriction after its lease ends restores local access only when no security hold remains", async () => {
  const ctx = context();
  await seed(ctx, { independent: false });
  const { planDigest } = await plan(ctx);
  const { operationToken } = await run(
    response.apply,
    ctx,
    applyArgs(planDigest),
  );
  await run(response.finish, ctx, { ...base, operationToken });
  await expect(resolveSource(ctx, `abuse-late:${reference}`)).resolves.toEqual({
    resolved: true,
  });
  expect(
    ctx.tables.local_sandbox_tokens.filter(
      (row: any) => row.user_id === "subject",
    ),
  ).toEqual([]);
});

test("final resolution of a containment-only case releases a marker left by an earlier late-report case", async () => {
  const ctx = context();
  await seed(ctx);
  await ctx.db.insert("chats", {
    id: "live",
    user_id: "subject",
    active_trigger_run_id: "run_live",
  });
  await ctx.db.insert("local_sandbox_tokens", {
    user_id: "other",
    token: "revoked_synthetic_other",
    token_created_at: NOW,
    updated_at: NOW,
    revoked_at: NOW,
  });
  const { planDigest } = await plan(ctx);
  const { operationToken } = await run(
    response.apply,
    ctx,
    applyArgs(planDigest),
  );
  await run(response.finish, ctx, { ...base, operationToken });
  await run(cases.resolve, ctx, {
    ...base,
    expectedRevision: ctx.tables.abuse_cases[0].revision,
    decision: ciphertext,
  });
  const marker = () =>
    ctx.tables.local_sandbox_tokens.filter(
      (row: any) => row.revoked_at !== undefined,
    );
  // The independent hold keeps the block after the late case resolves.
  expect(marker().map((row: any) => row.user_id)).toEqual(["subject", "other"]);

  await ctx.db.insert("abuse_cases", {
    reference: otherReference,
    digest: "2".repeat(64),
    kind: "abuse",
    ciphertext,
    status: "reviewing",
    revision: 0,
    evidenceHold: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const second = { ...base, reference: otherReference };
  await run(cases.annotate, ctx, {
    ...second,
    expectedRevision: 0,
    kind: "verified_fact",
    ciphertext,
  });
  const contained = await run(cases.beginContainment, ctx, {
    ...second,
    expectedRevision: 1,
    userId: "subject",
    chatId: "live",
    runId: "run_live",
    transport: "local",
    preserveSnapshot: false,
    decision: ciphertext,
    operationToken: "owner",
  });
  await expect(
    resolveSource(ctx, `abuse:${otherReference}`),
  ).rejects.toMatchObject(code("ABUSE_RESPONSE_BUSY"));
  // The containment hold now keeps the block after the independent hold ends.
  await resolveSource(ctx, "independent");
  expect(marker()).toHaveLength(2);
  await run(cases.recordContainment, ctx, {
    ...second,
    operationToken: "owner",
    containment: { ...contained.containment, triggerState: "stopped" },
    finished: true,
  });
  await run(cases.resolve, ctx, {
    ...second,
    expectedRevision: ctx.tables.abuse_cases[1].revision,
    decision: ciphertext,
  });
  expect(marker().map((row: any) => row.user_id)).toEqual(["other"]);
  expect(
    ctx.tables.user_suspensions.map((row: any) => [row.source_id, row.status]),
  ).toEqual([
    ["billing", "active"],
    ["independent", "resolved"],
    [`abuse-late:${reference}`, "resolved"],
    [`abuse:${otherReference}`, "resolved"],
  ]);
});

test("an emailed receipt imports idempotently into an operator-only case without restricting anyone", async () => {
  const ctx = context();
  await ctx.db.insert("abuse_notifications", {
    reference,
    status: "sent",
    attempts: 1,
    updatedAt: NOW,
  });
  const args = {
    ...base,
    kind: "abuse",
    ciphertext,
    digests: ["c".repeat(64), "d".repeat(64)],
  };
  await expect(
    run(response.importCase, ctx, { ...args, actor: "support" }),
  ).rejects.toThrow("access denied");
  await expect(run(response.importCase, ctx, args)).resolves.toEqual({
    outcome: "created",
    revision: 0,
    intakeReceipt: "found",
  });
  // After key rotation the retained key's fingerprint still matches.
  await expect(
    run(response.importCase, ctx, {
      ...args,
      digests: ["e".repeat(64), "c".repeat(64)],
    }),
  ).resolves.toMatchObject({ outcome: "existing" });
  await expect(
    run(response.importCase, ctx, { ...args, digests: ["e".repeat(64)] }),
  ).rejects.toMatchObject(code("ABUSE_IMPORT_CONFLICT"));
  await expect(
    run(response.importCase, ctx, {
      ...args,
      reference: otherReference,
      ciphertext: "v1.retired.nonce.tag.encrypted",
    }),
  ).rejects.toThrow("Invalid encrypted evidence");
  expect(ctx.tables.abuse_cases).toHaveLength(1);
  expect(ctx.tables.abuse_cases[0]).toMatchObject({
    status: "new",
    evidenceHold: true,
  });
  expect(
    ctx.tables.abuse_events.map((row: any) => [row.kind, row.actor]),
  ).toEqual([["received", "operator"]]);
  expect(ctx.tables.user_suspensions).toBeUndefined();

  await run(response.importCase, ctx, {
    ...args,
    reference: otherReference,
    kind: "appeal",
  });
  await ctx.db.insert("chats", { id: "chat", user_id: "subject" });
  await expect(
    plan(ctx, subject, { ...base, reference: otherReference }),
  ).rejects.toMatchObject(code("ABUSE_CASE_UNAVAILABLE"));
});
