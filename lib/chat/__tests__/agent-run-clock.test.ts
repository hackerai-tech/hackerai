import { getAgentRunClockContext } from "../agent-run-clock";

afterEach(() => jest.restoreAllMocks());

it("retains only bounded source-clock fields with one stable instance across attempts", () => {
  const uptime = jest.spyOn(process, "uptime").mockReturnValue(1.2345);
  const first = getAgentRunClockContext(1)!;
  uptime.mockReturnValue(2);
  const next = getAgentRunClockContext(2)!;
  expect(first).toEqual({
    run_clock_version: 1,
    run_clock_process_instance: expect.stringMatching(/^[a-f0-9]{16}$/),
    run_clock_uptime_ms: 1234,
    run_clock_attempt: 1,
  });
  expect(next).toEqual({
    ...first,
    run_clock_uptime_ms: 2000,
    run_clock_attempt: 2,
  });
  expect(JSON.stringify(first).length).toBeLessThan(256);
});

it("censors missing, coerced, fractional or unsafe attempts instead of fabricating equivalence", () => {
  const valueOf = jest.fn(() => {
    throw new Error("PRIVATE_CANARY");
  });
  for (const attempt of [
    undefined,
    0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    { valueOf },
  ])
    expect(getAgentRunClockContext(attempt)).toBeUndefined();
  expect(valueOf).not.toHaveBeenCalled();
});

it("censors unavailable or invalid uptime instead of reporting a zero clock", () => {
  const uptime = jest.spyOn(process, "uptime");
  for (const value of [NaN, -1, Number.MAX_SAFE_INTEGER]) {
    uptime.mockReturnValue(value);
    expect(getAgentRunClockContext(1)).toBeUndefined();
  }
  uptime.mockImplementation(() => {
    throw new Error("PRIVATE_CLOCK_CANARY");
  });
  expect(getAgentRunClockContext(1)).toBeUndefined();
});

it("contains an entropy failure without retrying it on subsequent existing emissions", () => {
  const entropy = jest.fn(() => {
    throw new Error("PRIVATE_ENTROPY_CANARY");
  });
  try {
    jest.isolateModules(() => {
      jest.doMock("node:crypto", () => ({ randomBytes: entropy }));
      const {
        getAgentRunClockContext: isolated,
      } = require("../agent-run-clock");
      expect(isolated(1)).toBeUndefined();
      expect(isolated(2)).toBeUndefined();
    });
  } finally {
    jest.dontMock("node:crypto");
  }
  expect(entropy).toHaveBeenCalledTimes(1);
});
