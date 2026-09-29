import { metrics, type MeterProvider } from "@opentelemetry/api";
import { recordRelayReceivedBytes } from "../traffic";

afterEach(() => {
  metrics.disable();
});

test("records relay bytes when the meter provider registers after module import", () => {
  metrics.disable();
  recordRelayReceivedBytes("command", "agent-long", 10, 2);

  const add = jest.fn();
  const provider = {
    getMeter: () => ({ createCounter: () => ({ add }) }),
  } as unknown as MeterProvider;
  expect(metrics.setGlobalMeterProvider(provider)).toBe(true);

  recordRelayReceivedBytes("command", "agent-long", 10, 2);

  expect(add).toHaveBeenCalledTimes(2);
  expect(add).toHaveBeenCalledWith(8, {
    operation: "command",
    source: "agent-long",
    correlation: "matched",
  });
  expect(add).toHaveBeenCalledWith(2, {
    operation: "command",
    source: "agent-long",
    correlation: "unmatched",
  });
});
