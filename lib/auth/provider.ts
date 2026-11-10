import * as workos from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isSelfHosted } from "@/lib/selfhost/config";
import { readSession, SESSION_COOKIE } from "@/lib/selfhost/session";
export * from "@workos-inc/authkit-nextjs";

export const withAuth: typeof workos.withAuth = (async (options?: {
  ensureSignedIn?: boolean;
}) => {
  if (!isSelfHosted()) return workos.withAuth(options);
  const session = await readSession(
    (await cookies()).get(SESSION_COOKIE)?.value,
  );
  if (!session && options?.ensureSignedIn) redirect("/local-login");
  return session ?? { user: null };
}) as typeof workos.withAuth;

export const authkit: typeof workos.authkit = (async (request, options) => {
  if (!isSelfHosted()) return workos.authkit(request, options);
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  return {
    session: session ?? { user: null },
    headers: new Headers({ "x-workos-middleware": "true" }),
    authorizationUrl: "/local-login",
  };
}) as typeof workos.authkit;

export const getSignInUrl: typeof workos.getSignInUrl = async (...args) =>
  isSelfHosted() ? "/local-login" : workos.getSignInUrl(...args);
export const getSignUpUrl: typeof workos.getSignUpUrl = async (...args) =>
  isSelfHosted() ? "/local-login" : workos.getSignUpUrl(...args);
export const signOut: typeof workos.signOut = async (...args) => {
  if (!isSelfHosted()) return workos.signOut(...args);
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/local-login");
};
