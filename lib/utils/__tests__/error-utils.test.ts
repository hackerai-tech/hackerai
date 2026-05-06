import { describe, it, expect } from "@jest/globals";
import { extractRetryAttempts } from "../error-utils";

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

  it("falls back to cf-ray header when no body id is present", () => {
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

  it("returns undefined when error has no errors[] array", () => {
    expect(extractRetryAttempts(new Error("nope"))).toBeUndefined();
  });
});
