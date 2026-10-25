import { goalElapsedMs, goalTimingForState } from "../timing";
import type { GoalState } from "../contracts";

const running = {
  state: "running" as const,
  startedAt: 1000,
  updatedAt: 1000,
  elapsedMs: 2000,
  activeSince: 1000,
};

it.each<GoalState>([
  "paused",
  "canceled",
  "waiting",
  "needs_approval",
  "needs_input",
  "blocked",
  "failed",
  "usage_exhausted",
  "budget_exhausted",
  "achieved",
])("freezes %s until an active state resumes", (state) => {
  const stopped = {
    ...running,
    ...goalTimingForState(running, state, 4000),
    state,
    updatedAt: 4000,
  };
  expect(goalElapsedMs(stopped, 64000)).toBe(5000);
  const resumed = {
    ...stopped,
    ...goalTimingForState(stopped, "queued", 64000),
    state: "queued" as const,
  };
  expect(goalElapsedMs(resumed, 66000)).toBe(7000);
});

it("materializes legacy paused time before a late cleanup or edit changes updatedAt", () => {
  const legacy = { state: "paused" as const, startedAt: 1000, updatedAt: 6000 };
  expect(goalElapsedMs(legacy, 66000)).toBe(5000);
  const edited = {
    ...legacy,
    ...goalTimingForState(legacy, "paused", 66000),
    updatedAt: 66000,
  };
  expect(goalElapsedMs(edited, 126000)).toBe(5000);
});

it("does not charge a future active interval against saved time when the client clock lags", () => {
  expect(goalElapsedMs(running, 0)).toBe(2000);
});
