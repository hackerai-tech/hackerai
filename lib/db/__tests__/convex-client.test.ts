import { afterEach, describe, expect, it, jest } from "@jest/globals";

const originalConvexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

afterEach(() => {
  if (originalConvexUrl === undefined) {
    delete process.env.NEXT_PUBLIC_CONVEX_URL;
  } else {
    process.env.NEXT_PUBLIC_CONVEX_URL = originalConvexUrl;
  }
  jest.resetModules();
});

describe("Convex client routing", () => {
  it("exposes the effective environment URL for child task handoff", async () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://main.example.convex.cloud";
    const { getConvexUrl } = await import("../convex-client");

    expect(getConvexUrl()).toBe("https://main.example.convex.cloud");
  });

  it("prefers a run-specific override for preview deployments", async () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://main.example.convex.cloud";
    const { getConvexUrl, setConvexUrl } = await import("../convex-client");

    setConvexUrl("https://preview.example.convex.cloud");

    expect(getConvexUrl()).toBe("https://preview.example.convex.cloud");
  });
});
