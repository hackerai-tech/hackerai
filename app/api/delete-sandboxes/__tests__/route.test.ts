import { Sandbox } from "@e2b/code-interpreter";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { POST } from "../route";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    list: jest.fn(),
    kill: jest.fn(),
  },
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: jest.fn(),
}));

const mockSandboxList = Sandbox.list as jest.MockedFunction<
  typeof Sandbox.list
>;
const mockSandboxKill = Sandbox.kill as jest.MockedFunction<
  typeof Sandbox.kill
>;
const mockGetUserIDAndPro = getUserIDAndPro as jest.MockedFunction<
  typeof getUserIDAndPro
>;

const mockSandboxes = (sandboxIds: string[]) => {
  mockSandboxList.mockReturnValue({
    nextItems: jest
      .fn()
      .mockResolvedValue(sandboxIds.map((sandboxId) => ({ sandboxId }))),
  } as never);
};

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
    mockSandboxes(["sbx_live", "sbx_missing"]);
    mockSandboxKill
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(
        Object.assign(new Error("sandbox not_found"), { status: 404 }),
      );

    const response = await POST({} as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      total: 2,
      killed: 1,
      alreadyGone: 1,
    });
    expect(mockSandboxKill).toHaveBeenCalledWith("sbx_live");
    expect(mockSandboxKill).toHaveBeenCalledWith("sbx_missing");
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to kill sandbox"),
      expect.anything(),
    );
  });

  it("still fails on unexpected kill errors", async () => {
    mockSandboxes(["sbx_denied"]);
    mockSandboxKill.mockRejectedValueOnce(new Error("permission denied"));

    const response = await POST({} as any);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to delete sandboxes" });
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to kill sandbox sbx_denied:",
      expect.any(Error),
    );
  });
});
