import { Sandbox } from "@e2b/code-interpreter";
import { terminateAwsLambdaMicrovmForUser } from "../aws-lambda-microvm";
import { terminateCloudSandboxesForUser } from "../cloud-sandbox";

const mockDeleteAwsLambdaMicrovmWorkspace = jest.fn();

jest.mock("../aws-lambda-microvm", () => ({
  terminateAwsLambdaMicrovmForUser: jest.fn(),
}));
jest.mock("../aws-lambda-microvm-workspace", () => ({
  deleteAwsLambdaMicrovmWorkspace: mockDeleteAwsLambdaMicrovmWorkspace,
}));
jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    list: jest.fn(),
    kill: jest.fn(),
  },
}));

const mockTerminateAwsLambdaMicrovmForUser =
  terminateAwsLambdaMicrovmForUser as jest.MockedFunction<
    typeof terminateAwsLambdaMicrovmForUser
  >;
const mockListE2BSandboxes = Sandbox.list as jest.MockedFunction<
  typeof Sandbox.list
>;
const mockKillE2BSandbox = Sandbox.kill as jest.MockedFunction<
  typeof Sandbox.kill
>;

describe("cloud sandbox cleanup configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      CONVEX_SERVICE_ROLE_KEY: "test-service-key",
    };
    delete process.env.CLOUD_SANDBOX_PROVIDER;
    delete process.env.AWS_LAMBDA_MICROVM_IMAGE_ID;
    delete process.env.E2B_API_KEY;
    mockTerminateAwsLambdaMicrovmForUser.mockResolvedValue({
      total: 1,
      killed: 1,
      alreadyGone: 0,
    });
    mockDeleteAwsLambdaMicrovmWorkspace.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("cleans persisted AWS sessions without Vercel provider or image variables", async () => {
    await expect(terminateCloudSandboxesForUser("user_123")).resolves.toEqual({
      total: 1,
      killed: 1,
      alreadyGone: 0,
    });

    expect(mockTerminateAwsLambdaMicrovmForUser).toHaveBeenCalledWith(
      "user_123",
    );
    expect(mockListE2BSandboxes).not.toHaveBeenCalled();
    expect(mockDeleteAwsLambdaMicrovmWorkspace).toHaveBeenCalledWith(
      "user_123",
      "test-service-key",
    );
  });

  it("fails closed when AWS is selected without cleanup authorization", async () => {
    process.env.CLOUD_SANDBOX_PROVIDER = "aws-lambda-microvm";
    delete process.env.CONVEX_SERVICE_ROLE_KEY;

    await expect(terminateCloudSandboxesForUser("user_123")).rejects.toThrow(
      "CONVEX_SERVICE_ROLE_KEY is required",
    );
  });

  it("does not delete an archive that a still-running AWS VM can recreate", async () => {
    mockTerminateAwsLambdaMicrovmForUser.mockRejectedValueOnce(
      new Error("AWS unavailable"),
    );

    await expect(terminateCloudSandboxesForUser("user_123")).rejects.toThrow(
      "AWS unavailable",
    );
    expect(mockDeleteAwsLambdaMicrovmWorkspace).not.toHaveBeenCalled();
  });

  it("terminates every page of E2B sandboxes during provider migration", async () => {
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
      total: 3,
      killed: 3,
      alreadyGone: 0,
    });
    expect(mockKillE2BSandbox).toHaveBeenCalledTimes(2);
    expect(mockKillE2BSandbox).toHaveBeenNthCalledWith(1, "sandbox-page-1");
    expect(mockKillE2BSandbox).toHaveBeenNthCalledWith(2, "sandbox-page-2");
    expect(
      mockTerminateAwsLambdaMicrovmForUser.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockDeleteAwsLambdaMicrovmWorkspace.mock.invocationCallOrder[0],
    );
    expect(
      mockDeleteAwsLambdaMicrovmWorkspace.mock.invocationCallOrder[0],
    ).toBeLessThan(mockKillE2BSandbox.mock.invocationCallOrder[0]);
  });

  it("deletes the durable workspace even when legacy E2B cleanup fails", async () => {
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
    expect(mockDeleteAwsLambdaMicrovmWorkspace).toHaveBeenCalledWith(
      "user_123",
      "test-service-key",
    );
    expect(
      mockDeleteAwsLambdaMicrovmWorkspace.mock.invocationCallOrder[0],
    ).toBeLessThan(mockKillE2BSandbox.mock.invocationCallOrder[0]);

    errorSpy.mockRestore();
  });
});
