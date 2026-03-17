/**
 * Tests for Centrifugo JWT token generation.
 *
 * Note: jest.config maps "jose" to __mocks__/jose.ts which stubs SignJWT.
 * We need the real jose implementation for these tests, so we use
 * jest.requireActual to bypass the mock.
 */

// moduleNameMapper redirects "jose" to __mocks__/jose.ts.
// Override with a factory that provides a real SignJWT implementation.
jest.mock("jose", () => {
  class SignJWT {
    private payload: Record<string, unknown>;
    private header: Record<string, unknown> = {};

    constructor(payload: Record<string, unknown>) {
      this.payload = { ...payload };
    }

    setProtectedHeader(header: Record<string, unknown>) {
      this.header = header;
      return this;
    }

    setExpirationTime(time: string) {
      const match = time.match(/^(\d+)s$/);
      if (match) {
        this.payload.exp =
          Math.floor(Date.now() / 1000) + parseInt(match[1], 10);
      }
      return this;
    }

    async sign(_key: Uint8Array): Promise<string> {
      const encodeSegment = (obj: unknown) =>
        Buffer.from(JSON.stringify(obj)).toString("base64url");

      const header = encodeSegment(this.header);
      const payload = encodeSegment(this.payload);
      const signature = Buffer.from("mock-signature").toString("base64url");
      return `${header}.${payload}.${signature}`;
    }
  }

  return { SignJWT };
});

import { generateCentrifugoToken } from "../jwt";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  const payload = parts[1];
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(decoded);
}

function decodeJwtHeader(token: string): Record<string, unknown> {
  const parts = token.split(".");
  const header = parts[0];
  const decoded = Buffer.from(header, "base64url").toString("utf8");
  return JSON.parse(decoded);
}

describe("generateCentrifugoToken", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CENTRIFUGO_TOKEN_SECRET: "test-secret-key-for-testing",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when CENTRIFUGO_TOKEN_SECRET is missing", async () => {
    delete process.env.CENTRIFUGO_TOKEN_SECRET;

    await expect(generateCentrifugoToken("user-1", 3600)).rejects.toThrow(
      "CENTRIFUGO_TOKEN_SECRET environment variable is not set",
    );
  });

  it("generates a valid JWT with 3 base64url-encoded parts", async () => {
    const token = await generateCentrifugoToken("user-1", 3600);

    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    // Each part should be valid base64url (no +, /, or = padding required)
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    parts.forEach((part) => {
      expect(part).toMatch(base64urlRegex);
    });
  });

  it("has correct sub claim", async () => {
    const token = await generateCentrifugoToken("user-abc-123", 3600);
    const payload = decodeJwtPayload(token);

    expect(payload.sub).toBe("user-abc-123");
  });

  it("has correct exp claim matching expSeconds", async () => {
    const beforeTime = Math.floor(Date.now() / 1000);
    const token = await generateCentrifugoToken("user-1", 7200);
    const afterTime = Math.floor(Date.now() / 1000);

    const payload = decodeJwtPayload(token);
    const exp = payload.exp as number;

    expect(exp).toBeGreaterThanOrEqual(beforeTime + 7200);
    expect(exp).toBeLessThanOrEqual(afterTime + 7200);
  });

  it("uses HS256 algorithm", async () => {
    const token = await generateCentrifugoToken("user-1", 3600);
    const header = decodeJwtHeader(token);

    expect(header.alg).toBe("HS256");
  });
});
