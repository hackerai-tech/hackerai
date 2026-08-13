import { beforeEach, describe, expect, it, jest } from "@jest/globals";

describe("acquireTeamInvitationLock", () => {
  const mockCreateRedisClient = jest.fn();
  const mockSet = jest.fn();
  const mockEval = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    jest.clearAllMocks();
    mockSet.mockResolvedValue("OK");
    mockEval.mockResolvedValue(1);
  });

  const getIsolatedModule = () => {
    let isolatedModule: typeof import("../team-invitation-lock");

    jest.isolateModules(() => {
      jest.doMock("@/lib/rate-limit/redis", () => ({
        createRedisClient: mockCreateRedisClient,
      }));
      isolatedModule = require("../team-invitation-lock");
    });

    return isolatedModule!;
  };

  it("acquires an organization lock and releases only its own token", async () => {
    mockCreateRedisClient.mockReturnValue({ set: mockSet, eval: mockEval });
    const { acquireTeamInvitationLock } = getIsolatedModule();

    const lock = await acquireTeamInvitationLock("org-123");

    expect(lock).not.toBeNull();
    expect(mockSet).toHaveBeenCalledWith(
      "team_invitation_lock:org-123",
      expect.any(String),
      { nx: true, ex: 60 },
    );
    const token = mockSet.mock.calls[0][1];

    await lock!.assertOwned();
    expect(mockEval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("EXPIRE"),
      ["team_invitation_lock:org-123"],
      [token, "60"],
    );

    await lock!.release();
    await lock!.release();
    expect(mockEval).toHaveBeenCalledTimes(2);
    expect(mockEval).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DEL"),
      ["team_invitation_lock:org-123"],
      [token],
    );
  });

  it("renews the lease while invitation processing is running", async () => {
    mockCreateRedisClient.mockReturnValue({ set: mockSet, eval: mockEval });
    const { acquireTeamInvitationLock } = getIsolatedModule();
    const lock = await acquireTeamInvitationLock("org-123");
    const token = mockSet.mock.calls[0][1];

    await jest.advanceTimersByTimeAsync(15_000);

    expect(mockEval).toHaveBeenCalledWith(
      expect.stringContaining("EXPIRE"),
      ["team_invitation_lock:org-123"],
      [token, "60"],
    );
    await lock!.release();
  });

  it("returns null while another invitation holds the lock", async () => {
    mockCreateRedisClient.mockReturnValue({ set: mockSet, eval: mockEval });
    mockSet.mockResolvedValue(null);
    const { acquireTeamInvitationLock } = getIsolatedModule();

    await expect(acquireTeamInvitationLock("org-123")).resolves.toBeNull();
    expect(mockEval).not.toHaveBeenCalled();
  });

  it("maps Redis acquisition errors to lock unavailability", async () => {
    mockCreateRedisClient.mockReturnValue({ set: mockSet, eval: mockEval });
    mockSet.mockRejectedValueOnce(new Error("Redis unavailable"));
    const { acquireTeamInvitationLock, TeamInvitationLockUnavailableError } =
      getIsolatedModule();

    await expect(acquireTeamInvitationLock("org-123")).rejects.toBeInstanceOf(
      TeamInvitationLockUnavailableError,
    );
  });
});
