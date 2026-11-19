import os from "os";

export interface CommandIdentity {
  uid: number;
  gid: number;
  home: string;
}

/** Optional isolation for a root-owned client in a disposable Linux sandbox. */
export function commandIdentityFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): CommandIdentity | undefined {
  const uidText = env.HACKERAI_LOCAL_COMMAND_UID;
  const gidText = env.HACKERAI_LOCAL_COMMAND_GID;
  const home = env.HACKERAI_LOCAL_COMMAND_HOME;
  if (uidText === undefined && gidText === undefined && home === undefined) {
    return undefined;
  }
  const validId = (value: string | undefined): value is string =>
    value !== undefined && /^[1-9]\d{0,8}$/.test(value);
  if (
    os.platform() !== "linux" ||
    process.getuid?.() !== 0 ||
    !validId(uidText) ||
    !validId(gidText) ||
    !home?.startsWith("/") ||
    home.includes("\0")
  ) {
    throw new Error("Invalid isolated command identity for the local client");
  }
  return { uid: Number(uidText), gid: Number(gidText), home };
}
