import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { terminateCloudSandboxesForUser } from "@/lib/ai/tools/utils/cloud-sandbox";
import { POST } from "../route";

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/cloud-sandbox", () => ({
  terminateCloudSandboxesForUser: jest.fn(),
}));

const mockGetUserIDAndPro = getUserIDAndPro as jest.MockedFunction<
  typeof getUserIDAndPro
>;
const mockTerminateCloudSandboxesForUser =
  terminateCloudSandboxesForUser as jest.MockedFunction<
    typeof terminateCloudSandboxesForUser
  >;

describe("POST /api/delete-sandboxes", () => {
  let debugSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    global.Response = class TestResponse {
      status: number;
      private body: string;

      constructor(body: string, init?: ResponseInit) {
        this.body = body;
        this.status = init?.status ?? 200;
      }

      async json() {
        return JSON.parse(this.body);
      }
    } as unknown as typeof Response;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "pro",
    } as never);
  });

  afterEach(() => {
    debugSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("treats already-gone sandbox kills as successful delete progress", async () => {
    mockTerminateCloudSandboxesForUser.mockResolvedValue({
      total: 2,
      killed: 1,
      alreadyGone: 1,
    });

    const response = await POST({} as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      total: 2,
      killed: 1,
      alreadyGone: 1,
    });
    expect(mockTerminateCloudSandboxesForUser).toHaveBeenCalledWith("user_123");
  });

  it("still fails on unexpected kill errors", async () => {
    mockTerminateCloudSandboxesForUser.mockRejectedValueOnce(
      new Error("permission denied"),
    );

    const response = await POST({} as any);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to delete sandboxes" });
    expect(errorSpy).toHaveBeenCalledWith(
      "Error deleting sandboxes:",
      expect.any(Error),
    );
  });

  it("does not count transport-closure failures as deleted sandboxes", async () => {
    mockTerminateCloudSandboxesForUser.mockRejectedValueOnce(
      new Error("kill transport channel already closed"),
    );

    const response = await POST({} as any);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to delete sandboxes" });
    expect(errorSpy).toHaveBeenCalledWith(
      "Error deleting sandboxes:",
      expect.any(Error),
    );
  });
});
