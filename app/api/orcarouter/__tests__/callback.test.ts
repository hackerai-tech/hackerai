jest.mock("server-only", () => ({}));

const edge = require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
  Headers: typeof Headers;
  Request: typeof Request;
  Response: typeof Response;
};
globalThis.Headers = edge.Headers;
globalThis.Request = edge.Request;
globalThis.Response = edge.Response;

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mockMutation } from "@/__mocks__/convex/browser";
import {
  ORCAROUTER_PKCE_COOKIE,
  sealPendingPkceAttempt,
} from "@/lib/ai/orcarouter/credentials";
import { createS256Challenge } from "@/lib/ai/orcarouter/pkce";
import { openOrcaRouterSecret } from "@/lib/ai/orcarouter/credential-crypto";

const mockGetUserID = jest.fn(async (): Promise<string> => "user_1");
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: () => mockGetUserID(),
}));

// next/server needs the Fetch globals above, so load it after they are set.
const { NextRequest } = require("next/server") as typeof import("next/server");
const { GET } =
  jest.requireActual<typeof import("../callback/route")>("../callback/route");

const VERIFIER = "v".repeat(43);
const STATE = "expected-state";

const callbackRequest = (query: string, cookie?: string) =>
  new NextRequest(`https://hackerai.test/api/orcarouter/callback?${query}`, {
    headers: cookie ? { cookie: `${ORCAROUTER_PKCE_COOKIE}=${cookie}` } : {},
  });

const resultOf = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get(
    "orcarouter_connect",
  );

beforeEach(() => {
  process.env.ORCAROUTER_CREDENTIALS_KEY = randomBytes(32).toString("base64");
  process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
  mockMutation.mockReset();
  mockMutation.mockResolvedValue({ generation: 1 } as never);
  globalThis.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    expect(String(input)).toBe("https://www.orcarouter.ai/api/v1/auth/keys");
    const body = JSON.parse(String(init?.body));
    // The server checks the verifier against the challenge it was given.
    const ok =
      body.code === "good-code" &&
      createS256Challenge(body.code_verifier) === createS256Challenge(VERIFIER);
    return new edge.Response(
      JSON.stringify(ok ? { key: "sk-orca-from-pkce", scope: "api" } : {}),
      { status: ok ? 200 : 403 },
    );
  }) as unknown as typeof fetch;
});

describe("GET /api/orcarouter/callback", () => {
  it("redeems the code with the sealed verifier and stores the key", async () => {
    const cookie = sealPendingPkceAttempt("user_1", {
      verifier: VERIFIER,
      state: STATE,
    });
    const response = await GET(
      callbackRequest(`code=good-code&state=${STATE}`, cookie),
    );

    expect(response.status).toBe(307);
    expect(resultOf(response)).toBe("connected");
    const saved = mockMutation.mock.calls[0][1] as { encryptedKey: string };
    expect(openOrcaRouterSecret(saved.encryptedKey, "user_1")).toBe(
      "sk-orca-from-pkce",
    );
    expect(response.headers.get("set-cookie")).toMatch(
      new RegExp(`${ORCAROUTER_PKCE_COOKIE}=;`),
    );
    expect(response.headers.get("location")).not.toContain("sk-orca");
  });

  it.each([
    ["a forged state", `code=good-code&state=forged`, "state_mismatch"],
    ["a denial", `error=access_denied&state=${STATE}`, "access_denied"],
    ["a reused code", `code=used-code&state=${STATE}`, "invalid_code"],
  ])("reports %s without storing anything", async (_name, query, result) => {
    const cookie = sealPendingPkceAttempt("user_1", {
      verifier: VERIFIER,
      state: STATE,
    });
    const response = await GET(callbackRequest(query, cookie));
    expect(resultOf(response)).toBe(result);
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it("rejects an attempt sealed for another user or already expired", async () => {
    const otherUser = sealPendingPkceAttempt("user_2", {
      verifier: VERIFIER,
      state: STATE,
    });
    expect(
      resultOf(
        await GET(callbackRequest(`code=good-code&state=${STATE}`, otherUser)),
      ),
    ).toBe("state_mismatch");

    const expired = sealPendingPkceAttempt(
      "user_1",
      { verifier: VERIFIER, state: STATE },
      Date.now() - 11 * 60 * 1000,
    );
    expect(
      resultOf(
        await GET(callbackRequest(`code=good-code&state=${STATE}`, expired)),
      ),
    ).toBe("state_mismatch");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
