import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Exercise both shipped actions and the source patch, bypassing the app's
// AuthKit Jest mock so an unapplied or divergent dependency patch fails here.
describe.each(["src/actions.ts", "dist/esm/actions.js"])(
  "AuthKit %s",
  (file) => {
    function loadActions(error?: unknown) {
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

    const throwingGetter = () => {
      throw new Error("getter canary");
    };
    const withThrowingGetter = (error: Error, key: string) =>
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
        expected: metadata(
          ["TokenRefreshError", null, "absent", "none"],
          ["RateLimitExceededException", 429, "integer", "none"],
          true,
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
        const { actions, auth, organization, warn } = loadActions(error);
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
        expect(diagnostics).not.toMatch(/canary|req_|user_|session_/i);
        expect(JSON.parse(diagnostics)).toEqual(expected);
      },
    );

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
