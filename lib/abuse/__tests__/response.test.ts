/** @jest-environment node */
jest.mock("@/convex/lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));
jest.mock("@/convex/lib/utils", () => ({
  validateServiceKey: (key: string) => {
    if (key !== "test-service") throw new Error("Unauthorized");
  },
}));
import { getFunctionName } from "convex/server";
import * as abuseResponse from "@/convex/abuseResponse";
import { database } from "@/__mocks__/abuse-database";
import { decryptAbuseEvidence } from "@/lib/abuse/evidence-crypto";
import {
  AbuseResponseInputError,
  applyResponse,
  containsCredential,
  importReport,
  planResponse,
  requestCancellation,
  responseStatus,
  retryResponse,
  type TriggerRun,
} from "../response";
import { startTriggerOperation } from "../trigger-response";

// Synthetic identities only. Convex handlers run against indexed in-memory
// storage; Trigger is faked at its network boundary.
const CONVEX_URL = "https://synthetic-preview.convex.cloud";
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const FACTS =
  "Synthetic verified facts: recorded source port and timestamp match the run.";
const NOW = Date.parse("2026-03-01T12:00:00Z");
const caseFile = {
  operator: "operator",
  reference,
  subject: {
    userId: "subject",
    chatId: "chat",
    runId: "run_hist",
    transport: "local" as const,
  },
};
const importFile = {
  operator: "operator",
  reference,
  kind: "abuse",
  receivedAt: "2026-02-27T09:00:00Z",
  report: {
    target: "synthetic.example",
    description: "Synthetic report of scanning from a hosted agent session.",
  },
};
function applyInput(planDigest: string) {
  return {
    ...caseFile,
    planDigest,
    requestId: "11111111-2222-4333-8444-555555555555",
    review: {
      reviewer: "reviewer",
      reviewDate: "2026-02-28",
      retentionReviewDate: "2026-08-28",
      reason: "Synthetic reviewed decision to restrict the verified account.",
      verifiedFacts: FACTS,
      evidence: [
        {
          source: "synthetic provider record",
          observedAt: "2026-02-27T10:00:00Z",
          summary: "Synthetic connection record.",
        },
      ],
    },
    acknowledge: { accountRestriction: true, processStopUnconfirmed: true },
  };
}

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

function harness() {
  const ctx = {
    ...database(),
    auth: { getUserIdentity: async () => null },
  } as any;
  const calls: Array<{ name: string; args: any }> = [];
  const failures = new Map<string, () => Error>();
  const call = async (reference: any, args: any) => {
    const name = getFunctionName(reference);
    calls.push({ name, args });
    const [module, fn] = name.split(":");
    expect(module).toBe("abuseResponse");
    const result = await (abuseResponse as any)[fn].handler(ctx, args);
    // Simulate a committed mutation whose response is lost in transit.
    const failure = failures.get(fn);
    if (failure) {
      failures.delete(fn);
      throw failure();
    }
    return result;
  };
  const runs: Record<string, TriggerRun> = {
    run_hist: {
      status: "COMPLETED",
      taskIdentifier: "agent-long",
      payload: {
        userId: "subject",
        chatId: "chat",
        convexUrl: CONVEX_URL,
        sandboxPreference: "environment:cafecafe-1234-4123-8123-abcdefabcdef",
      },
    },
  };
  const trigger = {
    retrieveRun: jest.fn(async (runId: string) => {
      if (!runs[runId]) throw new Error("synthetic provider outage");
      return { ...runs[runId] };
    }),
    cancelRun: jest.fn(async (_runId: string) => true),
    closeApprovalSession: jest.fn(async () => true),
  };
  const convex = { query: jest.fn(call), mutation: jest.fn(call) } as any;
  return {
    ctx,
    calls,
    failures,
    runs,
    trigger,
    convex,
    deps: {
      convex,
      serviceKey: "test-service",
      convexUrl: CONVEX_URL,
      ...trigger,
    },
  };
}
async function seedAccount(h: ReturnType<typeof harness>) {
  await importReport(h.deps, importFile);
  await h.ctx.db.insert("chats", { id: "chat", user_id: "subject" });
  await h.ctx.db.insert("local_sandbox_tokens", {
    user_id: "subject",
    token: `hsb_${"cd".repeat(32)}`,
    token_created_at: NOW,
    updated_at: NOW,
  });
}
const root = (chatId: string, user = "subject") => ({
  status: "EXECUTING",
  taskIdentifier: "agent-long",
  payload: { userId: user, chatId, convexUrl: CONVEX_URL },
});

test("partial cancellation failure stays retryable and never reports containment; only verified owned runs are canceled", async () => {
  const h = harness();
  await seedAccount(h);
  for (const [id, runId, session] of [
    ["a", "run_a", "session_a"],
    ["b", "run_b", undefined],
    ["c", "run_c", undefined],
  ])
    await h.ctx.db.insert("chats", {
      id,
      user_id: "subject",
      active_trigger_run_id: runId,
      ...(session ? { active_agent_approval_session_id: session } : {}),
    });
  await h.ctx.db.insert("subagent_runs", {
    user_id: "subject",
    chat_id: "a",
    subagent_id: "sub_1",
    status: "running",
    trigger_run_id: "run_child",
  });
  h.runs.run_a = root("a");
  // Trigger's recorded owner disagrees with the server record.
  h.runs.run_b = root("b", "someone-else");
  h.runs.run_c = root("c");
  h.runs.run_child = {
    status: "EXECUTING",
    taskIdentifier: "hackerai-subagent",
    payload: { subagentId: "sub_1", convexUrl: CONVEX_URL },
  };
  h.trigger.cancelRun.mockImplementation(async (runId: string) => {
    if (runId === "run_c") throw new Error("synthetic private provider detail");
    if (runId === "run_a") h.runs.run_a.status = "CANCELED";
    return true;
  });

  const plan = await planResponse(h.deps, caseFile);
  expect(plan.historicalRun).toEqual({
    verified: true,
    transport: "local",
    status: "COMPLETED",
  });
  const applied = await applyResponse(
    h.deps,
    applyInput(plan.planDigest),
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  const states = (result: any) =>
    Object.fromEntries(
      result.response.cancellations.map((target: any) => [
        target.runId,
        target.state,
      ]),
    );
  expect(states(applied)).toEqual({
    run_a: "terminal",
    run_b: "identity_mismatch",
    run_c: "unknown",
    run_child: "cancel_requested",
  });
  expect(applied.response).toMatchObject({
    contained: false,
    processStop: "unconfirmed",
    inProgress: false,
  });
  expect(applied.response.outstanding).toEqual(
    expect.arrayContaining([
      "process_stop_unconfirmed",
      "cancellation_unconfirmed",
    ]),
  );
  const canceled = h.trigger.cancelRun.mock.calls.map(([runId]) => runId);
  expect(canceled.sort()).toEqual(["run_a", "run_c", "run_child"]);
  expect(h.trigger.closeApprovalSession).toHaveBeenCalledWith(
    "session_a",
    "reviewed_security_abuse",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );

  // Evidence is stored encrypted before any cancellation and is readable by the keyring.
  const applyCall = h.calls.find(({ name }) => name === "abuseResponse:apply")!;
  expect(JSON.stringify(applyCall.args)).not.toContain(FACTS);
  const facts = h.ctx.tables.abuse_events.find(
    (row: any) => row.kind === "verified_fact",
  );
  expect(decryptAbuseEvidence(reference, facts.ciphertext)).toMatchObject({
    facts: FACTS,
    subject: caseFile.subject,
    historicalRun: { verified: true },
  });
  const mutations = h.convex.mutation.mock;
  const applyOrder =
    mutations.invocationCallOrder[
      mutations.calls.findIndex(
        ([fn]: [any]) => getFunctionName(fn) === "abuseResponse:apply",
      )
    ];
  expect(applyOrder).toBeLessThan(
    h.trigger.cancelRun.mock.invocationCallOrder[0],
  );

  // Retry reuses the same response and recorded identities, never the historical run.
  h.trigger.cancelRun.mockReset().mockImplementation(async (runId: string) => {
    h.runs[runId].status = "CANCELED";
    return true;
  });
  h.runs.run_child.status = "CANCELED";
  const retried = await retryResponse(
    h.deps,
    caseFile,
    "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  expect(states(retried)).toEqual({
    run_a: "terminal",
    run_b: "identity_mismatch",
    run_c: "terminal",
    run_child: "terminal",
  });
  expect(h.trigger.cancelRun.mock.calls.map(([runId]) => runId)).toEqual([
    "run_c",
  ]);
  expect(retried.response.contained).toBe(false);
  expect(retried.response.outstanding).toContain("cancellation_unconfirmed");
  expect(h.ctx.tables.abuse_responses).toHaveLength(1);
  await expect(responseStatus(h.deps, caseFile)).resolves.toEqual(
    retried.response,
  );
});

test("approval closure is attempted independently of cancellation, and a terminal run is not finalized until its session is closed", async () => {
  const h = harness();
  await seedAccount(h);
  for (const [id, runId, session] of [
    ["done", "run_done", "session_done"],
    ["live", "run_live", "session_live"],
  ])
    await h.ctx.db.insert("chats", {
      id,
      user_id: "subject",
      active_trigger_run_id: runId,
      active_agent_approval_session_id: session,
    });
  // The root already finished in Trigger but its approval session is still open.
  h.runs.run_done = { ...root("done"), status: "COMPLETED" };
  h.runs.run_live = root("live");
  h.trigger.cancelRun.mockRejectedValue(new Error("synthetic cancel outage"));
  h.trigger.closeApprovalSession.mockImplementation(async (session) => {
    if (session === "session_done") throw new Error("synthetic session outage");
    return true;
  });
  const { planDigest } = await planResponse(h.deps, caseFile);
  const applied = await applyResponse(
    h.deps,
    applyInput(planDigest),
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  const state = (result: any, runId: string) =>
    result.response.cancellations.find((target: any) => target.runId === runId)
      .state;
  expect(state(applied, "run_done")).toBe("unknown");
  expect(state(applied, "run_live")).toBe("unknown");
  // A terminal run is never canceled again; a failed cancel still closes its session.
  expect(h.trigger.cancelRun.mock.calls.map(([runId]) => runId)).toEqual([
    "run_live",
  ]);
  expect(
    h.trigger.closeApprovalSession.mock.calls.map(([id]) => id).sort(),
  ).toEqual(["session_done", "session_live"]);

  h.trigger.closeApprovalSession.mockReset().mockResolvedValue(true);
  h.trigger.cancelRun.mockReset().mockImplementation(async () => {
    h.runs.run_live.status = "CANCELED";
    return true;
  });
  const retried = await retryResponse(
    h.deps,
    caseFile,
    "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  expect(state(retried, "run_done")).toBe("terminal");
  expect(state(retried, "run_live")).toBe("terminal");
  expect(h.trigger.closeApprovalSession).toHaveBeenCalledWith(
    "session_done",
    "reviewed_security_abuse",
    expect.anything(),
  );
  expect(h.trigger.cancelRun.mock.calls.map(([runId]) => runId)).toEqual([
    "run_live",
  ]);
});

test("a lost apply response is resumed by rerunning the same input, without duplicate evidence or cancellation overlap", async () => {
  const h = harness();
  await seedAccount(h);
  await h.ctx.db.insert("chats", {
    id: "a",
    user_id: "subject",
    active_trigger_run_id: "run_a",
  });
  h.runs.run_a = root("a");
  const { planDigest } = await planResponse(h.deps, caseFile);
  h.failures.set("apply", () => new Error("synthetic socket reset"));
  await expect(
    applyResponse(
      h.deps,
      applyInput(planDigest),
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ),
  ).rejects.toThrow("socket reset");
  expect(h.trigger.cancelRun).not.toHaveBeenCalled();
  // The restriction committed; the original lease still excludes another operator.
  const pending = await applyResponse(
    h.deps,
    applyInput(planDigest),
    "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  expect(pending.outcome).toBe("in_progress");
  expect(h.trigger.cancelRun).not.toHaveBeenCalled();

  clock.mockReturnValue(NOW + 6 * 60_000);
  const resumed = await applyResponse(
    h.deps,
    applyInput(planDigest),
    "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  expect(resumed.outcome).toBe("resumed");
  expect(h.trigger.cancelRun).toHaveBeenCalledTimes(1);
  expect(
    h.ctx.tables.abuse_events.filter((row: any) =>
      ["verified_fact", "decision"].includes(row.kind),
    ),
  ).toHaveLength(2);
  expect(
    h.ctx.tables.user_suspensions.filter(
      (row: any) => row.source_id === `abuse-late:${reference}`,
    ),
  ).toHaveLength(1);
});

test("a storage failure while recording a receipt releases the lease so retry can continue", async () => {
  const h = harness();
  await seedAccount(h);
  await h.ctx.db.insert("chats", {
    id: "a",
    user_id: "subject",
    active_trigger_run_id: "run_a",
  });
  h.runs.run_a = root("a");
  const { planDigest } = await planResponse(h.deps, caseFile);
  h.failures.set("recordTarget", () => new Error("synthetic storage outage"));
  await expect(
    applyResponse(
      h.deps,
      applyInput(planDigest),
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ),
  ).rejects.toThrow("storage outage");
  const status = await responseStatus(h.deps, caseFile);
  expect(status).toMatchObject({ inProgress: false, contained: false });
  const retried = await retryResponse(
    h.deps,
    caseFile,
    "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  expect(retried.outcome).toBe("resumed");
});

test.each([
  [
    "missing acknowledgement",
    (input: any) => ({ ...input, acknowledge: { accountRestriction: true } }),
    "invalid_input",
  ],
  [
    "missing verified facts",
    (input: any) => ({
      ...input,
      review: { ...input.review, verifiedFacts: "" },
    }),
    "invalid_input",
  ],
  [
    "a credential in a note",
    (input: any) => ({
      ...input,
      review: {
        ...input.review,
        verifiedFacts: `${FACTS} hsb_${"ef".repeat(32)}`,
      },
    }),
    "credential_in_note",
  ],
])(
  "%s is rejected before any backend or Trigger call",
  async (_label, change, expected) => {
    const h = harness();
    const error = await applyResponse(
      h.deps,
      change(applyInput("f".repeat(64))),
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(AbuseResponseInputError);
    expect(error.code).toBe(expected);
    expect(JSON.stringify(error)).not.toContain("efef");
    expect(h.convex.mutation).not.toHaveBeenCalled();
    expect(h.trigger.retrieveRun).not.toHaveBeenCalled();
  },
);

test.each([
  ["another account", { userId: "someone-else" }],
  ["another deployment", { convexUrl: "https://other.convex.cloud" }],
  ["a Desktop environment", { sandboxPreference: "desktop-environment:x" }],
  ["an unrecorded environment", { sandboxPreference: "conn-legacy" }],
])(
  "a historical run recorded for %s fails closed before planning",
  async (_label, payload) => {
    const h = harness();
    Object.assign(h.runs.run_hist.payload as object, payload);
    await expect(
      planResponse(h.deps, {
        ...caseFile,
        subject: {
          ...caseFile.subject,
          environmentId: "cafecafe-1234-4123-8123-abcdefabcdef",
        },
      }),
    ).rejects.toMatchObject({ code: "historical_run_mismatch" });
    expect(h.convex.query).not.toHaveBeenCalled();
  },
);

test("imports are idempotent for identical receipts and conflict when content changes", async () => {
  const h = harness();
  await expect(importReport(h.deps, importFile)).resolves.toMatchObject({
    outcome: "created",
  });
  await expect(importReport(h.deps, importFile)).resolves.toMatchObject({
    outcome: "existing",
  });
  await expect(
    importReport(h.deps, {
      ...importFile,
      report: { ...importFile.report, target: "changed.example" },
    }),
  ).rejects.toMatchObject({ data: { code: "ABUSE_IMPORT_CONFLICT" } });
  expect(
    decryptAbuseEvidence(reference, h.ctx.tables.abuse_cases[0].ciphertext),
  ).toMatchObject({ source: "email_import", report: importFile.report });
  await expect(
    importReport(h.deps, {
      ...importFile,
      report: { ...importFile.report, evidence: "password: synthetic-value" },
    }),
  ).rejects.toMatchObject({
    code: "credential_in_note",
    fields: ["report.evidence"],
  });
  const credentialSource = "AKIAABCDEFGHIJKLMNOP";
  const error = await importReport(h.deps, {
    ...importFile,
    reference: "AB-123e4567-e89b-42d3-a456-426614174009",
    report: { ...importFile.report, sourceIp: credentialSource },
  }).catch((caught) => caught);
  expect(error).toMatchObject({
    code: "credential_in_note",
    fields: ["report.sourceIp"],
  });
  expect(JSON.stringify(error)).not.toContain(credentialSource);
  expect(h.ctx.tables.abuse_cases).toHaveLength(1);
});

test.each([
  [
    "a child whose Trigger payload names another subagent",
    { taskIdentifier: "hackerai-subagent", payload: { subagentId: "other" } },
    "identity_mismatch",
  ],
  [
    "an already terminal root",
    {
      status: "COMPLETED",
      taskIdentifier: "agent-long",
      payload: { userId: "subject", chatId: "a" },
    },
    "terminal",
  ],
  ["an unreadable run", undefined, "unknown"],
])("cancellation of %s is never requested", async (_label, run, state) => {
  const h = harness();
  if (run) h.runs.run_x = { status: "EXECUTING", ...run };
  const kind = run?.taskIdentifier === "hackerai-subagent" ? "child" : "root";
  await expect(
    requestCancellation(
      h.deps,
      {
        runId: "run_x",
        kind,
        chatId: "a",
        subagentId: "sub_1",
        state: "pending",
      },
      "subject",
      async () => startTriggerOperation(),
    ),
  ).resolves.toMatchObject({ state });
  expect(h.trigger.cancelRun).not.toHaveBeenCalled();
});

// The first observation of run_a is held open; meanwhile the operator's
// authority ends. Its next step must not cancel or close anything.
async function deferredObservation(h: ReturnType<typeof harness>) {
  await seedAccount(h);
  await h.ctx.db.insert("chats", {
    id: "a",
    user_id: "subject",
    active_trigger_run_id: "run_a",
    active_agent_approval_session_id: "session_a",
  });
  h.runs.run_a = root("a");
  const { planDigest } = await planResponse(h.deps, caseFile);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const observing = new Promise<void>((resolve) => (started = resolve));
  let deferred = true;
  const observe = h.trigger.retrieveRun.getMockImplementation()!;
  h.trigger.retrieveRun.mockImplementation(async (runId, operation) => {
    if (runId === "run_a" && deferred) {
      deferred = false;
      started();
      await held;
    }
    return observe(runId, operation);
  });
  const first = applyResponse(
    h.deps,
    applyInput(planDigest),
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  await observing;
  return { first, release };
}

test.each([
  [
    "its lease expired",
    () => clock.mockReturnValue(NOW + 6 * 60_000),
    "ABUSE_RESPONSE_LEASE_LOST",
  ],
  [
    "its restriction was lifted",
    (h: ReturnType<typeof harness>) => {
      h.ctx.tables.user_suspensions.find(
        (row: any) => row.source_id === `abuse-late:${reference}`,
      ).status = "resolved";
    },
    "ABUSE_RESTRICTION_CONFLICT",
  ],
])(
  "an operator whose authority ended because %s during a pending observation sends no Trigger mutation",
  async (_label, interrupt, expected) => {
    const h = harness();
    const { first, release } = await deferredObservation(h);
    interrupt(h);
    release();
    await expect(first).rejects.toMatchObject({ data: { code: expected } });
    expect(h.trigger.cancelRun).not.toHaveBeenCalled();
    expect(h.trigger.closeApprovalSession).not.toHaveBeenCalled();
  },
);

test("a superseded operator cannot repeat effects after the new operator completes", async () => {
  const h = harness();
  const { first, release } = await deferredObservation(h);
  clock.mockReturnValue(NOW + 6 * 60_000);
  const second = await retryResponse(
    h.deps,
    caseFile,
    "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  expect(second.outcome).toBe("resumed");
  expect(h.trigger.cancelRun).toHaveBeenCalledTimes(1);
  expect(h.trigger.closeApprovalSession).toHaveBeenCalledTimes(1);
  release();
  await expect(first).rejects.toMatchObject({
    data: { code: "ABUSE_RESPONSE_LEASE_LOST" },
  });
  expect(h.trigger.cancelRun).toHaveBeenCalledTimes(1);
  expect(h.trigger.closeApprovalSession).toHaveBeenCalledTimes(1);
  // The stale operator's lease release cannot clear another owner's state.
  await expect(responseStatus(h.deps, caseFile)).resolves.toMatchObject({
    inProgress: false,
  });
});

test("each cancellation and approval closure is dispatched only after a fresh server checkpoint", async () => {
  const h = harness();
  await seedAccount(h);
  await h.ctx.db.insert("chats", {
    id: "a",
    user_id: "subject",
    active_trigger_run_id: "run_a",
    active_agent_approval_session_id: "session_a",
  });
  h.runs.run_a = root("a");
  const { planDigest } = await planResponse(h.deps, caseFile);
  const order: string[] = [];
  h.convex.mutation.mockImplementation(async (fn: any, args: any) => {
    order.push(getFunctionName(fn));
    const [, name] = getFunctionName(fn).split(":");
    return (abuseResponse as any)[name].handler(h.ctx, args);
  });
  h.trigger.cancelRun.mockImplementation(async () => {
    order.push("trigger:cancel");
  });
  h.trigger.closeApprovalSession.mockImplementation(async () => {
    order.push("trigger:close");
  });
  await applyResponse(
    h.deps,
    applyInput(planDigest),
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  for (const effect of ["trigger:cancel", "trigger:close"])
    expect(order[order.indexOf(effect) - 1]).toBe("abuseResponse:checkpoint");
});

test("credential screening flags raw credentials but accepts ordinary review prose", () => {
  for (const value of [
    `Authorization: Bearer ${"x".repeat(24)}`,
    "AWS key AKIAABCDEFGHIJKLMNOP observed",
    "-----BEGIN RSA PRIVATE KEY-----",
    `tr_prod_${"a".repeat(20)}`,
  ])
    expect(containsCredential(value)).toBe(true);
  expect(
    containsCredential(
      "Verified source port 51234 at 10:02 UTC against the recorded run region.",
    ),
  ).toBe(false);
});
