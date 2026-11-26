/** @jest-environment node */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

// Jest maps @workos-inc/node to a stub; exercise the SDK the app ships.
jest.mock("@workos-inc/node", () => {
  const fs = jest.requireActual<typeof import("node:fs")>("node:fs");
  const path = jest.requireActual<typeof import("node:path")>("node:path");
  return jest.requireActual(
    path.join(
      fs.realpathSync(
        path.join(process.cwd(), "node_modules/@workos-inc/node"),
      ),
      "lib/index.cjs",
    ),
  );
});

const PENDING = Symbol("pending");

/** A WorkOS request that never answers until the SDK aborts it. */
const hangUntilAborted = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("app WorkOS client request bound", () => {
  const originalApiKey = process.env.WORKOS_API_KEY;
  const originalClientId = process.env.WORKOS_CLIENT_ID;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    process.env.WORKOS_API_KEY = "sk_test_bounds";
    process.env.WORKOS_CLIENT_ID = "client_test";
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env.WORKOS_API_KEY = originalApiKey;
    process.env.WORKOS_CLIENT_ID = originalClientId;
  });

  /** A billing/entitlement membership lookup on a fresh client bound to this test's fetch. */
  function listMemberships() {
    const { workos } =
      jest.requireActual<typeof import("../workos")>("../workos");
    let outcome: unknown = PENDING;
    workos.userManagement
      .listOrganizationMemberships({ userId: "user_1" })
      .then(
        (value) => (outcome = value),
        (error) => (outcome = error),
      );
    return () => outcome;
  }

  it("aborts a stalled attempt at 4s and settles within 10s after one retry", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(hangUntilAborted);
    const outcome = listMemberships();

    await jest.advanceTimersByTimeAsync(3_999);
    const firstSignal = fetchMock.mock.calls[0][1]?.signal;
    expect(firstSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(firstSignal?.aborted).toBe(true);

    await jest.advanceTimersByTimeAsync(6_000);
    expect(outcome()).toMatchObject({ status: 408 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx once, then surfaces it", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        jsonResponse(502, { message: "bad gateway" }),
      );
    const outcome = listMemberships();

    await jest.advanceTimersByTimeAsync(10_000);

    expect(outcome()).toMatchObject({ status: 502 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a fast success from a single request", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        jsonResponse(200, {
          object: "list",
          data: [],
          list_metadata: { before: null, after: null },
        }),
      );
    const outcome = listMemberships();

    await jest.advanceTimersByTimeAsync(0);

    expect(outcome()).toMatchObject({ data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
