import { describe, expect, it } from "@jest/globals";
import { resolveOrcaRouterEndpoints } from "@/lib/ai/orcarouter/config";

describe("resolveOrcaRouterEndpoints", () => {
  it("keeps auth and inference on their separate public origins", () => {
    expect(resolveOrcaRouterEndpoints({})).toEqual({
      authOrigin: "https://www.orcarouter.ai",
      apiBaseUrl: "https://api.orcarouter.ai/v1",
    });
  });

  it("uses one shared self-hosted origin for both surfaces", () => {
    expect(
      resolveOrcaRouterEndpoints({
        ORCAROUTER_BASE_URL: "https://gateway.example.com/",
      }),
    ).toEqual({
      authOrigin: "https://gateway.example.com",
      apiBaseUrl: "https://gateway.example.com/v1",
    });
  });

  it("prefers explicit auth and API overrides over the shared origin", () => {
    expect(
      resolveOrcaRouterEndpoints({
        ORCAROUTER_BASE_URL: "https://gateway.example.com",
        ORCAROUTER_AUTH_BASE_URL: "https://login.example.com",
        ORCAROUTER_API_BASE_URL: "https://relay.example.com/openai/v1/",
      }),
    ).toEqual({
      authOrigin: "https://login.example.com",
      apiBaseUrl: "https://relay.example.com/openai/v1",
    });
  });

  it("allows plain HTTP only for loopback development", () => {
    expect(
      resolveOrcaRouterEndpoints({
        ORCAROUTER_BASE_URL: "http://127.0.0.1:8080",
      }).apiBaseUrl,
    ).toBe("http://127.0.0.1:8080/v1");
    expect(() =>
      resolveOrcaRouterEndpoints({
        ORCAROUTER_API_BASE_URL: "http://relay.example.com/v1",
      }),
    ).toThrow(/https/);
    expect(() =>
      resolveOrcaRouterEndpoints({
        ORCAROUTER_AUTH_BASE_URL: "https://user:pass@login.example.com",
      }),
    ).toThrow(/credentials/);
  });
});
