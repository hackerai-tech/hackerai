/** @jest-environment node */
jest.mock("../../convex/lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import * as notices from "../../convex/abuseBlockNotices";
import { database } from "../../__mocks__/abuse-database";
import {
  dispatchNotices,
  stdioMailSender,
  workosRecipientResolver,
  type DispatchDeps,
  type OutgoingNotice,
} from "../../lib/abuse/block-notice-dispatch";
import { main, type CliFactories } from "../abuse-block-notices";

// Synthetic placeholders only.
const DISPATCH_KEY = "synthetic-dispatch-key";
const USER = "user_subject";
const ADDRESS = "synthetic.user@example.invalid";
const REFERENCE = "AB-0123abcd-0123-4abc-8abc-0123456789ab";
const URL = "https://synthetic-preview.convex.cloud";
const MINUTE_MS = 60_000;
const original = { ...process.env };

beforeEach(() => {
  process.env = {
    ...original,
    E2B_EGRESS_ABUSE_REVIEW_ENABLED: "true",
    E2B_EGRESS_ABUSE_ENFORCEMENT_ENABLED: "true",
    ABUSE_BLOCK_NOTICE_DISPATCH_ENABLED: "true",
    CONVEX_EGRESS_ABUSE_ENFORCEMENT_SERVICE_KEY: "synthetic-enforcement-key",
    CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY: DISPATCH_KEY,
    CONVEX_SERVICE_ROLE_KEY: "synthetic-main-key",
    ABUSE_EVIDENCE_KEYS: JSON.stringify({
      active: "k1",
      keys: { k1: "ab".repeat(32) },
    }),
  };
});
afterAll(() => {
  process.env = original;
});

/** One applied automated block in the in-memory store. */
async function blockedStore() {
  const ctx = database();
  const now = Date.now();
  const caseId = await ctx.db.insert("abuse_cases", {
    reference: REFERENCE,
    status: "needs_followup",
    revision: 1,
  });
  const suspensionId = await ctx.db.insert("user_suspensions", {
    user_id: USER,
    status: "active",
    category: "security_abuse",
    source: "support",
    source_id: `abuse-late:${REFERENCE}`,
  });
  await ctx.db.insert("abuse_block_notices", {
    caseId,
    reference: REFERENCE,
    userId: USER,
    suspensionId,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    blockedAt: now,
    blockRevision: 1,
    createdAt: now,
    templateVersion: "abuse-block-notice-v1",
    messageId: "<abuse-block." + "a".repeat(40) + "@hackerai.co>",
  });
  const convex = {
    mutation: jest.fn((reference: any, args: any) =>
      (notices as any)[getFunctionName(reference).split(":")[1]].handler(
        ctx,
        args,
      ),
    ),
    query: jest.fn((reference: any, args: any) =>
      (notices as any)[getFunctionName(reference).split(":")[1]].handler(
        ctx,
        args,
      ),
    ),
  };
  return { ctx, convex };
}

function deps(
  convex: DispatchDeps["convex"],
  overrides: Partial<DispatchDeps> = {},
): DispatchDeps & { sent: OutgoingNotice[] } {
  const sent: OutgoingNotice[] = [];
  return {
    convex,
    serviceKey: DISPATCH_KEY,
    resolveRecipient: async () => ({ status: "verified", email: ADDRESS }),
    send: async (notice) => {
      sent.push(notice);
      return "sent";
    },
    newLeaseToken: () => crypto.randomUUID(),
    now: Date.now,
    ...overrides,
    sent,
  };
}

describe("dispatchNotices", () => {
  it("sends the fixed notice once to the exact verified address", async () => {
    const { ctx, convex } = await blockedStore();
    const run = deps(convex);
    const receipt = await dispatchNotices(run);
    const [notice] = ctx.tables.abuse_block_notices;
    expect(receipt).toEqual({
      status: "processed",
      notices: [
        {
          reference: REFERENCE,
          messageId: notice.messageId,
          result: "sent",
          ack: "recorded",
        },
      ],
    });
    expect(run.sent).toEqual([
      expect.objectContaining({
        from: "abuse@hackerai.co",
        to: ADDRESS,
        messageId: notice.messageId,
      }),
    ]);
    expect(notice.status).toBe("sent");
    // The receipt is safe to print: no account ID or address.
    expect(JSON.stringify(receipt)).not.toMatch(
      new RegExp(`${USER}|${ADDRESS}`),
    );
    // Nothing left to send on the next run.
    await expect(dispatchNotices(run)).resolves.toEqual({
      status: "idle",
      notices: [],
    });
    expect(run.sent).toHaveLength(1);
  });

  it("never resends an uncertain submission", async () => {
    const { ctx, convex } = await blockedStore();
    const run = deps(convex, { send: async () => "uncertain" });
    await dispatchNotices(run);
    expect(ctx.tables.abuse_block_notices[0].status).toBe("uncertain");
    await expect(dispatchNotices(run)).resolves.toMatchObject({
      status: "idle",
    });
  });

  it("does not send without a single verified address for the account", async () => {
    const { ctx, convex } = await blockedStore();
    const send = jest.fn();
    await dispatchNotices(
      deps(convex, {
        resolveRecipient: async () => ({ status: "unavailable" }),
        send,
      }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(ctx.tables.abuse_block_notices[0]).toMatchObject({
      status: "failed",
      failure: "recipient_unavailable",
    });
  });

  it("rechecks that the same restriction is active after resolving the recipient", async () => {
    const { ctx, convex } = await blockedStore();
    const send = jest.fn();
    await dispatchNotices(
      deps(convex, {
        resolveRecipient: async () => {
          await ctx.db.patch(ctx.tables.user_suspensions[0]._id, {
            status: "resolved",
          });
          return { status: "verified", email: ADDRESS };
        },
        send,
      }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(ctx.tables.abuse_block_notices[0].status).toBe("pending");
  });

  it("does not send once the lease budget is too short", async () => {
    const { ctx, convex } = await blockedStore();
    const send = jest.fn();
    await dispatchNotices(
      deps(convex, { send, now: () => Date.now() + 4 * MINUTE_MS }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(ctx.tables.abuse_block_notices[0].status).toBe("pending");
  });

  it("stops when Convex has dispatch switched off", async () => {
    const { convex } = await blockedStore();
    process.env.ABUSE_BLOCK_NOTICE_DISPATCH_ENABLED = "false";
    const send = jest.fn();
    await expect(dispatchNotices(deps(convex, { send }))).resolves.toEqual({
      status: "disabled",
      notices: [],
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("workosRecipientResolver", () => {
  const resolver = (user: unknown, error?: unknown) =>
    workosRecipientResolver({
      userManagement: {
        getUser: async () => {
          if (error) throw error;
          return user as never;
        },
      },
    });

  it("accepts only the same user's verified address", async () => {
    const user = { id: USER, email: ADDRESS, emailVerified: true };
    await expect(resolver(user)(USER)).resolves.toEqual({
      status: "verified",
      email: ADDRESS,
    });
    for (const changed of [
      { ...user, id: "user_other" },
      { ...user, emailVerified: false },
      { ...user, email: `${ADDRESS}\r\nBcc: x@example.invalid` },
    ])
      await expect(resolver(changed)(USER)).resolves.toEqual({
        status: "unavailable",
      });
    await expect(resolver(null, { status: 404 })(USER)).resolves.toEqual({
      status: "unavailable",
    });
    await expect(resolver(null, new Error("network"))(USER)).resolves.toEqual({
      status: "error",
    });
  });
});

describe("stdioMailSender", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "notice-helper-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const helper = (body: string, timeoutMs?: number) => {
    const script = join(directory, "helper.py");
    writeFileSync(script, body);
    return stdioMailSender({
      python: "/usr/bin/python3",
      script,
      bridgeDir: directory,
      timeoutMs,
    });
  };
  const notice: OutgoingNotice = {
    messageId: `<abuse-block.${"a".repeat(40)}@hackerai.co>`,
    from: "abuse@hackerai.co",
    to: ADDRESS,
    subject: "Subject",
    text: "Body",
  };

  it("passes the message only on stdin, without inherited secrets", async () => {
    process.env.WORKOS_API_KEY = "sk_test_synthetic";
    const send = helper(
      [
        "import json, os, sys",
        "data = json.load(sys.stdin)",
        `open(${JSON.stringify(join(directory, "seen.json"))}, "w").write(json.dumps({"to": data["to"], "argv": sys.argv, "env": sorted(os.environ)}))`,
        'print(json.dumps({"result": "sent"}))',
      ].join("\n"),
    );
    await expect(send(notice)).resolves.toBe("sent");
    const seen = JSON.parse(
      require("node:fs").readFileSync(join(directory, "seen.json"), "utf8"),
    );
    expect(seen.to).toBe(ADDRESS);
    expect(JSON.stringify(seen.argv)).not.toContain(ADDRESS);
    expect(seen.env).not.toContain("WORKOS_API_KEY");
    expect(seen.env).not.toContain("CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY");
  });

  it("treats malformed output, a crash or a timeout as uncertain", async () => {
    await expect(helper("print('not json')")(notice)).resolves.toBe(
      "uncertain",
    );
    await expect(helper("raise SystemExit(3)")(notice)).resolves.toBe(
      "uncertain",
    );
    await expect(
      helper("import time\ntime.sleep(5)", 200)(notice),
    ).resolves.toBe("uncertain");
  });
});

describe("CLI", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        stdout: (l: string) => out.push(l),
        stderr: (l: string) => err.push(l),
      },
    };
  };
  const factories = (): CliFactories & { createConvex: jest.Mock } => ({
    createConvex: jest.fn(),
    createDispatchDeps: jest.fn(),
  });
  const env = {
    NEXT_PUBLIC_CONVEX_URL: URL,
    CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY: DISPATCH_KEY,
    CONVEX_SERVICE_ROLE_KEY: "synthetic-main-key",
    WORKOS_API_KEY: "sk_test_synthetic",
    ABUSE_NOTICE_BRIDGE_DIR: "/synthetic/bridge",
  };

  it.each([
    [
      "another deployment",
      ["--expect-convex-url", "https://other.convex.cloud"],
      {},
    ],
    [
      "the general service key",
      [],
      { CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY: "synthetic-main-key" },
    ],
    [
      "a live WorkOS key for a test assertion",
      [],
      { WORKOS_API_KEY: "sk_live_synthetic" },
    ],
    ["a missing WorkOS assertion", ["--expect-workos-env", ""], {}],
    ["a relative bridge directory", [], { ABUSE_NOTICE_BRIDGE_DIR: "bridge" }],
  ])("refuses %s before any call", async (_label, args, changes) => {
    const made = factories();
    const { io: streams, err } = io();
    const argv = [
      "dispatch",
      "--expect-convex-url",
      URL,
      "--expect-workos-env",
      "test",
      ...args,
    ];
    await expect(
      main(argv, { ...env, ...changes }, streams, made),
    ).resolves.toBe(1);
    expect(made.createConvex).not.toHaveBeenCalled();
    expect(made.createDispatchDeps).not.toHaveBeenCalled();
    expect(JSON.parse(err[0]).message).toMatch(/Nothing was called/);
    expect(err.join("")).not.toContain("synthetic");
  });

  it("prints only the aggregate summary", async () => {
    const { convex } = await blockedStore();
    const made = factories();
    made.createConvex.mockReturnValue(convex);
    const { io: streams, out } = io();
    await expect(
      main(["summary", "--expect-convex-url", URL], env, streams, made),
    ).resolves.toBe(0);
    const printed = out.join("");
    expect(JSON.parse(printed).result.actions).toContainEqual({
      reference: REFERENCE,
      action: "review_block",
    });
    expect(printed).not.toContain(USER);
  });
});
