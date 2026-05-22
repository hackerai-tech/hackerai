import { describe, it, expect } from "@jest/globals";
import {
  extractErrorDetails,
  extractRetryAttempts,
  getProviderErrorCategory,
  isProviderStreamTerminatedError,
} from "../error-utils";

const apiCallError = (overrides: Record<string, unknown>) =>
  Object.assign(new Error("Internal Server Error"), {
    name: "AI_APICallError",
    statusCode: 500,
    ...overrides,
  });

const retryError = (errors: unknown[]) =>
  Object.assign(new Error("Failed after 3 attempts."), {
    name: "AI_RetryError",
    errors,
  });

describe("extractRetryAttempts -> request_id", () => {
  it("extracts OpenRouter provider metadata from data.error.metadata", () => {
    const err = apiCallError({
      data: {
        id: "gen-1778016347-NLwcIgc6sf7HbOc1VW4x",
        error: {
          code: 502,
          message: "Upstream idle timeout exceeded",
          metadata: {
            provider_name: "Moonshot AI",
            raw: "upstream idle timeout exceeded after 60s",
          },
        },
      },
    });

    expect(extractErrorDetails(err)).toMatchObject({
      providerName: "Moonshot AI",
      providerErrorCode: 502,
      providerErrorMessage: "Upstream idle timeout exceeded",
      providerRawError: "upstream idle timeout exceeded after 60s",
      openrouterGenerationId: "gen-1778016347-NLwcIgc6sf7HbOc1VW4x",
    });
  });

  it("extracts OpenRouter provider metadata from responseBody JSON", () => {
    const err = apiCallError({
      responseBody: JSON.stringify({
        id: "gen-9999999999-abcdefabcdef",
        error: {
          code: 503,
          message: "Provider overloaded",
          metadata: {
            provider_name: "Anthropic",
          },
        },
      }),
    });

    expect(extractErrorDetails(err)).toMatchObject({
      providerName: "Anthropic",
      providerErrorCode: 503,
      providerErrorMessage: "Provider overloaded",
      openrouterGenerationId: "gen-9999999999-abcdefabcdef",
    });
  });

  it("prefers OpenRouter gen-id from error.data over cf-ray header", () => {
    const err = retryError([
      apiCallError({
        data: { id: "gen-1778016347-NLwcIgc6sf7HbOc1VW4x" },
        responseHeaders: { "cf-ray": "9f72c2a5a959778a-IAD" },
      }),
    ]);

    const attempts = extractRetryAttempts(err);
    expect(attempts).toBeDefined();
    expect(attempts?.[0].request_id).toBe(
      "gen-1778016347-NLwcIgc6sf7HbOc1VW4x",
    );
    expect(attempts?.[0].status_code).toBe(500);
    expect(attempts?.[0].error_name).toBe("AI_APICallError");
  });

  it("accepts a req- id from data.id (no gen- prefix required)", () => {
    const err = retryError([
      apiCallError({
        data: { id: "req-1778016347-xR1Km9PePxpLUOKwXsqW" },
        responseHeaders: { "cf-ray": "9f72c2a5a959778a-IAD" },
      }),
    ]);

    expect(extractRetryAttempts(err)?.[0].request_id).toBe(
      "req-1778016347-xR1Km9PePxpLUOKwXsqW",
    );
  });

  it("falls back to data.request_id (req-…) when no gen id", () => {
    const err = retryError([
      apiCallError({
        data: { request_id: "req-1778016347-xR1Km9PePxpLUOKwXsqW" },
        responseHeaders: { "cf-ray": "9f72c2a5a959778a-IAD" },
      }),
    ]);

    expect(extractRetryAttempts(err)?.[0].request_id).toBe(
      "req-1778016347-xR1Km9PePxpLUOKwXsqW",
    );
  });

  it("parses gen-id out of responseBody string when data is missing", () => {
    const err = retryError([
      apiCallError({
        responseBody: JSON.stringify({
          id: "gen-9999999999-abcdefabcdef",
          error: { message: "Internal Server Error" },
        }),
        responseHeaders: { "cf-ray": "9f72c2a5a959778a-IAD" },
      }),
    ]);

    expect(extractRetryAttempts(err)?.[0].request_id).toBe(
      "gen-9999999999-abcdefabcdef",
    );
  });

  it("prefers x-generation-id header over cf-ray when no body id is present", () => {
    const err = retryError([
      apiCallError({
        responseHeaders: {
          "x-generation-id": "gen-1778028118-8p4SD1KZJCPm5JpEOwtC",
          "cf-ray": "9f72bbfae8f83b5c-IAD",
        },
      }),
    ]);

    expect(extractRetryAttempts(err)?.[0].request_id).toBe(
      "gen-1778028118-8p4SD1KZJCPm5JpEOwtC",
    );
  });

  it("falls back to cf-ray header when neither body nor x-generation-id is present", () => {
    const err = retryError([
      apiCallError({
        responseHeaders: { "cf-ray": "9f72bbfae8f83b5c-IAD" },
      }),
    ]);

    expect(extractRetryAttempts(err)?.[0].request_id).toBe(
      "9f72bbfae8f83b5c-IAD",
    );
  });

  it("falls back to cf-ray when responseBody is malformed JSON", () => {
    const err = retryError([
      apiCallError({
        responseBody: "<html>upstream 502</html>",
        responseHeaders: { "cf-ray": "9f72bbfae8f83b5c-IAD" },
      }),
    ]);

    expect(extractRetryAttempts(err)?.[0].request_id).toBe(
      "9f72bbfae8f83b5c-IAD",
    );
  });

  it("returns one attempt per inner error and preserves order", () => {
    const err = retryError([
      apiCallError({
        data: { id: "gen-aaa" },
        responseHeaders: { "cf-ray": "ray-1" },
      }),
      apiCallError({
        data: { id: "gen-bbb" },
        responseHeaders: { "cf-ray": "ray-2" },
      }),
      apiCallError({
        responseHeaders: { "cf-ray": "ray-3" },
      }),
    ]);

    const ids = extractRetryAttempts(err)?.map((a) => a.request_id);
    expect(ids).toEqual(["gen-aaa", "gen-bbb", "ray-3"]);
  });

  it("adds provider name to retry attempts when OpenRouter exposes it", () => {
    const err = retryError([
      apiCallError({
        data: {
          error: {
            metadata: {
              provider_name: "Google",
            },
          },
        },
      }),
    ]);

    expect(extractRetryAttempts(err)?.[0].provider_name).toBe("Google");
  });

  it("returns undefined when error has no errors[] array", () => {
    expect(extractRetryAttempts(new Error("nope"))).toBeUndefined();
  });
});

describe("provider error classification", () => {
  it("classifies undici terminated errors as provider stream termination", () => {
    const err = Object.assign(new TypeError("terminated"), {
      cause: "other side closed",
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "stream_terminated",
    );
    expect(isProviderStreamTerminatedError(err)).toBe(true);
  });

  it("classifies provider status codes before message patterns", () => {
    const err = apiCallError({
      statusCode: 503,
      message: "terminated",
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "provider_5xx",
    );
  });

  it("classifies upstream idle timeouts without an HTTP status as provider timeouts", () => {
    const err = {
      code: 502,
      message: "Upstream idle timeout exceeded",
    };

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe("timeout");
  });
});
