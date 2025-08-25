import { redirect } from "next/navigation";
import { getSignUpUrl } from "@workos-inc/authkit-nextjs";

export async function GET() {
  const authorizationUrl = await getSignUpUrl();
  return redirect(authorizationUrl);
}
