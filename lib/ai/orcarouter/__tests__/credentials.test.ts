jest.mock("server-only", () => ({}));

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mockMutation, mockQuery } from "@/__mocks__/convex/browser";
import {
  isOrcaRouterCredentialStorageConfigured,
  openOrcaRouterSecret,
  sealOrcaRouterSecret,
} from "@/lib/ai/orcarouter/credential-crypto";
import {
  createOrcaRouterProviderForUser,
  credentialFromApiKey,
  credentialFromPkceCallback,
  markOrcaRouterCredentialNeedsReauth,
  openPendingPkceAttempt,
  ORCAROUTER_NOT_CONNECTED_MESSAGE,
  ORCAROUTER_RECONNECT_MESSAGE,
  OrcaRouterCredentialInputError,
  saveOrcaRouterCredential,
  sealPendingPkceAttempt,
} from "@/lib/ai/orcarouter/credentials";
import {
  buildOrcaRouterAuthorizeUrl,
  createPkceAttempt,
  createS256Challenge,
} from "@/lib/ai/orcarouter/pkce";
import { ChatSDKError } from "@/lib/errors";

const { Response: EdgeResponse } =
  require("next/dist/compiled/@edge-runtime/primitives/fetch") as {
    Response: typeof Response;
  };

const USER = "user_123";
const AUTH_ORIGIN = "https://www.orcarouter.ai";

beforeEach(() => {
  process.env.ORCAROUTER_CREDENTIALS_KEY = randomBytes(32).toString("base64");
  process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
  mockQuery.mockReset();
  mockMutation.mockReset();
  mockMutation.mockResolvedValue({ generation: 1 } as never);
});

/**
 * Minimal OrcaRouter auth server: it remembers the challenge sent on the
 * consent URL and, like the real endpoint, redeems a code once and only for
 * the matching verifier.
 */
function createFakeAuthServer() {
  const issued = new Map<string, string>();
  return {
    approve(authorizeUrl: string) {
      const url = new URL(authorizeUrl);
      const code = `code-${issued.size + 1}`;
      issued.set(code, url.searchParams.get("code_challenge")!);
      return new URLSearchParams({
        code,
        state: url.searchParams.get("state")!,
      });
    },
    fetch: jest.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe(`${AUTH_ORIGIN}/api/v1/auth/keys`);
      const body = JSON.parse(String(init?.body)) as {
        code: string;
        code_verifier: string;
      };
      const challenge = issued.get(body.code);
      issued.delete(body.code);
      if (!challenge || createS256Challenge(body.code_verifier) !== challenge) {
        return new EdgeResponse("{}", { status: 403 });
      }
      return new EdgeResponse(
        JSON.stringify({ key: "sk-orca-issued-by-pkce", scope: "api" }),
        { status: 200 },
      );
    }),
  };
}

describe("OrcaRouter credential encryption", () => {
  it("round-trips only for the same context", () => {
    const sealed = sealOrcaRouterSecret("sk-orca-secret", USER);
    expect(sealed).not.toContain("sk-orca-secret");
    expect(openOrcaRouterSecret(sealed, USER)).toBe("sk-orca-secret");
    expect(() => openOrcaRouterSecret(sealed, "user_other")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const [version, iv, tag, ciphertext] = sealOrcaRouterSecret(
      "sk-orca-secret",
      USER,
    ).split(".");
    const flipped = `${ciphertext.slice(0, -2)}${ciphertext.endsWith("A") ? "BB" : "AA"}`;
    expect(() =>
      openOrcaRouterSecret([version, iv, tag, flipped].join("."), USER),
    ).toThrow();
  });

  it("requires a 32-byte deployment key", () => {
    expect(isOrcaRouterCredentialStorageConfigured()).toBe(true);
    expect(
      isOrcaRouterCredentialStorageConfigured({
        ORCAROUTER_CREDENTIALS_KEY: "short",
      }),
    ).toBe(false);
    expect(isOrcaRouterCredentialStorageConfigured({})).toBe(false);
  });
});

describe("OrcaRouter credential adapters", () => {
  it("normalizes a pasted API key", () => {
    expect(credentialFromApiKey("  sk-orca-pasted  ")).toEqual({
      key: "sk-orca-pasted",
      source: "api_key",
    });
    expect(() => credentialFromApiKey("   ")).toThrow(
      OrcaRouterCredentialInputError,
    );
    expect(() => credentialFromApiKey("sk-orca bad")).toThrow(
      OrcaRouterCredentialInputError,
    );
  });

  it("completes authorize → callback → exchange → persist through the PKCE adapter", async () => {
    const server = createFakeAuthServer();
    const attempt = createPkceAttempt();
    const authorizeUrl = buildOrcaRouterAuthorizeUrl({
      authOrigin: AUTH_ORIGIN,
      callbackUrl: "https://hackerai.co/api/orcarouter/callback",
      challenge: attempt.challenge,
      state: attempt.state,
    });
    const callbackParams = server.approve(authorizeUrl);

    const credential = await credentialFromPkceCallback({
      authOrigin: AUTH_ORIGIN,
      expectedState: attempt.state,
      verifier: attempt.verifier,
      params: callbackParams,
      fetchImpl: server.fetch as unknown as typeof fetch,
    });
    expect(credential).toEqual({
      key: "sk-orca-issued-by-pkce",
      source: "pkce",
    });

    await saveOrcaRouterCredential(USER, credential);
    const saved = mockMutation.mock.calls[0][1] as {
      encryptedKey: string;
      keyHint: string;
      source: string;
    };
    expect(saved.source).toBe("pkce");
    expect(saved.keyHint).toBe("…pkce");
    expect(saved.encryptedKey).not.toContain("sk-orca-issued-by-pkce");
    expect(openOrcaRouterSecret(saved.encryptedKey, USER)).toBe(
      "sk-orca-issued-by-pkce",
    );

    // Codes are single-use: replaying the same callback is refused.
    await expect(
      credentialFromPkceCallback({
        authOrigin: AUTH_ORIGIN,
        expectedState: attempt.state,
        verifier: attempt.verifier,
        params: callbackParams,
        fetchImpl: server.fetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind: "invalid_code" });
  });

  it("stores both adapters' credentials through the same seam", async () => {
    await saveOrcaRouterCredential(USER, credentialFromApiKey("sk-orca-abcd"));
    await saveOrcaRouterCredential(USER, {
      key: "sk-orca-wxyz",
      source: "pkce",
    });
    const [apiKeyCall, pkceCall] = mockMutation.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(Object.keys(apiKeyCall).sort()).toEqual(
      Object.keys(pkceCall).sort(),
    );
    expect(apiKeyCall.source).toBe("api_key");
    expect(pkceCall.source).toBe("pkce");
  });

  it.each([
    ["state mismatch", { code: "c", state: "forged" }, "state_mismatch"],
    ["denial", { error: "access_denied", state: "S" }, "access_denied"],
    ["missing code", { state: "S" }, "missing_code"],
  ])("stops on %s before redeeming anything", async (_name, params, kind) => {
    const server = createFakeAuthServer();
    await expect(
      credentialFromPkceCallback({
        authOrigin: AUTH_ORIGIN,
        expectedState: "S",
        verifier: "secret-verifier",
        params: new URLSearchParams(params),
        fetchImpl: server.fetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ kind });
    expect(server.fetch).not.toHaveBeenCalled();
  });
});

describe("pending PKCE attempt cookie", () => {
  it("opens only for the same user before expiry", () => {
    const sealed = sealPendingPkceAttempt(
      USER,
      { verifier: "v", state: "s" },
      1_000,
    );
    expect(sealed).not.toContain('"v"');
    expect(openPendingPkceAttempt(USER, sealed, 2_000)).toEqual({
      verifier: "v",
      state: "s",
    });
    expect(openPendingPkceAttempt("user_other", sealed, 2_000)).toBeNull();
    expect(
      openPendingPkceAttempt(USER, sealed, 1_000 + 10 * 60 * 1000),
    ).toBeNull();
    expect(openPendingPkceAttempt(USER, undefined)).toBeNull();
    expect(openPendingPkceAttempt(USER, "garbage")).toBeNull();
  });
});

describe("createOrcaRouterProviderForUser", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    encrypted_key: sealOrcaRouterSecret("sk-orca-live", USER),
    key_hint: "…live",
    source: "api_key",
    status: "active",
    generation: 7,
    updated_at: 1,
    ...overrides,
  });

  it("asks the user to connect when no key is stored", async () => {
    mockQuery.mockResolvedValue(null as never);
    const error = await createOrcaRouterProviderForUser(USER).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ChatSDKError);
    expect((error as ChatSDKError).cause).toBe(
      ORCAROUTER_NOT_CONNECTED_MESSAGE,
    );
  });

  it("asks the user to reconnect after a revoked key, without refresh", async () => {
    mockQuery.mockResolvedValue(row({ status: "needs_reauth" }) as never);
    const error = await createOrcaRouterProviderForUser(USER).catch(
      (caught: unknown) => caught,
    );
    expect((error as ChatSDKError).cause).toBe(ORCAROUTER_RECONNECT_MESSAGE);
    expect(mockMutation).not.toHaveBeenCalled();
  });

  it("resolves OrcaRouter model keys with the stored key", async () => {
    mockQuery.mockResolvedValue(row() as never);
    const provider = await createOrcaRouterProviderForUser(USER);
    expect(provider.languageModel("orcarouter:openai/gpt-5.5").modelId).toBe(
      "openai/gpt-5.5",
    );
  });

  it("marks only the rejected generation for reconnection", async () => {
    await markOrcaRouterCredentialNeedsReauth(USER, 7);
    expect(mockMutation.mock.calls[0][1]).toEqual({
      serviceKey: "service-key",
      userId: USER,
      generation: 7,
    });
  });
});
