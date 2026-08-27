import { Sandbox } from "@e2b/code-interpreter";
import { terminateCloudSandboxesForUser } from "../cloud-sandbox";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    list: jest.fn(),
    kill: jest.fn(),
  },
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
    delete process.env.E2B_EU_API_KEY;
    delete process.env.E2B_EU_DOMAIN;
    delete process.env.E2B_EU_TEMPLATE;
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

  it("terminates sandboxes in both configured clusters", async () => {
    process.env.E2B_API_KEY = "e2b-us-test-key";
    process.env.E2B_EU_API_KEY = "e2b-eu-test-key";
    mockListE2BSandboxes
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => [{ sandboxId: "sandbox-us" }]),
        hasNext: false,
      } as ReturnType<typeof Sandbox.list>)
      .mockReturnValueOnce({
        nextItems: jest.fn(async () => [{ sandboxId: "sandbox-eu" }]),
        hasNext: false,
      } as ReturnType<typeof Sandbox.list>);
    mockKillE2BSandbox.mockResolvedValue(undefined);

    await expect(terminateCloudSandboxesForUser("user_123")).resolves.toEqual({
      total: 2,
      killed: 2,
      alreadyGone: 0,
    });
    expect(mockListE2BSandboxes).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        apiKey: "e2b-eu-test-key",
        domain: "e2b-juliett.dev",
      }),
    );
    expect(mockKillE2BSandbox).toHaveBeenNthCalledWith(1, "sandbox-us");
    expect(mockKillE2BSandbox).toHaveBeenNthCalledWith(2, "sandbox-eu", {
      apiKey: "e2b-eu-test-key",
      domain: "e2b-juliett.dev",
    });
  });
});
