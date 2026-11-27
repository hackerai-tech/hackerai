import { AlertCircle, RefreshCw, Home } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AutoRetryButton } from "./auto-retry-button";

type ErrorCode = "429" | "401" | "403" | "500" | "502" | "503" | "504";

const ERROR_MESSAGES: Record<
  ErrorCode,
  { title: string; description: string; autoRetry?: boolean }
> = {
  "429": {
    title: "Too Many Requests",
    description:
      "Too many login attempts. Please wait a moment before trying again.",
  },
  "401": {
    title: "Session Expired",
    description:
      "Your session has expired or the login link is no longer valid. Please sign in again.",
  },
  "403": {
    title: "Access Denied",
    description:
      "You don't have permission to access this resource. Please sign in with a different account.",
  },
  "500": {
    title: "Authentication Failed",
    description:
      "Something went wrong during sign in. This can happen when multiple browser tabs try to authenticate at the same time.",
    autoRetry: true,
  },
  "502": {
    title: "Service Unavailable",
    description:
      "Our authentication service is temporarily unavailable. Please try again in a few minutes.",
  },
  "503": {
    title: "Service Unavailable",
    description:
      "Our authentication service is temporarily unavailable. Please try again in a few minutes.",
  },
  "504": {
    title: "Request Timeout",
    description:
      "The authentication request timed out. Please check your connection and try again.",
  },
};

const DEFAULT_ERROR = {
  title: "Authentication Error",
  description: "An unexpected error occurred during sign in. Please try again.",
};

type SearchParams = Promise<{ code?: string }>;

/**
 * Only an HTTP status may be echoed. Anyone can link to this page, so showing
 * arbitrary query text would let a third party put their own message, such as
 * a fake support number, on a hackerai.co page.
 */
const DISPLAYABLE_CODE = /^[1-5]\d\d$/;

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { code } = await searchParams;
  const errorInfo = ERROR_MESSAGES[code as ErrorCode] ?? DEFAULT_ERROR;
  const displayCode =
    typeof code === "string" && DISPLAYABLE_CODE.test(code) ? code : undefined;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle className="text-xl">{errorInfo.title}</CardTitle>
          <CardDescription className="mt-2">
            {errorInfo.description}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {displayCode && (
            <p className="text-center text-xs text-muted-foreground">
              Error code: {displayCode}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-col gap-3 sm:flex-row w-full">
          {errorInfo.autoRetry ? (
            <AutoRetryButton loginUrl="/login" />
          ) : (
            <Button asChild className="flex-1 min-w-0">
              <a href="/login">
                <RefreshCw className="h-4 w-4" />
                Try Again
              </a>
            </Button>
          )}
          <Button asChild variant="outline" className="flex-1 min-w-0">
            <Link href="/">
              <Home className="h-4 w-4" />
              Go Home
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
