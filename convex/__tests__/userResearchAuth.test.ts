import { afterEach, describe, expect, it } from "@jest/globals";
import { validateUserResearchServiceKey } from "../lib/userResearchAuth";

const originalKey = process.env.CONVEX_USER_RESEARCH_SERVICE_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.CONVEX_USER_RESEARCH_SERVICE_KEY;
  } else {
    process.env.CONVEX_USER_RESEARCH_SERVICE_KEY = originalKey;
  }
});

describe("validateUserResearchServiceKey", () => {
  it("accepts the dedicated user research service key", () => {
    process.env.CONVEX_USER_RESEARCH_SERVICE_KEY = "research-key";

    expect(() => validateUserResearchServiceKey("research-key")).not.toThrow();
  });

  it("rejects the general Convex service key", () => {
    process.env.CONVEX_USER_RESEARCH_SERVICE_KEY = "research-key";

    expect(() => validateUserResearchServiceKey("general-service-key")).toThrow(
      "Unauthorized: Invalid user research service key",
    );
  });

  it("fails closed when the dedicated key is not configured", () => {
    delete process.env.CONVEX_USER_RESEARCH_SERVICE_KEY;

    expect(() => validateUserResearchServiceKey("any-key")).toThrow(
      "Unauthorized: Invalid user research service key",
    );
  });
});
