import { isWebAssemblyAvailable, shouldUseShikiHighlighter } from "../shiki";

describe("shiki utilities", () => {
  const originalWebAssembly = globalThis.WebAssembly;

  afterEach(() => {
    Object.defineProperty(globalThis, "WebAssembly", {
      configurable: true,
      value: originalWebAssembly,
      writable: true,
    });
  });

  it("disables Shiki highlighting when WebAssembly is unavailable", () => {
    Object.defineProperty(globalThis, "WebAssembly", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    expect(isWebAssemblyAvailable()).toBe(false);
    expect(shouldUseShikiHighlighter("js")).toBe(false);
  });
});
