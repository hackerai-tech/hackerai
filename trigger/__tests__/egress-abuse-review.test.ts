/** @jest-environment node */
jest.mock("@trigger.dev/sdk", () => ({
  schemaTask: (definition: unknown) => definition,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  runs: { list: jest.fn(), retrieve: jest.fn() },
  query: { execute: jest.fn() },
}));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));
jest.mock("@/lib/db/service-client", () => ({
  createServiceConvexClient: jest.fn(),
}));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: jest.fn(() => "classifier-model") },
}));
jest.mock("ai", () => ({
  generateText: jest.fn(),
  Output: { object: jest.fn((options: unknown) => options) },
}));
// Run the actual Convex handlers against the in-memory store.
jest.mock("@/convex/lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  action: (config: unknown) => config,
  internalQuery: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));

import { getFunctionName } from "convex/server";
import { generateText } from "ai";
import { logger, query as triggerQuery, runs } from "@trigger.dev/sdk";
import fixture from "@/scripts/egress/tests/credentials.json";
import * as reviewFunctions from "@/convex/egressAbuseReview";
import * as enforcementFunctions from "@/convex/egressAbuseEnforcement";
import * as reassessmentFunctions from "@/convex/egressAbuseReassessment";
import * as reassessmentActions from "@/convex/egressAbuseReassessmentActions";
import { database } from "@/__mocks__/abuse-database";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { createServiceConvexClient } from "@/lib/db/service-client";
import { decryptAbuseEvidence } from "@/lib/abuse/evidence-crypto";
import { recordEgressReviewAcquisition } from "@/lib/abuse/egress-review-context";
import { reviewCooldownKey } from "@/lib/abuse/egress-review-cooldown";
import {
  reviewCaseKey,
  reviewReference,
  reviewWindowStart,
} from "@/lib/abuse/egress-review";
import { registerAttributedWorkspace } from "@/lib/cloud-network/egress-attribution";
import {
  ingestTelemetryBatch,
  telemetryBatchSchema,
} from "@/lib/cloud-network/egress-telemetry";
import {
  egressAbuseReviewTask,
  runEgressAbuseReview,
} from "../egress-abuse-review";
import {
  egressAbuseReassessTask,
  runEgressAbuseReassessment,
} from "../egress-abuse-reassess";

const [first, second, europe] = fixture.vectors;
const REVIEW_KEY = "synthetic-egress-review-key";
const ENFORCEMENT_KEY = "synthetic-egress-enforcement-key";
const CHAT = "chat_review";
const RUN = "run_parent1";
const MINUTE_MS = 60_000;
// Two settled minutes at the start of one 30-minute window.
const MINUTE = reviewWindowStart(Math.floor(Date.now() / MINUTE_MS) - 40) + 1;
const BURST_START = MINUTE * MINUTE_MS;
const reference = reviewReference(
  reviewCaseKey("us", first.owner, reviewWindowStart(MINUTE)),
);
const SCAN = "masscan [test options omitted] 203.0.113.0/24";
const FINAL = { number: 4, max: 4 };
const originalEnv = process.env;

let convex: ReturnType<typeof reviewDatabase>;
let kv: Map<string, string>;
let sets: Map<string, Map<string, number>>;

function reviewDatabase() {
  const ctx = database();
  const query = ctx.db.query.bind(ctx.db);
  (ctx.db as any).query = (table: string) => {
    const chain: any = query(table);
    chain[Symbol.asyncIterator] = async function* () {
      yield* await chain.take(Number.POSITIVE_INFINITY);
    };
    return chain;
  };
  return ctx;
}

function fakeRedis() {
  kv = new Map();
  sets = new Map();
  const read = (key: string) => {
    const value = kv.get(key);
    return value === undefined ? null : JSON.parse(value);
  };
  const zset = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  const redis = {
    set: jest.fn(
      async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && kv.has(key)) return null;
        kv.set(key, value);
        return "OK";
      },
    ),
    get: jest.fn(async (key: string) => read(key)),
    mget: jest.fn(async (...keys: string[]) => keys.map(read)),
    expire: jest.fn(async () => 1),
    zrange: jest.fn(async (key: string) =>
      [...zset(key).entries()]
        .sort((a, b) => a[1] - b[1])
        .flatMap(([member, score]) => [member, score]),
    ),
    // An acquisition record as a plain add; its coalescing script runs
    // against real Redis in scripts/tests/egress-review-acquisition.integration.ts.
    eval: jest.fn(
      async (_script: string, [key]: string[], [prefix, time]: string[]) => {
        zset(key).set(`${prefix}${time}`, Number(time));
        return 1;
      },
    ),
  };
  jest.mocked(createRedisClient).mockReturnValue(redis as never);
  return redis;
}

async function upload(
  counts: Array<[typeof first, number]>,
  minute = MINUTE,
  region: "us" | "eu" = "us",
  droppedEvents = 0,
) {
  const batch = telemetryBatchSchema.parse({
    version: 1,
    region,
    minute,
    complete: true,
    droppedEvents,
    droppedBatches: 0,
    overflowConnections: 0,
    counts: counts.map(([vector, connections]) => ({
      owner: vector.owner,
      workspace: vector.workspace,
      connections,
    })),
  });
  const body = Buffer.from(JSON.stringify(batch));
  await ingestTelemetryBatch(
    createRedisClient() as never,
    batch,
    body,
    minute * MINUTE_MS,
  );
}

async function link(
  runId = RUN,
  runKind: "parent" | "subagent" = "parent",
  chatId = CHAT,
  now = BURST_START - 10 * MINUTE_MS,
) {
  recordEgressReviewAcquisition({
    region: "us",
    userId: first.userId,
    sandboxId: first.sandboxId,
    chatId,
    runId,
    runKind,
    now,
  });
  await new Promise((resolve) => setImmediate(resolve));
}

/** One root run as Trigger lists it: status and timing only. */
const rootRun = (
  id: string,
  timing: { started?: number; finished?: number; status?: string } = {},
) => ({
  id,
  status: timing.status ?? "COMPLETED",
  taskIdentifier: "agent-long",
  tags: [`user_${first.userId}`, `chat_${CHAT}`],
  ...(timing.started !== undefined
    ? { startedAt: new Date(timing.started) }
    : {}),
  ...(timing.finished !== undefined
    ? { finishedAt: new Date(timing.finished) }
    : {}),
});
const selectedRun = rootRun(RUN, {
  started: BURST_START - 5 * MINUTE_MS,
  finished: BURST_START + 10 * MINUTE_MS,
});
function listRootRuns(rows: unknown[], hasNextPage = false) {
  jest.mocked(runs.list).mockReturnValue({
    data: rows,
    hasNextPage: () => hasNextPage,
  } as never);
}

const terminal = (toolCallId: string, command: string) => ({
  type: "tool-run_terminal_cmd",
  toolCallId,
  state: "output-available",
  input: { action: "exec", command },
  output: { result: { processStarted: true, output: "scan results" } },
});

async function seedRun(
  runId = RUN,
  chatId = CHAT,
  options: { active?: boolean; command?: string; message?: string } = {},
) {
  await convex.db.insert("chats", {
    id: chatId,
    user_id: first.userId,
    ...(options.active ? { active_trigger_run_id: runId } : {}),
  });
  await convex.db.insert("messages", {
    id: `${chatId}-user`,
    chat_id: chatId,
    user_id: first.userId,
    role: "user",
    parts: [
      { type: "text", text: options.message ?? "Find open ports for me." },
    ],
  });
  await convex.db.insert("messages", {
    id: `${chatId}-assistant`,
    chat_id: chatId,
    user_id: first.userId,
    role: "assistant",
    trigger_run_id: runId,
    terminal_evidence_state: "complete",
    generation_started_at: BURST_START - 5 * MINUTE_MS,
    ...(options.active ? {} : { generation_time_ms: 15 * MINUTE_MS }),
    parts: [terminal("call-1", options.command ?? SCAN)],
  });
}

const classifyAs = (output: Record<string, unknown>) =>
  jest.mocked(generateText).mockResolvedValue({ output } as never);
const concerning = {
  verdict: "concerning_unauthorized",
  activity: "network_scanning",
  authorization: "not_stated",
  commandIndices: [1],
  messageIndices: [],
};
const caseRecord = () =>
  decryptAbuseEvidence(
    reference,
    convex.tables.abuse_cases[0].ciphertext,
  ) as any;

beforeEach(async () => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true",
    E2B_EGRESS_BURST_THRESHOLD: "800",
    NEXT_PUBLIC_CONVEX_URL: "https://fixture.convex.cloud",
    CONVEX_CLOUD_URL: "https://fixture.convex.cloud",
    CONVEX_SERVICE_ROLE_KEY: "synthetic-main-key",
    CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY: REVIEW_KEY,
    ABUSE_EVIDENCE_KEYS: JSON.stringify({
      active: "k1",
      keys: { k1: "cd".repeat(32) },
    }),
  };
  fakeRedis();
  convex = reviewDatabase();
  const modules: Record<string, any> = {
    egressAbuseReview: reviewFunctions,
    egressAbuseEnforcement: enforcementFunctions,
    egressAbuseReassessment: reassessmentFunctions,
    egressAbuseReassessmentActions: reassessmentActions,
  };
  const call = (reference: unknown, args: unknown): any => {
    const [module, name] = getFunctionName(reference as never).split(":");
    // An action's internal calls run the actual handlers too.
    const ctx = { ...convex, runQuery: call, runMutation: call };
    return modules[module][name].handler(ctx, args);
  };
  jest.mocked(createServiceConvexClient).mockReturnValue({
    query: jest.fn(call),
    mutation: jest.fn(call),
    action: jest.fn(call),
  } as never);
  await upload([[first, 900]]);
  await registerAttributedWorkspace("us", first, first.userId, first.sandboxId);
  listRootRuns([selectedRun]);
});
afterAll(() => {
  process.env = originalEnv;
});

const run = (minute = MINUTE, attempt = FINAL) =>
  runEgressAbuseReview({ region: "us", owner: first.owner, minute }, attempt);
const mutationCalls = () =>
  jest
    .mocked(createServiceConvexClient)
    .mock.results.flatMap(({ value }) => value.mutation.mock.calls);
const recordCaseCalls = () =>
  mutationCalls().filter(
    ([reference]: any) =>
      getFunctionName(reference) === "egressAbuseReview:recordCase",
  );

it("is off by default without reading telemetry or evidence", async () => {
  delete process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED;
  jest.mocked(createRedisClient).mockClear();
  await expect(run()).resolves.toEqual({ status: "disabled" });
  expect(createRedisClient).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
});

it("accepts only opaque references in its payload", () => {
  const schema = (egressAbuseReviewTask as any).schema;
  expect(
    schema.safeParse({ region: "us", owner: first.owner, minute: MINUTE })
      .success,
  ).toBe(true);
  expect(
    schema.safeParse({
      region: "us",
      owner: first.owner,
      minute: MINUTE,
      command: SCAN,
    }).success,
  ).toBe(false);
});

it("saves one encrypted case with an unsent draft for cited concerning activity", async () => {
  await seedRun();
  await link();
  classifyAs(concerning);

  const result = await run();
  expect(result).toEqual({
    status: "completed",
    outcome: "authorization_request",
    reason: "concerning_unauthorized",
    case: "created",
    // The confirmation pass returned nothing valid: no block.
    enforcement: "keep_active",
    enforcementReason: "inconclusive",
  });
  // Output, the RPC arguments and the stored row carry no raw evidence.
  const exposed = JSON.stringify([
    result,
    mutationCalls(),
    convex.tables.abuse_cases,
  ]);
  for (const raw of [SCAN, "203.0.113", "Find open ports", first.userId, CHAT])
    expect(exposed).not.toContain(raw);

  const record = caseRecord();
  expect(record).toMatchObject({
    outcome: "authorization_request",
    account: { verifiedUserId: first.userId, sandboxIds: [first.sandboxId] },
    run: { chatId: CHAT, runId: RUN },
    observation: { region: "us", connections: 900, workspacesCounted: 1 },
    classification: { verdict: "concerning_unauthorized" },
    evidenceLocators: {
      commands: [{ messageId: `${CHAT}-assistant`, toolCallId: "call-1" }],
      messages: [],
    },
    draft: {
      status: "unsent_draft",
      from: "abuse@hackerai.co",
      recipient: { accountId: first.userId },
    },
  });
  expect(record).toMatchObject({
    evidenceMode: "exact_run",
    accountActivity: null,
  });
  // Locators and fixed text only: never the command, prompt or model payload.
  const stored = JSON.stringify(record);
  for (const raw of [SCAN, "203.0.113", "Find open ports", "masscan"])
    expect(stored).not.toContain(raw);

  // The model saw scrubbed evidence only and was given no tools.
  const request = jest.mocked(generateText).mock.calls[0][0] as any;
  expect(request.tools).toBeUndefined();
  expect(request.prompt).toContain("[T1:public-ip]/24");
  expect(request.prompt).not.toContain("203.0.113");
  expect(request.providerOptions.openrouter.provider).toEqual({ zdr: true });

  // Review never restricts, notifies or contains.
  for (const table of [
    "user_suspensions",
    "abuse_notifications",
    "abuse_responses",
  ])
    expect(convex.tables[table] ?? []).toHaveLength(0);

  // Account root runs come from one bounded, account-scoped list in this
  // worker's environment, created by the end of the burst plus clock skew.
  expect(runs.list).toHaveBeenCalledTimes(1);
  expect(runs.list).toHaveBeenCalledWith({
    taskIdentifier: "agent-long",
    tag: `user_${first.userId}`,
    from: 1,
    to: BURST_START + 2 * MINUTE_MS,
    limit: 50,
  });
});

describe("other root runs of the account", () => {
  const competing = (timing: Parameters<typeof rootRun>[1]) =>
    rootRun("run_unlinked", timing);

  it("checks older disjoint rows on a second page before evaluating the selected run", async () => {
    await seedRun();
    await link();
    const getNextPage = jest.fn().mockResolvedValue({
      data: [
        competing({
          started: BURST_START - 120_000,
          finished: BURST_START - 90_000,
        }),
      ],
      hasNextPage: () => false,
    });
    jest.mocked(runs.list).mockReturnValue({
      data: [selectedRun],
      hasNextPage: () => true,
      getNextPage,
    } as never);
    classifyAs(concerning);
    await expect(run()).resolves.toMatchObject({
      outcome: "authorization_request",
    });
    expect(getNextPage).toHaveBeenCalledTimes(1);
  });

  it("waits for recent Trigger history to settle before interpreting an apparent single run", async () => {
    await seedRun();
    await link();
    const clock = jest
      .spyOn(Date, "now")
      .mockReturnValue(BURST_START + 10 * MINUTE_MS);
    try {
      await expect(
        runEgressAbuseReview(
          { region: "us", owner: first.owner, minute: MINUTE },
          { number: 1, max: 4 },
        ),
      ).rejects.toThrow("evidence is still being recorded");
      await expect(run()).resolves.toMatchObject({
        outcome: "manual_review",
        reason: "account_runs_unverified",
      });
      expect(runs.list).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("reviews the selected run when every other run is disjoint", async () => {
    await seedRun();
    await link();
    listRootRuns([
      competing({ started: BURST_START + 3 * MINUTE_MS }),
      selectedRun,
      rootRun("run_earlier", {
        started: BURST_START - 60 * MINUTE_MS,
        finished: BURST_START - 2 * MINUTE_MS,
      }),
      // Cancelled before it ever started.
      rootRun("run_cancelled", { status: "CANCELED" }),
    ]);
    classifyAs(concerning);
    await expect(run()).resolves.toMatchObject({
      outcome: "authorization_request",
      case: "created",
    });
  });

  it.each<[string, () => void, string, string]>([
    [
      "a finished run with no acquisition link that overlapped the burst",
      () =>
        listRootRuns([
          competing({
            started: BURST_START - 20 * MINUTE_MS,
            finished: BURST_START + 30_000,
          }),
          selectedRun,
        ]),
      "multiple_runs",
      "concurrent_root_run",
    ],
    [
      "a run that has not started yet",
      () => listRootRuns([competing({ status: "QUEUED" }), selectedRun]),
      "multiple_runs",
      "concurrent_root_run",
    ],
    [
      "pagination is unavailable",
      () => listRootRuns([selectedRun], true),
      "account_runs_unverified",
      "root_lookup_failed",
    ],
    [
      "more history than the bounded page reads",
      () => {
        const page: any = {
          data: [selectedRun],
          hasNextPage: () => true,
          getNextPage: async () => page,
        };
        jest.mocked(runs.list).mockReturnValue(page);
      },
      "account_runs_unverified",
      "root_page_limit",
    ],
    [
      "a list without the selected run",
      () =>
        listRootRuns([
          competing({
            started: BURST_START - 60 * MINUTE_MS,
            finished: BURST_START - 30 * MINUTE_MS,
          }),
        ]),
      "account_runs_unverified",
      "selected_run_absent",
    ],
    [
      "a selected run Trigger never started",
      () => listRootRuns([rootRun(RUN, { status: "CANCELED" })]),
      "account_runs_unverified",
      "selected_run_not_started",
    ],
    [
      "a row for another account",
      () =>
        listRootRuns([
          selectedRun,
          { ...competing({ status: "CANCELED" }), tags: ["user_someone"] },
        ]),
      "account_runs_unverified",
      "root_row_mismatch",
    ],
    [
      "an unavailable run list",
      () =>
        jest.mocked(runs.list).mockImplementation(() => {
          throw new Error(`list failed for user_${first.userId} ${CHAT}`);
        }),
      "account_runs_unverified",
      "root_lookup_failed",
    ],
  ])(
    "opens a closed manual case for %s",
    async (_label, arrange, reason, detail) => {
      await seedRun();
      await link();
      arrange();
      classifyAs(concerning);
      await expect(run()).resolves.toEqual({
        status: "completed",
        outcome: "manual_review",
        reason,
        case: "created",
        enforcement: "keep_active",
        enforcementReason: "coverage_incomplete",
        diagnostic: {
          detail,
          sandboxes: 1,
          storedLinks: 1,
          runLinks: 1,
          plausibleRuns: 1,
        },
      });
      expect(generateText).not.toHaveBeenCalled();
      const record = caseRecord();
      expect(record).toMatchObject({
        reason,
        draft: null,
        run: { chatId: CHAT, runId: RUN },
        coverage: null,
      });
      // Neither run data nor an SDK error reaches the case or the logs.
      const exposed = JSON.stringify([
        record,
        jest.mocked(logger.info).mock.calls,
        jest.mocked(logger.warn).mock.calls,
        jest.mocked(logger.error).mock.calls,
      ]);
      for (const raw of ["run_unlinked", "list failed", "user_someone"])
        expect(exposed).not.toContain(raw);
    },
  );
});

it("finds a run by its pre-burst acquisition after it re-acquired the workspace", async () => {
  await seedRun();
  await link();
  // Acquired again after the burst; that record must not hide the first.
  await link(RUN, "parent", CHAT, BURST_START + 3 * MINUTE_MS);
  classifyAs(concerning);
  await expect(run()).resolves.toMatchObject({
    outcome: "authorization_request",
    case: "created",
  });
});

it("skips clearly corroborated legitimate work without creating a case", async () => {
  await seedRun(RUN, CHAT, { command: "npm install && npm test" });
  await link();
  classifyAs({
    verdict: "clearly_legitimate",
    activity: "ordinary_development",
    authorization: "not_stated",
    commandIndices: [1],
    messageIndices: [1],
  });
  await expect(run()).resolves.toEqual({
    status: "completed",
    outcome: "no_case",
    reason: "legitimate_corroborated",
    case: "none",
    enforcement: "keep_active",
    enforcementReason: "legitimate_corroborated",
    diagnostic: expect.objectContaining({ cooldownGrant: "granted" }),
  });
  expect(convex.tables.abuse_cases ?? []).toHaveLength(0);
  expect(recordCaseCalls()).toHaveLength(0);
});

it.each([
  ["saved before terminal evidence provenance", undefined],
  ["saved from a browser snapshot", "unverified"],
  ["whose storage compaction lost terminal evidence", "incomplete"],
])(
  "never clears or grants a cooldown for a run row %s",
  async (_label, provenance) => {
    await seedRun(RUN, CHAT, { command: "npm install && npm test" });
    convex.tables.messages.find(
      ({ id }: any) => id === `${CHAT}-assistant`,
    ).terminal_evidence_state = provenance;
    await link();
    classifyAs({
      verdict: "clearly_legitimate",
      activity: "ordinary_development",
      authorization: "not_stated",
      commandIndices: [1],
      messageIndices: [1],
    });
    const result = await run();
    expect(result).toMatchObject({
      status: "completed",
      outcome: "manual_review",
    });
    expect(result.diagnostic?.cooldownGrant).toBeUndefined();
    expect(convex.tables.abuse_cases).toHaveLength(1);
  },
);

it("dedupes a sustained burst into the window's case and preserves operator review", async () => {
  await seedRun();
  await link();
  classifyAs(concerning);
  await run();
  const row = convex.tables.abuse_cases[0];
  const ciphertext = row.ciphertext;
  Object.assign(row, { status: "reviewing", revision: 2 });

  // The next minute of the same burst, now classified differently. The
  // receipt says the case was kept, not what this attempt decided.
  await upload([[first, 1_200]], MINUTE + 1);
  classifyAs({ ...concerning, verdict: "ambiguous" });
  await expect(run(MINUTE + 1)).resolves.toEqual({
    status: "preserved",
    case: "existing",
  });
  expect(convex.tables.abuse_cases).toHaveLength(1);
  expect(convex.tables.abuse_cases[0]).toMatchObject({
    status: "reviewing",
    revision: 2,
    ciphertext,
  });
});

it.each<[string, () => Promise<unknown>, string, string | undefined]>([
  [
    "several plausible runs",
    async () => {
      await seedRun();
      await seedRun("run_parent2", "chat_two");
      await link();
      await link("run_parent2", "parent", "chat_two");
    },
    "multiple_runs",
    "competing_links",
  ],
  [
    "a subagent that may have used the workspace",
    async () => {
      await seedRun();
      await convex.db.insert("subagent_runs", {
        user_id: first.userId,
        chat_id: CHAT,
        parent_trigger_run_id: RUN,
        trigger_run_id: "run_child1",
        status: "running",
        created_at: BURST_START - MINUTE_MS,
      });
      await link();
      await link("run_child1", "subagent");
    },
    "subagent_unresolved",
    "subagent_link",
  ],
  [
    "a counted workspace that is not verified",
    async () => {
      kv.clear();
      await upload([
        [first, 900],
        [second, 50],
      ]);
      await registerAttributedWorkspace(
        "us",
        first,
        first.userId,
        first.sandboxId,
      );
      await seedRun();
      await link();
    },
    "attribution_unverified",
    undefined,
  ],
  [
    "no recorded acquisition",
    async () => seedRun(),
    "no_acquisition_link",
    undefined,
  ],
  [
    "an acquisition that started after the burst",
    async () => {
      await seedRun();
      recordEgressReviewAcquisition({
        region: "us",
        userId: first.userId,
        sandboxId: first.sandboxId,
        chatId: CHAT,
        runId: RUN,
        now: BURST_START + 2 * MINUTE_MS,
      });
      await new Promise((resolve) => setImmediate(resolve));
    },
    "no_acquisition_link",
    undefined,
  ],
  [
    "a deleted linked chat",
    async () => {
      await seedRun();
      convex.tables.chats[0].deletion_started_at = 1;
      await link();
    },
    "evidence_unavailable",
    "linked_chat_unavailable",
  ],
])(
  "creates a manual case without a model call or draft for %s",
  async (_label, arrange, reason, detail) => {
    await arrange();
    classifyAs(concerning);
    const result = await run();
    expect(result).toMatchObject({
      status: "completed",
      outcome: "manual_review",
      reason,
      case: "created",
      enforcement: "keep_active",
      enforcementReason: "coverage_incomplete",
    });
    expect((result as any).diagnostic?.detail).toBe(detail);
    expect(generateText).not.toHaveBeenCalled();
    expect(caseRecord()).toMatchObject({ draft: null, reason });
  },
);

it("waits for an active run and never skips it on partial evidence", async () => {
  await seedRun(RUN, CHAT, {
    active: true,
    command: "npm install && npm test",
  });
  await link();
  classifyAs({
    verdict: "clearly_legitimate",
    activity: "ordinary_development",
    authorization: "not_stated",
    commandIndices: [1],
    messageIndices: [1],
  });
  await expect(run(MINUTE, { number: 1, max: 4 })).rejects.toThrow(
    "still being recorded",
  );
  expect(convex.tables.abuse_cases ?? []).toHaveLength(0);
  await expect(run(MINUTE, FINAL)).resolves.toMatchObject({
    outcome: "manual_review",
    reason: "observation_incomplete",
    case: "created",
    diagnostic: { detail: "evidence_gaps", gaps: ["run_active"] },
  });
});

it("does not open a case for an incomplete telemetry minute", async () => {
  kv.clear();
  const batch = telemetryBatchSchema.parse({
    version: 1,
    region: "us",
    minute: MINUTE,
    complete: false,
    droppedEvents: 3,
    droppedBatches: 0,
    overflowConnections: 0,
    counts: [
      { owner: first.owner, workspace: first.workspace, connections: 900 },
    ],
  });
  await ingestTelemetryBatch(
    createRedisClient() as never,
    batch,
    Buffer.from(JSON.stringify(batch)),
    MINUTE * MINUTE_MS,
  );
  await expect(run()).resolves.toEqual({
    status: "skipped",
    reason: "burst_not_verified",
  });
  expect(convex.tables.abuse_cases ?? []).toHaveLength(0);
  expect(generateText).not.toHaveBeenCalled();
});

it("does not open a case when a replay no longer meets the configured burst threshold", async () => {
  process.env.E2B_EGRESS_BURST_THRESHOLD = "901";
  await expect(run()).resolves.toEqual({
    status: "skipped",
    reason: "burst_not_verified",
  });
  expect(convex.tables.abuse_cases ?? []).toHaveLength(0);
  expect(generateText).not.toHaveBeenCalled();
});

it("records a manual case when the classifier is unavailable", async () => {
  await seedRun();
  await link();
  jest.mocked(generateText).mockRejectedValueOnce(new Error("provider down"));
  await expect(run()).resolves.toMatchObject({
    outcome: "manual_review",
    reason: "classifier_unavailable",
  });
  expect(caseRecord().draft).toBeNull();
});

describe("without an acquisition link", () => {
  /** A recent Agent chat of the account, not linked to the workspace. */
  async function seedAccountChat(
    chatId: string,
    request: string,
    command: string,
    at = BURST_START - 30 * MINUTE_MS,
  ) {
    await convex.db.insert("chats", {
      id: chatId,
      user_id: first.userId,
      update_time: at + MINUTE_MS,
      _creationTime: at - MINUTE_MS,
    });
    await convex.db.insert("messages", {
      id: `${chatId}-user`,
      chat_id: chatId,
      user_id: first.userId,
      role: "user",
      update_time: at - MINUTE_MS,
      _creationTime: at - MINUTE_MS,
      parts: [{ type: "text", text: request }],
    });
    await convex.db.insert("messages", {
      id: `${chatId}-assistant`,
      chat_id: chatId,
      user_id: first.userId,
      role: "assistant",
      trigger_run_id: `run_${chatId}`,
      generation_started_at: at,
      generation_time_ms: 5 * MINUTE_MS,
      update_time: at + 5 * MINUTE_MS,
      _creationTime: at + 5 * MINUTE_MS,
      parts: [terminal("call-1", command)],
    });
  }

  it("writes a manual case when the advisory account read fails", async () => {
    const fixture = createServiceConvexClient("https://fixture.convex.cloud");
    jest
      .mocked(fixture.query)
      .mockRejectedValueOnce(new Error("advisory read unavailable"));
    await expect(run()).resolves.toEqual({
      status: "completed",
      outcome: "manual_review",
      reason: "no_acquisition_link",
      case: "created",
      enforcement: "keep_active",
      enforcementReason: "coverage_incomplete",
      diagnostic: { sandboxes: 1, storedLinks: 0 },
    });
    expect(caseRecord().accountActivity.status).toBe("unavailable");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("flags a separately corroborated concerning chat for manual review without a draft", async () => {
    await seedAccountChat("chat_recent", "Find open ports for me.", SCAN);
    classifyAs(concerning);
    // Unlinked history never reaches the enforcement step.
    process.env.E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED = "true";
    process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY = ENFORCEMENT_KEY;

    const result = await run();
    expect(result).toEqual({
      status: "completed",
      outcome: "manual_review",
      reason: "account_activity_concerning",
      case: "created",
      enforcement: "keep_active",
      enforcementReason: "unlinked_history",
      diagnostic: { sandboxes: 1, storedLinks: 0 },
    });
    const record = caseRecord();
    expect(record).toMatchObject({
      version: 3,
      evidenceMode: "account_activity",
      draft: null,
      run: null,
      model: { promptVersion: "egress-account-activity-review-v1" },
      accountActivity: {
        status: "read",
        coverage: { chatsScanned: 1, chatsOmitted: 0 },
        chats: [
          {
            chatId: "chat_recent",
            runIds: ["run_chat_recent"],
            finding: "concerning_corroborated",
            classification: { verdict: "concerning_unauthorized" },
            locators: {
              commands: [
                { messageId: "chat_recent-assistant", toolCallId: "call-1" },
              ],
              messages: [],
            },
          },
        ],
      },
    });
    const stored = JSON.stringify(record);
    for (const raw of [SCAN, "203.0.113", "Find open ports", "masscan"])
      expect(stored).not.toContain(raw);
    // The model is told the chat is not linked to the alerting workspace.
    const prompt = (jest.mocked(generateText).mock.calls[0][0] as any).prompt;
    expect(prompt).toContain("No record links this chat");
    expect(prompt).not.toContain("203.0.113");
    for (const table of [
      "user_suspensions",
      "abuse_notifications",
      "abuse_responses",
    ])
      expect(convex.tables[table] ?? []).toHaveLength(0);
  });

  it("never clears the burst from legitimate-looking unlinked activity", async () => {
    await seedAccountChat(
      "chat_recent",
      "Run the unit tests.",
      "npm install && npm test",
    );
    classifyAs({
      verdict: "clearly_legitimate",
      activity: "ordinary_development",
      authorization: "not_stated",
      commandIndices: [1],
      messageIndices: [1],
    });
    await expect(run()).resolves.toEqual({
      status: "completed",
      outcome: "manual_review",
      reason: "no_acquisition_link",
      case: "created",
      enforcement: "keep_active",
      enforcementReason: "coverage_incomplete",
      diagnostic: { sandboxes: 1, storedLinks: 0 },
    });
    expect(caseRecord()).toMatchObject({
      draft: null,
      accountActivity: { chats: [{ finding: "inconclusive" }] },
    });
  });

  it("assesses each chat on its own so one chat's scope never covers another", async () => {
    await seedAccountChat(
      "chat_scope",
      "AUTHORIZED SCOPE 203.0.113.0/24",
      "npm test",
      BURST_START - 3 * 60 * MINUTE_MS,
    );
    await seedAccountChat("chat_scan", "Find open ports for me.", SCAN);
    classifyAs({ ...concerning, verdict: "ambiguous" });
    await run();
    const prompts = jest
      .mocked(generateText)
      .mock.calls.map(([request]) => (request as any).prompt as string);
    expect(prompts).toHaveLength(2);
    // Each prompt holds exactly one chat's text.
    expect(prompts.filter((p) => p.includes("AUTHORIZED SCOPE"))).toHaveLength(
      1,
    );
    expect(prompts.filter((p) => p.includes("Find open ports"))).toHaveLength(
      1,
    );
    expect(
      prompts.some(
        (p) => p.includes("AUTHORIZED SCOPE") && p.includes("Find open ports"),
      ),
    ).toBe(false);
    expect(
      caseRecord().accountActivity.chats.map((chat: any) => chat.chatId),
    ).toEqual(["chat_scan", "chat_scope"]);
  });

  it("keeps the neutral case when the privacy guard rejects a chat", async () => {
    // An unterminated quoted value passes the scrubber but not the guard.
    await seedAccountChat(
      "chat_recent",
      "Log in to the box.",
      'curl -d password="unterminated-synthetic-value',
    );
    classifyAs(concerning);
    await expect(run()).resolves.toMatchObject({
      reason: "no_acquisition_link",
    });
    expect(caseRecord()).toMatchObject({
      model: null,
      accountActivity: { chats: [{ finding: "privacy_guard" }] },
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("does not reread account activity once the window's case exists", async () => {
    await seedAccountChat("chat_recent", "Find open ports for me.", SCAN);
    classifyAs(concerning);
    await run();
    jest.mocked(generateText).mockClear();
    const ciphertext = convex.tables.abuse_cases[0].ciphertext;

    await upload([[first, 1_200]], MINUTE + 1);
    await expect(run(MINUTE + 1)).resolves.toEqual({
      status: "preserved",
      case: "existing",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(convex.tables.abuse_cases).toHaveLength(1);
    expect(convex.tables.abuse_cases[0].ciphertext).toBe(ciphertext);
  });
});

describe("automatic enforcement", () => {
  // Synthetic placeholder text stating harm against the scanned range.
  const INTENT = "Synthetic intent: knock 203.0.113.0/24 offline for good.";
  const confirmed = {
    harmfulIntent: "explicit",
    intentKind: "service_disruption",
    voice: "own_request",
    authorizationClaim: "none_stated",
    messageIndices: [1],
    commandIndices: [1],
    targetIds: [1],
  };
  const classifyThenConfirm = (confirmation: Record<string, unknown>) =>
    jest
      .mocked(generateText)
      .mockResolvedValueOnce({
        output: { ...concerning, activity: "denial_of_service" },
      } as never)
      .mockResolvedValueOnce({ output: confirmation } as never);
  const enable = () => {
    process.env.E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED = "true";
    process.env.CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY = ENFORCEMENT_KEY;
  };
  const restrictions = () => convex.tables.user_suspensions ?? [];
  const receipts = () => convex.tables.egress_review_receipts ?? [];

  beforeEach(async () => {
    await seedRun(RUN, CHAT, {
      message: INTENT,
      command: "synthetic recorded disruptive action against 203.0.113.0/24",
    });
    await link();
  });

  it("never blocks a run whose storage compaction lost terminal evidence", async () => {
    enable();
    convex.tables.messages.find(
      ({ id }: any) => id === `${CHAT}-assistant`,
    ).terminal_evidence_state = "incomplete";
    classifyAs({ ...concerning, activity: "denial_of_service" });
    await expect(run()).resolves.toMatchObject({
      status: "completed",
      outcome: "manual_review",
      enforcement: "keep_active",
    });
    expect(restrictions()).toEqual([]);
    expect(convex.tables.abuse_block_notices ?? []).toEqual([]);
  });

  it("blocks the exact run's account and queues one notice when confirmed", async () => {
    enable();
    classifyThenConfirm(confirmed);
    const result = await run();
    expect(result).toEqual({
      status: "completed",
      outcome: "authorization_request",
      reason: "concerning_unauthorized",
      case: "created",
      enforcement: "block_applied",
      enforcementReason: "harmful_intent_confirmed",
      notice: "queued",
    });
    expect(restrictions()).toEqual([
      expect.objectContaining({
        user_id: first.userId,
        status: "active",
        category: "security_abuse",
        source_id: `abuse-late:${reference}`,
      }),
    ]);
    expect(convex.tables.abuse_block_notices).toEqual([
      expect.objectContaining({ status: "pending", reference }),
    ]);
    expect(caseRecord()).toMatchObject({
      outcome: "authorization_request",
      draft: null,
      enforcement: {
        decision: "block_applied",
        intentKind: "service_disruption",
        policyVersion: "egress-enforcement-v1",
        promptVersion: "egress-intent-confirmation-v1",
        locators: {
          messages: [{ messageId: `${CHAT}-user` }],
          commands: [{ messageId: `${CHAT}-assistant`, toolCallId: "call-1" }],
        },
      },
    });
    // The second pass saw the same scrubbed evidence and asked one question.
    const prompt = (jest.mocked(generateText).mock.calls[1][0] as any).prompt;
    expect(prompt).toContain("You check one narrow question");
    expect(prompt).toContain("[T1:public-ip]/24");
    // No raw evidence in the result, any RPC, the stored record or the logs.
    const exposed = JSON.stringify([
      result,
      mutationCalls(),
      convex.tables.abuse_cases,
      caseRecord(),
      jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.warn).mock.calls,
    ]);
    for (const raw of [SCAN, "203.0.113", "knock", "masscan"])
      expect(exposed).not.toContain(raw);
    const logs = JSON.stringify(jest.mocked(logger.info).mock.calls);
    for (const raw of [first.userId, CHAT, RUN])
      expect(logs).not.toContain(raw);
  });

  it("keeps a preserved case from becoming a new pending action", async () => {
    await convex.db.insert("abuse_cases", {
      reference,
      status: "new",
      revision: 0,
    });
    classifyThenConfirm(confirmed);
    await expect(run()).resolves.toEqual({
      status: "preserved",
      case: "existing",
    });
    expect(receipts()).toHaveLength(0);
  });

  it("reports incomplete coverage when preparing the prompt clipped the evidence", async () => {
    const message = convex.tables.messages.find(
      (row: any) => row.role === "user",
    );
    message.parts = [
      { type: "text", text: "synthetic short words ".repeat(100) },
    ];
    await expect(run()).resolves.toMatchObject({
      reason: "observation_incomplete",
    });
    expect(receipts()).toEqual([
      expect.objectContaining({ coverage: "incomplete" }),
    ]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("records a pending case and its owner-summary receipt together", async () => {
    const client = createServiceConvexClient("https://fixture.convex.cloud");
    const mutate = jest.mocked(client.mutation).getMockImplementation()!;
    jest.mocked(client.mutation).mockImplementation(async (fn, args) => {
      if (getFunctionName(fn) === "egressAbuseReview:recordReceipt")
        throw new Error("standalone receipt request failed");
      return mutate(fn, args);
    });
    classifyThenConfirm(confirmed);
    await expect(run()).resolves.toMatchObject({
      enforcement: "enforcement_pending",
      enforcementReason: "enforcement_disabled",
      case: "created",
    });
    expect(restrictions()).toHaveLength(0);
    expect(convex.tables.abuse_block_notices ?? []).toHaveLength(0);
    expect(caseRecord()).toMatchObject({
      draft: null,
      enforcement: { decision: "enforcement_pending" },
    });
    expect(receipts()).toEqual([
      expect.objectContaining({
        reference,
        decision: "enforcement_pending",
        reason: "enforcement_disabled",
        intentKind: "service_disruption",
      }),
    ]);
  });

  it.each([
    [
      "authorization is claimed",
      { authorizationClaim: "claims_authorization" },
    ],
    ["the text is pasted", { voice: "quoted_or_pasted" }],
    ["intent is uncertain", { harmfulIntent: "unclear" }],
    ["the stated target is not the command's", { targetIds: [2] }],
  ])("keeps the account active when %s", async (_label, change) => {
    enable();
    classifyThenConfirm({ ...confirmed, ...change });
    await expect(run()).resolves.toMatchObject({
      enforcement: "keep_active",
      enforcementReason: "intent_not_established",
    });
    expect(restrictions()).toHaveLength(0);
    // The operator draft remains for an unconfirmed concern.
    expect(caseRecord().draft).toMatchObject({ status: "unsent_draft" });
    expect(receipts()).toEqual([
      expect.objectContaining({ decision: "keep_active" }),
    ]);
    expect(receipts()[0].reference).toBeUndefined();
  });

  it("returns the recorded block when a retry follows a lost response", async () => {
    enable();
    const client = createServiceConvexClient("https://fixture.convex.cloud");
    const mutate = jest.mocked(client.mutation).getMockImplementation()!;
    jest
      .mocked(client.mutation)
      .mockImplementationOnce(async (reference: any, args: any) => {
        await mutate(reference, args);
        throw new Error("response lost");
      });
    classifyThenConfirm(confirmed);
    await expect(run(MINUTE, { number: 1, max: 4 })).rejects.toThrow(
      "response lost",
    );
    classifyThenConfirm(confirmed);
    await expect(run()).resolves.toMatchObject({
      case: "existing",
      enforcement: "block_applied",
    });
    expect(restrictions()).toHaveLength(1);
    expect(convex.tables.abuse_block_notices).toHaveLength(1);
  });

  it("records pending enforcement at once when the Convex switch is off", async () => {
    enable();
    const client = createServiceConvexClient("https://fixture.convex.cloud");
    const mutate = jest.mocked(client.mutation).getMockImplementation()!;
    // The deployment's own switch is off while the worker's is still on.
    jest
      .mocked(client.mutation)
      .mockImplementationOnce(async (reference: any, args: any) => {
        process.env.E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED = "false";
        try {
          return await mutate(reference, args);
        } finally {
          process.env.E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED = "true";
        }
      });
    classifyThenConfirm(confirmed);
    await expect(run(MINUTE, { number: 1, max: 4 })).resolves.toMatchObject({
      enforcement: "enforcement_pending",
      enforcementReason: "enforcement_disabled",
      case: "created",
    });
    expect(restrictions()).toHaveLength(0);
  });

  it("leaves a refused block to an operator as pending enforcement", async () => {
    enable();
    await convex.db.insert("abuse_cases", {
      reference: "AB-ffffffff-0123-4abc-8abc-0123456789ab",
      activeContainmentUserId: first.userId,
    });
    classifyThenConfirm(confirmed);
    await expect(run()).resolves.toMatchObject({
      enforcement: "enforcement_pending",
      enforcementReason: "enforcement_refused",
    });
    expect(restrictions()).toHaveLength(0);
    expect(receipts()).toEqual([
      expect.objectContaining({ refusal: "competing_case", reference }),
    ]);
  });
});

describe("closed diagnostics for abstentions", () => {
  it("names a burst split across several sandboxes of the account", async () => {
    kv.clear();
    await upload([
      [first, 500],
      [second, 500],
    ]);
    for (const vector of [first, second])
      await registerAttributedWorkspace(
        "us",
        vector,
        vector.userId,
        vector.sandboxId,
      );
    await expect(run()).resolves.toMatchObject({
      reason: "acquisition_incomplete",
      diagnostic: { detail: "multiple_sandboxes", sandboxes: 2 },
    });
  });

  it("names link history the previous writer trimmed past its bound", async () => {
    // That writer left 17 records and no metadata.
    for (let index = 0; index <= 16; index++) await link(`run_${index}`);
    await expect(run()).resolves.toMatchObject({
      reason: "acquisition_incomplete",
      diagnostic: { detail: "link_history_trimmed", storedLinks: 17 },
    });
  });

  it("still abstains on more than 16 runs in complete expanded history", async () => {
    for (let index = 0; index <= 16; index++) await link(`run_${index}`);
    // Metadata the current writer adds above 16 records: nothing was evicted.
    const [key] = [...sets.keys()].filter((name) =>
      name.startsWith("egress-review:v2:"),
    );
    sets.get(key)!.set("m|0", 0);
    await expect(run()).resolves.toMatchObject({
      reason: "acquisition_incomplete",
      diagnostic: { detail: "too_many_runs", storedLinks: 17, runLinks: 17 },
    });
  });
});

describe("run timeline shadow", () => {
  const legitimate = {
    verdict: "clearly_legitimate",
    activity: "ordinary_development",
    authorization: "not_stated",
    commandIndices: [1],
    messageIndices: [1],
  };
  const cleared = {
    status: "completed",
    outcome: "no_case",
    reason: "legitimate_corroborated",
    case: "none",
    enforcement: "keep_active",
    enforcementReason: "legitimate_corroborated",
    diagnostic: expect.objectContaining({ cooldownGrant: "granted" }),
  };
  /** Routes timeline scripts to `reply`; acquisition links keep the fake. */
  const timelineStore = (reply: () => Promise<unknown>) => {
    const redis = createRedisClient() as any;
    const links = redis.eval.getMockImplementation();
    redis.eval.mockImplementation(
      (script: string, keys: string[], args: string[]) =>
        keys[0].startsWith("egress-review:timeline:")
          ? reply()
          : links(script, keys, args),
    );
    return redis;
  };
  const shadowLog = () =>
    jest
      .mocked(logger.info)
      .mock.calls.find(([message]) => message === "Egress run timeline shadow");

  beforeEach(async () => {
    process.env.E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED = "true";
    await seedRun(RUN, CHAT, { command: "npm install && npm test" });
    await link();
    classifyAs(legitimate);
  });

  it("cannot change the review when its read fails", async () => {
    timelineStore(() => Promise.reject(new Error("store down")));
    await expect(run()).resolves.toEqual(cleared);
    expect(shadowLog()?.[1]).toMatchObject({
      timeline: { status: "unavailable" },
      review: { status: "completed", reason: "legitimate_corroborated" },
    });
  });

  it("logs an aggregate comparison without identifiers", async () => {
    const at = String(BURST_START - 10 * MINUTE_MS);
    timelineStore(async () => [[`p|${CHAT}|${RUN}|${at}`, at], ""]);
    await expect(run()).resolves.toEqual(cleared);
    const [, fields] = shadowLog()!;
    expect(fields).toEqual({
      timeline: expect.objectContaining({
        status: "read",
        assessment: "one_possible",
        parents: 1,
        limitations: [],
      }),
      review: {
        status: "completed",
        outcome: "no_case",
        reason: "legitimate_corroborated",
        runLinks: 1,
        plausibleRuns: 1,
      },
      selectedRun: "listed",
    });
    const exposed = JSON.stringify(fields);
    for (const raw of [CHAT, RUN, first.userId, first.sandboxId, first.owner])
      expect(exposed).not.toContain(raw);
  });

  it("is not read or logged while switched off", async () => {
    delete process.env.E2B_EGRESS_RUN_TIMELINE_SHADOW_ENABLED;
    const redis = timelineStore(async () => [[], ""]);
    await expect(run()).resolves.toEqual(cleared);
    expect(
      redis.eval.mock.calls.some(([, [key]]: [string, string[]]) =>
        key.startsWith("egress-review:timeline:"),
      ),
    ).toBe(false);
    expect(shadowLog()).toBeUndefined();
  });
});

describe("account cooldown after a corroborated legitimate review", () => {
  const legitimate = {
    verdict: "clearly_legitimate",
    activity: "ordinary_development",
    authorization: "not_stated",
    commandIndices: [1],
    messageIndices: [1],
  };
  // The next 30-minute window; by default it has fully settled.
  const NEXT = MINUTE + 29;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    clock = jest.spyOn(Date, "now").mockReturnValue((NEXT + 31) * MINUTE_MS);
  });
  afterEach(() => clock.mockRestore());
  const nextWindow = async (
    peaks: Record<number, number>,
    vector = first,
    region: "us" | "eu" = "us",
  ) => {
    const latest = Math.floor(Date.now() / MINUTE_MS) - 2;
    for (let minute = NEXT; minute <= Math.min(NEXT + 29, latest); minute++)
      await upload(
        peaks[minute] ? [[vector, peaks[minute]]] : [],
        minute,
        region,
      );
  };
  const clear = async () => {
    await seedRun(RUN, CHAT, { command: "npm install && npm test" });
    await link();
    classifyAs(legitimate);
    await expect(run()).resolves.toMatchObject({ outcome: "no_case" });
    jest.mocked(generateText).mockClear();
    jest.mocked(runs.list).mockClear();
  };
  // Every run shares one client fixture.
  const evidenceReads = () =>
    jest.mocked(createServiceConvexClient).mock.results[0].value.query.mock
      .calls.length;

  it("skips a routine burst of the account in a later window before reading evidence", async () => {
    await clear();
    // Below twice the cleared peak (900), though above twice the threshold.
    await nextWindow({ [NEXT]: 1_799 });
    const reads = evidenceReads();
    await expect(run(NEXT)).resolves.toEqual({
      status: "skipped",
      reason: "cooldown_active",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(evidenceReads()).toBe(reads);
    expect(recordCaseCalls()).toHaveLength(0);
  });

  it("applies across regions, keyed by the verified account", async () => {
    await clear();
    await registerAttributedWorkspace(
      "eu",
      europe,
      europe.userId,
      europe.sandboxId,
    );
    await nextWindow({ [NEXT]: 900 }, europe, "eu");
    await expect(
      runEgressAbuseReview(
        { region: "eu", owner: europe.owner, minute: NEXT },
        FINAL,
      ),
    ).resolves.toEqual({ status: "skipped", reason: "cooldown_active" });
  });

  it("reviews a material escalation in full", async () => {
    await clear();
    await nextWindow({ [NEXT]: 1_800 });
    const result = await run(NEXT);
    expect(result).toMatchObject({ status: "completed" });
    expect((result as any).diagnostic.cooldown).toBe("bypassed");
  });

  it("waits before suppressing a queued review and uses the minute that escalated", async () => {
    await clear();
    clock.mockReturnValue((NEXT + 2) * MINUTE_MS);
    await nextWindow({ [NEXT]: 900 });
    await expect(run(NEXT, { number: 1, max: 4 })).rejects.toThrow(
      "evidence is still being recorded",
    );
    expect(generateText).not.toHaveBeenCalled();

    clock.mockReturnValue((NEXT + 31) * MINUTE_MS);
    await nextWindow({ [NEXT]: 900, [NEXT + 1]: 2_000 });
    const result = await run(NEXT);
    expect(result).toMatchObject({ status: "completed" });
    expect((result as any).diagnostic.cooldown).toBe("bypassed");
    const row = convex.tables.abuse_cases[0];
    expect(decryptAbuseEvidence(row.reference, row.ciphertext)).toMatchObject({
      observation: { connections: 2_000 },
    });
  });

  it.each(["missing", "lossy"])(
    "reviews the strongest verified spike with an earlier %s minute",
    async (gap) => {
      await clear();
      await upload([[first, 900]], NEXT);
      if (gap === "lossy") await upload([[first, 3_000]], NEXT + 1, "us", 1);
      await upload([[first, 2_000]], NEXT + 2);
      await expect(run(NEXT)).resolves.toMatchObject({
        status: "completed",
        diagnostic: { cooldown: "bypassed" },
      });
      const row = convex.tables.abuse_cases[0];
      expect(decryptAbuseEvidence(row.reference, row.ciphertext)).toMatchObject(
        {
          observation: { connections: 2_000 },
        },
      );
    },
  );

  it("does not suppress a retry of the review that granted it", async () => {
    await clear();
    await expect(run()).resolves.toMatchObject({
      outcome: "no_case",
      diagnostic: { cooldownGrant: "kept" },
    });
  });

  it("reviews in full when the cooldown cannot be read", async () => {
    await clear();
    await nextWindow({ [NEXT]: 900 });
    const redis = jest.mocked(createRedisClient).mock.results[0].value;
    const mget = redis.mget.getMockImplementation();
    redis.mget.mockImplementation(async (...keys: string[]) => {
      if (keys.includes(reviewCooldownKey(first.userId)))
        throw new Error("store down");
      return mget(...keys);
    });
    const result = await run(NEXT);
    expect(result).toMatchObject({ status: "completed" });
    expect((result as any).diagnostic.cooldown).toBe("unavailable");
  });

  it.each<[string, () => Promise<void>]>([
    [
      "an authorization request",
      async () => {
        await seedRun();
        await link();
        classifyAs(concerning);
      },
    ],
    [
      "an ambiguous classification",
      async () => {
        await seedRun();
        await link();
        classifyAs({ ...legitimate, verdict: "ambiguous" });
      },
    ],
    [
      "incomplete run evidence",
      async () => {
        await seedRun(RUN, CHAT, { active: true });
        await link();
        classifyAs(legitimate);
      },
    ],
    [
      "unlinked account activity that looks legitimate",
      async () => {
        await seedRun(RUN, CHAT, { command: "npm install && npm test" });
        classifyAs(legitimate);
      },
    ],
  ])("is never granted by %s", async (_label, arrange) => {
    await arrange();
    await expect(run()).resolves.toMatchObject({ status: "completed" });
    expect(kv.has(reviewCooldownKey(first.userId))).toBe(false);
    await nextWindow({ [NEXT]: 900 });
    await expect(run(NEXT)).resolves.toMatchObject({ status: "completed" });
  });
});

describe("on-demand reassessment of a retained candidate", () => {
  const reassess = () => runEgressAbuseReassessment({ reference });
  const legitimate = {
    verdict: "clearly_legitimate",
    activity: "ordinary_development",
    authorization: "not_stated",
    commandIndices: [1],
    messageIndices: [1],
  };
  const advisory = {
    status: "completed",
    scope: "retained_candidate_only",
    attribution: "unverified",
    otherCandidates: "unverified",
    determination: "advisory_only",
  };
  const candidateLifecycle = {
    run_id: RUN,
    task_identifier: "agent-long",
    status: "Completed",
    completed_at_s: (BURST_START + 10 * MINUTE_MS) / 1_000,
  };

  /**
   * The actual review keeps the linked run as its candidate while another
   * root chat of the account is still marked active, then abstains: by
   * default because that marker withholds the exact-run read, or, when
   * `arrangeHistory` exceeds the bounded Trigger history, before that read.
   */
  async function retainedCase(
    options: Parameters<typeof seedRun>[2] = {},
    expected: {
      reason: string;
      detail: string;
      arrangeHistory?: () => void;
    } = {
      reason: "multiple_runs",
      detail: "concurrent_run_evidence",
    },
  ) {
    await seedRun(RUN, CHAT, options);
    await convex.db.insert("chats", {
      id: "chat_other",
      user_id: first.userId,
      active_trigger_run_id: "run_other",
    });
    await convex.db.insert("messages", {
      id: "chat_other-user",
      chat_id: "chat_other",
      user_id: first.userId,
      role: "user",
      parts: [{ type: "text", text: "UNRELATED CHAT TEXT" }],
    });
    await link();
    expected.arrangeHistory?.();
    await expect(run()).resolves.toMatchObject({
      outcome: "manual_review",
      reason: expected.reason,
      case: "created",
      diagnostic: { detail: expected.detail },
    });
    expect(caseRecord()).toMatchObject({
      version: 3,
      reason: expected.reason,
      evidenceMode: "none",
      observation: { workspacesCounted: 1 },
      run: { chatId: CHAT, runId: RUN },
      coverage: null,
      evidenceLocators: { commands: [], messages: [] },
    });
    jest.clearAllMocks();
    jest.mocked(triggerQuery.execute).mockResolvedValue({
      format: "json",
      results: [candidateLifecycle],
    });
    return structuredClone(convex.tables.abuse_cases[0]);
  }
  const overlapCase = (options?: Parameters<typeof seedRun>[2]) =>
    retainedCase(options);

  /** Nothing outside the audit read changed, and nothing identifying left. */
  function expectAdvisoryOnly(result: unknown, saved: unknown) {
    expect(convex.tables.abuse_cases).toEqual([saved]);
    expect(
      convex.tables.abuse_events.map(({ actor, kind }: any) => [actor, kind]),
    ).toEqual([
      ["egress_abuse_review", "received"],
      ["egress_abuse_reassessment", "read"],
    ]);
    expect(mutationCalls()).toHaveLength(0);
    expect(kv.has(reviewCooldownKey(first.userId))).toBe(false);
    expect(convex.tables.egress_review_receipts).toHaveLength(1);
    for (const table of [
      "user_suspensions",
      "abuse_block_notices",
      "abuse_notifications",
    ])
      expect(convex.tables[table] ?? []).toHaveLength(0);
    const exposed = JSON.stringify([
      result,
      jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.warn).mock.calls,
    ]);
    for (const raw of [
      first.userId,
      first.sandboxId,
      CHAT,
      RUN,
      `${CHAT}-user`,
      "call-1",
      "203.0.113",
      "masscan",
      "Find open ports",
      "UNRELATED",
    ])
      expect(exposed).not.toContain(raw);
  }

  it("accepts only a case reference", () => {
    const { schema } = egressAbuseReassessTask as any;
    expect(schema.safeParse({ reference }).success).toBe(true);
    for (const payload of [
      { reference, chatId: CHAT },
      { reference, userId: first.userId },
      { reference: "AB-not-a-reference" },
      { region: "us", owner: first.owner, minute: MINUTE },
    ])
      expect(schema.safeParse(payload).success).toBe(false);
  });

  it("reports cited concerning activity of the retained run as advisory only", async () => {
    const saved = await overlapCase();
    classifyAs(concerning);
    const result = await reassess();
    expect(result).toEqual({
      ...advisory,
      coverage: "complete",
      advisory: "concern",
      reason: "concerning_corroborated",
      classification: {
        activity: "network_scanning",
        authorization: "not_stated",
      },
      model: {
        key: "model-grok-4.6",
        promptVersion: "egress-retained-candidate-review-v2",
      },
    });
    // One scrubbed, tool-less, ZDR classification of the candidate only:
    // no intent confirmation, block, draft or other chat.
    expect(generateText).toHaveBeenCalledTimes(1);
    const request = jest.mocked(generateText).mock.calls[0][0] as any;
    expect(request.tools).toBeUndefined();
    expect(request.providerOptions.openrouter.provider).toEqual({ zdr: true });
    expect(request.prompt).toContain(
      "no record shows that this run used the alerting workspace",
    );
    expect(request.prompt).toContain("[T1:public-ip]/24");
    expect(request.prompt).not.toContain("203.0.113");
    expect(request.prompt).not.toContain("UNRELATED");
    expect(caseRecord().draft).toBeNull();
    expectAdvisoryOnly(result, saved);
  });

  it("assesses only the retained candidate of a history-limited case", async () => {
    const saved = await retainedCase(
      {},
      {
        reason: "account_runs_unverified",
        detail: "root_page_limit",
        arrangeHistory: () => {
          const page: any = {
            data: [selectedRun],
            hasNextPage: () => true,
            getNextPage: async () => page,
          };
          jest.mocked(runs.list).mockReturnValue(page);
        },
      },
    );
    classifyAs(concerning);
    const result = await reassess();
    expect(result).toEqual({
      ...advisory,
      coverage: "complete",
      advisory: "concern",
      reason: "concerning_corroborated",
      classification: {
        activity: "network_scanning",
        authorization: "not_stated",
      },
      model: expect.any(Object),
    });
    // The other active root chat stays unread; Trigger history is not re-read.
    expect(generateText).toHaveBeenCalledTimes(1);
    const { prompt } = jest.mocked(generateText).mock.calls[0][0] as any;
    expect(prompt).toContain("Find open ports");
    expect(prompt).not.toContain("UNRELATED");
    expect(runs.list).not.toHaveBeenCalled();
    expectAdvisoryOnly(result, saved);
  });

  it("requests only lifecycle columns without downloading archived run packets", async () => {
    await overlapCase();
    classifyAs(concerning);

    await expect(reassess()).resolves.toMatchObject({ advisory: "concern" });

    expect(triggerQuery.execute).toHaveBeenCalledTimes(1);
    expect(triggerQuery.execute).toHaveBeenCalledWith(
      `SELECT run_id, task_identifier, status, toUnixTimestamp(completed_at) AS completed_at_s FROM runs WHERE run_id = '${RUN}' LIMIT 2`,
      { scope: "environment", from: 1, to: expect.any(Number) },
      { retry: { maxAttempts: 1 } },
    );
    // The pinned SDK's runs.retrieve() automatically resolves payload/output.
    expect(runs.retrieve).not.toHaveBeenCalled();
  });

  it("constrains model citations to the evidence and policy limit before classification", async () => {
    await overlapCase();
    const row = convex.tables.messages.find(
      ({ id }: any) => id === `${CHAT}-assistant`,
    );
    for (let index = 2; index <= 11; index++)
      row.parts.push(terminal(`call-${index}`, "npm test"));
    classifyAs(concerning);

    await expect(reassess()).resolves.toMatchObject({ advisory: "concern" });

    const request = jest.mocked(generateText).mock.calls[0][0] as any;
    const schema = request.output.schema;
    expect(request.prompt).toContain("at most 10 commands and 10 messages");
    expect(
      schema.safeParse({ ...concerning, commandIndices: [1, 11] }).success,
    ).toBe(true);
    for (const citations of [
      { commandIndices: [0] },
      { commandIndices: [12] },
      { messageIndices: [2] },
      { commandIndices: Array.from({ length: 11 }, (_, i) => i + 1) },
    ])
      expect(schema.safeParse({ ...concerning, ...citations }).success).toBe(
        false,
      );
  });

  it("reports corroborated legitimate work without clearing the case or granting a cooldown", async () => {
    const saved = await overlapCase({ command: "npm install && npm test" });
    classifyAs(legitimate);
    const result = await reassess();
    expect(result).toEqual({
      ...advisory,
      coverage: "complete",
      advisory: "neutral",
      reason: "legitimate_corroborated",
      classification: {
        activity: "ordinary_development",
        authorization: "not_stated",
      },
      model: expect.any(Object),
    });
    expectAdvisoryOnly(result, saved);
  });

  it("makes no determination from uncorroborated concern", async () => {
    const saved = await overlapCase();
    classifyAs({ ...concerning, authorization: "unclear" });
    const result = await reassess();
    expect(result).toEqual({
      ...advisory,
      coverage: "complete",
      advisory: "inconclusive",
      reason: "concerning_uncorroborated",
      model: expect.any(Object),
    });
    expectAdvisoryOnly(result, saved);
  });

  it("does not classify incomplete candidate evidence", async () => {
    const saved = await overlapCase();
    // A later failed tool call of the same run leaves its commands incomplete.
    const row = convex.tables.messages.find(
      ({ id }: any) => id === `${CHAT}-assistant`,
    );
    row.parts.push({ ...terminal("call-2", SCAN), state: "output-error" });
    classifyAs(concerning);
    const result = await reassess();
    expect(result).toEqual({
      ...advisory,
      coverage: "incomplete",
      advisory: "inconclusive",
      reason: "evidence_gaps",
      gaps: ["incomplete_tool_calls"],
    });
    expect(generateText).not.toHaveBeenCalled();
    expectAdvisoryOnly(result, saved);
  });

  it.each([
    ["is still executing", { status: "Executing", completed_at_s: null }],
    [
      "finishes after the read starts",
      { completed_at_s: Math.ceil((Date.now() + MINUTE_MS) / 1_000) },
    ],
  ])("does not classify a replaced run that %s", async (_label, lifecycle) => {
    const saved = await overlapCase();
    convex.tables.chats.find(
      ({ id }: any) => id === CHAT,
    ).active_trigger_run_id = "run_successor";
    jest.mocked(triggerQuery.execute).mockResolvedValueOnce({
      format: "json",
      results: [{ ...candidateLifecycle, ...lifecycle }],
    });
    classifyAs(concerning);

    const result = await reassess();

    expect(result).toEqual({
      ...advisory,
      coverage: "incomplete",
      advisory: "inconclusive",
      reason: "candidate_completion_unverified",
    });
    expect(generateText).not.toHaveBeenCalled();
    expectAdvisoryOnly(result, saved);
  });

  it("reports an unavailable candidate without reading other chats", async () => {
    const saved = await overlapCase();
    convex.tables.chats.find(({ id }: any) => id === CHAT).deletion_started_at =
      Date.now();
    const result = await reassess();
    expect(result).toEqual({
      ...advisory,
      coverage: "unavailable",
      advisory: "inconclusive",
      reason: "candidate_unavailable",
    });
    expect(generateText).not.toHaveBeenCalled();
    expectAdvisoryOnly(result, saved);
  });

  it("returns a closed result for an overlap case that kept no candidate", async () => {
    await seedRun();
    await seedRun("run_parent2", "chat_two");
    await link();
    await link("run_parent2", "parent", "chat_two");
    await expect(run()).resolves.toMatchObject({
      reason: "multiple_runs",
      diagnostic: { detail: "competing_links" },
    });
    jest.clearAllMocks();
    await expect(reassess()).resolves.toEqual({
      status: "closed",
      reason: "no_candidate",
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  describe("of competing links with one Convex overlap", () => {
    const OTHER = "run_parent2";
    const OTHER_CHAT = "chat_two";
    /** A linked root run whose stored rows never recorded when it ended. */
    async function seedUnplacedRun() {
      await convex.db.insert("chats", {
        id: OTHER_CHAT,
        user_id: first.userId,
      });
      await convex.db.insert("messages", {
        id: `${OTHER_CHAT}-user`,
        chat_id: OTHER_CHAT,
        user_id: first.userId,
        role: "user",
        parts: [{ type: "text", text: "UNRELATED CHAT TEXT" }],
      });
      await convex.db.insert("messages", {
        id: `${OTHER_CHAT}-assistant`,
        chat_id: OTHER_CHAT,
        user_id: first.userId,
        role: "assistant",
        trigger_run_id: OTHER,
        generation_started_at: BURST_START - 45 * MINUTE_MS,
        parts: [terminal("call-1", "npm test")],
      });
      await link(OTHER, "parent", OTHER_CHAT);
    }
    const reviewQueries = () =>
      jest
        .mocked(createServiceConvexClient)
        .mock.results.flatMap(({ value }) => value.query.mock.calls)
        .map(([fn]: any) => getFunctionName(fn));

    it("keeps the overlapping run as the case's candidate without reading or classifying evidence", async () => {
      await seedRun();
      await link();
      await seedUnplacedRun();
      classifyAs(concerning);
      await expect(run()).resolves.toEqual({
        status: "completed",
        outcome: "manual_review",
        reason: "multiple_runs",
        case: "created",
        enforcement: "keep_active",
        enforcementReason: "coverage_incomplete",
        diagnostic: {
          detail: "competing_links",
          sandboxes: 1,
          storedLinks: 2,
          runLinks: 2,
          plausibleRuns: 2,
        },
      });
      expect(caseRecord()).toMatchObject({
        evidenceMode: "none",
        run: { chatId: CHAT, runId: RUN },
        coverage: null,
        classification: null,
        evidenceLocators: { commands: [], messages: [] },
        draft: null,
      });
      expect(recordCaseCalls()[0][1].receipt).toMatchObject({
        evidenceMode: "none",
        coverage: "not_read",
      });
      expect(reviewQueries()).toEqual([
        "egressAbuseReview:matchRun",
        "egressAbuseReview:matchRun",
      ]);
      expect(runs.list).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
      const saved = structuredClone(convex.tables.abuse_cases[0]);

      // The existing on-demand task reads that candidate only, as advisory.
      jest.clearAllMocks();
      jest.mocked(triggerQuery.execute).mockResolvedValue({
        format: "json",
        results: [candidateLifecycle],
      });
      const result = await reassess();
      expect(result).toEqual({
        ...advisory,
        coverage: "complete",
        advisory: "concern",
        reason: "concerning_corroborated",
        classification: {
          activity: "network_scanning",
          authorization: "not_stated",
        },
        model: expect.any(Object),
      });
      expect(triggerQuery.execute).toHaveBeenCalledWith(
        expect.stringContaining(`WHERE run_id = '${RUN}'`),
        expect.any(Object),
        expect.any(Object),
      );
      const { prompt } = jest.mocked(generateText).mock.calls[0][0] as any;
      expect(prompt).not.toContain("npm test");
      expectAdvisoryOnly(result, saved);
    });

    it("keeps no candidate when the same run is also linked from another chat", async () => {
      await seedRun();
      await link();
      await seedUnplacedRun();
      // The same run ID under another chat, long before the burst.
      await convex.db.insert("chats", {
        id: "chat_three",
        user_id: first.userId,
      });
      await convex.db.insert("messages", {
        id: "chat_three-assistant",
        chat_id: "chat_three",
        user_id: first.userId,
        role: "assistant",
        trigger_run_id: RUN,
        generation_started_at: BURST_START - 3 * 60 * MINUTE_MS,
        generation_time_ms: MINUTE_MS,
        parts: [],
      });
      await link(RUN, "parent", "chat_three", BURST_START - 3 * 60 * MINUTE_MS);
      await expect(run()).resolves.toMatchObject({
        reason: "multiple_runs",
        diagnostic: {
          detail: "competing_links",
          runLinks: 3,
          plausibleRuns: 2,
        },
      });
      expect(caseRecord().run).toBeNull();
      await expect(reassess()).resolves.toEqual({
        status: "closed",
        reason: "no_candidate",
      });
    });
  });

  it("is off with the review switch", async () => {
    await overlapCase();
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED = "false";
    await expect(reassess()).resolves.toEqual({ status: "disabled" });
    expect(convex.tables.abuse_events).toHaveLength(1);
  });
});
