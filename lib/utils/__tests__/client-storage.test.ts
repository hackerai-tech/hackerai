import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  getDraftAttachmentsById,
  readSelectedModel,
  removeDraftAttachments,
  writeSelectedModel,
  clearSelectedModelFromStorage,
  hasAuthenticatedBefore,
  hasDraftAttachmentsById,
  markHasAuthenticatedBefore,
  upsertDraft,
  upsertDraftAttachments,
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

describe("client-storage draft attachments", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists generated pasted-text attachments without draft text", () => {
    const timestamp = Date.now();
    upsertDraftAttachments("chat-1", [
      {
        kind: "pasted-text",
        fileId: "file_123",
        name: "pasted-text.txt",
        mediaType: "text/plain",
        size: 512,
        generatedSource: "pasted-text",
        generatedTextAttachmentId: "generated_123",
        generatedTextContent: "Original pasted source material",
        tokens: 120,
        timestamp,
      },
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
        generatedTextContent: "Original pasted source material",
        tokens: 120,
        timestamp,
      },
    ]);
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
