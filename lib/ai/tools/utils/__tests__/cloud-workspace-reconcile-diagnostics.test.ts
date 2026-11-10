import { Sandbox } from "@e2b/code-interpreter";
import { reconcileWorkspaceCreation } from "../cloud-workspace-identity";
import {
  CloudWorkspaceUnavailableError,
  type ProvisioningWorkspace,
} from "../cloud-workspace-guard";

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { list: jest.fn(), create: jest.fn() },
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
const mockEval = jest.fn();
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({ eval: mockEval }),
}));

const creating: ProvisioningWorkspace = {
  version: 1,
  phase: "provisioning",
  step: "creating",
  token: "private-creation-token",
  region: "us-east-1",
};
const owned = {
  sandboxId: "private-workspace-id",
  state: "paused",
  metadata: {
    userID: "owner",
    template: "terminal-agent-sandbox",
    e2bCluster: "us",
    workspaceCreationToken: creating.token,
  },
};
const environment = process.env;
let warning: jest.SpyInstance;
const inventory = (items: unknown[], hasNext = false) => {
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext,
    nextItems: jest.fn(async () => items),
  } as never);
};
const expectReason = (reason: string) => {
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace creation reconciliation failed",
    { event: "cloud_workspace_creation_reconcile_failed", reason },
  );
  expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-|owner/);
  expect(Sandbox.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...environment, E2B_API_KEY: "synthetic-us" };
  warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockEval.mockResolvedValue(1);
  inventory([owned]);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = environment;
});

it.each<[string, unknown[], boolean, string]>([
  ["incomplete inventory", [owned, owned], true, "inventory_incomplete"],
  ["no match", [], false, "no_matching_workspace"],
  ["multiple matches", [owned, owned], false, "multiple_matching_workspaces"],
  [
    "different owner",
    [{ ...owned, metadata: { ...owned.metadata, userID: "private-other" } }],
    false,
    "workspace_identity_mismatch",
  ],
  [
    "different creation token",
    [
      {
        ...owned,
        metadata: {
          ...owned.metadata,
          workspaceCreationToken: "private-other",
        },
      },
    ],
    false,
    "creation_token_mismatch",
  ],
])(
  "reports %s without adopting or creating a workspace",
  async (_name, items, hasNext, reason) => {
    inventory(items, hasNext);
    await expect(
      reconcileWorkspaceCreation("owner", creating),
    ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
    expectReason(reason);
    expect(mockEval).not.toHaveBeenCalled();
  },
);

it("preserves the provider error without disclosing its contents", async () => {
  const failure = new Error("private-provider-response");
  jest.mocked(Sandbox.list).mockImplementation(() => {
    throw failure;
  });
  await expect(reconcileWorkspaceCreation("owner", creating)).rejects.toBe(
    failure,
  );
  expectReason("inventory_lookup_failed");
  expect(mockEval).not.toHaveBeenCalled();
});

it("reports a rejected binding commit without retrying it", async () => {
  mockEval.mockResolvedValue(0);
  await expect(
    reconcileWorkspaceCreation("owner", creating),
  ).rejects.toBeInstanceOf(CloudWorkspaceUnavailableError);
  expectReason("binding_rejected");
  expect(mockEval).toHaveBeenCalledTimes(1);
});

it("leaves a failed binding transport outcome unconfirmed", async () => {
  const failure = new Error("private-store-response");
  mockEval.mockRejectedValue(failure);
  await expect(reconcileWorkspaceCreation("owner", creating)).rejects.toBe(
    failure,
  );
  expectReason("binding_finalize_unconfirmed");
  expect(mockEval).toHaveBeenCalledTimes(1);
});

it("preserves a binding transport error even when logging throws", async () => {
  const failure = new Error("private-store-response");
  mockEval.mockRejectedValue(failure);
  warning.mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  await expect(reconcileWorkspaceCreation("owner", creating)).rejects.toBe(
    failure,
  );
  expect(warning).toHaveBeenCalledWith(
    "Cloud workspace creation reconciliation failed",
    {
      event: "cloud_workspace_creation_reconcile_failed",
      reason: "binding_finalize_unconfirmed",
    },
  );
  expect(mockEval).toHaveBeenCalledTimes(1);
  expect(Sandbox.create).not.toHaveBeenCalled();
});

it("does not label an uncertain binding result as cancellation", async () => {
  const controller = new AbortController();
  const failure = new Error("private-lost-reply");
  mockEval.mockImplementation(async () => {
    controller.abort();
    throw failure;
  });
  await expect(
    reconcileWorkspaceCreation("owner", creating, controller.signal),
  ).rejects.toBe(failure);
  expectReason("binding_finalize_unconfirmed");
  expect(mockEval).toHaveBeenCalledTimes(1);
});

it("retains cancellation before the binding commit", async () => {
  const controller = new AbortController();
  const failure = new Error("private-abort-reason");
  controller.abort(failure);
  await expect(
    reconcileWorkspaceCreation("owner", creating, controller.signal),
  ).rejects.toBe(failure);
  expectReason("request_aborted");
  expect(mockEval).not.toHaveBeenCalled();
});

it("identifies cancellation during the provider lookup without replacing it", async () => {
  const controller = new AbortController();
  const failure = new Error("private-abort-reason");
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => {
      controller.abort(failure);
      throw failure;
    },
  } as never);
  await expect(
    reconcileWorkspaceCreation("owner", creating, controller.signal),
  ).rejects.toBe(failure);
  expectReason("request_aborted");
  expect(mockEval).not.toHaveBeenCalled();
});

it("keeps an unrelated lookup error distinct from a simultaneous cancellation", async () => {
  const controller = new AbortController();
  const failure = new Error("private-provider-response");
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => {
      controller.abort(new Error("private-abort-reason"));
      throw failure;
    },
  } as never);
  await expect(
    reconcileWorkspaceCreation("owner", creating, controller.signal),
  ).rejects.toBe(failure);
  expectReason("inventory_lookup_failed");
  expect(mockEval).not.toHaveBeenCalled();
});

it("identifies a standard abort error during the provider lookup", async () => {
  const controller = new AbortController();
  const failure = new DOMException("private-abort-error", "AbortError");
  jest.mocked(Sandbox.list).mockReturnValue({
    hasNext: false,
    nextItems: async () => {
      controller.abort();
      throw failure;
    },
  } as never);
  await expect(
    reconcileWorkspaceCreation("owner", creating, controller.signal),
  ).rejects.toBe(failure);
  expectReason("request_aborted");
  expect(mockEval).not.toHaveBeenCalled();
});

it("adopts the matching completed creation without failure diagnostics", async () => {
  await expect(
    reconcileWorkspaceCreation("owner", creating),
  ).resolves.toMatchObject({
    phase: "e2b",
    origin: "created",
    token: creating.token,
    destinationId: owned.sandboxId,
  });
  expect(mockEval).toHaveBeenCalledTimes(1);
  expect(warning).not.toHaveBeenCalled();
  expect(Sandbox.create).not.toHaveBeenCalled();
});
