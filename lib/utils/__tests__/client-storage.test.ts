import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  readSelectedModel,
  writeSelectedModel,
  clearSelectedModelFromStorage,
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

    it("maps legacy gemini-3-flash and kimi-k2.6 both to hackerai-lite", () => {
      window.localStorage.setItem(STORAGE_KEY, "gemini-3-flash");
      expect(readSelectedModel()).toBe("hackerai-lite");

      window.localStorage.setItem(STORAGE_KEY, "kimi-k2.6");
      expect(readSelectedModel()).toBe("hackerai-lite");
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

      expect(readSelectedModel()).toBe("hackerai-lite");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("hackerai-lite");
      expect(window.localStorage.getItem(LEGACY_AGENT_KEY)).toBeNull();
    });

    it("ignores legacy keys with unrecognized values and returns null", () => {
      window.localStorage.setItem(LEGACY_ASK_KEY, "grok-4.3");
      window.localStorage.setItem(LEGACY_AGENT_KEY, "grok-4.1");

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
