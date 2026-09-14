import { createHash } from "node:crypto";
import { POST } from "../route";
import {
  runQuotaMigration,
  MigrationBlocked,
} from "@/lib/rate-limit/quota-migration-runner";

jest.mock("next/server", () => ({
  NextResponse: class {
    status: number;
    headers: Headers;
    constructor(
      private data: unknown,
      init?: ResponseInit,
    ) {
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(data: unknown, init?: ResponseInit) {
      return new this(data, init);
    }
    async json() {
      return this.data;
    }
  },
}));
jest.mock("@/lib/rate-limit/quota-migration-runner", () => ({
  runQuotaMigration: jest.fn(),
  MigrationBlocked: class MigrationBlocked extends Error {},
}));
const run = jest.mocked(runQuotaMigration);
const original = { ...process.env };
const token = "a".repeat(64);
function request(
  body: unknown = { action: "status" },
  authorization = `Bearer ${token}`,
) {
  return {
    headers: new Headers({ authorization }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      },
    }),
  } as Request;
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(process.env, {
    FREE_QUOTA_MIGRATION_OPERATOR_SHA256: createHash("sha256")
      .update(token)
      .digest("hex"),
    FREE_QUOTA_MIGRATION_OPERATOR_EXPIRES_AT: new Date(
      Date.now() + 3600000,
    ).toISOString(),
    VERCEL: "1",
    VERCEL_ENV: "preview",
    FREE_QUOTA_MIGRATION_ENVIRONMENT: "preview",
    UPSTASH_REDIS_REST_URL: "https://test.upstash.io",
    FREE_QUOTA_MIGRATION_REDIS_HOST: "test.upstash.io",
    NEXT_PUBLIC_CONVEX_URL: "https://preview.convex.cloud",
    FREE_QUOTA_MIGRATION_CONVEX_URL: "https://preview.convex.cloud",
    WORKOS_CLIENT_ID: "client_test",
    FREE_QUOTA_MIGRATION_WORKOS_CLIENT_ID: "client_test",
    UPSTASH_REDIS_REST_TOKEN: "redis-test-secret",
    WORKOS_API_KEY: "workos-test-secret",
    ACCOUNT_IDENTITY_HMAC_SECRET: "quota-test-secret",
  });
  run.mockResolvedValue({ state: "not_started" } as any);
});
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});
it("is disabled without an operator hash or after expiry", async () => {
  delete process.env.FREE_QUOTA_MIGRATION_OPERATOR_SHA256;
  expect((await POST(request())).status).toBe(404);
  process.env.FREE_QUOTA_MIGRATION_OPERATOR_SHA256 = createHash("sha256")
    .update(token)
    .digest("hex");
  process.env.FREE_QUOTA_MIGRATION_OPERATOR_EXPIRES_AT = new Date(
    Date.now() - 1000,
  ).toISOString();
  expect((await POST(request())).status).toBe(404);
  expect(run).not.toHaveBeenCalled();
});
it.each(["", "Bearer wrong", `Bearer ${"b".repeat(64)}`])(
  "rejects invalid credentials before any migration access",
  async (authorization) => {
    expect((await POST(request(undefined, authorization))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  },
);
it.each([
  ["VERCEL_ENV", "production"],
  ["UPSTASH_REDIS_REST_URL", "https://wrong.upstash.io"],
  ["NEXT_PUBLIC_CONVEX_URL", "https://wrong.convex.cloud"],
  ["WORKOS_CLIENT_ID", "client_wrong"],
  ["ACCOUNT_IDENTITY_HMAC_SECRET", ""],
  ["FREE_QUOTA_MIGRATION_WORKOS_CLIENT_ID", ""],
])("rejects a mismatched or missing %s", async (key, value) => {
  process.env[key] = value;
  expect((await POST(request())).status).toBe(503);
  expect(run).not.toHaveBeenCalled();
});
it("accepts only bounded commands, never supplied inventories or scripts", async () => {
  expect(
    (
      await POST(
        request({ action: "inventory", emails: ["private@example.test"] }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await POST(request({ action: "eval", script: "anything" }))).status,
  ).toBe(400);
  expect(
    (await POST(request({ action: "inventory", payload: "x".repeat(2000) })))
      .status,
  ).toBe(413);
  expect(run).not.toHaveBeenCalled();
});
it("returns only runner progress without caching", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({ state: "not_started" });
  expect(run.mock.calls[0][0]).toEqual({ action: "status" });
});
it("does not expose provider errors or private data", async () => {
  run.mockRejectedValue(new Error("private@example.test secret=very-private"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "migration_step_failed" });
  run.mockRejectedValue(new MigrationBlocked("private details"));
  expect(await (await POST(request())).json()).toEqual({
    error: "migration_precondition_failed",
  });
});
