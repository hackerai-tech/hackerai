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
      window.localStorage.setItem(STORAGE_KEY, "sonnet-4.6");
      expect(readSelectedModel()).toBe("sonnet-4.6");
    });

    it("rejects invalid stored values", () => {
      window.localStorage.setItem(STORAGE_KEY, "not-a-real-model");
      expect(readSelectedModel()).toBeNull();
    });

    it("migrates from legacy selected_model_ask key when unified key is empty", () => {
      window.localStorage.setItem(LEGACY_ASK_KEY, "opus-4.6");
      window.localStorage.setItem(LEGACY_AGENT_KEY, "sonnet-4.6");

      expect(readSelectedModel()).toBe("opus-4.6");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("opus-4.6");
      expect(window.localStorage.getItem(LEGACY_ASK_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_AGENT_KEY)).toBeNull();
    });

    it("falls back to legacy selected_model_agent key when ask is missing", () => {
      window.localStorage.setItem(LEGACY_AGENT_KEY, "kimi-k2.6");

      expect(readSelectedModel()).toBe("kimi-k2.6");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("kimi-k2.6");
      expect(window.localStorage.getItem(LEGACY_AGENT_KEY)).toBeNull();
    });

    it("ignores legacy keys with invalid values and returns null", () => {
      window.localStorage.setItem(LEGACY_ASK_KEY, "grok-4.3");
      window.localStorage.setItem(LEGACY_AGENT_KEY, "grok-4.1");

      expect(readSelectedModel()).toBeNull();
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("does not run migration when unified key is already set", () => {
      window.localStorage.setItem(STORAGE_KEY, "sonnet-4.6");
      window.localStorage.setItem(LEGACY_ASK_KEY, "opus-4.6");

      expect(readSelectedModel()).toBe("sonnet-4.6");
      // Legacy key is left alone when unified key is valid.
      expect(window.localStorage.getItem(LEGACY_ASK_KEY)).toBe("opus-4.6");
    });
  });

  describe("writeSelectedModel", () => {
    it("persists under the unified key", () => {
      writeSelectedModel("opus-4.6");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("opus-4.6");
    });
  });

  describe("clearSelectedModelFromStorage", () => {
    it("removes the unified key and legacy per-mode keys", () => {
      window.localStorage.setItem(STORAGE_KEY, "sonnet-4.6");
      window.localStorage.setItem(LEGACY_ASK_KEY, "opus-4.6");
      window.localStorage.setItem(LEGACY_AGENT_KEY, "kimi-k2.6");

      clearSelectedModelFromStorage();

      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_ASK_KEY)).toBeNull();
      expect(window.localStorage.getItem(LEGACY_AGENT_KEY)).toBeNull();
    });
  });
});
