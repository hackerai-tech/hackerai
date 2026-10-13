import type { NoUserInfo, UserInfo } from "@workos-inc/authkit-nextjs";
import {
  isEndedSessionRefreshError,
  isInvalidRefreshTokenError,
} from "./expected-auth-errors";

type ServerAuth = UserInfo | NoUserInfo;

export type ClientInitialAuth =
  Omit<UserInfo, "accessToken"> | Omit<NoUserInfo, "accessToken">;

export async function resolveClientInitialAuth(
  loadAuth: () => Promise<ServerAuth>,
): Promise<ClientInitialAuth> {
  try {
    const { accessToken: _serverOnlyAccessToken, ...initialAuth } =
      await loadAuth();
    return initialAuth;
  } catch (error) {
    if (isInvalidRefreshTokenError(error)) {
      console.warn(
        JSON.stringify({
          event: "auth.invalid_refresh_token",
          boundary: "initial_auth",
        }),
      );
      return { user: null };
    }
    if (isEndedSessionRefreshError(error)) {
      return { user: null };
    }
    throw error;
  }
}
