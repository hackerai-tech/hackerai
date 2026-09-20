import {
  connectionMatchesPreference,
  environmentPreference,
  resolveEnvironmentConnection,
} from "../environment";

const oldSession = {
  connectionId: "old",
  environmentId: "machine-a",
  createdAt: 1,
  isDesktop: false,
};
const newSession = { ...oldSession, connectionId: "new", createdAt: 2 };
const unrelated = {
  ...newSession,
  connectionId: "other",
  environmentId: "machine-b",
  createdAt: 3,
};

it("selects the newest session of the saved environment and pins a healthy active session", () => {
  expect(
    resolveEnvironmentConnection(
      [oldSession, unrelated, newSession],
      "environment:machine-a",
    ),
  ).toBe(newSession);
  expect(
    resolveEnvironmentConnection(
      [oldSession, newSession],
      "environment:machine-a",
      "old",
    ),
  ).toBe(oldSession);
  expect(
    resolveEnvironmentConnection([unrelated], "environment:machine-a"),
  ).toBeUndefined();
});

it("keeps desktop identity distinct from a CLI using the same UUID", () => {
  const desktop = { ...newSession, isDesktop: true };
  expect(environmentPreference(desktop)).toBe("desktop-environment:machine-a");
  expect(connectionMatchesPreference(desktop, "environment:machine-a")).toBe(
    false,
  );
  expect(
    connectionMatchesPreference(newSession, "desktop-environment:machine-a"),
  ).toBe(false);
});

it("continues resolving legacy selections without matching different sessions", () => {
  expect(connectionMatchesPreference(oldSession, "old")).toBe(true);
  expect(connectionMatchesPreference(newSession, "old")).toBe(false);
  expect(environmentPreference({ connectionId: "legacy" })).toBe("legacy");
  expect(
    environmentPreference({ connectionId: "legacy", isDesktop: true }),
  ).toBe("desktop");
});
