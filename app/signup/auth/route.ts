import { getSignUpUrl } from "@/lib/auth/provider";
import { redirectToAuthorizationUrl } from "@/lib/auth/auth-redirect-intents";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const authorizationUrl = await getSignUpUrl();
  return redirectToAuthorizationUrl(authorizationUrl, url);
}
