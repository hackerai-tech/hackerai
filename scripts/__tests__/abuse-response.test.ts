/** @jest-environment node */
jest.mock("@trigger.dev/sdk", () => ({ runs: { retrieve: jest.fn() } }));
jest.mock("../../lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: jest.fn(),
  closeAgentApprovalSession: jest.fn(),
}));
const mockCreateServiceClient = jest.fn();
jest.mock("../../lib/db/service-client", () => ({
  createServiceConvexClient: (...args: unknown[]) =>
    mockCreateServiceClient(...args),
}));
import { ConvexError } from "convex/values";
import {
  assertProtectedInput,
  defaultFactories,
  main,
  type CliFactories,
} from "../abuse-response";

// Synthetic credentials only; the CLI must never echo them.
const SERVICE_KEY = "synthetic-service-credential-value";
const URL = "https://synthetic-preview.convex.cloud";
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
const env = {
  NEXT_PUBLIC_CONVEX_URL: URL,
  CONVEX_SERVICE_ROLE_KEY: SERVICE_KEY,
  TRIGGER_SECRET_KEY: "tr_dev_syntheticvalue",
};
const original = { ...process.env };
beforeEach(() => {
  process.env.ABUSE_EVIDENCE_KEYS = JSON.stringify({
    active: "test",
    keys: { test: "11".repeat(32) },
  });
});
afterEach(() => {
  process.env = { ...original };
});

function setup(input: unknown = { operator: "operator", reference }) {
  const out: string[] = [];
  const err: string[] = [];
  const convex = { query: jest.fn(), mutation: jest.fn() };
  const io = {
    readInput: jest.fn(async () => input),
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };
  const factories: CliFactories = {
    createConvex: jest.fn(() => convex as any),
    trigger: {
      retrieveRun: jest.fn(),
      cancelRun: jest.fn(),
      closeApprovalSession: jest.fn(),
    },
    newOperationToken: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  };
  return { out, err, convex, io, factories };
}

test.each([
  [
    "a different Convex deployment",
    ["status", "--expect-convex-url", "https://other.convex.cloud"],
    env,
  ],
  [
    "a missing service credential",
    ["status", "--expect-convex-url", URL],
    { ...env, CONVEX_SERVICE_ROLE_KEY: "" },
  ],
  [
    "a Trigger key for another environment",
    ["apply", "--expect-convex-url", URL, "--expect-trigger-env", "prod"],
    env,
  ],
  [
    "no Trigger environment assertion",
    ["retry", "--expect-convex-url", URL],
    env,
  ],
  ["an unsupported command", ["contain", "--expect-convex-url", URL], env],
])(
  "%s stops before reading input or calling any service",
  async (_label, argv, environment) => {
    const { io, factories, err } = setup();
    expect(await main(argv, environment, io, factories)).toBe(1);
    expect(io.readInput).not.toHaveBeenCalled();
    expect(factories.createConvex).not.toHaveBeenCalled();
    expect(err.join("\n")).not.toContain(SERVICE_KEY);
  },
);

test("import and apply require the evidence keyring before any call", async () => {
  delete process.env.ABUSE_EVIDENCE_KEYS;
  const { io, factories, err } = setup();
  expect(
    await main(["import", "--expect-convex-url", URL], env, io, factories),
  ).toBe(1);
  expect(io.readInput).not.toHaveBeenCalled();
  expect(err[0]).toContain("ABUSE_EVIDENCE_KEYS");
});

test.each([
  [
    "a terminal",
    { isFile: () => false, isFIFO: () => false, mode: 0o20620 },
    false,
  ],
  [
    "a group-readable file",
    { isFile: () => true, isFIFO: () => false, mode: 0o100640 },
    false,
  ],
  [
    "an owner-only file",
    { isFile: () => true, isFIFO: () => false, mode: 0o100600 },
    true,
  ],
  ["a pipe", { isFile: () => false, isFIFO: () => true, mode: 0o10600 }, true],
])("stdin from %s is accepted: %s", (_label, stat, accepted) => {
  if (accepted) expect(() => assertProtectedInput(stat)).not.toThrow();
  else expect(() => assertProtectedInput(stat)).toThrow();
});

test("status prints receipts through the signed service client and never echoes credentials or raw backend errors", async () => {
  const { io, factories, convex, out, err } = setup();
  convex.query.mockResolvedValueOnce({ reference, contained: false });
  expect(
    await main(["status", "--expect-convex-url", URL], env, io, factories),
  ).toBe(0);
  expect(factories.createConvex).toHaveBeenCalledWith(URL);
  expect(JSON.parse(out[0])).toEqual({
    command: "status",
    result: { reference, contained: false },
  });
  expect(out.join("\n")).not.toContain(SERVICE_KEY);

  convex.query.mockRejectedValueOnce(
    new Error(`backend echoed ${SERVICE_KEY} and synthetic evidence text`),
  );
  expect(
    await main(["status", "--expect-convex-url", URL], env, io, factories),
  ).toBe(1);
  expect(err.at(-1)).toContain("not confirmed");
  expect(err.join("\n")).not.toContain(SERVICE_KEY);
  expect(err.join("\n")).not.toContain("synthetic evidence");

  mockCreateServiceClient.mockReturnValue("signed-client");
  expect(defaultFactories().createConvex(URL)).toBe("signed-client");
  expect(mockCreateServiceClient).toHaveBeenCalledWith(URL);
});

test("known backend rejections and invalid fields are reported without input values", async () => {
  const known = setup();
  known.convex.query.mockRejectedValueOnce(
    new ConvexError({ code: "ABUSE_SCOPE_MISMATCH" }),
  );
  await main(
    ["status", "--expect-convex-url", URL],
    env,
    known.io,
    known.factories,
  );
  expect(JSON.parse(known.err[0])).toMatchObject({
    code: "ABUSE_SCOPE_MISMATCH",
  });

  const secretNote = `Synthetic note with token hsb_${"ef".repeat(32)} included.`;
  const invalid = setup({
    operator: "operator",
    reference,
    subject: { userId: "subject", chatId: "chat", transport: "local" },
    planDigest: "f".repeat(64),
    requestId: "11111111-2222-4333-8444-555555555555",
    review: {
      reviewer: "reviewer",
      reviewDate: "2026-02-28",
      retentionReviewDate: "2026-08-28",
      reason: "Synthetic reviewed decision to restrict the account.",
      verifiedFacts: secretNote,
    },
    acknowledge: { accountRestriction: true, processStopUnconfirmed: true },
  });
  expect(
    await main(
      ["apply", "--expect-convex-url", URL, "--expect-trigger-env", "dev"],
      env,
      invalid.io,
      invalid.factories,
    ),
  ).toBe(1);
  expect(JSON.parse(invalid.err[0])).toMatchObject({
    fields: ["review.verifiedFacts"],
  });
  expect(invalid.err[0]).not.toContain("efef");
  expect(invalid.convex.mutation).not.toHaveBeenCalled();
});
