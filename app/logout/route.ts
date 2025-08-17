import { signOut } from "@workos-inc/authkit-nextjs";
import { isWorkOSEnabled } from "@/lib/auth/client";
import { redirect } from "next/navigation";

export const GET = async () => {
  if (!isWorkOSEnabled()) {
    // If WorkOS is not configured, redirect to home page
    return redirect("/");
  }

  return signOut();
};
