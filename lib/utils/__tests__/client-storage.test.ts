import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  CONVERSATION_DRAFTS_STORAGE_KEY,
  getDraftAttachmentsById,
  readOpenSidebarProjectIds,
  readSelectedModel,
  removeDraftAttachments,
  writeSelectedModel,
  clearSelectedModelFromStorage,
  clearSidebarTaskLastVisitedAt,
  hasAuthenticatedBefore,
  hasDraftAttachmentsById,
  markHasAuthenticatedBefore,
  upsertDraft,
  upsertDraftAttachments,
  writeOpenSidebarProjectIds,
  readAgentPermissionMode,
  writeAgentPermissionMode,
  SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY,
  SIDEBAR_TASK_LAST_VISITED_AT_STORAGE_PREFIX,
  getSidebarTaskLastVisitedAtStorageKey,
  markSidebarTaskVisited,
  parseSidebarTaskLastVisitedAt,
  readSidebarTaskLastVisitedAt,
  subscribeSidebarTaskLastVisitedAt,
  AGENT_PERMISSION_MODE_STORAGE_KEY,
} from "../client-storage";

const STORAGE_KEY = "selected_model";
const LEGACY_ASK_KEY = `${STORAGE_KEY}_ask`;
const LEGACY_AGENT_KEY = `${STORAGE_KEY}_agent`;

describe("client-storage selected model", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("readSelectedModel", () => {
    it("returns null when nothing is stored", () => {
      expect(readSelectedModel()).toBeNull();
    });

    it("returns the value stored under the unified key", () => {
      window.localStorage.setItem(STORAGE_KEY, "hackerai-pro");
      expect(readSelectedModel()).toBe("hackerai-pro");
    });

    it("rejects invalid stored values", () => {
      window.localStorage.setItem(STORAGE_KEY, "not-a-real-model");
      expect(readSelectedModel()).toBeNull();
    });

    it("migrates legacy underlying-model ids to HackerAI tiers", () => {
      window.localStorage.setItem(STORAGE_KEY, "opus-4.6");
      expect(readSelectedModel()).toBe("hackerai-max");
      // The migration rewrites the unified key to the tier id.
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("hackerai-max");
    });

    it("maps legacy gemini-3-flash and kimi-k2.6 both to hackerai-standard", () => {
      window.localStorage.setItem(STORAGE_KEY, "gemini-3-flash");
      expect(readSelectedModel()).toBe("hackerai-standard");

      window.localStorage.setItem(STORAGE_KEY, "kimi-k2.6");
      expect(readSelectedModel()).toBe("hackerai-standard");
    });

    it("migrates the short-lived hackerai-lite tier id to hackerai-standard", () => {
      window.localStorage.setItem(STORAGE_KEY, "hackerai-lite");
      expect(readSelectedModel()).toBe("hackerai-standard");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
        "hackerai-standard",
      );
    });

    it("migrates removed Grok ids to hackerai-standard", () => {
      window.localStorage.setItem(STORAGE_KEY, "grok-4.1");
      expect(readSelectedModel()).toBe("hackerai-standard");

      window.localStorage.setItem(STORAGE_KEY, "grok-4.3");
      expect(readSelectedModel()).toBe("hackerai-standard");

      window.localStorage.setItem(STORAGE_KEY, "grok-4.5");
      expect(readSelectedModel()).toBe("hackerai-standard");
    });

    it("does not match inherited Object.prototype keys via the legacy map", () => {
      // Without Object.hasOwn, "toString" / "constructor" would resolve to
      // inherited functions, not SelectedModel values.
      window.localStorage.setItem(STORAGE_KEY, "toString");
      expect(readSelectedModel()).toBeNull();

      window.localStorage.setItem(STORAGE_KEY, "constructor");
      expect(readSelectedModel()).toBeNull();

      window.localStorage.setItem(STORAGE_KEY, "hasOwnProperty");
      expect(readSelectedModel()).toBeNull();
    });

    it("migrates from legacy selected_model_ask key when unified key is empty", () => {
      window.localStorage.setItem(LEGACY_ASK_KEY, "opus-4.6");
      window.localStorage.setItem(LEGACY_AGENT_KEY, "sonnet-4.6");

      expect(readSelectedModel()).toBe("hackerai-max");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("hackerai-max");
      expect(window.localStorage.getItem(LEGACY_ASK_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_AGENT_KEY)).toBeNull();
    });

    it("falls back to legacy selected_model_agent key when ask is missing", () => {
      window.localStorage.setItem(LEGACY_AGENT_KEY, "kimi-k2.6");

      expect(readSelectedModel()).toBe("hackerai-standard");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
        "hackerai-standard",
      );
      expect(window.localStorage.getItem(LEGACY_AGENT_KEY)).toBeNull();
    });

    it("ignores legacy keys with unrecognized values and returns null", () => {
      window.localStorage.setItem(LEGACY_ASK_KEY, "totally-fake-model");
      window.localStorage.setItem(LEGACY_AGENT_KEY, "another-bogus-id");

      expect(readSelectedModel()).toBeNull();
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("does not migrate from legacy keys when unified key is already a tier id", () => {
      window.localStorage.setItem(STORAGE_KEY, "hackerai-pro");
      window.localStorage.setItem(LEGACY_ASK_KEY, "opus-4.6");

      expect(readSelectedModel()).toBe("hackerai-pro");
      // Legacy key is left alone when unified key is valid.
      expect(window.localStorage.getItem(LEGACY_ASK_KEY)).toBe("opus-4.6");
    });
  });

  describe("writeSelectedModel", () => {
    it("persists under the unified key", () => {
      writeSelectedModel("hackerai-max");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("hackerai-max");
    });
  });

  describe("clearSelectedModelFromStorage", () => {
    it("removes the unified key and legacy per-mode keys", () => {
      window.localStorage.setItem(STORAGE_KEY, "hackerai-pro");
      window.localStorage.setItem(LEGACY_ASK_KEY, "opus-4.6");
      window.localStorage.setItem(LEGACY_AGENT_KEY, "kimi-k2.6");

      clearSelectedModelFromStorage();

      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_ASK_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_AGENT_KEY)).toBeNull();
    });
  });
});

describe("client-storage Agent permission mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each(["ask_approval", "auto_review", "full_access"] as const)(
    "round trips %s",
    (mode) => {
      writeAgentPermissionMode(mode);
      expect(readAgentPermissionMode()).toBe(mode);
    },
  );

  it("keeps Full access as the fallback for unknown stored values", () => {
    window.localStorage.setItem(
      AGENT_PERMISSION_MODE_STORAGE_KEY,
      "approve_for_me",
    );
    expect(readAgentPermissionMode()).toBe("full_access");
  });
});

describe("client-storage auth marker", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns false before the browser has authenticated", () => {
    expect(hasAuthenticatedBefore()).toBe(false);
  });

  it("persists that this browser has authenticated before", () => {
    markHasAuthenticatedBefore();
    expect(hasAuthenticatedBefore()).toBe(true);
  });
});

describe("client-storage sidebar open projects", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores only unique, non-empty project ids", () => {
    writeOpenSidebarProjectIds(["project-1", "", "project-2", "project-1"]);

    expect(readOpenSidebarProjectIds()).toEqual(["project-1", "project-2"]);
  });

  it("ignores malformed saved values", () => {
    window.localStorage.setItem(
      SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY,
      JSON.stringify(["project-1", null, 2, {}, "project-1"]),
    );

    expect(readOpenSidebarProjectIds()).toEqual(["project-1"]);

    window.localStorage.setItem(
      SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY,
      "not-json",
    );
    expect(readOpenSidebarProjectIds()).toEqual([]);
  });

  it("removes storage when every project is closed", () => {
    writeOpenSidebarProjectIds(["project-1"]);
    writeOpenSidebarProjectIds([]);

    expect(
      window.localStorage.getItem(SIDEBAR_OPEN_PROJECT_IDS_STORAGE_KEY),
    ).toBeNull();
  });
});

describe("client-storage sidebar task last-visited times", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSidebarTaskLastVisitedAt();
  });

  it("persists the latest visit time for a task", () => {
    markSidebarTaskVisited("chat-1", 100);
    markSidebarTaskVisited("chat-1", 90);

    expect(readSidebarTaskLastVisitedAt("chat-1")).toBe(100);
    expect(
      window.localStorage.getItem(
        getSidebarTaskLastVisitedAtStorageKey("chat-1"),
      ),
    ).toBe("100");
  });

  it("rejects malformed, non-finite, and negative saved values", () => {
    expect(parseSidebarTaskLastVisitedAt("100")).toBe(100);
    expect(parseSidebarTaskLastVisitedAt("-1")).toBeUndefined();
    expect(parseSidebarTaskLastVisitedAt("Infinity")).toBeUndefined();
    expect(parseSidebarTaskLastVisitedAt("not-a-number")).toBeUndefined();
    expect(parseSidebarTaskLastVisitedAt(null)).toBeUndefined();
  });

  it("preserves another tab's task record before its storage event arrives", () => {
    const otherTaskKey = getSidebarTaskLastVisitedAtStorageKey("chat-2");
    window.localStorage.setItem(otherTaskKey, "200");

    markSidebarTaskVisited("chat-1", 100);

    expect(window.localStorage.getItem(otherTaskKey)).toBe("200");
    expect(
      window.localStorage.getItem(
        getSidebarTaskLastVisitedAtStorageKey("chat-1"),
      ),
    ).toBe("100");
  });

  it("restores the maximum timestamp when a stale same-task write appears", () => {
    const taskKey = getSidebarTaskLastVisitedAtStorageKey("chat-1");
    markSidebarTaskVisited("chat-1", 200);
    window.localStorage.setItem(taskKey, "100");

    expect(readSidebarTaskLastVisitedAt("chat-1")).toBe(200);
    expect(window.localStorage.getItem(taskKey)).toBe("200");
  });

  it("ignores sessionStorage clear events", () => {
    markSidebarTaskVisited("chat-1", 100);
    const listener = jest.fn();
    const unsubscribe = subscribeSidebarTaskLastVisitedAt("chat-1", listener);

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: null,
        storageArea: window.sessionStorage,
      }),
    );

    const getItemSpy = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });
    try {
      expect(readSidebarTaskLastVisitedAt("chat-1")).toBe(100);
    } finally {
      getItemSpy.mockRestore();
      unsubscribe();
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps only the 100 most recently visited task keys", () => {
    for (let index = 0; index <= 100; index += 1) {
      markSidebarTaskVisited(`chat-${index}`, index);
    }

    const taskKeys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter((key) =>
      key?.startsWith(SIDEBAR_TASK_LAST_VISITED_AT_STORAGE_PREFIX),
    );
    expect(taskKeys).toHaveLength(100);
    expect(
      window.localStorage.getItem(
        getSidebarTaskLastVisitedAtStorageKey("chat-0"),
      ),
    ).toBeNull();
    expect(
      window.localStorage.getItem(
        getSidebarTaskLastVisitedAtStorageKey("chat-100"),
      ),
    ).toBe("100");
  });

  it("clears all persisted visit times", () => {
    markSidebarTaskVisited("chat-1", 100);
    clearSidebarTaskLastVisitedAt();

    expect(readSidebarTaskLastVisitedAt("chat-1")).toBeUndefined();
    expect(
      window.localStorage.getItem(
        getSidebarTaskLastVisitedAtStorageKey("chat-1"),
      ),
    ).toBeNull();
  });
});

describe("client-storage draft attachments", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists generated pasted-text attachments without draft text", () => {
    const timestamp = Date.now();
    const pastedContent = "Original pasted source material";
    upsertDraftAttachments("chat-1", [
      {
        kind: "pasted-text",
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text",
        generatedTextAttachmentId: "generated_123",
        tokens: 120,
        timestamp,
        generatedTextContent: pastedContent,
      } as any,
    ]);

    expect(hasDraftAttachmentsById("chat-1")).toBe(true);
    expect(getDraftAttachmentsById("chat-1")).toEqual([
      {
        kind: "pasted-text",
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text",
        generatedTextAttachmentId: "generated_123",
        tokens: 120,
        timestamp,
      },
    ]);
    expect(
      window.localStorage.getItem(CONVERSATION_DRAFTS_STORAGE_KEY),
    ).not.toContain(pastedContent);
  });

  it("persists regular S3 draft attachments without draft text", () => {
    const timestamp = Date.now();
    upsertDraftAttachments("chat-1", [
      {
        kind: "file",
        fileId: "file_regular",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 1024,
        tokens: 42,
        timestamp,
      },
    ]);

    expect(hasDraftAttachmentsById("chat-1")).toBe(true);
    expect(getDraftAttachmentsById("chat-1")).toEqual([
      {
        kind: "file",
        fileId: "file_regular",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 1024,
        tokens: 42,
        timestamp,
      },
    ]);
  });

  it("persists local generated pasted-text draft metadata without content or source path", () => {
    const timestamp = Date.now();
    const pastedContent = "Sensitive pasted source material";
    const localPath = "/Users/alice/pasted_content.txt";

    upsertDraftAttachments("chat-1", [
      {
        kind: "pasted-text",
        storage: "local-desktop",
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text",
        generatedTextAttachmentId: "generated_123",
        tokens: 0,
        timestamp,
        generatedTextContent: pastedContent,
        localPath,
      } as any,
    ]);

    expect(hasDraftAttachmentsById("chat-1")).toBe(true);
    expect(getDraftAttachmentsById("chat-1")).toEqual([
      {
        kind: "pasted-text",
        storage: "local-desktop",
        name: "pasted_content.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text",
        generatedTextAttachmentId: "generated_123",
        tokens: 0,
        timestamp,
      },
    ]);
    const storedDraft = window.localStorage.getItem(
      CONVERSATION_DRAFTS_STORAGE_KEY,
    );
    expect(storedDraft).not.toContain(pastedContent);
    expect(storedDraft).not.toContain(localPath);
  });

  it("preserves draft attachments when text autosave updates content", () => {
    upsertDraftAttachments("chat-1", [
      {
        kind: "pasted-text",
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        timestamp: Date.now(),
      },
    ]);

    upsertDraft("chat-1", "follow-up question", 234567);

    expect(getDraftAttachmentsById("chat-1")).toHaveLength(1);
  });

  it("removes an attachment-only draft when attachments are cleared", () => {
    upsertDraftAttachments("chat-1", [
      {
        kind: "pasted-text",
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        timestamp: Date.now(),
      },
    ]);

    removeDraftAttachments("chat-1");

    expect(hasDraftAttachmentsById("chat-1")).toBe(false);
  });

  it("does not restore pasted-text attachments older than the orphan file purge window", () => {
    upsertDraftAttachments("chat-1", [
      {
        kind: "pasted-text",
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        timestamp: Date.now() - 25 * 60 * 60 * 1000,
      },
    ]);

    expect(getDraftAttachmentsById("chat-1")).toEqual([]);
    expect(hasDraftAttachmentsById("chat-1")).toBe(false);
  });
});
