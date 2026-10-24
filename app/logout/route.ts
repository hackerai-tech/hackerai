import { signOut } from "@workos-inc/authkit-nextjs";

export const GET = async (request: Request) => {
  if (process.env.VERCEL_ENV === "preview") {
    const trustedHosts = [
      process.env.VERCEL_URL,
      process.env.VERCEL_BRANCH_URL,
    ].filter((host): host is string => Boolean(host));
    const requestHost = new URL(request.url).host;
    const returnHost = trustedHosts.includes(requestHost)
      ? requestHost
      : trustedHosts[0];

    // WorkOS's shared development logout URL can point to localhost. Return
    // Preview sessions to this deployment without trusting an arbitrary host.
    if (returnHost) {
      return signOut({ returnTo: `https://${returnHost}/` });
    }
  }
  return signOut();
};
