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
      expect(warn).toHaveBeenCalledTimes(7);
      expect(
        warn.mock.calls.every(
          ([message]) =>
            message ===
            JSON.stringify({
              event: "auth.invalid_refresh_token",
              boundary: "server_action",
            }),
        ),
      ).toBe(true);
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
      expect(warn).not.toHaveBeenCalled();
    });
  },
);
