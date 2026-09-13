import { Sandbox } from "@e2b/code-interpreter";
import { assertFreshMiosaEnrollment } from "../miosa-enrollment";

jest.mock("@e2b/code-interpreter", () => ({ Sandbox: { list: jest.fn() } }));
const mockList = Sandbox.list as jest.Mock;

describe("fresh MIOSA enrollment", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, E2B_API_KEY: "test-us" };
    delete process.env.E2B_EU_API_KEY;
    mockList.mockReturnValue({
      nextItems: jest.fn(async () => []),
      hasNext: false,
    });
  });
  afterAll(() => {
    process.env = originalEnv;
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(["free", undefined] as const)(
    "does not enroll %s into a new workspace",
    async (subscription) => {
      await expect(
        assertFreshMiosaEnrollment({ userId: "user-1", subscription }),
      ).rejects.toMatchObject({ reason: "not_pro" });
      expect(mockList).not.toHaveBeenCalled();
    },
  );

  it.each(["pro", "pro-plus", "team", "ultra"] as const)(
    "admits %s only when no running or paused workspace exists, regardless of template",
    async (subscription) => {
      await expect(
        assertFreshMiosaEnrollment({ userId: "user-1", subscription }),
      ).resolves.toBeUndefined();
      expect(mockList).toHaveBeenCalledWith(
        expect.objectContaining({
          query: {
            metadata: { userID: "user-1" },
            state: ["running", "paused"],
          },
          limit: 1,
        }),
      );
    },
  );

  it.each(["running", "paused"])(
    "protects %s E2B workspaces on old templates",
    async (state) => {
      mockList.mockReturnValue({
        nextItems: jest.fn(async () => [
          { state, metadata: { template: "old-template" } },
        ]),
        hasNext: false,
      });
      await expect(
        assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
      ).rejects.toMatchObject({ reason: "existing_e2b_workspace" });
    },
  );

  it("does not treat an empty first page as proof of absence", async () => {
    let page = 0;
    mockList.mockReturnValue({
      nextItems: jest.fn(async () =>
        ++page === 1 ? [] : [{ state: "paused" }],
      ),
      get hasNext() {
        return page < 2;
      },
    });
    await expect(
      assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
    ).rejects.toMatchObject({ reason: "existing_e2b_workspace" });
  });

  it("protects workspaces found in another configured cluster without executing there", async () => {
    process.env.E2B_EU_API_KEY = "test-eu";
    mockList
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => []),
        hasNext: false,
      })
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => [{ state: "paused" }]),
        hasNext: false,
      });
    await expect(
      assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
    ).rejects.toMatchObject({ reason: "existing_e2b_workspace" });
    expect(mockList).toHaveBeenLastCalledWith(
      expect.objectContaining({ domain: "e2b-juliett.dev", apiKey: "test-eu" }),
    );
  });

  it("requires successful reads from every configured cluster", async () => {
    process.env.E2B_EU_API_KEY = "test-eu";
    const secondPage = jest.fn().mockRejectedValue(new Error("unavailable"));
    mockList
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => []),
        hasNext: false,
      })
      .mockReturnValueOnce({ nextItems: secondPage, hasNext: false });
    await expect(
      assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
    ).rejects.toMatchObject({ reason: "workspace_discovery_unavailable" });
  });

  it("fails closed without the default E2B account", async () => {
    delete process.env.E2B_API_KEY;
    await expect(
      assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
    ).rejects.toMatchObject({ reason: "workspace_discovery_unavailable" });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("bounds incomplete pagination instead of enrolling", async () => {
    mockList.mockReturnValue({
      nextItems: jest.fn(async () => []),
      hasNext: true,
    });
    await expect(
      assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
    ).rejects.toMatchObject({
      reason: "workspace_discovery_unavailable",
      discoveryFailure: { kind: "pagination_limit", cluster: "us" },
    });
  });

  it.each([
    ["AuthenticationError", "credentials secret-value", "authentication", 401],
    ["SandboxError", "403: secret-value", "authentication", 403],
    ["TimeoutError", "secret-value", "timeout", undefined],
    ["RateLimitError", "secret-value", "rate_limit", 429],
    ["SandboxError", "503: secret-value", "http_error", 503],
    ["TypeError", "secret-value", "request_error", undefined],
  ])(
    "safely classifies %s without retaining the response body",
    async (name, message, kind, httpStatus) => {
      process.env.E2B_EU_API_KEY = "test-eu";
      const failure = Object.assign(new Error(message), { name });
      mockList
        .mockReturnValueOnce({ nextItems: async () => [], hasNext: false })
        .mockReturnValueOnce({
          nextItems: async () => {
            throw failure;
          },
          hasNext: false,
        });
      const error = await assertFreshMiosaEnrollment({
        userId: "user-1",
        subscription: "pro",
      }).catch((error) => error);
      expect(error).toMatchObject({
        reason: "workspace_discovery_unavailable",
        discoveryFailure: {
          cluster: "eu",
          kind,
          elapsedMs: expect.any(Number),
        },
      });
      expect(error.discoveryFailure.httpStatus).toBe(httpStatus);
      expect(JSON.stringify(error)).not.toContain("secret-value");
      expect(error.cause).toBeUndefined();
    },
  );

  it("recomputes the remaining deadline for each page", async () => {
    let now = 0;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const nextItems = jest.fn(async () => {
      now += 2000;
      return [];
    });
    mockList.mockReturnValue({
      nextItems,
      get hasNext() {
        return now < 4000;
      },
    });
    process.env.E2B_EU_API_KEY = "test-eu";
    await expect(
      assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
    ).rejects.toMatchObject({
      discoveryFailure: { kind: "deadline", cluster: "eu" },
    });
    expect(nextItems).toHaveBeenLastCalledWith({ requestTimeoutMs: 1000 });
  });
});
