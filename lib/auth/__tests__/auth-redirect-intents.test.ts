import {
  ATTRIBUTION_COOKIE_NAME,
  decodeAttributionCookie,
} from "@/lib/analytics/attribution";
import { redirectToAuthorizationUrl } from "../auth-redirect-intents";

jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (url: string) => {
      const setCookies: string[] = [];
      const response = {
        headers: {
          append: (name: string, value: string) => {
            if (name.toLowerCase() === "set-cookie") setCookies.push(value);
          },
          get: (name: string) => {
            if (name.toLowerCase() === "set-cookie") {
              return setCookies.join(", ");
            }
            if (name.toLowerCase() === "location") return url;
            return null;
          },
          getSetCookie: () => setCookies,
        },
        cookies: {
          set: () => {},
        },
      } as unknown as Response & {
        cookies: {
          set: (
            name: string,
            value: string,
            options?: { path?: string; maxAge?: number },
          ) => void;
        };
      };
      response.cookies = {
        set: (name, value, options = {}) => {
          response.headers.append(
            "set-cookie",
            `${name}=${encodeURIComponent(value)}; Path=${options.path ?? "/"}; Max-Age=${options.maxAge ?? ""}`,
          );
        },
      };
      return response;
    },
  },
}));

function readCookie(response: Response, name: string) {
  const setCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
  const cookie = setCookie.find((value) => value.startsWith(`${name}=`));
  if (!cookie) return null;
  return cookie.split(";", 1)[0]?.slice(name.length + 1) ?? null;
}

describe("redirectToAuthorizationUrl", () => {
  it("preserves referrer attribution when signup redirects before client code runs", () => {
    const response = redirectToAuthorizationUrl(
      "https://auth.example.com/signup",
      new URL("https://hackerai.co/signup"),
      {
        captureAttribution: true,
        referrer: "https://www.producthunt.com/posts/hackerai",
      },
    );

    const attribution = decodeAttributionCookie(
      readCookie(response, ATTRIBUTION_COOKIE_NAME),
    );
    expect(attribution).toEqual(
      expect.objectContaining({
        initial_source: "producthunt.com",
        initial_medium: "referral",
        initial_landing_path: "/signup",
      }),
    );
  });

  it("still captures campaign params without explicit capture options", () => {
    const response = redirectToAuthorizationUrl(
      "https://auth.example.com/signup",
      new URL(
        "https://hackerai.co/signup?utm_source=x&utm_medium=social&utm_campaign=launch",
      ),
    );

    const attribution = decodeAttributionCookie(
      readCookie(response, ATTRIBUTION_COOKIE_NAME),
    );
    expect(attribution).toEqual(
      expect.objectContaining({
        initial_source: "x",
        initial_medium: "social",
        initial_campaign: "launch",
      }),
    );
  });
});
