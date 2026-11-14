import {
  connectionMatchesPreference,
  environmentPreference,
  localEnvironmentIdentity,
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

it("does not let a CLI runner claim a saved environment", () => {
  expect(
    resolveEnvironmentConnection(
      [oldSession, unrelated, newSession],
      "environment:machine-a",
    ),
  ).toBeUndefined();
  expect(
    resolveEnvironmentConnection([oldSession, newSession], "old", "old"),
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

it("uses a session for CLI work identity and stable identity only for Desktop", () => {
  expect(environmentPreference(newSession)).toBe("new");
  expect(localEnvironmentIdentity(newSession)).toBe("new");
  expect(localEnvironmentIdentity({ ...newSession, isDesktop: true })).toBe(
    "desktop-environment:machine-a",
  );
  expect(localEnvironmentIdentity({ connectionId: "legacy" })).toBe("legacy");
});

it("continues resolving legacy selections without matching different sessions", () => {
  expect(connectionMatchesPreference(oldSession, "old")).toBe(true);
  expect(connectionMatchesPreference(newSession, "old")).toBe(false);
  expect(environmentPreference({ connectionId: "legacy" })).toBe("legacy");
  expect(
    environmentPreference({ connectionId: "legacy", isDesktop: true }),
  ).toBe("desktop");
});
