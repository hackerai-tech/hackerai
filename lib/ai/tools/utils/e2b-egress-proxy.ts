import type { SandboxEgressProxyOpts } from "e2b";

type E2BEgressProxyEnvironment = Readonly<Record<string, string | undefined>>;

const MAX_SOCKS5_CREDENTIAL_BYTES = 255;

const optionalValue = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

const validateCredentialLength = (
  name: "username" | "password",
  value: string | undefined,
): void => {
  if (
    value !== undefined &&
    Buffer.byteLength(value, "utf8") > MAX_SOCKS5_CREDENTIAL_BYTES
  ) {
    throw new Error(
      `Invalid E2B egress proxy configuration: ${name} exceeds ${MAX_SOCKS5_CREDENTIAL_BYTES} bytes`,
    );
  }
};

/**
 * Resolves the server-owned E2B SOCKS5 proxy for one user.
 *
 * The allowlist is deliberately fail-closed: configuring a gateway without an
 * explicit user ID (or `*`) does not route any customer traffic through it.
 */
export const getE2BEgressProxyForUser = (
  userID: string,
  environment: E2BEgressProxyEnvironment = process.env,
): SandboxEgressProxyOpts | undefined => {
  const address = optionalValue(environment.E2B_EGRESS_PROXY_ADDRESS?.trim());
  const username = optionalValue(environment.E2B_EGRESS_PROXY_USERNAME);
  const password = optionalValue(environment.E2B_EGRESS_PROXY_PASSWORD);

  if (!address) {
    if (username || password) {
      throw new Error(
        "Invalid E2B egress proxy configuration: credentials require E2B_EGRESS_PROXY_ADDRESS",
      );
    }
    return undefined;
  }

  if (password && !username) {
    throw new Error(
      "Invalid E2B egress proxy configuration: E2B_EGRESS_PROXY_PASSWORD requires E2B_EGRESS_PROXY_USERNAME",
    );
  }

  validateCredentialLength("username", username);
  validateCredentialLength("password", password);

  const allowedUserIDs = new Set(
    (environment.E2B_EGRESS_PROXY_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!allowedUserIDs.has("*") && !allowedUserIDs.has(userID)) {
    return undefined;
  }

  return {
    address,
    ...(username !== undefined && { username }),
    ...(password !== undefined && { password }),
  };
};
