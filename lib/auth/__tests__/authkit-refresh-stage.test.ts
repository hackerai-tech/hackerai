/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Run the installed, patched AuthKit refresh in both shipped forms with the
// SDK's own jose dependency, not the app's jose or its Jest mock. Jest maps
// `jose` (even through createRequire), so load the SDK's copy by file path.
// Only cookie sealing, JWKS verification and WorkOS HTTP are emulated.
const sdkJose = fs.realpathSync(
  path.join(
    fs.realpathSync(
      path.join(process.cwd(), "node_modules/@workos-inc/authkit-nextjs"),
    ),
    "../../jose",
  ),
);
const jose = jest.requireActual(
  path.join(sdkJose, "dist/node/cjs/index.js"),
) as {
  decodeJwt: (token: unknown) => Record<string, unknown>;
  errors: { JWTInvalid: new (...args: unknown[]) => Error };
};

// Jest maps @workos-inc/node to a stub; load the SDK copy AuthKit resolves.
const workosSdk = jest.requireActual(
  path.join(
    fs.realpathSync(
      path.join(
        fs.realpathSync(
          path.join(process.cwd(), "node_modules/@workos-inc/authkit-nextjs"),
        ),
        "../node",
      ),
    ),
    "lib/index.cjs",
  ),
) as { WorkOS: new (...args: unknown[]) => unknown };

type RefreshClient = {
  userManagement: {
    authenticateWithRefreshToken: (args: unknown) => Promise<unknown>;
  };
};

/** Build AuthKit's patched WorkOS client from the shipped file next to `sessionFile`. */
function loadAuthKitWorkOS(sessionFile: string): RefreshClient {
  const file = sessionFile.replace(/session\.(ts|js)$/, "workos.$1");
  const source = fs.readFileSync(
    path.join(process.cwd(), "node_modules/@workos-inc/authkit-nextjs", file),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    "@workos-inc/node": workosSdk,
    "./env-variables.js": { WORKOS_API_KEY: "sk_test_bounds" },
    "./utils.js": { lazy: (fn: () => unknown) => fn },
  };
  const exports: { getWorkOS?: () => RefreshClient } = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (!(name in dependencies))
        throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return exports.getWorkOS!();
}

/** A WorkOS request that never answers until the SDK aborts it. */
const hangUntilAborted = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });

const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: object) =>
  `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
const now = Math.floor(Date.now() / 1000);
const user = { id: "user_1" };
const staleToken = jwt({
  sid: "session_1",
  org_id: "org_1",
  iat: now - 7200,
  exp: now - 3600,
});
const freshToken = jwt({
  sid: "session_2",
  org_id: "org_1",
  role: "member",
  iat: now,
  exp: now + 3600,
});
// Valid for 30 more seconds of a one-hour lifetime: inside the 60-second refresh buffer.
const expiringToken = jwt({
  sid: "session_1",
  org_id: "org_1",
  iat: now - 3570,
  exp: now + 30,
});
const sessionClear = `wos-session=; Expires=${new Date(0).toUTCString()}; Path=/; Max-Age=0`;
const jwtClear = "workos-access-token=; Max-Age=0";
const pkceCookie = "wos-auth-verifier=pkce-state";

describe.each(["src/session.ts", "dist/esm/session.js"])(
  "AuthKit %s refresh stage",
  (file) => {
    function loadSession(
      sessions: Record<string, object>,
      sdk: jest.Mock,
      validTokens: string[] = [],
    ) {
      const unexpected = (name: string) => () => {
        throw new Error(`Unexpected call to ${name}`);
      };
      const sealData = jest.fn(async () => "sealed-session");
      const dependencies: Record<string, unknown> = {
        "server-only": {},
        "iron-session": {
          sealData,
          unsealData: async (cookie: string) => sessions[cookie],
        },
        jose: {
          decodeJwt: jose.decodeJwt,
          createRemoteJWKSet: () => "jwks",
          jwtVerify: async (token: unknown) => {
            if (validTokens.includes(token as string)) return { payload: {} };
            throw new Error("signature or expiry rejected");
          },
        },
        "next/headers": {
          cookies: unexpected("cookies"),
          headers: unexpected("headers"),
        },
        "next/navigation": { redirect: unexpected("redirect") },
        "next/server": {},
        "./interfaces.js": {},
        "./cookie.js": {
          getCookieOptions: (
            _url: string,
            _secure: boolean,
            expired?: boolean,
          ) => (expired ? "Path=/; Max-Age=0" : "Path=/"),
          getJwtCookie: (
            token: string | null,
            _url: string,
            expired?: boolean,
          ) => (expired ? jwtClear : `workos-access-token=${token}`),
        },
        "./env-variables.js": {
          WORKOS_CLIENT_ID: "client_test",
          WORKOS_COOKIE_NAME: "",
          WORKOS_COOKIE_PASSWORD: "x".repeat(32),
          WORKOS_REDIRECT_URI: "https://app.example/callback",
        },
        "./errors.js": {
          TokenRefreshError: Error,
          getSessionErrorContext: () => ({}),
        },
        "./get-authorization-url.js": {
          getAuthorizationUrl: async () => ({
            url: "https://auth.example/authorize",
            sealedState: "pkce-state",
          }),
        },
        "./pkce.js": {
          appendPKCESetCookieHeader: (_request: unknown, headers: Headers) =>
            headers.append("Set-Cookie", pkceCookie),
          isInitialDocumentRequest: () => false,
          setPKCECookie: unexpected("setPKCECookie"),
          setPendingPKCERedirectHeaders: () => {},
        },
        "./workos.js": {
          getWorkOS: () => ({
            userManagement: {
              authenticateWithRefreshToken: sdk,
              getJwksUrl: () => "https://auth.example/jwks",
            },
          }),
        },
        "path-to-regexp": {
          parse: unexpected("parse"),
          tokensToRegexp: unexpected("tokensToRegexp"),
        },
        "./middleware-helpers.js": {
          handleAuthkitHeaders: unexpected("handleAuthkitHeaders"),
        },
        "./utils.js": {
          evaluateRecentAuth: unexpected("evaluateRecentAuth"),
          lazy: (fn: () => unknown) => fn,
          setCachePreventionHeaders: (headers: Headers) =>
            headers.set("Cache-Control", "no-store"),
        },
      };
      const source = fs.readFileSync(
        path.join(
          process.cwd(),
          "node_modules/@workos-inc/authkit-nextjs",
          file,
        ),
        "utf8",
      );
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const exports: Record<string, (...args: any[]) => Promise<any>> = {};
      vm.runInNewContext(compiled, {
        exports,
        require: (name: string) => {
          if (!(name in dependencies))
            throw new Error(`Unexpected dependency ${name}`);
          return dependencies[name];
        },
        console: { log: jest.fn() },
        Headers,
        URL,
      });
      return { updateSession: exports.updateSession, sealData };
    }

    const request = (cookie: string) => ({
      url: "https://app.example/api/chat",
      nextUrl: new URL("https://app.example/api/chat"),
      headers: new Headers(),
      cookies: {
        get: (name: string) =>
          name === "wos-session" ? { name, value: cookie } : undefined,
        has: (name: string) => name === "wos-session",
      },
    });

    async function refresh(
      session: object,
      sdk: jest.Mock,
      validTokens?: string[],
    ) {
      const { updateSession, sealData } = loadSession(
        { cookie: session },
        sdk,
        validTokens,
      );
      const onSessionRefreshError = jest.fn();
      const onSessionRefreshSuccess = jest.fn();
      const sentRequest = request("cookie");
      const result = await updateSession(sentRequest, {
        eagerAuth: true,
        onSessionRefreshError,
        onSessionRefreshSuccess,
      });
      return {
        result,
        onSessionRefreshError,
        onSessionRefreshSuccess,
        sentRequest,
        sealData,
      };
    }

    const providerError = (status: number) =>
      Object.assign(new Error("WorkOS refresh rejected"), {
        name: status === 400 ? "OauthException" : "GenericServerException",
        status,
        error: status === 400 ? "invalid_grant" : undefined,
      });

    it("separates the same jose non-string error before and after the WorkOS refresh", async () => {
      const beforeSdk = jest.fn();
      const before = await refresh(
        { refreshToken: "refresh_1", user },
        beforeSdk,
      );
      const afterSdk = jest.fn(async () => ({
        refreshToken: "refresh_2",
        user,
      }));
      const after = await refresh(
        { accessToken: staleToken, refreshToken: "refresh_1", user },
        afterSdk,
      );

      const [beforeArgs] = before.onSessionRefreshError.mock.calls[0];
      const [afterArgs] = after.onSessionRefreshError.mock.calls[0];
      for (const args of [beforeArgs, afterArgs]) {
        expect(args.error).toBeInstanceOf(jose.errors.JWTInvalid);
        expect(args.error).toMatchObject({
          code: "ERR_JWT_INVALID",
          message:
            "JWTs must use Compact JWS serialization, JWT must be a string",
        });
      }
      // The existing error metadata cannot tell these apart; only the stage can.
      expect(Object.keys(beforeArgs)).toEqual([
        "error",
        "request",
        "isTransient",
        "refreshStage",
      ]);
      expect(beforeArgs).toMatchObject({
        request: before.sentRequest,
        isTransient: false,
        refreshStage: "before_refresh_request",
      });
      expect(afterArgs).toMatchObject({
        request: after.sentRequest,
        isTransient: false,
        refreshStage: "after_refresh_response",
      });
      expect(beforeSdk).not.toHaveBeenCalled();
      expect(afterSdk).toHaveBeenCalledTimes(1);
      expect(afterSdk).toHaveBeenCalledWith({
        clientId: "client_test",
        refreshToken: "refresh_1",
        organizationId: "org_1",
      });

      for (const outcome of [before, after]) {
        expect(outcome.onSessionRefreshError).toHaveBeenCalledTimes(1);
        expect(outcome.onSessionRefreshSuccess).not.toHaveBeenCalled();
        expect(outcome.result.session).toEqual({ user: null });
        expect(outcome.result.authorizationUrl).toBe(
          "https://auth.example/authorize",
        );
      }
      expect(before.result.headers.getSetCookie()).toEqual([
        sessionClear,
        jwtClear,
        pkceCookie,
      ]);
      // The sealed refresh is appended before the new token fails to decode, as before.
      expect(after.result.headers.getSetCookie()).toEqual([
        "wos-session=sealed-session; Path=/",
        sessionClear,
        jwtClear,
        pkceCookie,
      ]);
    });

    it.each([
      [400, false, [sessionClear, jwtClear, pkceCookie]],
      [503, true, [pkceCookie]],
    ])(
      "reports a WorkOS %i rejection at the SDK request without changing cookie handling",
      async (status, isTransient, setCookies) => {
        const error = providerError(status);
        const sdk = jest.fn(async () => {
          throw error;
        });
        const outcome = await refresh(
          { accessToken: staleToken, refreshToken: "refresh_1", user },
          sdk,
        );

        expect(sdk).toHaveBeenCalledTimes(1);
        expect(outcome.onSessionRefreshError).toHaveBeenCalledTimes(1);
        const [args] = outcome.onSessionRefreshError.mock.calls[0];
        expect(args.error).toBe(error);
        expect(args).toMatchObject({
          isTransient,
          refreshStage: "refresh_request",
        });
        expect(outcome.result.session).toEqual({ user: null });
        expect(outcome.result.headers.getSetCookie()).toEqual(setCookies);
      },
    );

    it("leaves a successful refresh without an error callback", async () => {
      const sdk = jest.fn(async () => ({
        accessToken: freshToken,
        refreshToken: "refresh_2",
        user,
        impersonator: undefined,
        authenticationMethod: "Password",
      }));
      const outcome = await refresh(
        { accessToken: staleToken, refreshToken: "refresh_1", user },
        sdk,
      );

      expect(outcome.onSessionRefreshError).not.toHaveBeenCalled();
      expect(outcome.onSessionRefreshSuccess).toHaveBeenCalledWith({
        accessToken: freshToken,
        user,
        impersonator: undefined,
        organizationId: "org_1",
      });
      expect(outcome.sealData).toHaveBeenCalledWith(
        {
          accessToken: freshToken,
          refreshToken: "refresh_2",
          user,
          impersonator: undefined,
          authenticationMethod: "Password",
        },
        { password: "x".repeat(32), ttl: 0 },
      );
      expect(outcome.result.session).toMatchObject({
        sessionId: "session_2",
        user,
        organizationId: "org_1",
        role: "member",
        accessToken: freshToken,
      });
      expect(outcome.result.authorizationUrl).toBeUndefined();
      expect(outcome.result.headers.getSetCookie()).toEqual([
        "wos-session=sealed-session; Path=/",
      ]);
      expect(outcome.result.headers.get("x-workos-session")).toBe(
        "sealed-session",
      );
    });

    it("serves a still-valid token after a failed proactive refresh without an error callback", async () => {
      const sdk = jest.fn(async () => {
        throw providerError(400);
      });
      const outcome = await refresh(
        { accessToken: expiringToken, refreshToken: "refresh_1", user },
        sdk,
        [expiringToken],
      );

      expect(sdk).toHaveBeenCalledTimes(1);
      expect(outcome.onSessionRefreshError).not.toHaveBeenCalled();
      expect(outcome.result.session).toMatchObject({
        user,
        accessToken: expiringToken,
      });
      expect(outcome.result.authorizationUrl).toBeUndefined();
      expect(outcome.result.headers.getSetCookie()).toEqual([]);
      expect(outcome.result.headers.get("x-workos-session")).toBe("cookie");
    });

    describe("through AuthKit's bounded WorkOS client", () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
      });

      /** Route the session refresh through the real patched client and SDK. */
      function refreshThroughClient() {
        const client = loadAuthKitWorkOS(file);
        const sdk = jest.fn((args: unknown) =>
          client.userManagement.authenticateWithRefreshToken(args),
        );
        let outcome: Awaited<ReturnType<typeof refresh>> | undefined;
        void refresh(
          { accessToken: staleToken, refreshToken: "refresh_1", user },
          sdk,
        ).then((value) => (outcome = value));
        return () => outcome;
      }

      it.each([
        ["a stalled request", 408, () => hangUntilAborted],
        [
          "a 5xx response",
          503,
          () => async () =>
            new Response(JSON.stringify({ message: "unavailable" }), {
              status: 503,
            }),
        ],
      ])(
        "ends %s within 10s after one retry and keeps the session cookie",
        async (_case, status, fetchImplementation) => {
          const fetchMock = jest
            .spyOn(globalThis, "fetch")
            .mockImplementation(fetchImplementation());
          const outcome = refreshThroughClient();

          await jest.advanceTimersByTimeAsync(10_000);

          // Previously 60s per attempt and 3 retries held the request for minutes.
          expect(outcome()).toBeDefined();
          await jest.advanceTimersByTimeAsync(60_000);
          expect(fetchMock).toHaveBeenCalledTimes(2);
          const [args] = outcome()!.onSessionRefreshError.mock.calls[0];
          expect(args.error).toMatchObject({ status });
          expect(args).toMatchObject({
            isTransient: true,
            refreshStage: "refresh_request",
          });
          expect(outcome()!.result.session).toEqual({ user: null });
          // No session or access-token deletion: a later request can still refresh.
          expect(outcome()!.result.headers.getSetCookie()).toEqual([
            pkceCookie,
          ]);
        },
      );

      it("still completes a fast refresh with a single request", async () => {
        const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(
          async () =>
            new Response(
              JSON.stringify({
                user: { object: "user", id: "user_1" },
                access_token: freshToken,
                refresh_token: "refresh_2",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        );
        const outcome = refreshThroughClient();

        await jest.advanceTimersByTimeAsync(0);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(outcome()!.onSessionRefreshError).not.toHaveBeenCalled();
        expect(outcome()!.result.session).toMatchObject({
          sessionId: "session_2",
          accessToken: freshToken,
        });
        expect(outcome()!.result.headers.getSetCookie()).toEqual([
          "wos-session=sealed-session; Path=/",
        ]);
      });
    });

    it("keeps each request's stage when refreshes overlap", async () => {
      let rejectInFlight: (error: unknown) => void = () => {};
      let markSdkEntered: () => void = () => {};
      const sdkEntered = new Promise<void>((resolve) => {
        markSdkEntered = resolve;
      });
      const sdk = jest.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectInFlight = reject;
            markSdkEntered();
          }),
      );
      const { updateSession } = loadSession(
        {
          "cookie-a": {
            accessToken: staleToken,
            refreshToken: "refresh_a",
            user,
          },
          "cookie-b": { refreshToken: "refresh_b", user },
        },
        sdk,
      );
      const errorsA = jest.fn();
      const errorsB = jest.fn();

      const pendingA = updateSession(request("cookie-a"), {
        onSessionRefreshError: errorsA,
      });
      await sdkEntered;
      expect(sdk).toHaveBeenCalledTimes(1);

      await updateSession(request("cookie-b"), {
        onSessionRefreshError: errorsB,
      });
      const unavailable = providerError(503);
      rejectInFlight(unavailable);
      await pendingA;

      expect(sdk).toHaveBeenCalledTimes(1);
      expect(errorsB).toHaveBeenCalledWith(
        expect.objectContaining({ refreshStage: "before_refresh_request" }),
      );
      expect(errorsA).toHaveBeenCalledWith(
        expect.objectContaining({
          error: unavailable,
          isTransient: true,
          refreshStage: "refresh_request",
        }),
      );
    });
  },
);
