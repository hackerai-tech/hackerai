import { afterEach, describe, expect, it, jest } from "@jest/globals";

const originalClientId = process.env.WORKOS_CLIENT_ID;
const originalAuthDomain = process.env.WORKOS_AUTH_DOMAIN;

function restoreEnvironmentVariable(
  name: "WORKOS_CLIENT_ID" | "WORKOS_AUTH_DOMAIN",
  value: string | undefined,
) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function loadAuthConfig({
  clientId,
  authDomain,
}: {
  clientId?: string;
  authDomain?: string;
}) {
  jest.resetModules();
  restoreEnvironmentVariable("WORKOS_CLIENT_ID", clientId);
  restoreEnvironmentVariable("WORKOS_AUTH_DOMAIN", authDomain);
  return (await import("../auth.config")).default;
}

afterEach(() => {
  restoreEnvironmentVariable("WORKOS_CLIENT_ID", originalClientId);
  restoreEnvironmentVariable("WORKOS_AUTH_DOMAIN", originalAuthDomain);
  jest.resetModules();
});

describe("Convex WorkOS auth configuration", () => {
  it("leaves providers empty when WORKOS_CLIENT_ID is unavailable", async () => {
    const authConfig = await loadAuthConfig({});

    expect(authConfig.providers).toEqual([]);
  });

  it("always uses HackerAI's custom auth domain", async () => {
    const authConfig = await loadAuthConfig({
      clientId: "client_test",
      authDomain: "api.workos.com",
    });

    expect(authConfig.providers).toEqual([
      {
        type: "customJwt",
        issuer: "https://auth.hackerai.co/user_management/client_test",
        algorithm: "RS256",
        jwks: "https://auth.hackerai.co/sso/jwks/client_test",
      },
    ]);
  });
});
