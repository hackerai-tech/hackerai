import { NextResponse } from "next/server";

/** Protect cookie-authenticated mutation routes from cross-origin submissions. */
export function rejectUnsafeRequest(
  request: Request,
  options: { jsonBody?: boolean } = {},
): NextResponse | null {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    options.jsonBody &&
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return NextResponse.json(
      { error: "Expected JSON request" },
      { status: 415 },
    );
  }

  return null;
}
