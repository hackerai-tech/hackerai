/** @jest-environment node */
jest.mock("../../convex/lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));
import { getFunctionName } from "convex/server";
import * as notices from "../../convex/abuseBlockNotices";
import { insertReceipt, RECEIPT_TTL_MS } from "../../convex/lib/egressReceipts";
import { database } from "../../__mocks__/abuse-database";
import { main, type CliFactories } from "../egress-review-dispositions";

// Synthetic placeholders only.
const DISPATCH_KEY = "synthetic-dispatch-key";
const URL = "https://synthetic-preview.convex.cloud";
const REFERENCE = "AB-0123abcd-0123-4abc-8abc-0123456789ab";
const digest = (n: number) => n.toString(16).padStart(64, "0");
const original = { ...process.env };

beforeEach(() => {
  process.env = {
    ...original,
    CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY: DISPATCH_KEY,
    CONVEX_SERVICE_ROLE_KEY: "synthetic-main-key",
    CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY: "synthetic-review-key",
    CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY: "synthetic-enforcement-key",
  };
});
afterAll(() => {
  process.env = original;
});

const exactRun = {
  evidenceMode: "exact_run",
  coverage: "complete",
} as const;
const pendingBlock = {
  decision: "enforcement_pending",
  reason: "enforcement_refused",
  reviewReason: "concerning_unauthorized",
  ...exactRun,
  caseOutcome: "created",
  refusal: "run_active",
  intentKind: "credential_theft",
  reference: REFERENCE,
} as const;
const legitimate = {
  decision: "keep_active",
  reason: "legitimate_corroborated",
  reviewReason: "legitimate_corroborated",
  ...exactRun,
  caseOutcome: "none",
} as const;

/** Receipts as the review and enforcement writers persist them. */
async function receiptStore() {
  const ctx = database();
  const now = Date.now();
  const write = (n: number, fields: object, at = now) =>
    insertReceipt(ctx as any, { digest: digest(n), ...fields } as any, at);
  await write(1, {
    ...pendingBlock,
    decision: "block_applied",
    reason: "harmful_intent_confirmed",
    refusal: undefined,
  });
  await write(2, pendingBlock);
  await write(3, legitimate);
  // Near misses of each confirmed disposition stay undetermined.
  await write(4, { ...pendingBlock, coverage: "incomplete" });
  await write(5, { ...pendingBlock, intentKind: undefined });
  await write(6, { ...pendingBlock, evidenceMode: "account_activity" });
  await write(7, { ...legitimate, coverage: "incomplete" });
  await write(8, {
    ...legitimate,
    reason: "intent_not_established",
    reviewReason: "concerning_uncorroborated",
    caseOutcome: "created",
  });
  await write(9, { ...legitimate, evidenceMode: "none", coverage: "not_read" });
  await write(12, { ...legitimate, reason: "inconclusive" });
  // Past retention but not yet purged.
  await write(10, legitimate, now - RECEIPT_TTL_MS - 1);
  const convex = {
    query: jest.fn((reference: any, args: any) =>
      (notices as any)[getFunctionName(reference).split(":")[1]].handler(
        ctx,
        args,
      ),
    ),
  };
  return { ctx, convex };
}

const handler = (notices.reviewDispositions as any).handler;

describe("abuseBlockNotices:reviewDispositions", () => {
  it("reports only strict persisted receipts as confirmed, in input order", async () => {
    const { ctx } = await receiptStore();
    const order = [11, 10, 12, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    await expect(
      handler(ctx, {
        serviceKey: DISPATCH_KEY,
        digests: order.map(digest),
      }),
    ).resolves.toEqual([
      "missing",
      "missing",
      "undetermined",
      "undetermined",
      "undetermined",
      "undetermined",
      "undetermined",
      "undetermined",
      "undetermined",
      "confirmed_legitimate",
      "confirmed_abuse_pending",
      "blocked",
    ]);
  });

  it.each([
    ["no digests", []],
    ["more than 100 digests", Array.from({ length: 101 }, (_, n) => digest(n))],
    ["a duplicate", [digest(1), digest(1)]],
    ["an uppercase digest", [digest(1).replace(/0/g, "A")]],
    ["a short digest", ["ab".repeat(31)]],
    ["a reference", [REFERENCE]],
  ])("rejects %s before any read", async (_label, digests) => {
    const { ctx } = await receiptStore();
    const read = jest.spyOn(ctx.db, "query");
    await expect(
      handler(ctx, { serviceKey: DISPATCH_KEY, digests }),
    ).rejects.toThrow("Invalid review digests");
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts 100 digests", async () => {
    const { ctx } = await receiptStore();
    const result = await handler(ctx, {
      serviceKey: DISPATCH_KEY,
      digests: Array.from({ length: 100 }, (_, n) => digest(n + 1)),
    });
    expect(result).toHaveLength(100);
    expect(result.slice(0, 3)).toEqual([
      "blocked",
      "confirmed_abuse_pending",
      "confirmed_legitimate",
    ]);
  });

  it("refuses another key, and a dispatcher key shared with another scope", async () => {
    const { ctx } = await receiptStore();
    const digests = [digest(1)];
    await expect(
      handler(ctx, { serviceKey: "synthetic-review-key", digests }),
    ).rejects.toThrow(/Unauthorized/);
    for (const shared of [
      "CONVEX_SERVICE_ROLE_KEY",
      "CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY",
      "CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY",
      "CONVEX_USER_RESEARCH_SERVICE_KEY",
    ]) {
      process.env[shared] = DISPATCH_KEY;
      await expect(
        handler(ctx, { serviceKey: DISPATCH_KEY, digests }),
      ).rejects.toThrow(/Unauthorized/);
      process.env[shared] = `synthetic-${shared}`;
    }
  });
});

describe("CLI", () => {
  const env = {
    NEXT_PUBLIC_CONVEX_URL: URL,
    CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY: DISPATCH_KEY,
    CONVEX_SERVICE_ROLE_KEY: "synthetic-main-key",
  };
  const argv = ["--expect-convex-url", URL];
  const run = async (
    stdin: string,
    convex?: { query: jest.Mock },
    args = argv,
    changes: Record<string, string> = {},
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const factories: CliFactories & { createConvex: jest.Mock } = {
      createConvex: jest.fn(() => convex ?? { query: jest.fn() }),
    };
    const code = await main(
      args,
      { ...env, ...changes },
      {
        stdin: (async function* () {
          yield Buffer.from(stdin);
        })(),
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
      factories,
    );
    return { code, out, err, factories };
  };
  const input = JSON.stringify([digest(3), digest(11), digest(1)]);

  it("prints one array of dispositions in input order from one query", async () => {
    const { convex } = await receiptStore();
    const { code, out, err } = await run(input, convex);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual([
      "confirmed_legitimate",
      "missing",
      "blocked",
    ]);
    expect(convex.query).toHaveBeenCalledTimes(1);
    expect(out[0]).not.toContain(REFERENCE);
  });

  it.each([
    [
      "another deployment",
      ["--expect-convex-url", "https://other.convex.cloud"],
      {},
    ],
    ["a missing assertion", [], {}],
    ["a positional target", [...argv, URL], {}],
    [
      "the general service key",
      argv,
      { CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY: "synthetic-main-key" },
    ],
  ])("refuses %s before any call", async (_label, args, changes) => {
    const { code, err, factories } = await run(input, undefined, args, changes);
    expect(code).toBe(1);
    expect(factories.createConvex).not.toHaveBeenCalled();
    expect(err.join("")).not.toContain("synthetic");
  });

  it.each([
    ["non-JSON input", "not json"],
    ["an object", JSON.stringify({ digests: [digest(1)] })],
    ["a URL", JSON.stringify([URL])],
    ["a duplicate", JSON.stringify([digest(1), digest(1)])],
    [
      "more than 100 digests",
      JSON.stringify(Array.from({ length: 101 }, (_, n) => digest(n))),
    ],
    ["oversized input", " ".repeat(16 * 1024 + 1) + input],
  ])("rejects %s before any call", async (_label, stdin) => {
    const { code, err, factories } = await run(stdin);
    expect(code).toBe(1);
    expect(factories.createConvex).not.toHaveBeenCalled();
    expect(JSON.parse(err[0]).message).toMatch(/Nothing was called/);
  });

  it.each([
    ["a short array", ["blocked"]],
    ["an unknown status", ["blocked", "missing", "suspended"]],
    [
      "identifiers",
      [{ status: "blocked", reference: REFERENCE }, "missing", "missing"],
    ],
  ])(
    "rejects a response with %s and prints nothing",
    async (_label, response) => {
      const convex = { query: jest.fn(async () => response) };
      const { code, out, err } = await run(input, convex);
      expect(code).toBe(1);
      expect(out).toEqual([]);
      expect(JSON.parse(err[0]).message).toMatch(/unexpected response/);
      expect(err.join("")).not.toContain(REFERENCE);
    },
  );

  it("prints fixed text for a backend error", async () => {
    const convex = {
      query: jest.fn(async () => {
        throw new Error(`Server error for ${REFERENCE} ${DISPATCH_KEY}`);
      }),
    };
    const { code, out, err } = await run(input, convex);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      JSON.stringify({ message: "The query did not complete." }),
    ]);
  });
});
