import { getSandboxArtifactDirectory } from "../sandbox-types";

const local = (namespace?: string) =>
  ({
    sandboxKind: "centrifugo",
    supportsCommandStdin: () => true,
    supportsNativeFileRelay: () => false,
    isWindows: () => false,
    getConnectionInfo: () => ({
      capabilities: { privateArtifactNamespace: namespace },
    }),
  }) as any;

it("routes both private artifact types to the client's claimed namespace", () => {
  for (const kind of [
    "terminal_full_output",
    "terminal_execution_records",
  ] as const) {
    expect(getSandboxArtifactDirectory(local("uid-1000"), kind)).toBe(
      `/tmp/${kind}-uid-1000`,
    );
    expect(getSandboxArtifactDirectory(local(), kind)).toBe(`/tmp/${kind}`);
  }
});

it.each(["../outside", "uid-1/../outside", "uid--1", "uid-01", "uid-1000\n"])(
  "rejects unsafe namespace %s",
  (namespace) => {
    expect(() =>
      getSandboxArtifactDirectory(local(namespace), "terminal_full_output"),
    ).toThrow("Invalid private terminal artifact namespace");
  },
);

it("does not redirect native Desktop project paths", () => {
  const sandbox = {
    ...local("uid-1000"),
    getWorkingDirectory: () => "/qa/project",
    supportsNativeFileRelay: () => true,
  };
  expect(getSandboxArtifactDirectory(sandbox, "terminal_full_output")).toBe(
    "/qa/project/.hackerai/terminal_full_output",
  );
});
