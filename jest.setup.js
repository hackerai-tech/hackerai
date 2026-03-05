// Learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";
import { TextDecoder, TextEncoder } from "util";
import { ReadableStream, TransformStream } from "stream/web";

// Mock environment variables
process.env.NEXT_PUBLIC_CONVEX_URL = "https://test.convex.cloud";

// Polyfill TextEncoder/TextDecoder for gpt-tokenizer
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Polyfill Web Streams API for AI SDK
global.ReadableStream = ReadableStream;
global.TransformStream = TransformStream;

// Polyfill structuredClone for AI SDK (not available in jsdom)
if (typeof global.structuredClone === "undefined") {
  const { deserialize, serialize } = require("v8");
  global.structuredClone = (val) => deserialize(serialize(val));
}

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(), // Deprecated
    removeListener: jest.fn(), // Deprecated
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Global test utilities
global.beforeEach(() => {
  // Clear mocks before each test
  jest.clearAllMocks();
});
