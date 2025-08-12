import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { isWorkOSConfigured } from "@/lib/auth-utils";

export const GET = async () => {
  if (!isWorkOSConfigured()) {
    // If WorkOS is not configured, redirect to home page
    return redirect("/");
  }

  const signInUrl = await getSignInUrl();

  return redirect(signInUrl);
};
