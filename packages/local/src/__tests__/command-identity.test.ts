import os from "os";
import { commandIdentityFromEnvironment } from "../command-identity";

describe("isolated command identity", () => {
  const env = {
    HACKERAI_LOCAL_COMMAND_UID: "65534",
    HACKERAI_LOCAL_COMMAND_GID: "65534",
    HACKERAI_LOCAL_COMMAND_HOME: "/home/hackerai-agent",
  };

  it("keeps ordinary local clients unchanged", () => {
    expect(commandIdentityFromEnvironment({})).toBeUndefined();
  });

  it("rejects a partial or root command identity", () => {
    expect(() =>
      commandIdentityFromEnvironment({ HACKERAI_LOCAL_COMMAND_UID: "65534" }),
    ).toThrow("Invalid isolated command identity");
    expect(() =>
      commandIdentityFromEnvironment({
        ...env,
        HACKERAI_LOCAL_COMMAND_UID: "0",
      }),
    ).toThrow("Invalid isolated command identity");
  });

  it("requires a root-owned Linux client before dropping command privileges", () => {
    const platform = jest.spyOn(os, "platform").mockReturnValue("linux");
    const getuid = jest.spyOn(process, "getuid").mockReturnValue(0);
    try {
      expect(commandIdentityFromEnvironment(env)).toEqual({
        uid: 65534,
        gid: 65534,
        home: "/home/hackerai-agent",
      });
      getuid.mockReturnValue(501);
      expect(() => commandIdentityFromEnvironment(env)).toThrow(
        "Invalid isolated command identity",
      );
    } finally {
      getuid.mockRestore();
      platform.mockRestore();
    }
  });
});
