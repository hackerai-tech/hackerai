jest.mock("../_generated/server", () => ({
  query: (config: unknown) => config,
  internalQuery: (config: unknown) => config,
  internalMutation: (config: unknown) => config,
}));
import { getStatusForUser } from "../deletions";

function context({
  chat = null,
  file = null,
  project = null,
  receipt = null,
  job = null,
  user = "user-1",
}: Record<string, any> = {}) {
  return {
    auth: { getUserIdentity: async () => (user ? { subject: user } : null) },
    db: {
      get: async (id: string) => (id.startsWith("project") ? project : file),
      query: (table: string) => ({
        withIndex: () => ({
          first: async () =>
            table === "pendingFileDeletions" ? receipt : chat,
        }),
      }),
      system: { get: async () => job },
    },
  } as any;
}
const status = (ctx: any, args: any = {}) =>
  (getStatusForUser as any).handler(ctx, args);
const receipt = { user_id: "user-1", scheduled_function_id: "job-1" };

describe("deletion confirmation", () => {
  it("does not consider a fenced task deleted", async () => {
    await expect(
      status(context({ chat: { user_id: "user-1", deletion_started_at: 1 } })),
    ).resolves.toBe("pending");
  });
  it("waits for storage even after task and file records disappear", async () => {
    await expect(
      status(context({ receipt, job: { state: { kind: "inProgress" } } })),
    ).resolves.toBe("pending");
  });
  it.each(["failed", "canceled", "success"])(
    "does not accept a %s storage job with an outstanding receipt",
    async (kind) => {
      await expect(
        status(context({ receipt, job: { state: { kind } } })),
      ).resolves.toBe("failed");
    },
  );
  it("reports an expired job without a completion receipt as failed", async () => {
    await expect(status(context({ receipt }))).resolves.toBe("failed");
  });
  it("completes only after records and storage receipts are gone", async () => {
    await expect(status(context())).resolves.toBe("complete");
  });
  it("waits for a deleting project to finish detaching tasks", async () => {
    await expect(
      status(
        context({ project: { user_id: "user-1", deletion_started_at: 1 } }),
        { projectId: "project-1" },
      ),
    ).resolves.toBe("pending");
  });
  it("checks both file records and pending storage", async () => {
    await expect(
      status(context({ file: { user_id: "user-1" } }), { fileId: "file-1" }),
    ).resolves.toBe("pending");
  });
  it("requires authentication", async () => {
    await expect(status(context({ user: null }))).rejects.toThrow(
      "Not authenticated",
    );
  });
  it("rejects another user's file receipt", async () => {
    await expect(
      status(context({ receipt: { ...receipt, user_id: "other" } }), {
        fileId: "file-1",
      }),
    ).rejects.toThrow("Forbidden");
  });
  it("rejects another user's task", async () => {
    await expect(
      status(context({ chat: { user_id: "other" } }), { chatId: "chat-1" }),
    ).rejects.toThrow("Forbidden");
  });
  it("rejects mixed scopes", async () => {
    await expect(
      status(context(), { chatId: "chat-1", fileId: "file-1" }),
    ).rejects.toThrow("Invalid deletion scope");
  });
});
