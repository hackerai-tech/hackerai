jest.mock("next/dist/server/image-optimizer", () => ({ getSharp: jest.fn() }));

import { scoreVisionAnswer } from "../benchmark-vision-recovery";

describe("vision benchmark answer validation", () => {
  const expected = [
    { label: "R01", code: "A123B456" },
    { label: "R02", code: "C789D012" },
  ];

  it("accepts exact rows with platform line endings", () => {
    expect(
      scoreVisionAnswer("R01|A123B456\r\nR02|C789D012\r\n", expected),
    ).toBe(2);
  });

  it.each([
    "Here are the codes:\nR01|A123B456\nR02|C789D012",
    "R01|A123B456\nR02|C789D012\nR02|C789D012",
    "R01|A123B456",
    "R02|C789D012\nR01|A123B456",
    "R01|A123B456\nR01|A123B456",
    "R01|A123B456 or WRONG\nR02|C789D012",
    "R01 A123B456\nR02 C789D012",
    "R01|A123B456\nR02|UNKNOWN",
  ])("does not award full credit to invalid output: %s", (answer) => {
    expect(scoreVisionAnswer(answer, expected)).toBeLessThan(expected.length);
  });
});
