import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import {
  assertTriggerRunRegion,
  TriggerRegionMismatchError,
} from "@/lib/api/trigger-region";
import { migrateE2BWorkspace } from "@/lib/ai/tools/utils/miosa-workspace-migration";
import { phLogger } from "@/lib/posthog/server";

jest.mock("@trigger.dev/sdk", () => ({
  AbortTaskRunError: class AbortTaskRunError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AbortTaskRunError";
    }
  },
  schemaTask: jest.fn((definition) => definition),
}));
jest.mock("@/lib/api/trigger-region", () => ({
  assertTriggerRunRegion: jest.fn(),
  TriggerRegionMismatchError: class TriggerRegionMismatchError extends Error {},
}));
jest.mock("@/lib/ai/tools/utils/miosa-workspace-migration", () => ({
  migrateE2BWorkspace: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { flush: jest.fn().mockResolvedValue(undefined) },
}));

type TaskDefinition = {
  retry: { maxAttempts: number; minTimeoutInMs: number };
  run: (
    payload: {
      userId: string;
      sourceId: string;
      subscription: "pro";
      triggerRegion: "us-east-1";
    },
    context: {
      ctx: {
        run: { region: "us-east-1" };
        environment: { type: "PRODUCTION" };
      };
    },
  ) => Promise<{ reason: string }>;
};

const task = jest.requireActual("../miosa-workspace-migration")
  .miosaWorkspaceMigration as TaskDefinition;
const payload = {
  userId: "user",
  sourceId: "source",
  subscription: "pro" as const,
  triggerRegion: "us-east-1" as const,
};
const context = {
  ctx: {
    run: { region: "us-east-1" as const },
    environment: { type: "PRODUCTION" as const },
  },
};

describe("Miosa workspace migration task retries", () => {
  beforeEach(() => jest.clearAllMocks());

  it("retries transient transfer failures with a bounded backoff", async () => {
    (migrateE2BWorkspace as jest.Mock).mockResolvedValue({
      reason: "transfer_unavailable",
      failureStage: "archive_transfer",
      failureOperation: "destination_chunk_upload",
      failureKind: "timeout",
    });

    expect(task.retry).toMatchObject({
      maxAttempts: 3,
      minTimeoutInMs: 5 * 60 * 1000,
    });
    await expect(task.run(payload, context)).rejects.toThrow(
      "temporarily unavailable (archive_transfer/destination_chunk_upload/timeout)",
    );
    expect(phLogger.flush).toHaveBeenCalled();
  });

  it("completes policy rejections without retrying them", async () => {
    const result = {
      reason: "source_export_rejected",
      sourceExportReason: "external_symlink",
    };
    (migrateE2BWorkspace as jest.Mock).mockResolvedValue(result);

    await expect(task.run(payload, context)).resolves.toEqual(result);
    expect(assertTriggerRunRegion).toHaveBeenCalled();
    expect(phLogger.flush).toHaveBeenCalled();
  });

  it("aborts deterministic region mismatches without retrying", async () => {
    (assertTriggerRunRegion as jest.Mock).mockImplementation(() => {
      throw new TriggerRegionMismatchError("us-east-1", "us-west-2");
    });

    await expect(task.run(payload, context)).rejects.toBeInstanceOf(
      AbortTaskRunError,
    );
    expect(migrateE2BWorkspace).not.toHaveBeenCalled();
  });
});
