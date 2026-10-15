import { Sandbox } from "@e2b/code-interpreter";
import { NotFoundError } from "e2b";
import { accessCloudWorkspaceFiles } from "../cloud-workspace-files";
import { workspaceRequest } from "../workspace-files";
import {
  assertCloudWorkspaceAvailable,
  readCloudWorkspaceState,
} from "@/lib/ai/tools/utils/cloud-workspace-guard";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { list: jest.fn(), getInfo: jest.fn(), connect: jest.fn() },
}));
jest.mock("e2b", () => ({ NotFoundError: class extends Error {} }));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-guard", () => ({
  readCloudWorkspaceState: jest.fn(),
  assertCloudWorkspaceAvailable: jest.fn(),
  CloudWorkspaceUnavailableError: class extends Error {},
}));
const input = (extra = {}) =>
  workspaceRequest.parse({ chatId: "chat", action: "list", ...extra });
const run = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(readCloudWorkspaceState).mockResolvedValue(null);
  jest.mocked(Sandbox.getInfo).mockResolvedValue({
    sandboxId: "sandbox",
    state: "running",
    metadata: { userID: "owner", template: "terminal-agent-sandbox" },
  } as any);
  jest.mocked(Sandbox.connect).mockResolvedValue({ commands: { run } } as any);
  run.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ entries: [], total: 0, nextOffset: null }),
  });
});
it("rejects a foreign sandbox before connecting", async () => {
  jest
    .mocked(Sandbox.getInfo)
    .mockResolvedValue({ metadata: { userID: "other" } } as any);
  await expect(
    accessCloudWorkspaceFiles(
      "owner",
      "us-east-1",
      input({ sandboxId: "foreign" }),
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(Sandbox.connect).not.toHaveBeenCalled();
});
it("does not resume paused workspaces until explicitly requested", async () => {
  jest.mocked(Sandbox.getInfo).mockResolvedValue({
    state: "paused",
    metadata: { userID: "owner", template: "terminal-agent-sandbox" },
  } as any);
  expect(
    await accessCloudWorkspaceFiles(
      "owner",
      "us-east-1",
      input({ sandboxId: "sandbox" }),
    ),
  ).toEqual({ state: "paused", sandboxId: "sandbox" });
  expect(Sandbox.connect).not.toHaveBeenCalled();
  expect(
    await accessCloudWorkspaceFiles(
      "owner",
      "us-east-1",
      input({ sandboxId: "sandbox", action: "resume" }),
    ),
  ).toMatchObject({ state: "running", entries: [] });
});
it("does not replace a missing workspace or a pinned expired sandbox", async () => {
  jest
    .mocked(Sandbox.list)
    .mockReturnValue({ nextItems: async () => [], hasNext: false } as any);
  expect(
    await accessCloudWorkspaceFiles("owner", "us-east-1", input()),
  ).toEqual({ state: "missing" });
  jest.mocked(Sandbox.getInfo).mockRejectedValue(new NotFoundError("gone"));
  expect(
    await accessCloudWorkspaceFiles(
      "owner",
      "us-east-1",
      input({ sandboxId: "old" }),
    ),
  ).toEqual({ state: "missing", sandboxId: "old" });
  expect(Sandbox.connect).not.toHaveBeenCalled();
});
it("withholds bytes if recovery or deletion fences the workspace during the read", async () => {
  jest
    .mocked(assertCloudWorkspaceAvailable)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("fenced"));
  await expect(
    accessCloudWorkspaceFiles(
      "owner",
      "us-east-1",
      input({ sandboxId: "sandbox" }),
    ),
  ).rejects.toThrow("fenced");
});
it("reads without changing a running Agent's sandbox timeout", async () => {
  await accessCloudWorkspaceFiles(
    "owner",
    "us-east-1",
    input({ sandboxId: "sandbox" }),
  );
  expect(jest.mocked(Sandbox.connect).mock.calls[0][1]).not.toHaveProperty(
    "timeoutMs",
  );
});
