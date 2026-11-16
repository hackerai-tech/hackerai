import { createScheduleOrigin, scheduleScopeKey } from "../provenance";
import type { ScheduleDefinition } from "../recurrence";

const execution = {
  type: "local" as const,
  preference: "environment:12345678-1234-4123-8123-123456789abc",
  name: "Lab",
  workingDirectory: "/tmp/lab",
};
const definition: ScheduleDefinition = {
  name: "Nightly API scan",
  prompt: "Check PRIVATE-TARGET.example for exposed admin routes",
  model: "pro",
  timing: { type: "interval", minutes: 15 },
  execution,
};

describe("schedule scope key", () => {
  it("is a stable digest that does not contain the instructions", () => {
    const key = scheduleScopeKey(definition);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(scheduleScopeKey(JSON.parse(JSON.stringify(definition))));
    expect(key).not.toContain("PRIVATE-TARGET");
  });

  it("ignores name, timing and the computer's label", () => {
    const key = scheduleScopeKey(definition);
    const edited: ScheduleDefinition = {
      ...definition,
      name: "Renamed",
      timing: {
        type: "weekly",
        time: "09:00",
        weekdays: [1],
        timezone: "America/Chicago",
      },
      execution: { ...execution, name: "Renamed computer" },
    };
    expect(scheduleScopeKey(edited)).toBe(key);
  });

  it.each<[string, Partial<ScheduleDefinition>]>([
    ["instructions", { prompt: `${definition.prompt} and login pages` }],
    ["model", { model: "max" }],
    ["folder", { execution: { ...execution, workingDirectory: "/tmp/other" } }],
    [
      "computer",
      {
        execution: {
          ...execution,
          preference: "environment:99999999-1234-4123-8123-123456789abc",
        },
      },
    ],
    ["cloud instead of a computer", { execution: undefined }],
  ])("changes with the %s", (_label, change) => {
    expect(scheduleScopeKey({ ...definition, ...change })).not.toBe(
      scheduleScopeKey(definition),
    );
  });

  it("does not let adjacent fields collide", () => {
    expect(
      scheduleScopeKey({ prompt: "a", model: "pro", execution: undefined }),
    ).not.toBe(
      scheduleScopeKey({
        prompt: 'a",null,null,"pro',
        model: "pro",
        execution: undefined,
      }),
    );
  });

  it("snapshots the schedule name with the claimed receipt", () => {
    expect(
      createScheduleOrigin({
        scheduleId: "schedule-1" as any,
        runId: "run-1" as any,
        definition,
      }),
    ).toEqual({
      scheduleId: "schedule-1",
      scheduleName: "Nightly API scan",
      runId: "run-1",
      scopeKey: scheduleScopeKey(definition),
    });
  });
});
