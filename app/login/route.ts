import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { isWorkOSEnabled } from "@/lib/auth-config";

export const GET = async () => {
  if (!isWorkOSEnabled()) {
    // If WorkOS is not configured, redirect to home page
    return redirect("/");
  }

  const signInUrl = await getSignInUrl();

  return redirect(signInUrl);
};
