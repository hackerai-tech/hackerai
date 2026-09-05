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

  it.each(["free", "pro-plus", "ultra", "team", undefined] as const)(
    "does not enroll %s into a new workspace",
    async (subscription) => {
      await expect(
        assertFreshMiosaEnrollment({ userId: "user-1", subscription }),
      ).rejects.toMatchObject({ reason: "not_pro" });
      expect(mockList).not.toHaveBeenCalled();
    },
  );

  it("admits Pro only when no running or paused workspace exists, regardless of template", async () => {
    await expect(
      assertFreshMiosaEnrollment({ userId: "user-1", subscription: "pro" }),
    ).resolves.toBeUndefined();
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { metadata: { userID: "user-1" }, state: ["running", "paused"] },
        limit: 1,
      }),
    );
  });

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
    ).rejects.toMatchObject({ reason: "workspace_discovery_unavailable" });
  });
});
