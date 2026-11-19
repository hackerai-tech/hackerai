import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextEncoder } from "node:util";
import vm from "node:vm";
import ts from "typescript";

// Exercise both shipped actions and the source patch, bypassing the app's
// AuthKit Jest mock so an unapplied or divergent dependency patch fails here.
describe.each(["src/actions.ts", "dist/esm/actions.js"])(
  "AuthKit %s",
  (file) => {
    // The VM context has no platform globals; supply the server's Web Crypto.
    const platformGlobals = { crypto: webcrypto, TextEncoder };
    const spyCrypto = () => {
      const digest = jest.fn((algorithm: string, data: Uint8Array) =>
        webcrypto.subtle.digest(algorithm, data),
      );
      return {
        digest,
        globals: { crypto: { subtle: { digest } }, TextEncoder },
      };
    };

    function loadActions(
      error?: unknown,
      globals: Record<string, unknown> = platformGlobals,
    ) {
      const auth = jest.fn(async () => {
        if (error) throw error;
        return {
          user: { id: "user-1" },
          organizationId: "org-1",
          accessToken: "private-token",
        };
      });
      const organization = jest.fn(async () => ({
        id: "org-1",
        name: "Example",
        privateMetadata: "private",
      }));
      const warn = jest.fn();
      const dependencies: Record<string, unknown> = {
        "./auth.js": {
          getSignInUrl: async () => "https://example.com/login",
          switchToOrganization: auth,
        },
        "./session.js": { withAuth: auth, refreshSession: auth },
        "./workos.js": {
          getWorkOS: () => ({
            organizations: { getOrganization: organization },
          }),
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
      const actions: Record<string, (...args: any[]) => Promise<any>> = {};
      vm.runInNewContext(compiled, {
        exports: actions,
        require: (name: string) => {
          if (!(name in dependencies))
            throw new Error(`Unexpected dependency ${name}`);
          return dependencies[name];
        },
        console: { warn },
        ...globals,
      });
      return { actions, auth, organization, warn };
    }

    const terminal = {
      name: "TokenRefreshError",
      isTransient: false,
      cause: {
        status: 400,
        error: "invalid_grant",
        errorDescription: "Invalid refresh token.",
      },
    };

    it("recovers every auth action without leaking tokens or requesting an organization", async () => {
      const { actions, organization, warn } = loadActions(terminal);
      await expect(actions.getAuthAction()).resolves.toEqual({ user: null });
      await expect(
        actions.getAuthAction({ ensureSignedIn: true }),
      ).resolves.toEqual({
        user: null,
        signInUrl: "https://example.com/login",
      });
      await expect(
        actions.refreshAuthAction({ ensureSignedIn: true }),
      ).resolves.toEqual({
        user: null,
        signInUrl: "https://example.com/login",
      });
      await expect(
        actions.switchToOrganizationAction("org-other"),
      ).resolves.toEqual({ user: null });
      await expect(
        actions.getOrganizationAction("org-other"),
      ).resolves.toBeNull();
      await expect(actions.getAccessTokenAction()).resolves.toBeUndefined();
      await expect(actions.refreshAccessTokenAction()).resolves.toEqual({
        accessToken: undefined,
      });
      expect(organization).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual(
        Array(7).fill([
          JSON.stringify({
            event: "auth.invalid_refresh_token",
            boundary: "server_action",
          }),
        ]),
      );
    });

    it("keeps an ended session signed out without a refresh failure warning", async () => {
      const { actions, warn } = loadActions({
        name: "OauthException",
        status: 400,
        error: "invalid_grant",
        errorDescription: "Session has already ended.",
      });
      const result = await actions.refreshAccessTokenAction();
      expect(Object.keys(result)).toEqual(["accessToken"]);
      expect(result.accessToken).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      { ...terminal, isTransient: true },
      {
        ...terminal,
        cause: {
          ...terminal.cause,
          errorDescription: "Invalid code verifier.",
        },
      },
      new Error("Provider unavailable"),
    ])(
      "keeps unrecognized and transient failures visible: %j",
      async (error) => {
        const { actions, organization } = loadActions(error);
        for (const name of [
          "getAuthAction",
          "refreshAuthAction",
          "getOrganizationAction",
          "switchToOrganizationAction",
          "getAccessTokenAction",
        ])
          await expect(actions[name]()).rejects.toBe(error);
        await expect(
          actions.refreshAccessTokenAction(),
        ).resolves.toHaveProperty("error");
        expect(organization).not.toHaveBeenCalled();
      },
    );

    async function refreshWarningDiagnostics(
      error: unknown,
      globals?: Record<string, unknown>,
    ) {
      const { actions, auth, organization, warn } = loadActions(error, globals);
      const result = await actions.refreshAccessTokenAction();
      expect(Object.keys(result)).toEqual(["accessToken", "error"]);
      expect(result).toEqual({
        accessToken: undefined,
        error: "Failed to refresh access token",
      });
      expect(auth).toHaveBeenCalledTimes(1);
      expect(organization).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const [prefix, message, diagnostics, ...rest] = warn.mock.calls[0];
      expect(prefix).toBe("Failed to refresh access token:");
      expect(typeof message).toBe("string");
      expect(rest).toEqual([]);
      expect(typeof diagnostics).toBe("string");
      return diagnostics as string;
    }

    const throwingGetter = () => {
      throw new Error("getter canary");
    };
    const withThrowingGetter = <T extends object>(error: T, key: string) =>
      Object.defineProperty(error, key, { get: throwingGetter });
    const metadata = (
      root: [string, number | null, string, string],
      cause: [string, number | null, string, string],
      isTransient: boolean | string,
    ) => ({
      event: "auth.access_token_refresh_failed",
      boundary: "server_action",
      auth_action_refresh_diagnostic_version: 1,
      auth_action_refresh_error_kind: root[0],
      auth_action_refresh_error_status: root[1],
      auth_action_refresh_error_status_shape: root[2],
      auth_action_refresh_error_code: root[3],
      auth_action_refresh_cause_kind: cause[0],
      auth_action_refresh_cause_status: cause[1],
      auth_action_refresh_cause_status_shape: cause[2],
      auth_action_refresh_cause_code: cause[3],
      auth_action_refresh_is_transient: isTransient,
    });
    const withRateLimit = (
      coarse: ReturnType<typeof metadata>,
      requestId: string | null,
      requestIdShape: string,
      retryAfter: number | null,
      retryAfterShape: string,
      [sessionFingerprint, sessionShape]: [string | null, string],
    ) => ({
      ...coarse,
      auth_action_refresh_rate_limit_diagnostic_version: 1,
      auth_action_refresh_rate_limit_request_id: requestId,
      auth_action_refresh_rate_limit_request_id_shape: requestIdShape,
      auth_action_refresh_rate_limit_retry_after_seconds: retryAfter,
      auth_action_refresh_rate_limit_retry_after_shape: retryAfterShape,
      auth_action_refresh_rate_limit_session_diagnostic_version: 1,
      auth_action_refresh_rate_limit_session_fingerprint: sessionFingerprint,
      auth_action_refresh_rate_limit_session_shape: sessionShape,
    });
    // Raw session IDs start at a word boundary; field names contain "_session_".
    const privateText = /canary|user_|\bsession_/i;
    // SDK canary session IDs are not WorkOS-shaped and are never hashed.
    const unrecognizedSession: [null, string] = [null, "unrecognized"];
    const absentSession: [null, string] = [null, "absent"];
    const selfCycle = Object.assign(new Error("Canary server text"), {
      name: "GenericServerException",
      status: 700,
      code: "server_error",
    });
    selfCycle.cause = selfCycle;

    it.each([
      {
        case: "SDK-wrapped WorkOS 429",
        error: Object.assign(
          new Error("Failed to refresh session: Rate limit canary"),
          {
            name: "TokenRefreshError",
            isTransient: true,
            userId: "user_canary",
            sessionId: "session_canary",
            cause: Object.assign(new Error("Rate limit canary"), {
              name: "RateLimitExceededException",
              status: 429,
              requestID: "req_canary",
              retryAfter: 30,
              rawData: { message: "canary body" },
            }),
          },
        ),
        expected: withRateLimit(
          metadata(
            ["TokenRefreshError", null, "absent", "none"],
            ["RateLimitExceededException", 429, "integer", "none"],
            true,
          ),
          null,
          "invalid",
          30,
          "valid",
          unrecognizedSession,
        ),
      },
      {
        case: "network cause and a status-like message",
        error: Object.assign(new Error("HTTP 429 rate limit canary"), {
          cause: Object.assign(new TypeError("fetch failed canary"), {
            code: "ECONNRESET",
          }),
        }),
        expected: metadata(
          ["Error", null, "absent", "none"],
          ["TypeError", null, "absent", "ECONNRESET"],
          "absent",
        ),
      },
      {
        case: "unknown names, codes and malformed statuses",
        error: {
          name: "CanaryCustomError",
          status: "429",
          code: "CANARY_CODE",
          isTransient: "canary",
          cause: {
            name: "OauthException",
            status: 503.5,
            error: "temporarily_unavailable",
            errorDescription: "canary description",
          },
        },
        expected: metadata(
          ["other_error", null, "non_numeric", "other"],
          ["OauthException", null, "non_integer", "temporarily_unavailable"],
          "other",
        ),
      },
      {
        case: "self-referencing cause and out-of-range status",
        error: selfCycle,
        expected: metadata(
          ["GenericServerException", null, "out_of_range", "server_error"],
          ["none", null, "absent", "none"],
          "absent",
        ),
      },
      {
        case: "non-error value",
        error: "canary provider text",
        expected: metadata(
          ["non_error", null, "absent", "none"],
          ["none", null, "absent", "none"],
          "absent",
        ),
      },
      {
        case: "throwing root code getter",
        error: withThrowingGetter(new Error("Canary"), "code"),
        expected: metadata(
          ["unreadable", null, "unreadable", "unreadable"],
          ["none", null, "absent", "none"],
          "absent",
        ),
      },
      {
        case: "throwing cause code and root isTransient getters",
        error: Object.assign(
          withThrowingGetter(new Error("Canary"), "isTransient"),
          { cause: withThrowingGetter(new Error("Canary cause"), "code") },
        ),
        expected: metadata(
          ["Error", null, "absent", "none"],
          ["unreadable", null, "unreadable", "unreadable"],
          "unreadable",
        ),
      },
    ])(
      "adds only fixed refresh failure metadata to the existing warning: $case",
      async ({ error, expected }) => {
        const diagnostics = await refreshWarningDiagnostics(error);
        expect(diagnostics).not.toMatch(/canary|req_|user_|\bsession_/i);
        expect(JSON.parse(diagnostics)).toEqual(expected);
      },
    );

    describe("WorkOS 429 request metadata", () => {
      // Jest maps @workos-inc/node to an app mock; load the installed SDK build
      // so these cases use the error WorkOS actually throws for a 429.
      const { RateLimitExceededException } = jest.requireActual(
        path.join(process.cwd(), "node_modules/@workos-inc/node/lib/index.cjs"),
      ) as {
        RateLimitExceededException: new (
          message: string,
          requestID: unknown,
          retryAfter: unknown,
        ) => Error & Record<string, unknown>;
      };
      const rateLimit = (requestID: unknown, retryAfter: unknown) =>
        new RateLimitExceededException(
          "Rate limit canary",
          requestID,
          retryAfter,
        );
      const tokenRefreshError = (cause: unknown) =>
        Object.assign(
          new Error("Failed to refresh session: Rate limit canary"),
          {
            name: "TokenRefreshError",
            isTransient: true,
            userId: "user_canary",
            sessionId: "session_canary",
            cause,
          },
        );
      const none: [string, null, string, string] = [
        "none",
        null,
        "absent",
        "none",
      ];
      const rateLimitKind: [string, number, string, string] = [
        "RateLimitExceededException",
        429,
        "integer",
        "none",
      ];
      const wrapped = metadata(
        ["TokenRefreshError", null, "absent", "none"],
        rateLimitKind,
        true,
      );
      const unwrapped = metadata(rateLimitKind, none, "absent");
      const uuid = "9f1c2b3a-4d5e-4f60-8a7b-0c1d2e3f4a5b";
      const ulid = "01JCXK3V9Q7N4M2P8R6T5W0YZA";

      it("adds the actual SDK's request ID and Retry-After to the wrapped refresh warning", async () => {
        const diagnostics = await refreshWarningDiagnostics(
          tokenRefreshError(rateLimit(`req_${ulid}`, 30)),
        );
        expect(diagnostics).not.toMatch(privateText);
        expect(JSON.parse(diagnostics)).toEqual(
          withRateLimit(
            wrapped,
            `req_${ulid}`,
            "valid",
            30,
            "valid",
            unrecognizedSession,
          ),
        );
      });

      it.each<[unknown, unknown, string, string]>([
        [`request_${uuid}`, 0, "valid", "valid"],
        [uuid.toUpperCase(), 86400, "valid", "valid"],
        [ulid, 1.5, "valid", "valid"],
        // The SDK uses "" and null when X-Request-ID / Retry-After are missing.
        ["", null, "absent", "absent"],
        [undefined, undefined, "absent", "absent"],
        ["req_canary", "30", "invalid", "invalid"],
        ["canary@example.com", Number("canary"), "invalid", "invalid"],
        [`https://canary.example.com/${uuid}`, Infinity, "invalid", "invalid"],
        [`${uuid}\ncanary`, -1, "invalid", "invalid"],
        [`${uuid}\n`, 30, "invalid", "valid"],
        [`${uuid}\r\n`, 30, "invalid", "valid"],
        [`${uuid}\u2028`, 30, "invalid", "valid"],
        [`user_${ulid}`, 86400.5, "invalid", "invalid"],
        [ulid.toLowerCase(), { valueOf: () => 30 }, "invalid", "invalid"],
        [`8${ulid.slice(1)}`, true, "invalid", "invalid"],
        [`req_${uuid}`.padEnd(65, "0"), "", "invalid", "invalid"],
        [`X-Request-ID: ${uuid}`, 30, "invalid", "valid"],
        [12345, 30, "invalid", "valid"],
        [{ toString: () => uuid }, 30, "invalid", "valid"],
      ])(
        "accepts only closed request ID and delay formats: %j / %j",
        async (requestID, retryAfter, requestIdShape, retryAfterShape) => {
          const diagnostics = await refreshWarningDiagnostics(
            tokenRefreshError(rateLimit(requestID, retryAfter)),
          );
          expect(diagnostics).not.toMatch(privateText);
          expect(JSON.parse(diagnostics)).toEqual(
            withRateLimit(
              wrapped,
              requestIdShape === "valid" ? (requestID as string) : null,
              requestIdShape,
              retryAfterShape === "valid" ? (retryAfter as number) : null,
              retryAfterShape,
              unrecognizedSession,
            ),
          );
        },
      );

      it("keeps the coarse warning and the other field when one getter throws", async () => {
        expect(
          JSON.parse(
            await refreshWarningDiagnostics(
              tokenRefreshError(
                withThrowingGetter(rateLimit(uuid, 30), "requestID"),
              ),
            ),
          ),
        ).toEqual(
          withRateLimit(
            wrapped,
            null,
            "unreadable",
            30,
            "valid",
            unrecognizedSession,
          ),
        );
        expect(
          JSON.parse(
            await refreshWarningDiagnostics(
              tokenRefreshError(
                withThrowingGetter(rateLimit(uuid, 30), "retryAfter"),
              ),
            ),
          ),
        ).toEqual(
          withRateLimit(
            wrapped,
            uuid,
            "valid",
            null,
            "unreadable",
            unrecognizedSession,
          ),
        );
      });

      it("reads only the root or its immediate cause, preferring the cause", async () => {
        const selfCause = rateLimit(ulid, 5);
        selfCause.cause = selfCause;
        // An unwrapped 429 has no SDK session context, so it is never read.
        for (const error of [
          withThrowingGetter(rateLimit(ulid, 5), "sessionId"),
          selfCause,
        ])
          expect(JSON.parse(await refreshWarningDiagnostics(error))).toEqual(
            withRateLimit(unwrapped, ulid, "valid", 5, "valid", absentSession),
          );

        const both = Object.assign(rateLimit(ulid, 5), {
          cause: rateLimit(uuid, 7),
        });
        expect(JSON.parse(await refreshWarningDiagnostics(both))).toEqual(
          withRateLimit(
            metadata(rateLimitKind, rateLimitKind, "absent"),
            uuid,
            "valid",
            7,
            "valid",
            absentSession,
          ),
        );
      });

      describe("original session fingerprint", () => {
        const sessionId = `session_${ulid}`;
        const otherSessionId = `session_${ulid.slice(0, -1)}B`;
        // Fixed fixture, checked against Node's hash module rather than the
        // Web Crypto path the SDK uses.
        const expectedFingerprint = "eaea9c5efcf91b3c278f89a470a68a3d";
        const fingerprint = (id: string) =>
          createHash("sha256")
            .update(`hackerai:auth-refresh-429-session:v1:${id}`)
            .digest("hex")
            .slice(0, 32);
        const withSession = (session: [string | null, string]) =>
          withRateLimit(wrapped, uuid, "valid", 30, "valid", session);
        const sessionWarning = (
          sessionIdValue: unknown,
          globals?: Record<string, unknown>,
        ) =>
          refreshWarningDiagnostics(
            Object.assign(tokenRefreshError(rateLimit(uuid, 30)), {
              sessionId: sessionIdValue,
            }),
            globals,
          );

        it("emits a stable one-way fingerprint that distinguishes sessions", async () => {
          expect(fingerprint(sessionId)).toBe(expectedFingerprint);
          const { digest, globals } = spyCrypto();
          const first = await sessionWarning(sessionId, globals);
          expect(digest).toHaveBeenCalledTimes(1);
          expect(digest.mock.calls[0][0]).toBe("SHA-256");
          expect(first).not.toContain(ulid);
          expect(first).not.toMatch(privateText);
          expect(JSON.parse(first)).toEqual(
            withSession([expectedFingerprint, "valid"]),
          );
          expect(JSON.parse(await sessionWarning(sessionId))).toEqual(
            withSession([expectedFingerprint, "valid"]),
          );
          expect(JSON.parse(await sessionWarning(otherSessionId))).toEqual(
            withSession([fingerprint(otherSessionId), "valid"]),
          );
          expect(fingerprint(otherSessionId)).not.toBe(expectedFingerprint);
        });

        it.each<[unknown, string]>([
          [undefined, "absent"],
          [null, "absent"],
          ["", "unrecognized"],
          ["session_canary", "unrecognized"],
          [ulid, "unrecognized"],
          [`user_${ulid}`, "unrecognized"],
          [`sess_${ulid}`, "unrecognized"],
          [`Session_${ulid}`, "unrecognized"],
          [`session_${ulid.toLowerCase()}`, "unrecognized"],
          [`session_8${ulid.slice(1)}`, "unrecognized"],
          [`session_${ulid.slice(0, -1)}I`, "unrecognized"],
          [`${sessionId}0`, "unrecognized"],
          [`${sessionId}\n`, "unrecognized"],
          [` ${sessionId}`, "unrecognized"],
          [12345, "unrecognized"],
          [{ toString: () => sessionId }, "unrecognized"],
        ])(
          "hashes only WorkOS-shaped session IDs: %j",
          async (value, shape) => {
            const { digest, globals } = spyCrypto();
            const diagnostics = await sessionWarning(value, globals);
            expect(digest).not.toHaveBeenCalled();
            expect(diagnostics).not.toContain(ulid);
            expect(JSON.parse(diagnostics)).toEqual(withSession([null, shape]));
          },
        );

        it("closes a throwing session getter without hashing", async () => {
          const { digest, globals } = spyCrypto();
          const diagnostics = await refreshWarningDiagnostics(
            withThrowingGetter(
              tokenRefreshError(rateLimit(uuid, 30)),
              "sessionId",
            ),
            globals,
          );
          expect(digest).not.toHaveBeenCalled();
          expect(JSON.parse(diagnostics)).toEqual(
            withSession([null, "unreadable"]),
          );
        });

        it.each<[string, Record<string, unknown>]>([
          ["missing crypto", { crypto: undefined, TextEncoder }],
          ["missing subtle crypto", { crypto: {}, TextEncoder }],
          [
            "missing TextEncoder",
            { crypto: webcrypto, TextEncoder: undefined },
          ],
          [
            "throwing digest",
            {
              crypto: { subtle: { digest: throwingGetter } },
              TextEncoder,
            },
          ],
          [
            "rejecting digest",
            {
              crypto: {
                subtle: {
                  digest: async () => {
                    throw new Error("digest canary");
                  },
                },
              },
              TextEncoder,
            },
          ],
        ])(
          "keeps the warning and result when Web Crypto fails: %s",
          async (_, globals) => {
            const diagnostics = await sessionWarning(sessionId, globals);
            expect(diagnostics).not.toContain(ulid);
            expect(JSON.parse(diagnostics)).toEqual(
              withSession([null, "crypto_unavailable"]),
            );
          },
        );
      });

      it.each([
        {
          case: "rate-limit name with another status",
          cause: () => Object.assign(rateLimit(uuid, 30), { status: 503 }),
          kind: ["RateLimitExceededException", 503, "integer", "none"],
        },
        {
          case: "string 429 status",
          cause: () => Object.assign(rateLimit(uuid, 30), { status: "429" }),
          kind: ["RateLimitExceededException", null, "non_numeric", "none"],
        },
        {
          case: "429 from another error class",
          cause: () =>
            Object.assign(new Error("Canary"), {
              name: "GenericServerException",
              status: 429,
            }),
          kind: ["GenericServerException", 429, "integer", "none"],
        },
        {
          case: "rate limit below the immediate cause",
          cause: () =>
            Object.assign(new Error("Canary"), { cause: rateLimit(uuid, 30) }),
          kind: ["Error", null, "absent", "none"],
        },
      ])(
        "does not read request or session metadata from non-selected errors: $case",
        async ({ cause, kind }) => {
          const read = jest.fn();
          const immediate = cause();
          for (const target of [immediate, immediate.cause])
            for (const key of ["requestID", "retryAfter"])
              if (target instanceof Error)
                Object.defineProperty(target, key, {
                  get: () => read(key),
                });
          const root = Object.defineProperty(
            tokenRefreshError(immediate),
            "sessionId",
            { get: () => read("sessionId") },
          );
          const { digest, globals } = spyCrypto();
          const diagnostics = await refreshWarningDiagnostics(root, globals);
          expect(read).not.toHaveBeenCalled();
          expect(digest).not.toHaveBeenCalled();
          expect(JSON.parse(diagnostics)).toEqual(
            metadata(
              ["TokenRefreshError", null, "absent", "none"],
              kind as [string, number | null, string, string],
              true,
            ),
          );
        },
      );
    });

    it("preserves authenticated organization boundaries and token sanitization", async () => {
      const { actions, organization, warn } = loadActions();
      await expect(actions.getAuthAction()).resolves.toEqual({
        user: { id: "user-1" },
        organizationId: "org-1",
      });
      await expect(
        actions.getOrganizationAction("org-other"),
      ).resolves.toBeNull();
      expect(organization).not.toHaveBeenCalled();
      await expect(actions.getOrganizationAction("org-1")).resolves.toEqual({
        id: "org-1",
        name: "Example",
      });
      await expect(actions.refreshAccessTokenAction()).resolves.toEqual({
        accessToken: "private-token",
      });
      expect(warn).not.toHaveBeenCalled();
    });
  },
);
