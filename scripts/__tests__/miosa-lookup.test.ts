const mockListUsers = jest.fn();
const mockGet = jest.fn();
const mockList = jest.fn();
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  readFileSync: jest.fn(
    () => "WORKOS_API_KEY=test\nWORKOS_CLIENT_ID=test\nMIOSA_API_KEY=test",
  ),
}));
jest.mock("@workos-inc/node", () => ({
  WorkOS: jest.fn(() => ({ userManagement: { listUsers: mockListUsers } })),
}));
jest.mock("@miosa/sdk", () => ({
  Miosa: jest.fn(() => ({ sandboxes: { get: mockGet, list: mockList } })),
}));
import { main } from "../miosa-lookup";
import {
  miosaExternalUserId,
  miosaUserReference,
} from "../../lib/ai/tools/utils/miosa-identity";

describe("read-only Miosa support lookup", () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    process.exitCode = 0;
  });
  const user = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
  };
  const sandbox = {
    data: {
      id: "sandbox-1",
      name: `${miosaExternalUserId(user.id)}-v2`,
      state: "paused",
    },
  };

  it("finds an existing sandbox owner on a later page without resuming it", async () => {
    mockGet.mockResolvedValue(sandbox);
    mockListUsers.mockResolvedValueOnce({
      data: [{ ...user, id: "other" }],
      listMetadata: { after: "page-2" },
    });
    mockListUsers.mockResolvedValueOnce({ data: [user], listMetadata: {} });
    await main(["--env-file", "verified.env", "--sandbox-id", "sandbox-1"]);
    expect(mockListUsers).toHaveBeenLastCalledWith({
      limit: 100,
      after: "page-2",
    });
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      user: { id: user.id, email: user.email, name: "Test User" },
      sandboxes: [{ id: "sandbox-1", state: "paused" }],
    });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("looks up email and lists only that account's immutable provider identity", async () => {
    mockListUsers.mockResolvedValue({ data: [user], listMetadata: {} });
    mockList.mockResolvedValue([sandbox]);
    await main(["--env-file", "verified.env", "--email", user.email]);
    expect(mockList).toHaveBeenCalledWith({
      externalUserId: miosaExternalUserId(user.id),
    });
    expect(JSON.parse(log.mock.calls[0][0]).userReference).toBe(
      miosaUserReference(user.id),
    );
  });

  it("fails closed on ambiguous references without listing any sandboxes", async () => {
    mockListUsers.mockResolvedValue({ data: [user, user], listMetadata: {} });
    await main([
      "--env-file",
      "verified.env",
      "--reference",
      miosaUserReference(user.id),
    ]);
    expect(mockList).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0]).result).toBe(
      "ambiguous_reference_use_full_workspace_name",
    );
  });
});
