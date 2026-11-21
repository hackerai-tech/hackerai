/** @jest-environment node */
jest.mock("@trigger.dev/sdk", () => ({
  schemaTask: (definition: unknown) => definition,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
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
}));

import { getFunctionName } from "convex/server";
import { generateText } from "ai";
import fixture from "@/scripts/egress/tests/credentials.json";
import * as reviewFunctions from "@/convex/egressAbuseReview";
import { database } from "@/__mocks__/abuse-database";
import { createRedisClient } from "@/lib/rate-limit/redis";
import { createServiceConvexClient } from "@/lib/db/service-client";
import { decryptAbuseEvidence } from "@/lib/abuse/evidence-crypto";
import { recordEgressReviewAcquisition } from "@/lib/abuse/egress-review-context";
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

const [first, second] = fixture.vectors;
const REVIEW_KEY = "synthetic-egress-review-key";
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
    pipeline: jest.fn(() => {
      const ops: Array<() => void> = [];
      const chain = {
        zadd: (key: string, { score, member }: any) => {
          ops.push(() => zset(key).set(member, score));
          return chain;
        },
        zremrangebyscore: () => chain,
        zremrangebyrank: () => chain,
        expire: () => chain,
        exec: async () => ops.forEach((op) => op()),
      };
      return chain;
    }),
  };
  jest.mocked(createRedisClient).mockReturnValue(redis as never);
  return redis;
}

async function upload(counts: Array<[typeof first, number]>, minute = MINUTE) {
  const batch = telemetryBatchSchema.parse({
    version: 1,
    region: "us",
    minute,
    complete: true,
    droppedEvents: 0,
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
) {
  recordEgressReviewAcquisition({
    region: "us",
    userId: first.userId,
    sandboxId: first.sandboxId,
    chatId,
    runId,
    runKind,
    now: BURST_START - 10 * MINUTE_MS,
  });
  await new Promise((resolve) => setImmediate(resolve));
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
  options: { active?: boolean; command?: string } = {},
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
    parts: [{ type: "text", text: "Find open ports for me." }],
  });
  await convex.db.insert("messages", {
    id: `${chatId}-assistant`,
    chat_id: chatId,
    user_id: first.userId,
    role: "assistant",
    trigger_run_id: runId,
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
    CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY: REVIEW_KEY,
    ABUSE_EVIDENCE_KEYS: JSON.stringify({
      active: "k1",
      keys: { k1: "cd".repeat(32) },
    }),
  };
  fakeRedis();
  convex = reviewDatabase();
  const call = (reference: unknown, args: unknown) =>
    (reviewFunctions as any)[
      getFunctionName(reference as never).split(":")[1]
    ].handler(convex, args);
  jest.mocked(createServiceConvexClient).mockReturnValue({
    query: jest.fn(call),
    mutation: jest.fn(call),
  } as never);
  await upload([[first, 900]]);
  await registerAttributedWorkspace("us", first, first.userId, first.sandboxId);
});
afterAll(() => {
  process.env = originalEnv;
});

const run = (minute = MINUTE, attempt = FINAL) =>
  runEgressAbuseReview({ region: "us", owner: first.owner, minute }, attempt);
const recordCaseCalls = () =>
  jest
    .mocked(createServiceConvexClient)
    .mock.results.flatMap(({ value }) => value.mutation.mock.calls);

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
  });
  // Output, the RPC arguments and the stored row carry no raw evidence.
  const exposed = JSON.stringify([
    result,
    recordCaseCalls(),
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
  });
  expect(convex.tables.abuse_cases ?? []).toHaveLength(0);
  expect(recordCaseCalls()).toHaveLength(0);
});

it("dedupes a sustained burst into the window's case and preserves operator review", async () => {
  await seedRun();
  await link();
  classifyAs(concerning);
  await run();
  const row = convex.tables.abuse_cases[0];
  const ciphertext = row.ciphertext;
  Object.assign(row, { status: "reviewing", revision: 2 });

  // The next minute of the same burst, now classified differently.
  await upload([[first, 1_200]], MINUTE + 1);
  classifyAs({ ...concerning, verdict: "ambiguous" });
  await expect(run(MINUTE + 1)).resolves.toMatchObject({
    outcome: "manual_review",
    case: "existing",
  });
  expect(convex.tables.abuse_cases).toHaveLength(1);
  expect(convex.tables.abuse_cases[0]).toMatchObject({
    status: "reviewing",
    revision: 2,
    ciphertext,
  });
});

it.each([
  [
    "several plausible runs",
    async () => {
      await seedRun();
      await seedRun("run_parent2", "chat_two");
      await link();
      await link("run_parent2", "parent", "chat_two");
    },
    "multiple_runs",
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
  ],
  ["no recorded acquisition", async () => seedRun(), "no_acquisition_link"],
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
  ],
  [
    "a deleted linked chat",
    async () => {
      await seedRun();
      convex.tables.chats[0].deletion_started_at = 1;
      await link();
    },
    "evidence_unavailable",
  ],
])(
  "creates a manual case without a model call or draft for %s",
  async (_label, arrange, reason) => {
    await arrange();
    classifyAs(concerning);
    await expect(run()).resolves.toEqual({
      status: "completed",
      outcome: "manual_review",
      reason,
      case: "created",
    });
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
    messageIndices: [],
  });
  await expect(run(MINUTE, { number: 1, max: 4 })).rejects.toThrow(
    "still being recorded",
  );
  expect(convex.tables.abuse_cases ?? []).toHaveLength(0);
  await expect(run(MINUTE, FINAL)).resolves.toMatchObject({
    outcome: "manual_review",
    reason: "observation_incomplete",
    case: "created",
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
