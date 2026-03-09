import { describe, it, expect, jest } from "@jest/globals";
import type { UIMessageStreamWriter } from "ai";

jest.doMock("server-only", () => ({}));

const { writeAutoContinue } =
  require("../stream-writer-utils") as typeof import("../stream-writer-utils");

describe("writeAutoContinue", () => {
  it("should write data-auto-continue signal", () => {
    const mockWrite = jest.fn();
    const writer = { write: mockWrite } as unknown as UIMessageStreamWriter;

    writeAutoContinue(writer);

    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith({
      type: "data-auto-continue",
      data: { shouldContinue: true },
    });
  });
});
