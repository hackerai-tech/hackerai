/** @jest-environment node */
import type { NextRequest } from "next/server";
import { POST } from "../route";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";

jest.mock("@/lib/auth/get-user-id", () => ({ getUserID: jest.fn() }));

const mockEval = jest.fn();
const mockRedis = { available: true };
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => (mockRedis.available ? { eval: mockEval } : null),
}));

const NOW_MS = 1_800_000_000_000;
const ENDPOINT =
  "https://hackerai.co/api/desktop/authorization-challenge-diagnostic";
const PRIVATE = "PRIVATE-CANARY";
const record = {
  version: 1,
  capturedAtMs: NOW_MS - 1_000,
  requestId: { kind: "present", value: "cle1::Xy7.k_9:z-1" },
  retryAfter: { kind: "seconds", seconds: 30 },
};

function post(
  body: unknown,
  {
    url = ENDPOINT,
    origin = new URL(url).origin as string | null,
    contentType = "application/json",
    raw,
  }: {
    url?: string;
    origin?: string | null;
    contentType?: string;
    raw?: BodyInit;
  } = {},
): NextRequest {
  const headers = new Headers({ "content-type": contentType });
  if (origin !== null) headers.set("origin", origin);
  return new Request(url, {
    method: "POST",
    headers,
    body: raw ?? JSON.stringify(body),
    // Required by Node's fetch for a streamed body.
    ...(raw instanceof ReadableStream && { duplex: "half" }),
  } as RequestInit) as unknown as NextRequest;
}

async function expectStatus(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("");
  expect(response.headers.get("cache-control")).toBe("no-store");
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
  mockRedis.available = true;
  mockEval.mockResolvedValue(1);
  jest.mocked(getUserID).mockResolvedValue("user-1");
});

afterEach(() => jest.restoreAllMocks());

describe("POST /api/desktop/authorization-challenge-diagnostic", () => {
  it("appends one server-fixed record to the user's private capped list", async () => {
    await expectStatus(await POST(post(record)), 204);

    expect(mockEval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = mockEval.mock.calls[0];
    expect(keys).toEqual([
      "support:desktop-authorization-challenge:v1:user-1",
      "support:desktop-authorization-challenge-rate:v1:user-1",
    ]);
    // At most 16 retained records and 16 uploads per 60-second window.
    expect(args.slice(1)).toEqual(["16", "86400", "16", "60"]);
    expect(script).toContain("LPUSH");
    expect(script).toContain("LTRIM");
    expect(JSON.parse(args[0])).toEqual({
      version: 1,
      capturedAtMs: NOW_MS - 1_000,
      receivedAtMs: NOW_MS,
      httpStatus: 403,
      method: "POST",
      host: "hackerai.co",
      path: "/api/desktop/authorized-operation",
      mitigation: "challenge",
      requestId: { kind: "present", value: "cle1::Xy7.k_9:z-1" },
      retryAfter: { kind: "seconds", seconds: 30 },
    });
    // The user is the key, never part of the stored value.
    expect(args[0]).not.toContain("user-1");
  });

  it("fixes the host to an isolated localhost origin's own", async () => {
    await expectStatus(
      await POST(
        post(
          { ...record, requestId: { kind: "absent" } },
          {
            url: "http://localhost:3000/api/desktop/authorization-challenge-diagnostic",
          },
        ),
      ),
      204,
    );
    expect(JSON.parse(mockEval.mock.calls[0][2][0])).toMatchObject({
      host: "localhost",
      requestId: { kind: "absent" },
    });
  });

  it("rejects other origins and hosts before authentication", async () => {
    for (const options of [
      { origin: null },
      { origin: "https://evil.example" },
      { origin: "http://hackerai.co" },
      { origin: "null" },
      {
        url: "https://hackerai.co:8443/api/desktop/authorization-challenge-diagnostic",
      },
      // A Preview or other deployment never stores a record.
      {
        url: "https://hackerai-git-branch.vercel.app/api/desktop/authorization-challenge-diagnostic",
      },
      {
        url: "https://www.hackerai.co/api/desktop/authorization-challenge-diagnostic",
      },
    ])
      await expectStatus(await POST(post(record, options)), 403);
    await expectStatus(
      await POST(post(record, { contentType: "text/plain" })),
      415,
    );
    expect(getUserID).not.toHaveBeenCalled();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("requires the existing authenticated session", async () => {
    jest
      .mocked(getUserID)
      .mockRejectedValue(new ChatSDKError("unauthorized:auth"));
    await expectStatus(await POST(post(record)), 401);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("bounds the body before decoding it", async () => {
    const padded = { ...record, padding: "x".repeat(2_000) };
    // A declared length, and a streamed body without one.
    await expectStatus(await POST(post(padded)), 413);
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) throw new Error("the body was read past its bound");
        controller.enqueue(encoder.encode(" ".repeat(512)));
      },
    });
    await expectStatus(await POST(post(null, { raw: stream })), 413);
    // Reading stops just past the 1 KiB bound, plus stream buffering.
    expect(pulled).toBeLessThan(8);
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("accepts only the exact bounded schema", async () => {
    const invalid: unknown[] = [
      null,
      [],
      { ...record, version: 2 },
      { ...record, userId: PRIVATE },
      { ...record, httpStatus: 200 },
      { version: 1, capturedAtMs: NOW_MS, requestId: record.requestId },
      { ...record, capturedAtMs: NOW_MS + 0.5 },
      { ...record, capturedAtMs: String(NOW_MS) },
      // Older than the retention window, or implausibly far ahead.
      { ...record, capturedAtMs: NOW_MS - 24 * 60 * 60 * 1000 - 1 },
      { ...record, capturedAtMs: NOW_MS + 10 * 60 * 1000 + 1 },
      { ...record, requestId: { kind: "present", value: "" } },
      { ...record, requestId: { kind: "present", value: "a".repeat(257) } },
      {
        ...record,
        requestId: { kind: "present", value: `cle1::${PRIVATE} x` },
      },
      { ...record, requestId: { kind: "present", value: "cle1::a/b?t=1" } },
      { ...record, requestId: { kind: "present" } },
      { ...record, requestId: { kind: "absent", value: "cle1::abc" } },
      { ...record, requestId: "cle1::abc" },
      { ...record, retryAfter: { kind: "seconds", seconds: 1_000_000_000 } },
      { ...record, retryAfter: { kind: "seconds", seconds: -1 } },
      { ...record, retryAfter: { kind: "seconds", seconds: "30" } },
      { ...record, retryAfter: { kind: "http_date", unixMs: -1 } },
      {
        ...record,
        retryAfter: { kind: "http_date", unixMs: 253_402_300_800_000 },
      },
      {
        ...record,
        retryAfter: { kind: "malformed", value: "Sun, 06 Nov 1994" },
      },
      { ...record, retryAfter: { kind: "date" } },
    ];
    for (const body of invalid) await expectStatus(await POST(post(body)), 400);
    for (const raw of ["not json", new Uint8Array([0x7b, 0xff, 0x7d]), ""])
      await expectStatus(await POST(post(null, { raw })), 400);
    expect(mockEval).not.toHaveBeenCalled();

    // The longest accepted ID and both Retry-After value forms.
    for (const valid of [
      { ...record, requestId: { kind: "present", value: "A".repeat(256) } },
      { ...record, requestId: { kind: "invalid" } },
      { ...record, retryAfter: { kind: "absent" } },
      { ...record, retryAfter: { kind: "malformed" } },
      { ...record, retryAfter: { kind: "seconds", seconds: 999_999_999 } },
      { ...record, retryAfter: { kind: "http_date", unixMs: 784_111_777_000 } },
    ])
      await expectStatus(await POST(post(valid)), 204);
  });

  it("reports an unavailable store only as a status", async () => {
    mockRedis.available = false;
    await expectStatus(await POST(post(record)), 503);
    mockRedis.available = true;
    mockEval.mockRejectedValue(new Error(PRIVATE));
    await expectStatus(await POST(post(record)), 503);
  });

  it("returns an empty 429 when the authenticated account budget is exhausted", async () => {
    mockEval.mockResolvedValue(0);

    await expectStatus(await POST(post(record)), 429);
    expect(mockEval).toHaveBeenCalledTimes(1);
  });
});
