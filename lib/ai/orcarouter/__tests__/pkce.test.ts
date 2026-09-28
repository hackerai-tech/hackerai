import { describe, expect, it, jest } from "@jest/globals";
import {
  buildOrcaRouterAuthorizeUrl,
  createPkceAttempt,
  createS256Challenge,
  exchangeOrcaRouterCode,
  statesMatch,
} from "@/lib/ai/orcarouter/pkce";
import { OrcaRouterAuthError } from "@/lib/ai/orcarouter/auth-errors";

const { Response: EdgeResponse } =
  require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
    Response: typeof Response;
  };

const jsonResponse = (body: unknown, status = 200) =>
  new EdgeResponse(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const AUTH_ORIGIN = "https://www.orcarouter.ai";

describe("OrcaRouter PKCE", () => {
  it("derives base64url(sha256(verifier)) without padding", () => {
    // Expected value computed independently with Python hashlib/base64.
    expect(
      createS256Challenge("dBjftJeZ4CVP-mJ92K9h9tCNk2pGmzAvQ9S2c3n-Ixw"),
    ).toBe("c3VXkftpoXZtq0OCD76XmVvdIyYXAO_jHWG_oNlTpo4");
  });

  it("creates a fresh verifier and state for every attempt", () => {
    const first = createPkceAttempt();
    const second = createPkceAttempt();
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.state).not.toBe(second.state);
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toBe(createS256Challenge(first.verifier));
  });

  it("builds the consent URL on the auth origin with only the challenge", () => {
    const attempt = createPkceAttempt();
    const url = new URL(
      buildOrcaRouterAuthorizeUrl({
        authOrigin: AUTH_ORIGIN,
        callbackUrl: "https://hackerai.co/api/orcarouter/callback",
        challenge: attempt.challenge,
        state: attempt.state,
      }),
    );

    expect(url.origin).toBe(AUTH_ORIGIN);
    expect(url.pathname).toBe("/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: "https://hackerai.co/api/orcarouter/callback",
      code_challenge: attempt.challenge,
      code_challenge_method: "S256",
      state: attempt.state,
      app_name: "HackerAI",
      scope: "api",
    });
    expect(url.toString()).not.toContain(attempt.verifier);
  });

  it("compares state in constant time and rejects missing values", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch("abc", null)).toBe(false);
  });

  it("exchanges the code on /api/v1/auth/keys of the auth origin", async () => {
    const fetchImpl = jest.fn(async (_input: unknown, _init?: RequestInit) =>
      jsonResponse({ key: "sk-orca-test-key", user_id: "1", scope: "api" }),
    );

    await expect(
      exchangeOrcaRouterCode({
        authOrigin: AUTH_ORIGIN,
        code: "one-time-code",
        verifier: "the-verifier",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ key: "sk-orca-test-key", scope: "api" });

    const [input, init] = fetchImpl.mock.calls[0];
    expect(String(input)).toBe("https://www.orcarouter.ai/api/v1/auth/keys");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "one-time-code",
      code_verifier: "the-verifier",
      code_challenge_method: "S256",
    });
  });

  it.each([
    [403, "invalid_code"],
    [400, "method_rejected"],
    [429, "rate_limited"],
    [502, "network"],
  ])("maps HTTP %i to %s without leaking secrets", async (status, kind) => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ error: "boom sk-orca-leak" }, status),
    );
    const error = await exchangeOrcaRouterCode({
      authOrigin: AUTH_ORIGIN,
      code: "reused-code",
      verifier: "secret-verifier",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OrcaRouterAuthError);
    expect((error as OrcaRouterAuthError).kind).toBe(kind);
    const message = (error as Error).message;
    expect(message).not.toContain("secret-verifier");
    expect(message).not.toContain("reused-code");
    expect(message).not.toContain("sk-orca");
  });

  it("treats a transport failure as a network error", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      exchangeOrcaRouterCode({
        authOrigin: AUTH_ORIGIN,
        code: "c",
        verifier: "v",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("rejects a narrower granted scope instead of assuming the request", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ key: "sk-orca-test-key", scope: "connector" }),
    );
    await expect(
      exchangeOrcaRouterCode({
        authOrigin: AUTH_ORIGIN,
        code: "c",
        verifier: "v",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "insufficient_scope" });
  });

  it("rejects a success body without a key", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ scope: "api" }));
    await expect(
      exchangeOrcaRouterCode({
        authOrigin: AUTH_ORIGIN,
        code: "c",
        verifier: "v",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });
});
