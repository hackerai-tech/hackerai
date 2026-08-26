import { Sandbox } from "@e2b/code-interpreter";
import { terminateCloudSandboxesForUser } from "../cloud-sandbox";

const mockTerminateMiosaSandboxesForUser = jest.fn();

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    list: jest.fn(),
    kill: jest.fn(),
  },
}));

jest.mock("../miosa-sandbox", () => ({
  ensureMiosaSandboxConnection: jest.fn(),
  terminateMiosaSandboxesForUser: (...args: unknown[]) =>
    mockTerminateMiosaSandboxesForUser(...args),
}));

const mockListE2BSandboxes = Sandbox.list as jest.MockedFunction<
  typeof Sandbox.list
>;
const mockKillE2BSandbox = Sandbox.kill as jest.MockedFunction<
  typeof Sandbox.kill
>;

describe("cloud sandbox cleanup", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.E2B_API_KEY;
    delete process.env.MIOSA_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("terminates every page of E2B sandboxes", async () => {
    process.env.E2B_API_KEY = "e2b-test-key";
    let page = 0;
    const pages = [
      [{ sandboxId: "sandbox-page-1" }],
      [{ sandboxId: "sandbox-page-2" }],
    ];
    mockListE2BSandboxes.mockReturnValue({
      nextItems: jest.fn(async () => pages[page++] ?? []),
      get hasNext() {
        return page < pages.length;
      },
    } as ReturnType<typeof Sandbox.list>);
    mockKillE2BSandbox.mockResolvedValue(undefined);

    await expect(terminateCloudSandboxesForUser("user_123")).resolves.toEqual({
      total: 2,
      killed: 2,
      alreadyGone: 0,
    });
    expect(mockKillE2BSandbox).toHaveBeenCalledTimes(2);
    expect(mockKillE2BSandbox).toHaveBeenNthCalledWith(1, "sandbox-page-1");
    expect(mockKillE2BSandbox).toHaveBeenNthCalledWith(2, "sandbox-page-2");
  });

  it("surfaces E2B cleanup failures", async () => {
    process.env.E2B_API_KEY = "e2b-test-key";
    mockListE2BSandboxes.mockReturnValue({
      nextItems: jest.fn(async () => [{ sandboxId: "sandbox-failing" }]),
      hasNext: false,
    } as ReturnType<typeof Sandbox.list>);
    mockKillE2BSandbox.mockRejectedValueOnce(new Error("E2B unavailable"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    await expect(terminateCloudSandboxesForUser("user_123")).rejects.toThrow(
      "E2B unavailable",
    );

    errorSpy.mockRestore();
  });

  it("combines MIOSA and E2B cleanup totals", async () => {
    process.env.MIOSA_API_KEY = "msk_test";
    process.env.E2B_API_KEY = "e2b-test-key";
    mockTerminateMiosaSandboxesForUser.mockResolvedValue({
      total: 2,
      killed: 1,
      alreadyGone: 1,
    });
    mockListE2BSandboxes.mockReturnValue({
      nextItems: jest.fn(async () => [{ sandboxId: "sandbox-e2b" }]),
      hasNext: false,
    } as ReturnType<typeof Sandbox.list>);
    mockKillE2BSandbox.mockResolvedValue(undefined);

    await expect(terminateCloudSandboxesForUser("user_123")).resolves.toEqual({
      total: 3,
      killed: 2,
      alreadyGone: 1,
    });
    expect(mockTerminateMiosaSandboxesForUser).toHaveBeenCalledWith("user_123");
    expect(mockKillE2BSandbox).toHaveBeenCalledWith("sandbox-e2b");
  });

  it("still cleans up E2B when MIOSA cleanup fails", async () => {
    process.env.MIOSA_API_KEY = "msk_test";
    process.env.E2B_API_KEY = "e2b-test-key";
    mockTerminateMiosaSandboxesForUser.mockRejectedValue(
      new Error("MIOSA unavailable"),
    );
    mockListE2BSandboxes.mockReturnValue({
      nextItems: jest.fn(async () => [{ sandboxId: "sandbox-e2b" }]),
      hasNext: false,
    } as ReturnType<typeof Sandbox.list>);
    mockKillE2BSandbox.mockResolvedValue(undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    await expect(terminateCloudSandboxesForUser("user_123")).rejects.toThrow(
      "MIOSA unavailable",
    );
    expect(mockKillE2BSandbox).toHaveBeenCalledWith("sandbox-e2b");

    errorSpy.mockRestore();
  });
});
