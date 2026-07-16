import { describe, it, expect } from "@jest/globals";
import {
  classifyProviderOverflowError,
  extractErrorDetails,
  extractRetryAttempts,
  getUserFriendlyProviderError,
  getProviderErrorCategory,
  getProviderStatusCode,
  isInvalidImageInputError,
  isProviderContentBlockedError,
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

  it("extracts OpenRouter provider metadata from a direct parsed error body", () => {
    const err = {
      message: "Provider returned error",
      code: 400,
      id: "gen-direct-400",
      error: {
        code: 400,
        message: "Provider returned error",
        metadata: {
          provider_name: "Anthropic",
          raw: "tool_result without corresponding tool_use",
        },
      },
    };

    expect(extractErrorDetails(err)).toMatchObject({
      providerName: "Anthropic",
      providerErrorCode: 400,
      providerErrorMessage: "Provider returned error",
      providerRawError: "tool_result without corresponding tool_use",
      openrouterGenerationId: "gen-direct-400",
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

describe("extractErrorDetails -> wrapped provider errors", () => {
  it("extracts nested OpenRouter details from generic provider wrappers", () => {
    const nested = apiCallError({
      statusCode: 400,
      responseBody: JSON.stringify({
        id: "gen-400-wrapper",
        error: {
          code: 400,
          message: "Provider returned error",
          metadata: {
            provider_name: "Anthropic",
            raw: "tool_result without corresponding tool_use",
          },
        },
      }),
      requestBodyValues: {
        messages: [{ role: "user", content: "SECRET_PROMPT_TEXT" }],
      },
    });
    const err = {
      message: "Provider returned error",
      code: 400,
      error: nested,
    };

    const details = extractErrorDetails(err);

    expect(details).toMatchObject({
      errorName: "AI_APICallError",
      errorMessage: "Provider returned error",
      errorCode: 400,
      statusCode: 400,
      providerName: "Anthropic",
      providerErrorCode: 400,
      providerErrorMessage: "Provider returned error",
      providerRawError: "tool_result without corresponding tool_use",
      openrouterGenerationId: "gen-400-wrapper",
    });
    expect(getProviderStatusCode(details)).toBe(400);
    expect(getProviderErrorCategory(details)).toBe("provider_4xx");
    expect(JSON.stringify(details)).not.toContain("SECRET_PROMPT_TEXT");
  });
});

describe("provider error classification", () => {
  it("classifies undici terminated errors as provider stream termination", () => {
    const cause = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    });
    const err = Object.assign(new TypeError("terminated"), {
      cause,
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "stream_terminated",
    );
    expect(extractErrorDetails(err)).toMatchObject({
      cause: "other side closed",
      errorCode: "UND_ERR_SOCKET",
    });
    expect(isProviderStreamTerminatedError(err)).toBe(true);
  });

  it("classifies ECONNRESET provider socket closures as stream termination", () => {
    const err = Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "stream_terminated",
    );
    expect(extractErrorDetails(err)).toMatchObject({ errorCode: "ECONNRESET" });
  });

  it("recognizes expired provider image URLs as user-correctable input", () => {
    const err = apiCallError({
      statusCode: 400,
      message:
        "Failed to download the provided image because the image host returned HTTP status 404.",
    });

    expect(isInvalidImageInputError(err)).toBe(true);
    expect(getUserFriendlyProviderError(err)).toBe(
      "An attached image is no longer available at its source URL. Reattach the image and try again.",
    );
  });

  it("classifies network-loss messages as provider stream termination", () => {
    const err = new Error("Network connection lost.");

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

  it("uses top-level numeric provider error codes as status codes", () => {
    const err = {
      code: 400,
      message: "Provider returned error",
    };

    const details = extractErrorDetails(err);
    expect(getProviderStatusCode(details)).toBe(400);
    expect(getProviderErrorCategory(details)).toBe("provider_4xx");
  });

  it("classifies upstream idle timeouts without an HTTP status as provider timeouts", () => {
    const err = {
      code: 502,
      message: "Upstream idle timeout exceeded",
    };

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe("timeout");
  });

  it("uses nested provider status codes when direct HTTP status is missing", () => {
    const err = apiCallError({
      statusCode: undefined,
      responseBody: JSON.stringify({
        error: {
          code: 502,
          message: "Provider overloaded",
        },
      }),
    });

    const details = extractErrorDetails(err);
    expect(getProviderStatusCode(details)).toBe(502);
    expect(getProviderErrorCategory(details)).toBe("provider_5xx");
  });

  it("uses numeric string provider status codes when direct HTTP status is missing", () => {
    const err = apiCallError({
      statusCode: undefined,
      responseBody: JSON.stringify({
        error: {
          code: "502",
          message: "Provider overloaded",
        },
      }),
    });

    const details = extractErrorDetails(err);
    expect(getProviderStatusCode(details)).toBe(502);
    expect(getProviderErrorCategory(details)).toBe("provider_5xx");
  });

  it("classifies provider safety blocks separately from generic 403s", () => {
    const err = apiCallError({
      statusCode: 403,
      message: "PROHIBITED_CONTENT",
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "content_blocked",
    );
    expect(isProviderContentBlockedError(err)).toBe(true);
    expect(getUserFriendlyProviderError(err)).toBe(
      "The model provider blocked this request because the conversation content was flagged by its safety system. Edit your last message or remove sensitive or raw tool output, then try again.",
    );
  });

  it("keeps non-safety 403s as provider 4xx errors", () => {
    const err = apiCallError({
      statusCode: 403,
      message: "Access denied for this model",
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "provider_4xx",
    );
    expect(isProviderContentBlockedError(err)).toBe(false);
  });

  it("classifies explicit content policy block messages", () => {
    const err = apiCallError({
      statusCode: 403,
      message: "Request was rejected for a safety policy violation.",
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "content_blocked",
    );
    expect(isProviderContentBlockedError(err)).toBe(true);
  });

  it("classifies output blocks from content filtering policy", () => {
    const err = apiCallError({
      statusCode: 403,
      message: "Output blocked by content filtering policy",
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "content_blocked",
    );
    expect(isProviderContentBlockedError(err)).toBe(true);
  });

  it("does not classify moderation service failures as content blocks", () => {
    const err = apiCallError({
      statusCode: 503,
      message: "moderation service unavailable",
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe(
      "provider_5xx",
    );
    expect(isProviderContentBlockedError(err)).toBe(false);
  });

  it("classifies provider-specific messages when the top-level message is generic", () => {
    const err = apiCallError({
      statusCode: undefined,
      message: "Provider request failed",
      responseBody: JSON.stringify({
        error: {
          message: "Upstream idle timeout exceeded",
        },
      }),
    });

    expect(getProviderErrorCategory(extractErrorDetails(err))).toBe("timeout");
  });

  it("classifies provider context overflow errors", () => {
    const err = apiCallError({
      statusCode: 400,
      data: {
        error: {
          message:
            "context_length_exceeded: maximum context length is 128000 tokens",
        },
      },
    });

    expect(classifyProviderOverflowError(err)).toBe("context");
    expect(getUserFriendlyProviderError(err)).toContain("context limit");
  });

  it("classifies provider media overflow errors", () => {
    const err = apiCallError({
      statusCode: 413,
      responseBody: JSON.stringify({
        error: {
          message: "image file too large; reduce the attachment size",
        },
      }),
    });

    expect(classifyProviderOverflowError(err)).toBe("media");
    expect(getUserFriendlyProviderError(err)).toContain("attached media");
  });

  it("classifies OpenRouter downloaded image size failures as media overflow", () => {
    const err = apiCallError({
      statusCode: 413,
      responseBody: JSON.stringify({
        error: {
          message: "Downloaded image content cannot exceed 30MB",
        },
      }),
    });

    expect(classifyProviderOverflowError(err)).toBe("media");
    expect(getUserFriendlyProviderError(err)).toContain("attached media");
  });

  it("does not classify generic payload overflow as media-only", () => {
    const err = apiCallError({
      statusCode: 413,
      message: "payload too large",
    });

    expect(classifyProviderOverflowError(err)).toBe("context");
    expect(getUserFriendlyProviderError(err)).toContain("context limit");
  });
});
